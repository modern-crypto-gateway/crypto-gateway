import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { feeWallets } from "../../db/schema.js";
import type { SecretsCipher } from "../../core/ports/secrets-cipher.port.ts";
import type {
  FeeWalletRecord,
  FeeWalletRecordWithSecret,
  FeeWalletStore,
  PutFeeWalletInput
} from "../../core/ports/fee-wallet-store.port.ts";
import type { ChainFamily } from "../../core/types/chain.js";

// libSQL-backed FeeWalletStore.
//
// Imported-mode private keys are encrypted at the `put` boundary and
// decrypted at the `getWithSecret` boundary. Plaintext key material never
// touches an INSERT / UPDATE statement and never appears in a row returned
// by `get`. Callers that need to sign use `getWithSecret` + cipher.decrypt,
// then zero out the plaintext buffer as soon as the sign call returns.

interface FeeWalletStoreOptions {
  readonly db: Db;
  readonly secretsCipher: SecretsCipher;
  readonly clock: { now(): Date };
}

export function dbFeeWalletStore(opts: FeeWalletStoreOptions): FeeWalletStore {
  const { db, secretsCipher, clock } = opts;

  async function rowFor(family: ChainFamily): Promise<{
    id: string;
    family: ChainFamily;
    mode: "hd-pool" | "imported";
    address: string;
    privateKeyCiphertext: string | null;
  } | null> {
    const [row] = await db
      .select()
      .from(feeWallets)
      .where(eq(feeWallets.family, family))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      family: row.family,
      mode: row.mode,
      address: row.address,
      privateKeyCiphertext: row.privateKeyCiphertext ?? null
    };
  }

  return {
    async get(family): Promise<FeeWalletRecord | null> {
      const row = await rowFor(family);
      if (!row) return null;
      return { family: row.family, mode: row.mode, address: row.address };
    },

    async getWithSecret(family): Promise<FeeWalletRecordWithSecret> {
      const row = await rowFor(family);
      if (!row) {
        throw new Error(`FeeWalletStore.getWithSecret: no fee wallet for family='${family}'`);
      }
      return {
        family: row.family,
        mode: row.mode,
        address: row.address,
        privateKeyCiphertext: row.privateKeyCiphertext
      };
    },

    async has(family): Promise<boolean> {
      const row = await rowFor(family);
      return row !== null;
    },

    async put(input: PutFeeWalletInput): Promise<FeeWalletRecord> {
      const now = clock.now().getTime();
      // Encrypt at the boundary. For imported mode we normalize the hex
      // input (drop optional 0x prefix, lowercase) so the stored value is
      // canonical regardless of how the operator typed it in — matches what
      // the signer stores / derives internally.
      let ciphertext: string | null = null;
      if (input.mode === "imported") {
        const normalized = input.privateKey.replace(/^0x/i, "").toLowerCase();
        if (!/^[0-9a-f]+$/.test(normalized) || normalized.length < 32) {
          throw new Error("FeeWalletStore.put: privateKey must be hex (got non-hex or too short)");
        }
        ciphertext = await secretsCipher.encrypt(normalized);
      }

      // Upsert by family. SQLite's INSERT ... ON CONFLICT(family) DO UPDATE
      // gives us a single-round-trip swap without needing an explicit DELETE
      // first. Updating updates_at lets ops see when a wallet was re-registered.
      const id = globalThis.crypto.randomUUID();
      await db
        .insert(feeWallets)
        .values({
          id,
          family: input.family,
          mode: input.mode,
          address: input.address,
          privateKeyCiphertext: ciphertext,
          createdAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: feeWallets.family,
          set: {
            mode: input.mode,
            address: input.address,
            privateKeyCiphertext: ciphertext,
            updatedAt: now
          }
        });

      return {
        family: input.family,
        mode: input.mode,
        address: input.address
      };
    },

    async remove(family): Promise<boolean> {
      const result = await db
        .delete(feeWallets)
        .where(eq(feeWallets.family, family))
        .returning({ id: feeWallets.id });
      return result.length > 0;
    }
  };
}
