import type { ChainAdapter } from "../../core/ports/chain.port.ts";
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
}

export function hdSignerStore(opts: HdSignerStoreOptions): SignerStore {
  const { masterSeed, chains } = opts;

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

  function derivePrivateKey(scope: SignerScope): string {
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
      return derivePrivateKey(scope);
    },
    async delete() {
      // Keys aren't stored, so there's nothing to delete.
    },
    async has(scope) {
      if (scope.kind === "receive-hd") return true;
      return adapterByFamily.has(scope.family);
    }
  };
}
