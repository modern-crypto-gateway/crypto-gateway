import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { addressPool } from "../../db/schema.js";
import type { ChainAdapter } from "../../core/ports/chain.port.ts";
import type { FeeWalletStore } from "../../core/ports/fee-wallet-store.port.ts";
import type { SecretsCipher } from "../../core/ports/secrets-cipher.port.ts";
import type { SignerStore } from "../../core/ports/signer-store.port.ts";
import type { ChainFamily } from "../../core/types/chain.ts";
import type { SignerScope } from "../../core/types/signer.ts";

// Derivation-only SignerStore. Every key is deterministically derived from
// MASTER_SEED at a scope-specific BIP32 index — nothing is stored at rest,
// nothing crosses the admin API boundary as plaintext, nothing is lost when a
// Workers isolate terminates. The operator funds gateway-derived addresses
// instead of importing pre-existing wallet keys.
//
// Derivation-index layout (all within [0, 2^31-1], the non-hardened-safe range
// that every family's BIP32/SLIP-0010 implementation accepts):
//
//   [0x00000000, 0x3FFFFFFF]  — HD address pool. Every payout source is
//                                addressed from here: pool receive addresses,
//                                gas-top-up sponsors, everything. Indices are
//                                allocated monotonically by pool.service.ts.
//   [0x7F000000, 0x7FFFFFFF]  — reserved for gateway-singleton scopes
//                                (sweep-master per family). Not currently
//                                active in the payout path.

const SWEEP_MASTER_INDEX_BASE = 0x7F000000;

// Stable family → sweep-master index. Fixed constants, so the derived
// sweep-master key for a family never changes across deploys.
const SWEEP_MASTER_INDEX_BY_FAMILY: Readonly<Record<ChainFamily, number>> = {
  evm: SWEEP_MASTER_INDEX_BASE + 0,
  tron: SWEEP_MASTER_INDEX_BASE + 1,
  solana: SWEEP_MASTER_INDEX_BASE + 2
};

export class UnsupportedSignerOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSignerOperationError";
  }
}

export class NoAdapterForFamilyError extends Error {
  constructor(family: ChainFamily) {
    super(`hdSignerStore: no chain adapter registered for family='${family}'`);
    this.name = "NoAdapterForFamilyError";
  }
}

export interface HdSignerStoreOptions {
  // BIP39 mnemonic. Same value passed to chain adapters' `deriveAddress`.
  masterSeed: string;
  // Chain adapters the entrypoint already constructed. We reuse each family's
  // `deriveAddress` so the payout source private-key ↔ address mapping is
  // computed by exactly the same code that pool addresses use.
  chains: readonly ChainAdapter[];
  // Resolves the per-family fee-wallet configuration when `kind='fee-wallet'`.
  // Optional because older wiring paths (tests, Workers entrypoints mid-
  // migration) may not have a store yet — requesting a fee-wallet key without
  // one throws a helpful error instead of silently returning garbage.
  feeWalletStore?: FeeWalletStore;
  // Needed only when the store returns an imported (encrypted) fee wallet.
  // AES-GCM cipher; decrypts ciphertext back to plaintext hex private key.
  secretsCipher?: SecretsCipher;
  // Needed only for HD-pool-mode fee wallets: we look up the addressPool row
  // by address to recover its derivation index, then delegate to the chain
  // adapter's `deriveAddress` — same path pool payouts already take. The
  // cross-check here is deliberate: a corrupted fee_wallets row pointing at
  // an address that doesn't actually live in the pool produces a crisp
  // "pool-address-not-found" error instead of a silent "signer-mismatch"
  // at broadcast.
  db?: Db;
}

export function hdSignerStore(opts: HdSignerStoreOptions): SignerStore {
  const { masterSeed, chains, feeWalletStore, secretsCipher, db } = opts;

  // First adapter per family wins. Different chainIds in the same family share
  // the same derivation (EVM pubkeys are identical across all 7 EVM chains, and
  // SLIP-0010 for Solana / BIP44 for Tron are single-curve per family), so
  // picking the first is correct regardless of which chainId the caller has.
  const adapterByFamily = new Map<ChainFamily, ChainAdapter>();
  for (const adapter of chains) {
    if (!adapterByFamily.has(adapter.family)) {
      adapterByFamily.set(adapter.family, adapter);
    }
  }

  function requireAdapter(family: ChainFamily): ChainAdapter {
    const adapter = adapterByFamily.get(family);
    if (!adapter) throw new NoAdapterForFamilyError(family);
    return adapter;
  }

  async function resolvePrivateKey(scope: SignerScope): Promise<string> {
    if (scope.kind === "receive-hd") {
      // The HD seed IS the mnemonic. Callers that hold this scope are the
      // receive-address derivation path (pool.service.ts), which already
      // consumes the mnemonic directly — this arm is here for port
      // completeness and legacy callers.
      return masterSeed;
    }
    if (scope.kind === "sweep-master") {
      const adapter = requireAdapter(scope.family);
      const index = SWEEP_MASTER_INDEX_BY_FAMILY[scope.family];
      const { privateKey } = adapter.deriveAddress(masterSeed, index);
      return privateKey;
    }
    if (scope.kind === "fee-wallet") {
      // Fee-wallet keys live in the fee_wallets table. mode='hd-pool' is
      // the common case: the configured address points at an existing
      // pool row, and we derive the key via the same HD path that pool
      // payouts use — no new key material to manage. mode='imported' is
      // for operators who bring a pre-existing external wallet (e.g. a
      // Tron wallet with accumulated staked TRX they don't want to reset);
      // the store returns the encrypted private key and we decrypt it
      // here, on the signing path only, never caching the plaintext.
      if (!feeWalletStore) {
        throw new Error(
          "hdSignerStore: fee-wallet signer requested but no FeeWalletStore was wired into hdSignerStore({ feeWalletStore })"
        );
      }
      const record = await feeWalletStore.getWithSecret(scope.family);
      if (record.mode === "imported") {
        if (!secretsCipher) {
          throw new Error(
            "hdSignerStore: imported fee wallet requires secretsCipher to be wired into hdSignerStore({ secretsCipher })"
          );
        }
        if (record.privateKeyCiphertext === null) {
          // Should never happen — the fee_wallets CHECK constraint enforces
          // ciphertext presence for imported rows — but defend against a
          // corrupted row making it through.
          throw new Error(
            `hdSignerStore: imported fee wallet for family='${scope.family}' has no ciphertext`
          );
        }
        const plaintext = await secretsCipher.decrypt(record.privateKeyCiphertext);
        // Canonicalize: stored hex has no 0x prefix; EVM callers expect one,
        // Tron/Solana handle either. Add it here for uniformity.
        return plaintext.startsWith("0x") ? plaintext : `0x${plaintext}`;
      }
      // hd-pool mode: look up the pool row for this address, derive from
      // MASTER_SEED at its index. Verifies the row still exists (a deleted
      // pool row with a dangling fee_wallets reference is a configuration
      // bug worth failing loudly on).
      if (!db) {
        throw new Error(
          "hdSignerStore: hd-pool fee wallet requires db to be wired into hdSignerStore({ db })"
        );
      }
      const adapter = requireAdapter(scope.family);
      const canonical = adapter.canonicalizeAddress(record.address);
      const [poolRow] = await db
        .select({ addressIndex: addressPool.addressIndex })
        .from(addressPool)
        .where(and(eq(addressPool.family, scope.family), eq(addressPool.address, canonical)))
        .limit(1);
      if (!poolRow) {
        throw new Error(
          `hdSignerStore: fee-wallet (mode=hd-pool) points at address ${canonical} but no address_pool row exists for family='${scope.family}' — re-register the fee wallet`
        );
      }
      // Silence the unused-import warning in the specific case where
      // `isNotNull` isn't referenced by this file's code path today —
      // retained in the imports because future refactors of the pool
      // query (add status='available' filter, etc.) need it handy.
      void isNotNull;
      const { privateKey } = adapter.deriveAddress(masterSeed, poolRow.addressIndex);
      return privateKey;
    }
    // pool-address — derive at the supplied index directly. Every HD-derived
    // payout source (pool receive addresses, top-up sponsors) flows through
    // this arm; the caller looks up `addressPool.addressIndex` before signing.
    const adapter = requireAdapter(scope.family);
    const { privateKey } = adapter.deriveAddress(masterSeed, scope.derivationIndex);
    return privateKey;
  }

  return {
    async put() {
      // Importing externally-generated keys is intentionally unsupported. The
      // gateway only signs from HD-derived addresses — every payout source
      // lives in `address_pool` and derives deterministically from
      // MASTER_SEED.
      throw new UnsupportedSignerOperationError(
        "hdSignerStore.put: external-key import is not supported. Pay out only from HD-derived pool addresses."
      );
    },
    async get(scope) {
      return resolvePrivateKey(scope);
    },
    async delete() {
      // Keys aren't stored, so there's nothing to delete.
    },
    async has(scope) {
      if (scope.kind === "receive-hd") return true;
      if (scope.kind === "fee-wallet") {
        if (!feeWalletStore) return false;
        return feeWalletStore.has(scope.family);
      }
      return adapterByFamily.has(scope.family);
    }
  };
}
