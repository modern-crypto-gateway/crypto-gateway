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
npx wrangler d1 execute crypto-gateway-dev --file=migrations/schema.sql
npx wrangler kv namespace create CACHE

# Set secrets (not in wrangler.jsonc — they go to Cloudflare's store):
npx wrangler secret put MASTER_SEED                 # BIP39 mnemonic
npx wrangler secret put ADMIN_KEY                   # random 32+ chars
npx wrangler secret put ALCHEMY_NOTIFY_SIGNING_KEY  # optional
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
| `ALCHEMY_NOTIFY_SIGNING_KEY`      | optional        | —          | Enables `POST /webhooks/alchemy`                     |
| `DATABASE_URL`                    | when non-D1     | `file:./local.db` | libSQL URL (Turso or local file)              |
| `DATABASE_TOKEN`                  | Turso only      | —          | libSQL auth token                                    |
| `PORT`                            | no              | `8787`     |                                                      |
| `RATE_LIMIT_MERCHANT_PER_MINUTE`  | no              | `1000`     | Per-merchant cap on `/api/v1/*`                      |
| `RATE_LIMIT_CHECKOUT_PER_MINUTE`  | no              | `60`       | Per-IP cap on `/checkout/*`                          |
| `RATE_LIMIT_WEBHOOK_INGEST_PER_MINUTE` | no         | `300`      | Per-IP cap on `/webhooks/*`                          |

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

Full spec: [`openapi.yaml`](openapi.yaml). Import it into Postman, Bruno, or
Insomnia for an interactive client. A ready-made Postman collection is at
[`postman/crypto-gateway.postman_collection.json`](postman/crypto-gateway.postman_collection.json).

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
