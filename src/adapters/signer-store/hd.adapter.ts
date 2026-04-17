import { sha256 } from "@noble/hashes/sha2.js";
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
//   [0x00000000, 0x3FFFFFFF]  — receive-address pool (monotonic from 0,
//                                managed by pool.service.ts; never hashed).
//   [0x40000000, 0x7EFFFFFF]  — fee-wallet indices (sha256(family,label) mod
//                                range, OR'd with the 0x40000000 bit).
//   [0x7F000000, 0x7FFFFFFF]  — reserved for gateway-singleton scopes
//                                (sweep-master per family).
//
// Collision probability between a fee-wallet label and the pool is zero (the
// top bit of the fee-wallet region is set; the pool never reaches there). Collisions
// within fee wallets are ~100² / 2^31 ≈ 5e-6 for 100 labels — which still
// manifests safely because `fee_wallets` has a UNIQUE(chain_id, address)
// constraint, so a colliding label triggers a loud insert error at register
// time instead of silently sharing a key.

const FEE_WALLET_INDEX_BIT = 0x40000000;
const FEE_WALLET_INDEX_MASK = 0x3EFFFFFF;
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
  // `deriveAddress` so the fee-wallet private-key ↔ address mapping is
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
    // fee-wallet
    const adapter = requireAdapter(scope.family);
    const index = feeWalletIndex(scope.family, scope.label);
    const { privateKey } = adapter.deriveAddress(masterSeed, index);
    return privateKey;
  }

  return {
    async put() {
      // Importing externally-generated keys is intentionally unsupported. Fund
      // the address returned by POST /admin/fee-wallets instead; the gateway
      // derives the matching private key on demand from MASTER_SEED.
      throw new UnsupportedSignerOperationError(
        "hdSignerStore.put: external-key import is not supported. Register fee wallets via POST /admin/fee-wallets and fund the returned derived address."
      );
    },
    async get(scope) {
      return derivePrivateKey(scope);
    },
    async delete() {
      // Keys aren't stored, so there's nothing to delete. "Retiring" a
      // fee-wallet label is a DB concern (set `fee_wallets.active = 0`), not
      // a signer-store concern — the derived key still exists but won't be
      // selected for new payouts.
    },
    async has(scope) {
      if (scope.kind === "receive-hd") return true;
      return adapterByFamily.has(scope.family);
    }
  };
}

// Deterministic fee-wallet index from (family, label). Stable across deploys
// so the same label always derives to the same private key.
export function feeWalletIndex(family: ChainFamily, label: string): number {
  const digest = sha256(new TextEncoder().encode(`fee-wallet:${family}:${label}`));
  // First 4 bytes as a big-endian uint32, masked into the fee-wallet region.
  const raw =
    ((digest[0] ?? 0) << 24) |
    ((digest[1] ?? 0) << 16) |
    ((digest[2] ?? 0) << 8) |
    (digest[3] ?? 0);
  // `>>> 0` coerces to unsigned 32-bit after the OR with a high bit (JS bitwise
  // ops produce signed ints).
  return ((raw & FEE_WALLET_INDEX_MASK) | FEE_WALLET_INDEX_BIT) >>> 0;
}
