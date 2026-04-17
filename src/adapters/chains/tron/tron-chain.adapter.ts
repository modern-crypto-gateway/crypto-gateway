import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { ChainAdapter } from "../../../core/ports/chain.port.ts";
import type { Address, ChainId, TxHash } from "../../../core/types/chain.js";
import type { AmountRaw } from "../../../core/types/money.js";
import type { TokenSymbol } from "../../../core/types/token.js";
import { findToken } from "../../../core/types/token-registry.js";
import type { DetectedTransfer } from "../../../core/types/transaction.js";
import type { BuildTransferArgs, EstimateArgs, UnsignedTx } from "../../../core/types/unsigned-tx.js";
import { bytesToHex } from "../../crypto/subtle.js";
import {
  decodeTronAddress,
  isValidTronAddress,
  privateKeyToTronAddress,
  tronToEvmCoreHex
} from "./tron-address.js";
import {
  tronGridBackend,
  type TronGridBackendConfig,
  type TronRpcBackend
} from "./tron-rpc.js";

// Known Tron chain ids. Values match what Tron's own tooling reports in the
// genesis block timestamp heuristic; we just use them as identifiers.
export const TRON_MAINNET_CHAIN_ID = 728126428;
export const TRON_NILE_CHAIN_ID = 3448148188;

const DEFAULT_FEE_LIMIT_SUN = 100_000_000; // 100 TRX cap per payout tx (generous, rarely consumed)
// Hard energy cap for TRC-20 `transfer(address,uint256)`. Standard SRC-20
// transfers use 14k-65k energy; 150k leaves headroom for cold-slot writes
// and first-time recipient state. If the simulation reports more than this,
// the target is almost certainly NOT a standard TRC-20 (proxy, fee-on-transfer,
// or worse — a loop contract that would burn the full fee_limit). Refusing
// to broadcast turns a silent fee burn into a loud build-time error.
const MAX_EXPECTED_TRANSFER_ENERGY = 150_000;
const DEFAULT_ACCOUNT_INDEX = 0;
const DEFAULT_CHANGE_INDEX = 0;

export interface TronChainConfig {
  // Which chainIds this adapter serves. Defaults to Tron mainnet only.
  chainIds?: readonly number[];
  // Per-chain TronGrid configuration. Shortcut for the common single-backend
  // case — entries here build a `tronGridBackend` automatically. Ignored for
  // any chainId where `clients` already has an entry (which takes precedence
  // so operators can supply a composite with failover).
  trongrid?: Readonly<Record<number, TronGridBackendConfig>>;
  // Per-chain pre-built RPC clients. Use this (via `tronCompositeClient(...)`)
  // when you want TronGrid + Alchemy Tron failover, or to inject a fake
  // backend in tests and bypass HTTP entirely.
  clients?: Readonly<Record<number, TronRpcBackend>>;
  // BIP44 accountIndex (default 0).
  accountIndex?: number;
  // Cap on the lookback window for `scanIncoming`, ms. Defaults to 6 hours.
  maxScanWindowMs?: number;
  // Fee limit in sun for payout txs. Defaults to 100 TRX.
  feeLimitSun?: number;
}

export function tronChainAdapter(config: TronChainConfig = {}): ChainAdapter {
  const chainIds = (config.chainIds ?? [TRON_MAINNET_CHAIN_ID]) as readonly ChainId[];
  const accountIndex = config.accountIndex ?? DEFAULT_ACCOUNT_INDEX;
  const feeLimit = config.feeLimitSun ?? DEFAULT_FEE_LIMIT_SUN;
  const maxScanWindowMs = config.maxScanWindowMs ?? 6 * 60 * 60 * 1000;

  const clientCache = new Map<number, TronRpcBackend>();
  function getClient(chainId: number): TronRpcBackend {
    const cached = clientCache.get(chainId);
    if (cached) return cached;
    const injected = config.clients?.[chainId];
    if (injected) {
      clientCache.set(chainId, injected);
      return injected;
    }
    const cfg = config.trongrid?.[chainId];
    if (!cfg) {
      throw new Error(`tronChainAdapter: no Tron RPC configuration for chainId ${chainId}`);
    }
    const client = tronGridBackend(cfg);
    clientCache.set(chainId, client);
    return client;
  }

  return {
    family: "tron",
    supportedChainIds: chainIds,

    // ---- Addresses ----

    deriveAddress(seed: string, index: number) {
      // BIP44 path for Tron = m/44'/195'/{account}'/{change}/{index}. Coin type 195.
      const seedBytes = mnemonicToSeedSync(seed);
      const master = HDKey.fromMasterSeed(seedBytes);
      const child = master.derive(`m/44'/195'/${accountIndex}'/${DEFAULT_CHANGE_INDEX}/${index}`);
      if (!child.privateKey) {
        throw new Error(`Tron derivation produced no private key at index ${index}`);
      }
      const privateKeyHex = `0x${bytesToHex(child.privateKey)}`;
      const address = privateKeyToTronAddress(privateKeyHex) as Address;
      return { address, privateKey: privateKeyHex };
    },

    validateAddress(addr: string): boolean {
      return isValidTronAddress(addr);
    },

    canonicalizeAddress(addr: string): Address {
      // Base58 is already case-sensitive and canonical — decoding validates
      // the checksum, and re-encoding is the identity for valid inputs.
      // We reject hex-form addresses here; callers should have base58 in hand.
      if (!isValidTronAddress(addr)) {
        throw new Error(`Invalid Tron address: ${addr}`);
      }
      return addr as Address;
    },

    // ---- Detection ----

    async scanIncoming({ chainId, addresses, tokens, sinceMs }) {
      if (addresses.length === 0) return [];
      const client = getClient(chainId);

      // Clamp sinceMs to within the max window — protects against "rewind to epoch"
      // style calls returning a mountain of data.
      const now = Date.now();
      const minTimestamp = Math.max(sinceMs, now - maxScanWindowMs);

      // Map requested token symbols -> contract addresses for this chain.
      const targets = tokens
        .map((sym) => findToken(chainId as ChainId, sym))
        .filter((t): t is NonNullable<typeof t> => t !== null && t.contractAddress !== null);

      const allowedContracts = new Set(targets.map((t) => t.contractAddress!));
      const addressSet = new Set(addresses.map((a) => a));
      const symbolByContract = new Map(targets.map((t) => [t.contractAddress!, t.symbol]));

      // Fan out: one listTrc20Transfers call per (address x contract). TronGrid
      // doesn't offer a multi-contract filter, so this is the natural shape.
      const calls: Array<Promise<readonly DetectedTransfer[]>> = [];
      for (const addr of addresses) {
        for (const target of targets) {
          calls.push(
            client
              .listTrc20Transfers(addr, {
                minTimestamp,
                contractAddress: target.contractAddress!,
                limit: 200
              })
              .then((transfers) =>
                transfers
                  .filter((t) => t.token_info?.address !== undefined && allowedContracts.has(t.token_info.address))
                  .filter((t) => addressSet.has(t.to))
                  .map<DetectedTransfer>((t) => ({
                    chainId: chainId as ChainId,
                    txHash: t.transaction_id,
                    logIndex: null, // Tron TRC-20 transfers are 1 per tx in the v1 endpoint; no logIndex concept
                    fromAddress: t.from,
                    toAddress: t.to,
                    token: symbolByContract.get(t.token_info.address) ?? target.symbol,
                    amountRaw: t.value as AmountRaw,
                    blockNumber: t.block,
                    // `v1/.../transactions/trc20` doesn't expose a confirmation count directly.
                    // We record what we can see and let the sweeper call `getConfirmationStatus`
                    // for authoritative depth on each tx.
                    confirmations: 0,
                    seenAt: new Date(t.block_timestamp)
                  }))
              )
          );
        }
      }

      const arrays = await Promise.all(calls);
      return arrays.flat();
    },

    async getConfirmationStatus(chainId: ChainId, txHash: TxHash) {
      const client = getClient(chainId);
      const [info, now] = await Promise.all([client.getTransactionInfo(txHash), client.getNowBlock()]);
      const latest = now.block_header.raw_data.number;
      if (!info || info.blockNumber === undefined) {
        return { blockNumber: null, confirmations: 0, reverted: false };
      }
      const receiptResult = info.receipt?.result;
      // Tron's receipt.result is undefined for a typical successful transfer
      // (it's only populated when the VM executed a contract that returned a
      // status). So treat undefined as "not reverted".
      const reverted = receiptResult !== undefined && receiptResult !== "SUCCESS";
      return {
        blockNumber: info.blockNumber,
        confirmations: Math.max(0, latest - info.blockNumber + 1),
        reverted
      };
    },

    // ---- Payouts ----

    async buildTransfer(args: BuildTransferArgs): Promise<UnsignedTx> {
      const token = findToken(args.chainId as ChainId, args.token);
      if (!token) {
        throw new Error(`Tron buildTransfer: unknown token ${args.token} on chain ${args.chainId}`);
      }
      if (token.contractAddress === null) {
        throw new Error("Tron buildTransfer: native TRX transfers not implemented in Phase 3c");
      }
      const client = getClient(args.chainId);

      // ABI-encoded parameter for `transfer(address,uint256)`:
      //   - 32 bytes: zero-padded core address (Tron addresses in calldata are
      //     the 20-byte EVM-equivalent, NOT the 21-byte prefixed form).
      //   - 32 bytes: amount (big-endian uint256)
      const toCoreHex = tronToEvmCoreHex(args.toAddress).slice(2).padStart(64, "0");
      const amountHex = BigInt(args.amountRaw).toString(16).padStart(64, "0");
      const parameter = `${toCoreHex}${amountHex}`;

      const resp = await client.triggerSmartContract({
        owner_address: base58ToHex(args.fromAddress),
        contract_address: base58ToHex(token.contractAddress),
        function_selector: "transfer(address,uint256)",
        parameter,
        fee_limit: feeLimit,
        call_value: 0
      });

      if (resp.result.result !== true) {
        throw new Error(`Tron triggersmartcontract failed: ${resp.result.message ?? "unknown"}`);
      }

      // Energy-consumption guard. The fee_limit is a CEILING, not a quote —
      // without this check, a non-standard transfer() implementation (proxy
      // that loops, fee-on-transfer, malicious contract) could silently burn
      // the full 100 TRX on each payout. Bail loudly at build time instead.
      if (resp.energy_used !== undefined && resp.energy_used > MAX_EXPECTED_TRANSFER_ENERGY) {
        throw new Error(
          `Tron transfer simulation reported ${resp.energy_used} energy (cap=${MAX_EXPECTED_TRANSFER_ENERGY}); ` +
            `refusing to broadcast. Token ${args.token} on chain ${args.chainId} may not be a standard TRC-20.`
        );
      }

      return {
        chainId: args.chainId as ChainId,
        raw: {
          txID: resp.transaction.txID,
          raw_data_hex: resp.transaction.raw_data_hex,
          raw_data: resp.transaction.raw_data,
          fromAddress: args.fromAddress
        },
        summary: `TRON: TRC-20 ${args.token} transfer ${args.amountRaw} to ${args.toAddress}`
      };
    },

    async signAndBroadcast(unsignedTx: UnsignedTx, privateKey: string): Promise<TxHash> {
      const raw = unsignedTx.raw as { txID: string; raw_data_hex: string; raw_data: unknown };
      // Tron signs the sha256 of the raw_data bytes with secp256k1 (canonical
      // `recoveryBit` appended). The txID is already sha256(raw_data_hex) per
      // TronGrid, so we sign that directly.
      const privBytes = hexToBytesLocal(privateKey);
      const txIdBytes = hexToBytesLocal(raw.txID);
      // Noble returns `r || s || recovery` (65 bytes) when format='recovered'.
      // `prehash: false` tells it the message is already a 32-byte digest (Tron's
      // txID IS sha256 of raw_data_hex, so re-hashing would corrupt the signature).
      const sig = secp256k1.sign(txIdBytes, privBytes, { format: "recovered", prehash: false, lowS: true });
      const signatureHex = bytesToHex(sig);

      const client = getClient(unsignedTx.chainId);
      const resp = await client.broadcastTransaction({
        txID: raw.txID,
        raw_data: raw.raw_data,
        raw_data_hex: raw.raw_data_hex,
        signature: [signatureHex]
      });
      if (resp.result !== true) {
        throw new Error(`Tron broadcast failed: ${resp.message ?? resp.code ?? "unknown"}`);
      }
      return (resp.txid ?? raw.txID) as TxHash;
    },

    // ---- Fees ----

    nativeSymbol(_chainId: ChainId): TokenSymbol {
      return "TRX" as TokenSymbol;
    },

    async estimateGasForTransfer(args: EstimateArgs): Promise<AmountRaw> {
      // TronGrid's triggersmartcontract returns `energy_used` for the simulated
      // call. We invoke a dry-run build and read that field. For a simple TRC-20
      // `transfer`, energy is roughly 14k-65k depending on cold/warm slots.
      const token = findToken(args.chainId as ChainId, args.token);
      if (!token || token.contractAddress === null) {
        return "0" as AmountRaw;
      }
      const client = getClient(args.chainId);
      const toCoreHex = tronToEvmCoreHex(args.toAddress).slice(2).padStart(64, "0");
      const amountHex = BigInt(args.amountRaw).toString(16).padStart(64, "0");
      const resp = await client.triggerSmartContract({
        owner_address: base58ToHex(args.fromAddress),
        contract_address: base58ToHex(token.contractAddress),
        function_selector: "transfer(address,uint256)",
        parameter: `${toCoreHex}${amountHex}`,
        fee_limit: feeLimit,
        call_value: 0
      });
      const energy = resp.energy_used ?? 0;
      return energy.toString() as AmountRaw;
    }
  };
}

// ---- Local helpers ----

function base58ToHex(base58Address: string): string {
  const bytes = decodeTronAddress(base58Address);
  return bytesToHex(bytes);
}

function hexToBytesLocal(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

