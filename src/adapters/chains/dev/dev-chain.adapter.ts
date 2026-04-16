import type { ChainAdapter } from "../../../core/ports/chain.port.ts";
import type { Address, ChainId, TxHash } from "../../../core/types/chain.js";
import type { AmountRaw } from "../../../core/types/money.js";
import type { TokenSymbol } from "../../../core/types/token.js";
import type { DetectedTransfer } from "../../../core/types/transaction.js";
import type { BuildTransferArgs, EstimateArgs, UnsignedTx } from "../../../core/types/unsigned-tx.js";
import { bytesToHex } from "../../crypto/subtle.js";

export interface DevChainConfig {
  // Which chainIds this adapter claims to serve. Defaults to [999] (the dev chain id).
  chainIds?: readonly number[];
  // Optional override: if present, `scanIncoming` returns these transfers verbatim.
  // Used by tests to simulate detection without a real provider.
  incomingTransfers?: readonly DetectedTransfer[];
  // If true, `signAndBroadcast` returns a deterministic hash derived from inputs
  // instead of a random one (useful for snapshot tests).
  deterministicTxHashes?: boolean;
  // Per-txHash override for `getConfirmationStatus`. Tests populate this to
  // drive the confirmation sweeper through specific states (confirmed/reverted).
  confirmationStatuses?: ReadonlyMap<string, { blockNumber: number | null; confirmations: number; reverted: boolean }>;
  // Default status returned by `getConfirmationStatus` when a tx hash is not
  // in `confirmationStatuses`. Defaults to { null, 0, false }.
  defaultConfirmationStatus?: { blockNumber: number | null; confirmations: number; reverted: boolean };
}

// Dev / loopback chain adapter. Deterministic HD-like derivation via HMAC-SHA256
// so the same (seed, index) always produces the same address, but makes no claim
// to real-chain key material. Phase 3 introduces the real EVM adapter and this
// can stay around for local dev + tests without a network.

export function devChainAdapter(config: DevChainConfig = {}): ChainAdapter {
  const chainIds = (config.chainIds ?? [999]) as readonly ChainId[];
  const incoming = config.incomingTransfers ?? [];

  return {
    family: "evm",
    supportedChainIds: chainIds,

    deriveAddress(seed: string, index: number) {
      // HMAC-SHA256(seed, "dev-chain/{index}") -> 32 bytes.
      // Address: first 20 bytes hex-encoded with 0x prefix (EVM-looking).
      // Private key: full 32 bytes hex-encoded with 0x prefix.
      // NOTE: This is NOT a real key pair — the "address" is not derived from
      // the "private key" the way secp256k1 would do it. Phase 3 replaces this.
      const keyMaterial = hmacSha256Sync(seed, `dev-chain/${index}`);
      const addressBytes = keyMaterial.slice(0, 20);
      const privateKey = `0x${bytesToHex(keyMaterial)}`;
      const address = `0x${bytesToHex(addressBytes)}` as Address;
      return { address, privateKey };
    },

    validateAddress(addr: string): boolean {
      return /^0x[0-9a-fA-F]{40}$/.test(addr);
    },

    canonicalizeAddress(addr: string): Address {
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
        throw new Error(`Invalid dev-chain address: ${addr}`);
      }
      // Lowercase form is canonical for the dev adapter (no EIP-55 checksumming here;
      // the real EVM adapter in Phase 3 will checksum properly).
      return addr.toLowerCase() as Address;
    },

    async scanIncoming() {
      return incoming;
    },

    async getConfirmationStatus(_chainId: ChainId, txHash: TxHash) {
      const override = config.confirmationStatuses?.get(txHash);
      if (override) return override;
      return config.defaultConfirmationStatus ?? { blockNumber: null, confirmations: 0, reverted: false };
    },

    async buildTransfer(args: BuildTransferArgs): Promise<UnsignedTx> {
      return {
        chainId: args.chainId,
        raw: { ...args, _dev: true },
        summary: `dev: transfer ${args.amountRaw} ${args.token} from ${args.fromAddress} to ${args.toAddress}`
      };
    },

    async signAndBroadcast(unsignedTx: UnsignedTx, _privateKey: string): Promise<TxHash> {
      if (config.deterministicTxHashes === true) {
        const digest = hmacSha256Sync("dev-tx", JSON.stringify(unsignedTx.raw));
        return `0x${bytesToHex(digest)}` as TxHash;
      }
      const rand = new Uint8Array(32);
      globalThis.crypto.getRandomValues(rand);
      return `0x${bytesToHex(rand)}` as TxHash;
    },

    nativeSymbol(_chainId: ChainId): TokenSymbol {
      return "DEV" as TokenSymbol;
    },

    async estimateGasForTransfer(_args: EstimateArgs): Promise<AmountRaw> {
      return "21000" as AmountRaw;
    }
  };
}

// Sync HMAC-SHA256. deriveAddress needs to be sync per the ChainAdapter contract,
// but WebCrypto's HMAC API is async. We use a tiny sync implementation so the
// dev adapter doesn't need to leak async through deriveAddress — the real EVM
// adapter in Phase 3 will use ethers' secp256k1 which is also sync.
function hmacSha256Sync(key: string, message: string): Uint8Array {
  // For the dev adapter only: a simple deterministic pseudo-HMAC that mixes
  // key and message into a 32-byte output via iterated SHA-256.
  // Crypto correctness is not required — we just need determinism and uniqueness
  // across (seed, index) pairs in tests.
  const bytes = new Uint8Array(32);
  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(key);
  const msgBytes = encoder.encode(message);
  let acc = 0x9e3779b97f4a7c15n;
  for (let i = 0; i < 32; i++) {
    const kByte = keyBytes[i % keyBytes.length] ?? 0;
    const mByte = msgBytes[i % msgBytes.length] ?? 0;
    acc = BigInt.asUintN(64, acc * 1103515245n + BigInt(kByte ^ mByte) + BigInt(i));
    bytes[i] = Number(acc & 0xffn);
  }
  return bytes;
}

