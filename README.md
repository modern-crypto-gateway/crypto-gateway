# crypto-gateway

Runtime-agnostic crypto payment gateway. One codebase, four deployment targets:
**Cloudflare Workers**, **Node / Bun**, **Deno / Deno Deploy**, **Vercel Edge**.

Chains, storage, detection, pricing, and webhook delivery are all pluggable via
explicit port interfaces — adding a new EVM chain is a one-line entry in the
token registry; adding a whole new family (Solana, Bitcoin, …) is one adapter
file with no edits to core domain logic or HTTP routes.

Status: pre-1.0. Feature-complete for the primary payment flow (detect → confirm
→ webhook → payout). Production hardening items (ledger-balance picker w/ JIT gas top-up,
reorg recovery) are tracked as known follow-ups.

---

## Architecture at a glance

- **core/** — pure domain. Zero platform imports. Port interfaces + services.
- **adapters/** — concrete implementations per platform/provider (Drizzle over
  libSQL/Turso, CF-KV, memory cache, wait-until, promise-set, viem-based EVM,
  TronGrid, Solana SLIP-0010, Alchemy Notify, inline-fetch webhook dispatcher,
  console logger, …). Turso is the single database target across every
  runtime; D1 was removed in the 2026-Q1 migration.
- **http/** — Hono routes + middleware (auth, request-id, rate-limit, errors).
- **entrypoints/** — one file per runtime. Each constructs `AppDeps` with the
  adapters appropriate to that runtime and calls `buildApp(deps)`.

A three-layer boundary prevents leaks:
1. `src/core/tsconfig.json` has `types: []` — any reference to `process`,
   `D1Database`, `KVNamespace` etc. in core fails typecheck.
2. ESLint `no-restricted-globals` bans platform-specific globals outside of a
   hand-narrowed allow-list (entrypoints + their native-env adapters).
3. ESLint `import/no-restricted-paths` prevents `core/**` from importing
   `adapters/**`, `entrypoints/**`, or `http/**`.

## First-time Turso setup

Every runtime except local Node/Deno-with-`file:`-DB needs a Turso database.
Create it once, apply the schema once, and then feed `TURSO_URL` /
`TURSO_AUTH_TOKEN` to whichever runtime you deploy to. **This is the step
that creates all the tables** — `drizzle-kit push` reads
[`src/db/schema.ts`](src/db/schema.ts) and emits the full schema against the
empty remote DB.

```bash
# 0) Install the Turso CLI (one-time): https://docs.turso.tech/cli/installation
turso auth login

# 1) Create the DB + capture its URL + auth token
turso db create crypto-gateway
turso db show crypto-gateway --url           # → libsql://<db>-<org>.turso.io
turso db tokens create crypto-gateway        # → eyJhbGciOi...

# 2) Apply the schema. One command creates every table on the empty DB.
TURSO_URL="libsql://<db>-<org>.turso.io" \
TURSO_AUTH_TOKEN="eyJ..." \
  npx drizzle-kit push
```

**You do not need to run `drizzle-kit generate` first for a fresh DB.** That
command is only for version-controlling schema *changes* over time (see
[Database migrations](#database-migrations)). `push` applies the current
schema directly — perfect for an empty Turso DB on a first deploy.

Re-run `drizzle-kit push` whenever `src/db/schema.ts` changes (Workers and
Vercel Edge have no runtime filesystem, so boot-time `migrate()` isn't
available there — CLI push is the canonical applier). Node / Deno replay
`drizzle/migrations/*` at boot and will pick up schema changes automatically
on restart.

For **pure local development** this step is optional: the Node / Deno
quick-starts below default to `file:./local.db`, and boot-time `migrate()`
creates the schema in that SQLite file on first run.

## Quick start — Node

```bash
cp config/example.env .env
# edit .env: set at least MASTER_SEED (for prod) — dev works without it
npm install
npm run typecheck
npm test
npm run dev:node
```

Default port `8787`. libSQL data lands in `./local.db` (override with
`TURSO_URL=libsql://…` + `TURSO_AUTH_TOKEN=…` after running the
[Turso setup above](#first-time-turso-setup); the legacy `DATABASE_URL` /
`DATABASE_TOKEN` names still work for one release cycle).

A dev merchant is auto-seeded in non-production (`NODE_ENV != production`) with
id `00000000-0000-0000-0000-000000000001`. Its API key hash has no known
preimage, so create a real merchant via `POST /admin/merchants` before using
the merchant API.

## Quick start — Cloudflare Workers

Prerequisite: run [First-time Turso setup](#first-time-turso-setup) first —
you'll paste the resulting URL + token into the `wrangler secret put` lines
below. Workers has no runtime filesystem, so `/admin/migrate` returns 501 and
`drizzle-kit push` is the only applier available for this runtime.

```bash
cp wrangler.jsonc.example wrangler.jsonc

# Create the KV namespace for CacheStore and paste the id into wrangler.jsonc:
npx wrangler kv namespace create CACHE

# Set secrets (not in wrangler.jsonc — they go to Cloudflare's store):
npx wrangler secret put TURSO_URL                   # libsql://<db>-<org>.turso.io
npx wrangler secret put TURSO_AUTH_TOKEN            # token from `turso db tokens create`
npx wrangler secret put MASTER_SEED                 # BIP39 mnemonic
npx wrangler secret put ADMIN_KEY                   # random 32+ chars
npx wrangler secret put SECRETS_ENCRYPTION_KEY      # 64 hex chars (AES-256 master key)
npx wrangler secret put ALCHEMY_API_KEY             # optional — per-app JSON-RPC key
npx wrangler secret put ALCHEMY_NOTIFY_TOKEN        # optional — webhook-mgmt token (NOT the API key above)
npx wrangler secret put CRON_SECRET                 # optional

npx wrangler deploy -e dev
```

The scheduled cron (`* * * * *`) runs `pollPayments` + `confirmTransactions` +
`executeReservedPayouts` + `confirmPayouts` via the worker's `scheduled` export.

## Quick start — Deno

```bash
# deno.json has tasks + npm: import maps already wired.
deno task dev     # runs src/entrypoints/deno.ts with --allow-net --allow-read --allow-env
```

`Deno.cron` handles scheduling natively on Deno Deploy.

## Quick start — Vercel Edge

Prerequisite: run [First-time Turso setup](#first-time-turso-setup) first —
Edge runtime has no filesystem, so schema changes apply via CLI push only.

```bash
vercel --prod    # respects vercel.json (routes all paths to src/entrypoints/vercel-edge.ts)
```

Scheduled jobs run via Vercel Cron: `vercel.json` declares a minute-cadence cron
against `/internal/cron/tick`, which requires `CRON_SECRET` in your Vercel env.
Database must be a libSQL HTTP URL (Turso) or similar.

## Configuration

All variables are read via `loadConfig(env)` at boot. Missing/malformed values
fail fast with an aggregated error. See [`src/config/config.schema.ts`](src/config/config.schema.ts)
for the full list. Highlights:

| Var                               | Required        | Default    | Notes                                                |
| --------------------------------- | --------------- | ---------- | ---------------------------------------------------- |
| `NODE_ENV`                        | no              | `development` | `production` enables strict boot-time validation |
| `MASTER_SEED`                     | **prod only**   | —          | BIP39 mnemonic. Every HD-derived address — invoice receive addresses, payout sources, gas sponsors — comes from this seed. Keep it backed up. Rejects the literal `dev-seed` in prod. |
| `ADMIN_KEY`                       | **prod only**   | —          | ≥32 chars required in prod                           |
| `CRON_SECRET`                     | optional        | —          | Enables `POST /internal/cron/tick`                   |
| `ALCHEMY_API_KEY`                 | optional        | —          | Auto-wires a real EVM chain adapter + RPC-poll detection across the default mainnet set (ETH, OP, Polygon, Base, Arbitrum). See below. |
| `ALCHEMY_CHAINS`                  | optional        | —          | Comma-separated chainIds to enable via Alchemy (e.g. `1,137`). Defaults to the mainnet set. |
| `ALCHEMY_NOTIFY_TOKEN`            | required for webhook bootstrap | — | **NOT the same as `ALCHEMY_API_KEY`.** Webhook-management ("Notify") token at the top of [`dashboard.alchemy.com/apps/latest/webhooks`](https://dashboard.alchemy.com/apps/latest/webhooks) → "Auth Token". The JSON-RPC API key will return 401 from this endpoint; they look similar but are distinct strings. Old name `ALCHEMY_AUTH_TOKEN` still works for one release cycle with a deprecation warning. |
| `GATEWAY_PUBLIC_URL`              | required for webhook bootstrap | — | Public origin of this gateway (e.g. `https://gateway.example.com`). Bootstrap appends per-provider paths like `/webhooks/alchemy`. Env-only to prevent ADMIN_KEY-leak redirect attacks. |
| `TURSO_URL`                       | prod-ish        | `file:./local.db` | libSQL URL (Turso over HTTPS or local `file:` URL). `DATABASE_URL` still accepted as a legacy alias for one release cycle. |
| `TURSO_AUTH_TOKEN`                | Turso only      | —          | libSQL auth token. `DATABASE_TOKEN` still accepted as a legacy alias. |
| `PORT`                            | no              | `8787`     |                                                      |
| `RATE_LIMIT_MERCHANT_PER_MINUTE`  | no              | `1000`     | Per-merchant cap on `/api/v1/*`. Note: effective throughput is also bounded by per-request latency — concurrent connections may be needed to approach this cap (plan latency is ~100-300ms typical). |
| `RATE_LIMIT_CHECKOUT_PER_MINUTE`  | no              | `60`       | Per-IP cap on `/checkout/*`                          |
| `RATE_LIMIT_WEBHOOK_INGEST_PER_MINUTE` | no         | `300`      | Per-IP cap on `/webhooks/*`                          |
| `PAYOUT_CONCURRENCY_PER_CHAIN`    | no              | `16`       | Max concurrent `executeOnePayout` calls per chainId in a single executor tick. Cross-chain runs are unconditionally parallel. Tune lower on Workers under heavy backlog to stay inside the ~50-subrequest budget. Range 1–64. |
| `PRICE_ADAPTER`                   | no              | (full chain) | `coingecko` (default ordering), `alchemy` (Alchemy-first — requires `ALCHEMY_API_KEY`), or `static-peg` (disable all live sources). See [Price oracle fallback chain](#price-oracle-fallback-chain). |
| `COINGECKO_API_KEY`               | no              | —          | Raises the CoinGecko rate budget. Keyless free tier also works. |
| `COINGECKO_PLAN`                  | no              | `demo`     | `demo` → sends `x-cg-demo-api-key`; `pro` → `x-cg-pro-api-key`. |
| `COINCAP_API_KEY`                 | no              | —          | Optional CoinCap (Messari) key. `/v2/assets` is keyless in practice. |
| `DISABLE_COINGECKO` / `DISABLE_COINCAP` / `DISABLE_BINANCE` / `DISABLE_ALCHEMY` | no | — | Set `=1` to drop that provider from the fallback chain. Useful for jurisdiction constraints or incident-response. |
| `ALERT_WEBHOOK_URL`               | no              | —          | When set, `error`/`fatal` logs are POSTed here (JSON body). Sliding-window rate-limited to 30/min; drops are piggybacked on the next delivery. |
| `ALERT_WEBHOOK_AUTH_HEADER`       | no              | —          | Value for the `Authorization` header when calling `ALERT_WEBHOOK_URL` (e.g. `Bearer xyz`). |

## Price oracle fallback chain

Invoice quoting and the USD rate-window pull spot prices from a chained set of
providers. Each link tries itself first; on HTTP error, timeout, unmapped
symbol, or malformed response it delegates to the next link. Only the terminal
`static-peg` link is allowed to serve hardcoded numbers (stables at `1` + the
override map in [`static-peg.adapter.ts`](src/adapters/price-oracle/static-peg.adapter.ts)),
so a single provider outage never blocks a quote.

Default ordering when `ALCHEMY_API_KEY` is set:

```
CoinGecko → Alchemy → CoinCap → Binance → static-peg
```

`PRICE_ADAPTER=alchemy` promotes Alchemy to the front:

```
Alchemy → CoinGecko → CoinCap → Binance → static-peg
```

`PRICE_ADAPTER=static-peg` skips every live source (use for deterministic
tests or jurisdictions that can't reach the public providers).

Each provider is individually disableable via `DISABLE_COINGECKO=1`,
`DISABLE_COINCAP=1`, `DISABLE_BINANCE=1`, `DISABLE_ALCHEMY=1`. Disabling
collapses the chain to the remaining providers in the same order. Each
adapter caches responses in the shared `CacheStore` (30s TTL) so a burst of
invoice creations against the same token hits the upstream once.

## Log shipping + alerting

Setting `ALERT_WEBHOOK_URL` turns on a sync-fire-and-forget HTTP sink attached
to the structured logger. Every `error` or `fatal` log is POSTed as a JSON
body `{ ts, level, msg, ...fields }`. A 3s timeout protects the caller, a
sliding-window rate limit caps deliveries at 30/min, and any drops caused by
the rate limiter are reported on the `droppedSinceLast` field of the next
successful delivery. If you need auth, set `ALERT_WEBHOOK_AUTH_HEADER`
(e.g. `Bearer xyz`) and it's sent verbatim as `Authorization`.

## Enabling Alchemy (optional)

Setting `ALCHEMY_API_KEY` alone is sufficient — every entrypoint will:

1. Register a real `evmChainAdapter` pointing at Alchemy RPC URLs for the
   default mainnet set (chainIds `1, 10, 137, 8453, 42161` — Ethereum,
   Optimism, Polygon, Base, Arbitrum).
2. Enable `rpcPollDetection` on those chains so the minute-cadence cron job
   picks up incoming transfers.

Narrow the set by listing chainIds in `ALCHEMY_CHAINS`. Example for
mainnet-ETH + Polygon only:

```bash
ALCHEMY_API_KEY=alch_...
ALCHEMY_CHAINS=1,137
```

Testnets are **opt-in** — not in the default set. To include Sepolia:

```bash
ALCHEMY_CHAINS=1,137,11155111
```

Without `ALCHEMY_API_KEY` the gateway runs with just the dev chain adapter,
which is enough for local development and integration tests but can't talk
to real networks. To use a non-Alchemy RPC (self-hosted Geth, public RPC,
QuickNode, Infura, Ankr, …) you can edit the relevant entrypoint to pass
your own `rpcUrls` to `evmChainAdapter` — same construction, different URL
source.

### Auto-bootstrap Alchemy webhooks (optional)

Rather than click through Alchemy's dashboard to create webhooks manually, set
`ALCHEMY_NOTIFY_TOKEN` + `GATEWAY_PUBLIC_URL` and POST to the bootstrap endpoint:

> **Footgun alert.** `ALCHEMY_NOTIFY_TOKEN` is the **webhook management token**
> from the top of [`dashboard.alchemy.com/apps/latest/webhooks`](https://dashboard.alchemy.com/apps/latest/webhooks)
> (labelled "Auth Token"). It is **not** your JSON-RPC API key (`ALCHEMY_API_KEY`),
> even though both strings look similar in the UI. Using the API key here
> returns `401 Unauthenticated request. AuthError` from Alchemy's webhook
> admin API — the bootstrap route surfaces a pointer to this note when that
> happens. The old name `ALCHEMY_AUTH_TOKEN` still works (with a
> deprecation warning in logs) so existing deployments don't break.

```bash
# Set once in your deployment env:
# GATEWAY_PUBLIC_URL=https://gateway.example.com

curl -X POST "$GATEWAY_URL/admin/bootstrap/alchemy-webhooks" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"chainIds": [1, 137]}'
```

The bootstrap constructs the target URL as `$GATEWAY_PUBLIC_URL/webhooks/alchemy`.
The base is env-only — passing any URL override in the body is intentionally
rejected so a leaked `ADMIN_KEY` can't redirect Alchemy's webhook traffic to
an attacker-controlled host.

Response:

```json
{
  "results": [
    { "chainId": 1,   "status": "created",  "webhookId": "wh_…", "signingKey": "whsec_…" },
    { "chainId": 137, "status": "existing", "webhookId": "wh_…" }
  ]
}
```

The endpoint is **idempotent**: chains already configured with a matching
`(network, webhookUrl)` pair are reported as `existing` and left alone. Re-run
as often as you like.

The per-chain `signingKey` returned in each `created` result is automatically
persisted (encrypted-at-rest via `SECRETS_ENCRYPTION_KEY`) into
`alchemy_webhook_registry`, keyed on Alchemy's `webhookId`. The
`/webhooks/alchemy` ingest route resolves the right key on every incoming
POST — no env vars, no manual copy-paste, and multi-chain Just Works.

Alchemy only returns each `signingKey` once at creation time. If `persisted`
comes back `false` on a `created` row (the registry insert raced or failed),
the response's `signingKey` is your only chance to recover it — push it back
in manually via the endpoint below.

### Manual signing-key registration

For operators who created webhooks through the Alchemy dashboard UI (not via
bootstrap) or who need to re-insert a key after a persistence failure:

```bash
curl -X POST "$GATEWAY_URL/admin/alchemy-webhooks/signing-keys" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 1,
    "webhookId": "wh_abc",
    "signingKey": "whsec_xyz",
    "webhookUrl": "https://gateway.example.com/webhooks/alchemy"
  }'
```

Same encrypt-and-insert path bootstrap uses. Re-running with an existing
chainId rotates the webhookId + signingKey (for dashboard delete+recreate).

With both `GATEWAY_PUBLIC_URL` and `ALCHEMY_CHAINS` env vars set the bootstrap
request body can be empty:

```bash
GATEWAY_PUBLIC_URL=https://gateway.example.com
ALCHEMY_CHAINS=1,137

curl -X POST "$GATEWAY_URL/admin/bootstrap/alchemy-webhooks" \
  -H "Authorization: Bearer $ADMIN_KEY" -d '{}'
```

Alchemy requires at least one address at webhook creation time; the bootstrap
seeds a per-family placeholder (hex zero for EVM, a derived ed25519 pubkey
for Solana) and **immediately removes it from the watch list** via
`/update-webhook-addresses` — so the gateway doesn't get flooded with
mint/burn events on the zero address. Real HD-derived addresses come from
the address pool (below).

## Supported tokens

Native gas tokens are **first-class** alongside stablecoins — invoices and
payouts treat them identically. Cross-reference the live picture with
`GET /admin/chains` (each row's `tokens` array enumerates exactly what's
registered for that chainId).

| Chain | chainId | Native | Stables |
| --- | --- | --- | --- |
| Ethereum | 1 | ETH | USDC, USDT |
| Optimism | 10 | ETH | USDC, USDT |
| BNB Smart Chain | 56 | BNB | USDC, USDT |
| Polygon | 137 | POL | USDC, USDT |
| Base | 8453 | ETH | USDC, USDT |
| Arbitrum One | 42161 | ETH | USDC, USDT |
| Avalanche C-Chain | 43114 | AVAX | USDC, USDT |
| Sepolia (testnet) | 11155111 | ETH | USDC |
| Tron mainnet | 728126428 | TRX | USDC, USDT |
| Tron Nile (testnet) | 3448148188 | TRX | USDT |
| Solana mainnet | 900 | SOL | USDC, USDT |
| Solana devnet | 901 | SOL | — |

Notes:
- **Decimals differ.** Most stables are 6 decimals; BNB-chain USDC/USDT are
  18; native gas is 18 for all EVM chains, 6 for TRX (sun), 9 for SOL
  (lamports). Always quote against the per-token `decimals` from
  `/admin/chains` — never assume 6.
- **Universal acceptance via `amountUSD`.** A USD-pegged invoice can be paid
  in **any combination** of registered tokens at the same address. Each
  transfer's USD value is computed at detection time via the rate snapshot
  and summed. e.g. $50 USDC + $50 ETH = $100 invoice → confirmed.
- **Single-token invoices** (`amountRaw + token`) only credit the quoted
  token. Wrong-token transfers at the address still get logged for audit
  but don't satisfy the invoice.
- **Tron native (TRX) detection** routes through TronGrid
  (`/v1/accounts/{addr}/transactions`); Alchemy's Tron RPC has no indexed
  address-history endpoints. Outbound (payouts) works through either
  TronGrid or Alchemy.

## Multi-family invoice acceptance

An invoice can accept payment across multiple chain families. The merchant sets
`acceptedFamilies: ["evm", "tron", "solana"]` (any subset) at creation and the
invoice is allocated one receive address per family:

```bash
curl -X POST "$GATEWAY_URL/api/v1/invoices" \
  -H "Authorization: Bearer $MERCHANT_API_KEY" \
  -d '{
    "chainId": 1,
    "token": "USDT",
    "amountRaw": "1000000",
    "acceptedFamilies": ["evm", "tron", "solana"]
  }'
```

Response:

```json
{
  "invoice": {
    "id": "...",
    "chainId": 1,
    "receiveAddress": "0xABC…",
    "acceptedFamilies": ["evm", "tron", "solana"],
    "receiveAddresses": [
      { "family": "evm",    "address": "0xABC…" },
      { "family": "tron",   "address": "TXy…"  },
      { "family": "solana", "address": "9JxS…" }
    ],
    ...
  }
}
```

Detection matches incoming transfers by `(family, address)` via the
`invoice_receive_addresses` join, so a USDT transfer on **any** of the 7 EVM
chains (Ethereum, Polygon, Base, Arbitrum, OP, Avalanche, BSC) against the
`evm` entry matches this invoice — an EVM pubkey is identical across all EVM
chains. Tron and Solana each get their own canonical address.

Omitting `acceptedFamilies` defaults to `[familyOf(chainId)]` — single-family
invoices keep working without change. Use `amountUSD` instead of
`amountRaw` to make the invoice payable in **any registered token** on the
accepted families (USDC + USDT + native ETH/POL/BNB/AVAX, in any
combination). See "Supported tokens" above for the per-chain symbol list.

## Address pool

Incoming-payment addresses aren't HD-derived per-invoice anymore — they come
from a **shared family-scoped pool** that's pre-derived, pre-registered with
Alchemy, and reused across invoices. Pool rules:

- **One pool per family** (`evm` / `tron` / `solana`). EVM pubkeys are identical
  across all 7 EVM chains we support, so one pool row covers an entire family.
- **Reuse**. When an invoice reaches a terminal state (confirmed / expired /
  canceled) its pool row returns to `available` and serves the next invoice.
  This is what makes small-amount payments on expensive chains viable — 100
  invoices share one sweep tx instead of paying gas to sweep 100 dust addresses.
- **Auto-refill**. Allocation triggers a background refill when available
  count drops below threshold. Operators don't normally interact with the
  pool after initial seeding.
- **Fair rotation**. Allocation picks the row with the lowest
  `total_allocations` first, so reuse spreads evenly rather than pounding
  one address while others sit idle.

### Seed the pool

Run once per deployment:

```bash
curl -X POST "$GATEWAY_URL/admin/pool/initialize" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"families": ["evm", "tron", "solana"], "initialSize": 5}'
```

Families whose chain adapter isn't wired on the gateway are reported as
`skipped-no-adapter` (e.g., Solana absent without `ALCHEMY_API_KEY` or
`SOLANA_RPC_URL`). Idempotent: re-running only tops up families below
`initialSize`.

### Check utilization

```bash
curl "$GATEWAY_URL/admin/pool/stats" -H "Authorization: Bearer $ADMIN_KEY"
# { "stats": [
#   { "family": "evm", "available": 3, "allocated": 2, "total": 5, ... },
#   ...
# ]}
```

Alert on `available < 3` per family to catch low-supply before
`POOL_EXHAUSTED` (503) fires on a live invoice-create.

### Address subscription lifecycle (automatic)

When `ALCHEMY_NOTIFY_TOKEN` is set, the gateway tracks which of your HD-derived
receive addresses should be registered with Alchemy's webhooks — no manual
calls to the management API.

Event-driven enqueue (via the in-process event bus):

| Domain event         | Enqueued op                            |
| -------------------- | -------------------------------------- |
| `invoice.created`    | `add` row for `(chainId, receiveAddress)` |
| `invoice.confirmed`  | `remove` row (frees a slot toward Alchemy's 50k-per-webhook cap) |
| `invoice.expired`    | `remove` row                           |
| `invoice.canceled`   | `remove` row                           |

Rows land in `alchemy_address_subscriptions` with `status='pending'`. The
minute-cadence `scheduledJobs` cron invokes the sweep:

1. Claims all pending rows eligible for an attempt (never attempted OR last
   attempt was > `retryBackoffMs` ago — default 5 min).
2. Groups by `chain_id`; looks up the webhook for each chain from
   `alchemy_webhook_registry`.
3. Issues **one** `PATCH /update-webhook-addresses` per chain batching every
   pending add + remove for that chain.
4. Marks each row `synced` on success, or bumps `attempts` + stores
   `last_error` on failure. After `maxAttempts` failures (default 10) the
   row flips to `failed` — it stops retrying, and operators can inspect it
   via direct DB query (`SELECT * FROM alchemy_address_subscriptions WHERE status = 'failed'`).

Chains Alchemy doesn't serve (dev 999, Tron, Solana) are silently skipped at
enqueue time — their invoices never produce subscription rows. Chains with
pending rows but no webhook bootstrapped yet are reported as
`skipped-no-webhook` in the sweep result and are NOT counted toward
`attempts` — bootstrap + next sweep resolves them.

Improvements over v1's equivalent flow (studied before this was built):
- **Bounded retries** — v1 retried forever; we cap at 10 so a permanently
  malformed address doesn't look identical to an Alchemy outage.
- **Automatic deregistration on terminal invoice states** — v1 let addresses
  accumulate toward the 50k-per-webhook cap and required manual cleanup;
  we enqueue `remove` on `invoice.confirmed | expired | canceled`.
- **Per-chain signing keys in the DB** — v1 shared one env var across every
  chain; that approach could never serve multi-chain correctly. We persist
  per-(chainId, webhookId) rows in `alchemy_webhook_registry`, encrypted via
  `SECRETS_ENCRYPTION_KEY`. Compromise of one key doesn't spoof the others,
  and rotation is a DB upsert.

### Push detection is wired by default

Every entrypoint now registers `alchemyNotifyDetection()` as the
`"alchemy-notify"` push strategy unconditionally. Push + pull can coexist;
duplicate detection of the same tx hits the ingest's idempotency gate and
silently drops the second one.

## Authentication

- **Merchant API** (`/api/v1/*`): `Authorization: Bearer sk_…` (or `X-API-Key`).
  Keys are hashed (SHA-256) at rest; plaintext is returned **once** at merchant
  creation via `POST /admin/merchants` and is unrecoverable afterward.
- **Admin** (`/admin/*`): `Authorization: Bearer <ADMIN_KEY>` (or `X-Admin-Key`).
  Returns `404` when `ADMIN_KEY` is unset so operators can tell "not enabled"
  from "bad key".
- **Alchemy ingest** (`/webhooks/alchemy`): HMAC-SHA256 of raw body in
  `X-Alchemy-Signature`. Constant-time comparison; blanket `401` on failure.
- **Cron trigger** (`/internal/cron/tick`): `Authorization: Bearer <CRON_SECRET>`.
- **Outbound webhooks to merchants**: HMAC-SHA256 in `X-Webhook-Signature`;
  `X-Webhook-Idempotency-Key` stable across retries. Each `POST /api/v1/invoices`
  and `POST /api/v1/payouts` accepts an optional `webhookUrl` + `webhookSecret`
  pair — when set, that resource's events dispatch to the per-resource URL/secret
  instead of the merchant-account default. Precedence at dispatch time is
  `resource → merchant → skip`. The URL is echoed in API responses; the secret
  is encrypted at rest and never returned. Both must be supplied together (one
  without the other is a 400) — mismatched URL/secret would silently break HMAC
  verification on the merchant side.

## Outbound webhook events

Every event below is delivered as `POST {webhookUrl}` with body
`{ event, timestamp, data }`, signed by `X-Webhook-Signature`
(HMAC-SHA256 of the raw body), and carries an `X-Webhook-Idempotency-Key`
that is stable across retries — merchants should de-dup on it.

URL/secret resolution per event: **per-resource override → merchant default
→ silently skipped** (a `warn` log fires when no destination is configured
so operators can grep `"webhook event skipped — no target resolved"`).

### Invoice lifecycle (one row per status transition)

| Event                | Fires when                                                                                  | Idempotency key shape                              |
| -------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `invoice.partial`    | First confirmed payment lands but USD total is still under `amountUsd × (1 − underBps)`     | `invoice.partial:{invoiceId}:partial`              |
| `invoice.detected`   | A pending transfer covers the required amount (legacy single-token path)                    | `invoice.detected:{invoiceId}:detected`            |
| `invoice.confirmed`  | USD total clears the under-tolerance threshold                                              | `invoice.confirmed:{invoiceId}:confirmed`          |
| `invoice.overpaid`   | USD total exceeds `amountUsd × (1 + overBps)`                                               | `invoice.overpaid:{invoiceId}:overpaid`            |
| `invoice.expired`    | `expiresAt` elapses (cron sweeper) or `POST /invoices/{id}/expire` is called                | `invoice.expired:{invoiceId}:expired`              |
| `invoice.canceled`   | Merchant cancels via API                                                                    | `invoice.canceled:{invoiceId}:canceled`            |
| `invoice.demoted`    | Reorg un-confirms a previously-confirmed invoice; carries `previousStatus` + pool-recapture counts | `invoice.demoted:{invoiceId}:{prev}:{new}`  |

### Per-transfer audit (one row per on-chain tx, per stage)

These give merchants deep visibility into partial-payment scenarios — every
incoming transfer surfaces twice (once when first observed, once when
confirmed), with `confirmations` and a `payment` block alongside the invoice
snapshot.

| Event                         | Fires when                                                          | Idempotency key shape                                        |
| ----------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| `invoice.transfer_detected`   | First sighting of a pending transfer (push or poll). `data.payment.confirmations` will be `0` for push-detected, `n` for poll-detected | `invoice.transfer_detected:{invoiceId}:{txHash}` |
| `invoice.payment_received`    | Same transfer reaches the configured confirmation threshold          | `invoice.payment_received:{invoiceId}:{txHash}`              |

The event type is part of the idempotency key — a transfer that's first
detected and later confirmed produces TWO distinct webhook rows (not a
collision), so merchants can show "transfer pending" and "transfer
confirmed" UI states separately. For a partial payment scenario, expect
N pairs of `transfer_detected` + `payment_received` plus one or more
`invoice.partial` and finally `invoice.confirmed` once the USD total
crosses the threshold.

### Payout lifecycle

| Event              | Fires when                                                          | Idempotency key shape                  |
| ------------------ | ------------------------------------------------------------------- | -------------------------------------- |
| `payout.submitted` | Signed tx broadcasted; `txHash` populated                            | `payout.submitted:{payoutId}:submitted` |
| `payout.confirmed` | Broadcasted tx reached confirmation threshold                       | `payout.confirmed:{payoutId}:confirmed` |
| `payout.failed`    | Broadcast or confirmation failed terminally; `lastError` populated  | `payout.failed:{payoutId}:failed`      |

### Retry schedule

Each delivery is attempted up to **5 outer rounds** with exponential
backoff, and each round makes up to **4 inline HTTP attempts** (so up to
20 raw POSTs before a row is marked `dead`). Dead deliveries land in the
operator queue at `GET /admin/webhook-deliveries?status=dead` and can be
manually replayed via `POST /admin/webhook-deliveries/{id}/replay` once
the merchant endpoint is healthy again.

## Payouts

Outbound transfers. Every payout goes through `reserved → [topping-up →] submitted → confirmed` (or `→ failed` / `→ canceled`). `POST /api/v1/payouts` runs source selection synchronously inside an `BEGIN IMMEDIATE` transaction and returns **201 with `status: "reserved"`** — the source is picked, reservations are written, and the merchant has immediate go/no-go. Execution (broadcast + confirmations) happens in cron-driven background ticks.

(The `planned` status is a vestigial enum value for backward-compat migrations; no row is ever inserted in that state.)

### Latency expectations

`POST /api/v1/payouts` now includes an RPC call (chain gas estimate), per-HD-source ledger reads, and a writer-lock-serialized transaction. Typical latency is 100–300ms, P99 can reach ~1.5s under writer contention or slow chain RPC. Set client timeouts ≥5s; retry on 503 with exponential backoff starting at 1s.

### Amount inputs (pick exactly one)

```
amountRaw: "1000000"      // uint256 smallest units (1 USDC = "1000000")
amount:    "1.5"          // human decimal, converted against token.decimals
amountUSD: "10.00"        // fiat-pegged via price oracle; rate snapshotted on the row
```

### Source selection (HD pool + optional fee wallet)

Every HD-derived address in `address_pool` is a candidate payout source — the picker treats pool addresses (allocated to invoices or not), historical receivers, anything HD-derivable. Selection is ledger-derived (no RPC in the hot path):

```
spendable(chainId, address, token)
  = sum(transactions confirmed inbound to address)
  − sum(payouts confirmed outbound from address)
  − sum(active payout_reservations for address)
```

`selectSource` runs two tiers:

1. **Direct** — pick the richest HD address (by token balance) that ALSO has enough native for gas. Reservation rows debit token + gas atomically; concurrent payouts can share a source as long as cumulative debit fits.
2. **JIT gas top-up** — when a token holder lacks native, find a separate sponsor with enough native to top it up. Broadcast sponsor → source first, wait for it to confirm (status `topping-up`), then broadcast the main payout. The sponsor's debit is captured by an internal `gas_top_up` sibling payout row (hidden from merchant `/payouts` lists).

Native payouts can't be topped up (gas IS the asset). When the only candidate has balance ≈ amount but not enough headroom for gas, the API returns `MAX_AMOUNT_EXCEEDS_NET_SPENDABLE` (400) with `details` carrying three presentations of the suggested amount so the dashboard can render "send X − gas instead?" without re-computing:

```json
{
  "error": {
    "code": "MAX_AMOUNT_EXCEEDS_NET_SPENDABLE",
    "message": "Requested 1600000000000000 BNB ... Try 0.00159895 BNB or less.",
    "details": {
      "suggestedAmountRaw": "1598950000000000",
      "suggestedAmount": "0.00159895",
      "suggestedAmountUsd": "0.99"
    }
  }
}
```

`suggestedAmountUsd` is best-effort — `null` when the price oracle is out; the raw + decimal forms are always present.

### Fee tiers

`POST /api/v1/payouts/estimate` quotes **low / medium / high** before the operator commits AND previews the source the executor will pick (including any required top-up). The same `feeTier` field on `POST /api/v1/payouts` binds the chosen tier at broadcast time.

| Chain | Tier semantics | `tieringSupported` |
|---|---|---|
| EVM | priority-fee multipliers on viem's `estimateFeesPerGas` (0.8× / 1.0× / 1.5×), binds `maxFeePerGas` + `maxPriorityFeePerGas` | `true` on EIP-1559 chains, `false` on legacy |
| Solana | 25th / 50th / 75th percentile of recent `getRecentPrioritizationFees`, binds a `ComputeBudget` `setComputeUnitPrice` instruction | `true` when samples available, `false` on fallback |
| Tron | flat (no priority concept) | `false` |

### `POST /api/v1/payouts/estimate` response shape

```jsonc
{
  "amountRaw": "30",
  "tiers": { /* low/medium/high with nativeAmountRaw + usdAmount */ },
  "source": {
    "address": "0xabc...",
    "derivationIndex": 42,
    "tokenBalance": "100",
    "nativeBalance": "0"
  },
  "topUp": {
    "required": true,
    "sponsor": { "address": "0xdef...", "nativeBalance": "1000000" },
    "amountRaw": "25200"
  },
  "alternatives": [ /* next-best candidates, max 4 */ ],
  "warnings": []
}
```

`source: null` + `warnings: ["no_source_address_has_sufficient_token_balance"]` when no HD address can fund the payout. `topUp.sponsor: null` + `warnings: ["no_gas_sponsor_available"]` when a token holder exists but no funded sponsor — the plan would fail with `NO_GAS_SPONSOR_AVAILABLE`.

### Mass (batch) payouts

`POST /api/v1/payouts/batch` with up to 100 rows:

```json
{
  "payouts": [
    { "chainId": 42161, "token": "USDC", "amount": "1.5", "destinationAddress": "0x1111..." },
    { "chainId": 42161, "token": "USDC", "amount": "2.0", "destinationAddress": "0x2222..." }
  ]
}
```

- Per-row errors DON'T abort the batch — response is HTTP 200 with `results[i].status` per row.
- Every successful row gets the same `batchId` (UUID, returned top-level). Filter later with `GET /api/v1/payouts?batchId=<id>`.
- **Rate limit is proportional**: a 100-row batch costs 100 tokens from the merchant's per-minute quota, not 1.

### Gas-burn ledger debits on failed payouts

When a payout transitions to `failed` with a `txHash` set — meaning the tx actually reached chain before reverting — the chain still charged for gas/energy. EVM takes the full `gasUsed × effectiveGasPrice`, Tron burns `net_fee + energy_fee`, Solana charges the signature fee. Without accounting for this, the DB-tracked spendable stays the same but the on-chain balance drops, and the planner happily picks the same underfunded source again.

`failPayout` handles this by querying the adapter's `getConsumedNativeFee(chainId, txHash)` and inserting a synthetic `payouts` row with:

- `kind='gas_burn'`
- `sourceAddress` = address actually debited on chain
- `token` = native symbol for the chain
- `amountRaw` = consumed fee in native units
- `status='confirmed'` (so `computeSpendable`'s standard debit query picks it up)
- `parentPayoutId` = the failed payout
- `txHash` = the failed payout's txHash

`gas_burn` rows are hidden from merchant-facing `/payouts` lists (same filter as `gas_top_up`). They're visible to admin via the list-all query if you pass `includeKinds`, and via `SELECT * FROM payouts WHERE kind='gas_burn'` for debugging.

Gracefully degraded: if the RPC can't locate the tx receipt yet (just-broadcast, still in mempool), the debit is deferred and logged as `payout.gas_burn.deferred`. The current implementation doesn't auto-retry — a follow-up sweeper for these is worth considering if you see them accumulate in logs.

### Pool derivation audit

`GET /admin/pool/audit` walks every `address_pool` row and re-derives the expected address from `MASTER_SEED` + the row's `address_index` using the same adapter that populated the pool. Mismatches mean the gateway can't sign for the row's stored address — either the seed has rotated since the pool was populated, or the row was inserted by some external tool.

```bash
curl $GATEWAY/admin/pool/audit -H "Authorization: Bearer $ADMIN_KEY" | jq .
```

Response:
```json
{
  "status": "healthy",
  "scanLimit": 500,
  "reports": [
    { "family": "evm", "scanned": 14, "matches": 14, "mismatches": [], "unscannedBeyondLimit": 0 },
    { "family": "tron", "scanned": 4, "matches": 4, "mismatches": [], "unscannedBeyondLimit": 0 },
    { "family": "solana", "scanned": 5, "matches": 5, "mismatches": [], "unscannedBeyondLimit": 0 }
  ]
}
```

When mismatches exist, the per-family report lists every broken row with its `storedAddress` vs `expectedAddress`. **This is the tool to run before funding a new pool**, after any deploy where `MASTER_SEED` might have changed, or after a "signer-mismatch" error from a failed payout. Read-only; no state mutation.

In a Cloudflare Workers deployment there's no boot sequence to hook a "startup audit" into — this endpoint is the operator-triggered equivalent. Couple with a periodic cron (e.g. once-a-day call from an external scheduler) for a light background safety net.

### Stuck-reservation watchdog

`sweepStuckPayoutReservations` (cron-driven) does two things: releases any active reservation whose owning payout is already in a terminal state (defense-in-depth — atomic batches in `confirmPayouts`/`failPayout` make this normally a no-op), and logs WARN for reservations older than 30 minutes whose payout is still in flight (operator triage signal).

### Payout error codes

| Code | Status | Meaning |
|---|---|---|
| `MERCHANT_NOT_FOUND` | 404 | API key didn't resolve to a merchant |
| `MERCHANT_INACTIVE` | 403 | Merchant was deactivated |
| `TOKEN_NOT_SUPPORTED` | 400 | `(chainId, token)` not in `TOKEN_REGISTRY` |
| `INVALID_DESTINATION` | 400 | Address validation failed OR per-payout `webhookUrl` pointed at loopback/metadata (SSRF guard) |
| `BAD_AMOUNT` | 400 | `amount` had more decimal places than `token.decimals` |
| `ORACLE_FAILED` | 503 | Price oracle outage during `amountUSD` conversion |
| `INVALID_FEE_TIER` | 400 | `feeTier` outside the `low`/`medium`/`high` enum |
| `FEE_ESTIMATE_FAILED` | 503 | Chain adapter's `quoteFeeTiers` threw (RPC outage) |
| `BATCH_TOO_LARGE` | 400 | Batch > 100 rows |
| `MAX_AMOUNT_EXCEEDS_NET_SPENDABLE` | 400 | Native payout requested ≈ source balance with no gas headroom. `details` carries `suggestedAmountRaw` (uint256), `suggestedAmount` (decimal), and `suggestedAmountUsd` (best-effort, may be `null`). |
| `INSUFFICIENT_BALANCE_ANY_SOURCE` | 503 | Pool addresses exist on the chain but none have enough token (and, where applicable, gas). Operator tops up an HD address |
| `NO_GAS_SPONSOR_AVAILABLE` | 503 | Token holder exists but no other HD address has enough native to top it up. Operator funds a sponsor |
| `TOP_UP_BROADCAST_FAILED` | 503 | Sponsor → source top-up tx failed at broadcast. `lastError` carries the chain RPC's reason verbatim (scrubbed for RPC URLs + foreign addresses) — typically "insufficient funds", "nonce too low", etc. |
| `TOP_UP_REVERTED` | 500 | Top-up tx broadcast but reverted on-chain. Same passthrough: `lastError` carries the chain's revert reason. |
| `SOURCE_BROADCAST_FAILED` | 500 | Main payout broadcast failed. `lastError` carries the chain's reason — check `/admin/balances?live=true` first (usually ledger/chain drift). |
| `PAYOUT_NOT_FOUND` | 404 | `POST /payouts/:id/cancel` (or cross-merchant access). Surfaced as 404 rather than 403 to avoid leaking payout ids |
| `PAYOUT_NOT_CANCELABLE` | 409 | `POST /payouts/:id/cancel` — the payout already broadcast on-chain. Once in `topping-up` / `submitted` / terminal status, the gateway can't recall it |

Retry hints: 503 codes are transient — retry with exponential backoff starting at 1s. 400/404/409 are not retryable; fix the request or operator state first.

## Fee wallets (optional gas offloader)

Pool addresses natively hold tokens AND pay their own gas — that's the default and it always works. But it also means every pool address has to be kept funded in the chain's native coin, and on Tron + Solana that's operationally wasteful: Tron lets a staked wallet delegate energy to any address, and Solana has an explicit `feePayer` field in its tx format. A "fee wallet" is one designated address per family whose job is to cover gas for everyone else, letting pool addresses sit at zero native balance.

The feature is **entirely opt-in per family**. No configuration = current self-pay behavior, identical to before.

### Per-chain capability

| Family | Capability | What the fee wallet does |
|---|---|---|
| **EVM** | `none` | EIP-1559 has no feePayer separation; the existing sponsor-topup flow remains the gas strategy. Operators can register an EVM fee wallet anyway (for API symmetry), but the planner ignores it until account-abstraction lands on every chain we serve. |
| **Tron** | `delegate` | Fee wallet stakes TRX (`FreezeBalanceV2`) and pre-delegates energy to pool addresses (`DelegateResource`). At payout time the tx is a single-signer transfer from the pool address — the chain substitutes delegated energy for TRX burn. One-time setup, no per-tx cost. |
| **Solana** | `co-sign` | Fee wallet signs every payout as the tx's `feePayer` (accountKeys[0]). Pool address only signs as the SPL transfer authority. Fee wallet pays the signature fee AND the recipient-ATA rent (2,039,280 lamports for new ATAs). Source's SOL is untouched. |

The adapter reports its capability via `ChainAdapter.feeWalletCapability(chainId)`. The planner gates on that + `fee_wallets` row presence; if either is missing, the self-pay / sponsor-topup path still runs.

### Two registration modes

The `fee_wallets` table allows two ways to say "this address is the fee wallet for this family":

| Mode | When to use | Key storage |
|---|---|---|
| `hd-pool` | Default recommendation. The fee wallet is an existing HD pool address — no new secret to manage, same `MASTER_SEED` derivation path pool payouts already use. Verified at registration time to exist in `address_pool`. | No stored key. Signer derives on demand. |
| `imported` | You have an external wallet (common for Tron operators — the staked-TRX unfreeze cooldown is 14 days, so re-staking a fresh address is costly). | Private key encrypted at rest via `secretsCipher` (AES-256-GCM, same primitive as webhook HMAC secrets). Plaintext is only in memory during the encrypt call and each decrypt-to-sign call, then the buffer is zeroed. |

Exactly one row per family is allowed; `DELETE` then re-`POST` to swap.

### Admin surface (all require ADMIN_KEY)

CRUD:

```
GET    /admin/fee-wallets                        # list per-family state
POST   /admin/fee-wallets/{family}/use-pool      # register existing pool address
POST   /admin/fee-wallets/{family}/import        # register external key (encrypted)
DELETE /admin/fee-wallets/{family}               # unregister (self-pay resumes)
```

Tron-only resource ops (wrap Stake 2.0 primitives, signed with the fee wallet's key):

```
GET    /admin/fee-wallets/tron/resources         # energy + bandwidth snapshot
POST   /admin/fee-wallets/tron/freeze            # stake TRX for resource
POST   /admin/fee-wallets/tron/unfreeze          # begin 14-day unlock
POST   /admin/fee-wallets/tron/delegate          # lend staked resource to address
POST   /admin/fee-wallets/tron/undelegate        # reclaim
```

Solana has no equivalent management surface — registration alone is enough; the fee wallet's SOL balance is its only ongoing consideration. Top it up when it runs low; the balance is visible via `GET /admin/balances?family=solana&live=true`.

### Setup: Solana

1. Pick an address. Either use an existing well-funded pool address or import an external key.
   ```bash
   # Option A: use a pool address (recommended)
   curl -X POST $GATEWAY/admin/fee-wallets/solana/use-pool \
     -H "Authorization: Bearer $ADMIN_KEY" \
     -d '{"address":"<base58 pool address>"}'

   # Option B: import external
   curl -X POST $GATEWAY/admin/fee-wallets/solana/import \
     -H "Authorization: Bearer $ADMIN_KEY" \
     -d '{"privateKey":"<32-byte ed25519 seed hex>","address":"<base58>"}'
   ```
2. Fund it with SOL. Cover rent-exempt (0.00089 SOL) + enough for expected ATA creations (~0.00204 SOL each) + signature fees. For a workload of 100 payouts/day where half create new ATAs, ~0.1 SOL covers a week comfortably.
3. Done. The next payout plan auto-routes USDC/USDT payouts through the co-sign path; pool addresses' SOL balances stop mattering.

### Setup: Tron

1. Register the fee wallet (same as Solana step 1).
2. Fund the fee wallet with TRX externally.
3. Stake TRX for ENERGY (~10,000 energy per 100 TRX staked at current network rates — query [tronscan](https://tronscan.org/#/data/stats3/resources) to check today's rate):
   ```bash
   curl -X POST $GATEWAY/admin/fee-wallets/tron/freeze \
     -H "Authorization: Bearer $ADMIN_KEY" \
     -d '{"balance":10000000000,"resource":"ENERGY"}'   # 10,000 TRX
   ```
4. Delegate energy to each pool address you want to pay from:
   ```bash
   for addr in $(psql -c "SELECT address FROM address_pool WHERE family='tron'"); do
     curl -X POST $GATEWAY/admin/fee-wallets/tron/delegate \
       -H "Authorization: Bearer $ADMIN_KEY" \
       -d '{"receiver":"'$addr'","balance":200000000,"resource":"ENERGY"}'   # 200 TRX/addr
   done
   ```
5. Verify: `GET /admin/fee-wallets/tron/resources` should show a sizable `energyLimit` consumed as delegations-out. A pool address's own `getaccountresource` will show matching delegations-in.

Typical USDT transfer energy on Tron ≈ 32 000 units; 200 TRX staked → ~20 000 energy/day → ~2/3 of a daily USDT transfer free per address. Scale as needed.

### Teardown

Always **undelegate before unfreeze** on Tron — the chain rejects unstaking that would leave active delegations unfunded:

```bash
# per delegated address:
curl -X POST $GATEWAY/admin/fee-wallets/tron/undelegate \
  -d '{"receiver":"<addr>","balance":200000000,"resource":"ENERGY"}'

# then unstake:
curl -X POST $GATEWAY/admin/fee-wallets/tron/unfreeze \
  -d '{"balance":10000000000,"resource":"ENERGY"}'

# 14 days later, the TRX is withdrawable via tronweb withdrawExpireUnfreeze (not currently wrapped — use TronLink/TronScan manually)

# unregister:
curl -X DELETE $GATEWAY/admin/fee-wallets/tron
```

Deleting a fee wallet row WITHOUT undelegating/unfreezing strands the TRX on-chain — it still belongs to the fee wallet, but neither the gateway nor the dashboard tracks it anymore. Always teardown in order.

### Planner behavior summary

| Condition | Source's native-gas requirement |
|---|---|
| No fee wallet registered | Source must hold `gas × 1.5 safety + minNativeReserve` (rent-exempt on Solana, 0 elsewhere). Unchanged from before. |
| Fee wallet registered, `capability='none'` (EVM today) | Unchanged — planner ignores the registration. |
| Fee wallet registered, `capability='co-sign'` (Solana, token payouts) | Source needs only `minNativeReserve` (rent-exempt). Fee wallet covers sig fee + ATA rent. |
| Fee wallet registered, `capability='delegate'` (Tron, token payouts) | Source needs only `minNativeReserve` (0 on Tron). Delegated energy covers the TRC-20 execution cost. |
| Any fee wallet + native payout | Source STILL needs the full amount + gas + reserve — native payouts can't co-sign the value itself away. |

## Payment tolerance (slippage)

Real-world rate jitter, exchange spreads, and dust rounding mean the USD value
of a payment rarely lands exactly on the invoice target. The gateway lets each
merchant configure a two-sided tolerance band, expressed in basis points
(1 bp = 0.01 %, capped at 2000 bps = 20 %):

| Knob                       | Status logic                                                          | Example (1 % = 100 bps)                                |
| -------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| `paymentToleranceUnderBps` | `paid_usd ≥ amount_usd × (1 − bps/10_000)` → **confirmed**            | invoice 100 USD, paid 99 USD → confirmed (not partial) |
| `paymentToleranceOverBps`  | `paid_usd ≤ amount_usd × (1 + bps/10_000)` → **confirmed** (not over) | invoice 100 USD, paid 101 USD → confirmed (not overpaid) |

Defaults: `0 / 0` (strict — every cent matters; matches pre-tolerance behavior).

Configuration:

- **Per-merchant default**: set `paymentToleranceUnderBps` / `paymentToleranceOverBps`
  in the body of `POST /admin/merchants`, or update later via
  `PATCH /admin/merchants/:id`.
- **Per-invoice override**: pass either field on `POST /api/v1/invoices` to
  override the merchant default for that one invoice. The effective values are
  snapshotted onto the invoice row at create time, so a later change to the
  merchant default does **not** retroactively reshape already-issued invoices.

`overpaidUsd` always carries the **raw** delta (`paid_usd − amount_usd`),
regardless of where the over-tolerance threshold sits. This keeps merchant
accounting honest: a 1 % over-tolerance closes the invoice as `confirmed`,
but the books still see the 1 USD overshoot if you want to surface it.

Tradeoffs to flag in your merchant settings UI:

- A nonzero **under-tolerance** creates an accounting gap (invoice closes for
  the full amount; cashflow is short by the slippage).
- A nonzero **over-tolerance** suppresses the `invoice.overpaid` webhook for
  payments inside the band — they fire `invoice.confirmed` instead.

## API reference

Full spec: [`openapi.yaml`](openapi.yaml). Import into Postman, Bruno, or Insomnia
for an interactive client.

A full-coverage Postman setup lives in [`postman/`](postman/):

- [`crypto-gateway.postman_collection.json`](postman/crypto-gateway.postman_collection.json)
  — every route (admin bootstrap, merchant API, public checkout, Alchemy
  webhook ingest simulator, internal cron) grouped into folders. Per-chain
  quick-start requests under `Invoices / Quick starts` for Ethereum, OP,
  Polygon, Base, Arbitrum, Avalanche, BSC, Tron, Solana, and the local dev
  chain. Chained flow: the merchant-create test script writes `apiKey`,
  `merchantId`, `webhookSecret` into the environment; create-invoice writes
  `invoiceId` + `invoiceReceiveAddress`; bootstrap writes per-chain signing keys.
- [`crypto-gateway.local.postman_environment.json`](postman/crypto-gateway.local.postman_environment.json)
  — import as an environment. Pre-declares every variable the collection
  reads and writes. Only `adminKey` needs to be filled by hand; everything
  else populates as you run the setup folder.

The `Webhooks (simulate)` folder fires synthetic Alchemy payloads (both EVM
and Solana SPL shapes) at `/webhooks/alchemy` with a correct HMAC — useful
for replaying the detection path locally without waiting for a real on-chain
transfer.

## Database migrations

For creating a fresh Turso DB and applying the initial schema, see
[First-time Turso setup](#first-time-turso-setup). This section covers
ongoing schema changes after the DB exists.

Drizzle Kit owns migrations. The schema is the source-of-truth
([`src/db/schema.ts`](src/db/schema.ts)); `drizzle-kit generate` diffs the
schema against the last applied state and emits a new SQL file plus a
`_journal.json` entry under [`drizzle/migrations/`](drizzle/migrations/).
Drizzle's `migrate()` tracks applied files in the
`__drizzle_migrations` table, so re-running is idempotent.

| Runtime            | Applied how                                                                 |
| ------------------ | --------------------------------------------------------------------------- |
| Node               | At boot via `migrate(db, { migrationsFolder })` in `node.ts`.              |
| Deno               | At boot, same call in `deno.ts` — Deno reads the same `drizzle/migrations/` folder via `node:fs`. |
| Cloudflare Workers | CLI-side via `TURSO_URL=… TURSO_AUTH_TOKEN=… npx drizzle-kit push` (Workers has no FS at runtime, so the in-process migrator can't run). Re-run after every new migration. |
| Vercel Edge        | Same CLI-side `drizzle-kit push` against the remote Turso DB — Edge runtime also has no FS. |

The `/admin/migrate` endpoint re-applies `drizzle/migrations/` on Node / Deno
deployments (the `migrationsFolder` field of `AppDeps` is populated by those
entrypoints). On Workers / Vercel-Edge the field is absent and the endpoint
returns 501 — `drizzle-kit push` is the canonical applier there.

Adding a new migration:

```bash
# 1) edit src/db/schema.ts
# 2) generate the migration file + journal entry
npx drizzle-kit generate
# 3) review drizzle/migrations/NNNN_<name>.sql
# 4) apply locally (Node/Deno boot will apply on next restart)
#    or push to remote Turso for Workers/Vercel:
TURSO_URL="libsql://..." TURSO_AUTH_TOKEN="..." npx drizzle-kit push
```

### Pre-prod convention: editing `0000_initial.sql` in place

This project is still pre-prod and treats `0000_initial.sql` as a single
ever-evolving baseline rather than appending `0001_*.sql`, `0002_*.sql`, …
That keeps the schema readable in one file, but **Drizzle's migrator hashes the
journal `tag` ("0000_initial"), not the SQL contents** — so a database that
already journaled `0000_initial` against an older snapshot will keep the older
schema and silently skip re-applying the edited file. The Node entrypoint
guards against this by asserting that tables removed from the application
schema (currently: `fee_wallets`) are NOT present in the live DB, and refuses
to boot with `Schema drift detected: …` if they are.

**Cutover runbook:** after editing `0000_initial.sql`, drop the local DB file
(or create a fresh Turso DB) before restarting. Turso has no first-class
"drop database" UI yet — easiest path is `turso db destroy <name>` then
`turso db create <name>` and re-bootstrap. Once the project goes prod, switch
to the additive `0001_*.sql` flow above and remove the in-place edits.

## Development

```bash
npm run typecheck  # both tsconfigs (root + core-strict)
npm run lint       # ESLint (portability rules + TS hygiene)
npm test           # vitest (unit + integration)
```

Tests run in-memory (libSQL `:memory:`, memory cache, promise-set jobs,
capturing webhook dispatcher) so the whole suite completes in under two
seconds.

## Adding a new chain family

The architecture is validated by the Solana adapter (Phase 7 of the build):
adding a family required **zero edits** to `src/core/domain/**` or
`src/http/routes/**`. Checklist:

1. Create `src/adapters/chains/<family>/<family>-chain.adapter.ts` implementing
   the `ChainAdapter` port.
2. Add family-specific helpers in the same folder (address encoding, RPC
   client, message serialization, HD derivation).
3. Add tokens in [`src/core/types/token-registry.ts`](src/core/types/token-registry.ts).
4. Register the adapter in each entrypoint's `chains:` array (one-line each).
5. Write unit tests under `src/__tests__/unit/chains/<family>/`.

If any step forces you to edit `core/domain/**` or `http/routes/**`, the
abstraction leaked — stop and rethink.

## Contributing

- Keep `core/**` free of platform imports. The tsconfig + ESLint layers will
  catch leaks; they exist to enforce the rule, not to be worked around.
- Prefer **zod schemas as source of truth** and derive types via
  `z.infer<typeof Schema>`. Schema drift is a whole class of bug we don't want.
- Domain errors extend `DomainError` with a specific `code` and the route's
  `handleError` middleware handles the mapping — routes don't encode status
  codes inline.
- One domain event per state transition. Webhook composition + audit logging
  hang off the event bus so the state machine stays linear.

## License

TBD — pending OSS release decision.
