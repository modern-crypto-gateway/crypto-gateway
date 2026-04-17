# crypto-gateway

Runtime-agnostic crypto payment gateway. One codebase, four deployment targets:
**Cloudflare Workers**, **Node / Bun**, **Deno / Deno Deploy**, **Vercel Edge**.

Chains, storage, detection, pricing, and webhook delivery are all pluggable via
explicit port interfaces — adding a new EVM chain is a one-line entry in the
token registry; adding a whole new family (Solana, Bitcoin, …) is one adapter
file with no edits to core domain logic or HTTP routes.

Status: pre-1.0. Feature-complete for the primary payment flow (detect → confirm
→ webhook → payout). Production hardening items (fee-wallet balance pre-checks,
reorg recovery, Durable Objects–backed rate limiting) are tracked as known
follow-ups.

---

## Architecture at a glance

- **core/** — pure domain. Zero platform imports. Port interfaces + services.
- **adapters/** — concrete implementations per platform/provider (D1, libSQL,
  CF-KV, memory cache, wait-until, promise-set, viem-based EVM, TronGrid, Solana
  SLIP-0010, Alchemy Notify, inline-fetch webhook dispatcher, console logger, …).
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
`DATABASE_URL=libsql://…` + `DATABASE_TOKEN=…` for Turso).

A dev merchant is auto-seeded in non-production (`NODE_ENV != production`) with
id `00000000-0000-0000-0000-000000000001`. Its API key hash has no known
preimage, so create a real merchant via `POST /admin/merchants` before using
the merchant API.

## Quick start — Cloudflare Workers

```bash
cp wrangler.jsonc.example wrangler.jsonc
# Create bindings + paste the ids into wrangler.jsonc:
npx wrangler d1 create crypto-gateway-dev
# Apply every SQL file in migrations/ in order against REMOTE D1 (the one
# your deployed worker will read). Without --remote, wrangler writes to the
# local .wrangler sandbox only — fine for `wrangler dev`, invisible to prod.
for f in migrations/*.sql; do npx wrangler d1 execute crypto-gateway-dev --remote --file="$f"; done
npx wrangler kv namespace create CACHE

# Set secrets (not in wrangler.jsonc — they go to Cloudflare's store):
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
| `MASTER_SEED`                     | **prod only**   | —          | BIP39 mnemonic. Rejects the literal `dev-seed` in prod |
| `ADMIN_KEY`                       | **prod only**   | —          | ≥32 chars required in prod                           |
| `CRON_SECRET`                     | optional        | —          | Enables `POST /internal/cron/tick`                   |
| `ALCHEMY_API_KEY`                 | optional        | —          | Auto-wires a real EVM chain adapter + RPC-poll detection across the default mainnet set (ETH, OP, Polygon, Base, Arbitrum). See below. |
| `ALCHEMY_CHAINS`                  | optional        | —          | Comma-separated chainIds to enable via Alchemy (e.g. `1,137`). Defaults to the mainnet set. |
| `ALCHEMY_NOTIFY_TOKEN`            | required for webhook bootstrap | — | **NOT the same as `ALCHEMY_API_KEY`.** Webhook-management ("Notify") token at the top of [`dashboard.alchemy.com/apps/latest/webhooks`](https://dashboard.alchemy.com/apps/latest/webhooks) → "Auth Token". The JSON-RPC API key will return 401 from this endpoint; they look similar but are distinct strings. Old name `ALCHEMY_AUTH_TOKEN` still works for one release cycle with a deprecation warning. |
| `GATEWAY_PUBLIC_URL`              | required for webhook bootstrap | — | Public origin of this gateway (e.g. `https://gateway.example.com`). Bootstrap appends per-provider paths like `/webhooks/alchemy`. Env-only to prevent ADMIN_KEY-leak redirect attacks. |
| `DATABASE_URL`                    | when non-D1     | `file:./local.db` | libSQL URL (Turso or local file)              |
| `DATABASE_TOKEN`                  | Turso only      | —          | libSQL auth token                                    |
| `PORT`                            | no              | `8787`     |                                                      |
| `RATE_LIMIT_MERCHANT_PER_MINUTE`  | no              | `1000`     | Per-merchant cap on `/api/v1/*`                      |
| `RATE_LIMIT_CHECKOUT_PER_MINUTE`  | no              | `60`       | Per-IP cap on `/checkout/*`                          |
| `RATE_LIMIT_WEBHOOK_INGEST_PER_MINUTE` | no         | `300`      | Per-IP cap on `/webhooks/*`                          |

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

## Multi-family order acceptance

An order can accept payment across multiple chain families. The merchant sets
`acceptedFamilies: ["evm", "tron", "solana"]` (any subset) at creation and the
order is allocated one receive address per family:

```bash
curl -X POST "$GATEWAY_URL/api/v1/orders" \
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
  "order": {
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
`order_receive_addresses` join, so a USDT transfer on **any** of the 7 EVM
chains (Ethereum, Polygon, Base, Arbitrum, OP, Avalanche, BSC) against the
`evm` entry matches this order — an EVM pubkey is identical across all EVM
chains. Tron and Solana each get their own canonical address.

Omitting `acceptedFamilies` defaults to `[familyOf(chainId)]` — single-family
orders keep working without change. In A1.b, the **token** is still scoped
per-chain; A2 introduces USD-pegged amounts and any-token acceptance within
a family (e.g. pay $100 in USDC, USDT, or native ETH on any EVM chain).

## Address pool

Incoming-payment addresses aren't HD-derived per-order anymore — they come
from a **shared family-scoped pool** that's pre-derived, pre-registered with
Alchemy, and reused across orders. Pool rules:

- **One pool per family** (`evm` / `tron` / `solana`). EVM pubkeys are identical
  across all 7 EVM chains we support, so one pool row covers an entire family.
- **Reuse**. When an order reaches a terminal state (confirmed / expired /
  canceled) its pool row returns to `available` and serves the next order.
  This is what makes small-amount payments on expensive chains viable — 100
  orders share one sweep tx instead of paying gas to sweep 100 dust addresses.
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
`POOL_EXHAUSTED` (503) fires on a live order-create.

### Address subscription lifecycle (automatic)

When `ALCHEMY_NOTIFY_TOKEN` is set, the gateway tracks which of your HD-derived
receive addresses should be registered with Alchemy's webhooks — no manual
calls to the management API.

Event-driven enqueue (via the in-process event bus):

| Domain event      | Enqueued op                            |
| ----------------- | -------------------------------------- |
| `order.created`   | `add` row for `(chainId, receiveAddress)` |
| `order.confirmed` | `remove` row (frees a slot toward Alchemy's 50k-per-webhook cap) |
| `order.expired`   | `remove` row                           |
| `order.canceled`  | `remove` row                           |

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
enqueue time — their orders never produce subscription rows. Chains with
pending rows but no webhook bootstrapped yet are reported as
`skipped-no-webhook` in the sweep result and are NOT counted toward
`attempts` — bootstrap + next sweep resolves them.

Improvements over v1's equivalent flow (studied before this was built):
- **Bounded retries** — v1 retried forever; we cap at 10 so a permanently
  malformed address doesn't look identical to an Alchemy outage.
- **Automatic deregistration on terminal order states** — v1 let addresses
  accumulate toward the 50k-per-webhook cap and required manual cleanup;
  we enqueue `remove` on `order.confirmed | expired | canceled`.
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
  `X-Webhook-Idempotency-Key` stable across retries.

## API reference

Full spec: [`openapi.yaml`](openapi.yaml). Import into Postman, Bruno, or Insomnia
for an interactive client.

A full-coverage Postman setup lives in [`postman/`](postman/):

- [`crypto-gateway.postman_collection.json`](postman/crypto-gateway.postman_collection.json)
  — every route (admin bootstrap, merchant API, public checkout, Alchemy
  webhook ingest simulator, internal cron) grouped into folders. Per-chain
  quick-start requests under `Orders / Quick starts` for Ethereum, OP,
  Polygon, Base, Arbitrum, Avalanche, BSC, Tron, Solana, and the local dev
  chain. Chained flow: the merchant-create test script writes `apiKey`,
  `merchantId`, `webhookSecret` into the environment; create-order writes
  `orderId` + `orderReceiveAddress`; bootstrap writes per-chain signing keys.
- [`crypto-gateway.local.postman_environment.json`](postman/crypto-gateway.local.postman_environment.json)
  — import as an environment. Pre-declares every variable the collection
  reads and writes. Only `adminKey` needs to be filled by hand; everything
  else populates as you run the setup folder.

The `Webhooks (simulate)` folder fires synthetic Alchemy payloads (both EVM
and Solana SPL shapes) at `/webhooks/alchemy` with a correct HMAC — useful
for replaying the detection path locally without waiting for a real on-chain
transfer.

## Database migrations

Migrations live as sortable SQL files in [`migrations/`](migrations/) (e.g.
`0001_initial.sql`). A `schema_migrations` tracking table records which files
have been applied, so re-running is idempotent and only adds new files.

| Runtime        | Applied how                                                               |
| -------------- | ------------------------------------------------------------------------- |
| Node           | At boot by `applyMigrations(db, loadMigrationsFromDir(…))` in `node.ts`. |
| Deno           | At boot, same call in `deno.ts`. Deno supports `node:fs` + `node:url`.    |
| Cloudflare Workers | CLI-side via wrangler (Workers have no FS at runtime). Run `for f in migrations/*.sql; do npx wrangler d1 execute <db> --remote --file="$f"; done` once per new migration. Add `--remote` or you're writing to the local `.wrangler` sandbox, NOT the D1 your deployed worker reads. |
| Vercel Edge    | CLI-side against the Turso libSQL endpoint (Edge runtime also has no FS). Point a Node environment at `DATABASE_URL` + `DATABASE_TOKEN` and call `applyMigrations` from a small script, or run each file via the Turso CLI. |

Adding a new migration: drop a new `NNNN_description.sql` file into
`migrations/`. Must be **strictly numerically newer** than all predecessors
(filename sort is lexicographic), and must be idempotent — D1 and libSQL
cannot wrap DDL in a rollback, so we only mark the tracking row written
after the SQL succeeds, meaning a failed partial run can retry.

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
