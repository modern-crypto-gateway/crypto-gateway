import type { DbAdapter } from "../../core/ports/db.port.js";

// Per-chain Alchemy webhook registry. Persists the { chainId, webhookId,
// signingKeyCiphertext, webhookUrl } tuple so the inbound /webhooks/alchemy
// route can resolve the right HMAC key from the payload's `webhookId` — no
// shared env var spoofable across chains.
//
// The store is a pure DB-row shuttle — encrypting the signing key on write
// and decrypting on read is the caller's responsibility (via
// `deps.secretsCipher`). This keeps the store free of crypto dependencies
// and makes the encrypted-at-rest boundary explicit at every call site.
//
// Not a port. Alchemy-specific storage; if/when we add Helius, it'll get its
// own registry with a different shape (Solana webhooks have different
// metadata). Pluggable vs SQL is not a valuable axis here.

export interface AlchemyWebhookRegistryRow {
  chainId: number;
  webhookId: string;
  // Ciphertext as stored — caller must decrypt via `SecretsCipher.decrypt`
  // before using as an HMAC key.
  signingKeyCiphertext: string;
  webhookUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertArgs {
  chainId: number;
  webhookId: string;
  // Already-encrypted ciphertext. Callers (bootstrap, sync-sweep) must have
  // passed the plaintext through `SecretsCipher.encrypt` before calling.
  signingKeyCiphertext: string;
  webhookUrl: string;
  now: number;
}

export interface AlchemyRegistryStore {
  findByWebhookId(webhookId: string): Promise<AlchemyWebhookRegistryRow | null>;
  findByChainId(chainId: number): Promise<AlchemyWebhookRegistryRow | null>;
  // Upsert keyed by chainId — one webhook per chain in this deployment.
  // Overwrites signing_key_ciphertext on re-create, so a
  // delete+recreate-in-dashboard flow from the operator is recoverable via
  // bootstrap.
  upsert(args: UpsertArgs): Promise<void>;
  list(): Promise<readonly AlchemyWebhookRegistryRow[]>;
}

interface Row {
  chain_id: number;
  webhook_id: string;
  signing_key_ciphertext: string;
  webhook_url: string;
  created_at: number;
  updated_at: number;
}

function rowToRegistry(row: Row): AlchemyWebhookRegistryRow {
  return {
    chainId: row.chain_id,
    webhookId: row.webhook_id,
    signingKeyCiphertext: row.signing_key_ciphertext,
    webhookUrl: row.webhook_url,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

export function dbAlchemyRegistryStore(db: DbAdapter): AlchemyRegistryStore {
  return {
    async findByWebhookId(webhookId) {
      const row = await db
        .prepare("SELECT * FROM alchemy_webhook_registry WHERE webhook_id = ?")
        .bind(webhookId)
        .first<Row>();
      return row === null ? null : rowToRegistry(row);
    },

    async findByChainId(chainId) {
      const row = await db
        .prepare("SELECT * FROM alchemy_webhook_registry WHERE chain_id = ?")
        .bind(chainId)
        .first<Row>();
      return row === null ? null : rowToRegistry(row);
    },

    async upsert({ chainId, webhookId, signingKeyCiphertext, webhookUrl, now }) {
      await db
        .prepare(
          `INSERT INTO alchemy_webhook_registry
             (chain_id, webhook_id, signing_key_ciphertext, webhook_url, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(chain_id) DO UPDATE
             SET webhook_id = excluded.webhook_id,
                 signing_key_ciphertext = excluded.signing_key_ciphertext,
                 webhook_url = excluded.webhook_url,
                 updated_at = excluded.updated_at`
        )
        .bind(chainId, webhookId, signingKeyCiphertext, webhookUrl, now, now)
        .run();
    },

    async list() {
      const result = await db
        .prepare("SELECT * FROM alchemy_webhook_registry ORDER BY chain_id ASC")
        .all<Row>();
      return result.results.map(rowToRegistry);
    }
  };
}
