import { asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { alchemyWebhookRegistry } from "../../db/schema.js";

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

function drizzleRowToRegistry(row: typeof alchemyWebhookRegistry.$inferSelect): AlchemyWebhookRegistryRow {
  return {
    chainId: row.chainId,
    webhookId: row.webhookId,
    signingKeyCiphertext: row.signingKeyCiphertext,
    webhookUrl: row.webhookUrl,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt)
  };
}

export function dbAlchemyRegistryStore(db: Db): AlchemyRegistryStore {
  return {
    async findByWebhookId(webhookId) {
      const [row] = await db
        .select()
        .from(alchemyWebhookRegistry)
        .where(eq(alchemyWebhookRegistry.webhookId, webhookId))
        .limit(1);
      return row ? drizzleRowToRegistry(row) : null;
    },

    async findByChainId(chainId) {
      const [row] = await db
        .select()
        .from(alchemyWebhookRegistry)
        .where(eq(alchemyWebhookRegistry.chainId, chainId))
        .limit(1);
      return row ? drizzleRowToRegistry(row) : null;
    },

    async upsert({ chainId, webhookId, signingKeyCiphertext, webhookUrl, now }) {
      await db
        .insert(alchemyWebhookRegistry)
        .values({
          chainId,
          webhookId,
          signingKeyCiphertext,
          webhookUrl,
          createdAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: alchemyWebhookRegistry.chainId,
          set: {
            webhookId,
            signingKeyCiphertext,
            webhookUrl,
            updatedAt: now
          }
        });
    },

    async list() {
      const rows = await db
        .select()
        .from(alchemyWebhookRegistry)
        .orderBy(asc(alchemyWebhookRegistry.chainId));
      return rows.map(drizzleRowToRegistry);
    }
  };
}
