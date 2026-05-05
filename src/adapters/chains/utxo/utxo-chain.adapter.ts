import { HDKey } from "@scure/bip32";
import { cachedMnemonicToSeed } from "../../crypto/mnemonic-cache.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { ChainAdapter, FeeTierQuote } from "../../../core/ports/chain.port.js";
import type { Address, ChainId, TxHash } from "../../../core/types/chain.js";
import type { AmountRaw } from "../../../core/types/money.js";
import type { TokenSymbol } from "../../../core/types/token.js";
import { findToken } from "../../../core/types/token-registry.js";
import type { DetectedTransfer } from "../../../core/types/transaction.js";
import type { BuildTransferArgs, EstimateArgs, UnsignedTx } from "../../../core/types/unsigned-tx.js";
import { bytesToHex } from "../../crypto/subtle.js";
import {
  encodeP2wpkhAddress,
  hash160
} from "./bech32-address.js";
import {
  isValidDestinationAddress,
  decodeUtxoDestination
} from "./destination-script.js";
import {
  esploraClient,
  EsploraNotFoundError,
  type EsploraBackend,
  type EsploraClient,
  type EsploraTx
} from "./esplora-rpc.js";
import {
  signSegwitTx,
  type InputSigningKey,
  type UnsignedSegwitTx
} from "./utxo-sign.js";
import type { UtxoInput, UtxoOutput } from "./utxo-tx-encode.js";
import {
  BITCOIN_CONFIG,
  BITCOIN_TESTNET_CONFIG,
  LITECOIN_CONFIG,
  LITECOIN_TESTNET_CONFIG,
  utxoConfigForChainId,
  type UtxoChainConfig
} from "./utxo-config.js";

// Single ChainAdapter implementation for the entire UTXO family. Bitcoin and
// Litecoin differ only in BIP44 coin_type, bech32 HRP, and detection-backend
// URLs — all carried by `UtxoChainConfig`. One adapter, two registered chains.
//
// Phase 1 scope: address derivation + canonicalization. Detection and payout
// methods are stubbed (throw) and filled in Phase 2 (Esplora + BlockCypher) and
// Phase 3 (coin selection + signing + broadcast).

const DEFAULT_ACCOUNT_INDEX = 0;
const DEFAULT_CHANGE_INDEX = 0;

export interface UtxoChainAdapterConfig {
  // Which UTXO chain this instance serves. One adapter handles both BTC and
  // LTC by being instantiated once per chain (deps.chains gets two entries
  // wired in core/app-deps.ts).
  readonly chain: UtxoChainConfig;
  // Optional override for HD derivation account index. Defaults to 0.
  readonly accountIndex?: number;
  // Override the Esplora client (tests inject a fake; production passes
  // nothing and falls back to the chain's `defaultEsploraUrls`).
  readonly esplora?: EsploraClient;
  // Override the Esplora backend list (production knob — point at a
  // self-hosted Electrs/Esplora deployment). Ignored when `esplora` is set.
  readonly esploraBackends?: readonly EsploraBackend[];
  // Inject fetch (Workers + tests). Forwarded to esploraClient.
  readonly fetch?: typeof globalThis.fetch;
}

export function utxoChainAdapter(cfg: UtxoChainAdapterConfig): ChainAdapter {
  const { chain } = cfg;
  const accountIndex = cfg.accountIndex ?? DEFAULT_ACCOUNT_INDEX;
  const esplora =
    cfg.esplora ??
    esploraClient({
      backends: (cfg.esploraBackends ?? chain.defaultEsploraUrls.map((url) => ({ baseUrl: url }))),
      ...(cfg.fetch !== undefined ? { fetch: cfg.fetch } : {})
    });

  return {
    family: "utxo",
    supportedChainIds: [chain.chainId] as readonly ChainId[],

    // ---- Addresses ----

    deriveAddress(seed: string, index: number) {
      // BIP84 native-segwit path: m/84'/coin'/account'/change/addressIndex.
      // coin = 0 for BTC, 2 for LTC (slip-0044).
      const seedBytes = cachedMnemonicToSeed(seed);
      const master = HDKey.fromMasterSeed(seedBytes);
      const child = master.derive(
        `m/84'/${chain.coinType}'/${accountIndex}'/${DEFAULT_CHANGE_INDEX}/${index}`
      );
      if (!child.privateKey || !child.publicKey) {
        throw new Error(
          `UTXO derivation produced no key material at index ${index} for chain ${chain.slug}`
        );
      }
      // child.publicKey from @scure/bip32 is the 33-byte compressed
      // secp256k1 pubkey — exactly what BIP84 specifies for the witness
      // program. HASH160 it and bech32-encode.
      const programHash = hash160(child.publicKey);
      const address = encodeP2wpkhAddress(chain.bech32Hrp, programHash) as Address;
      const privateKey = `0x${bytesToHex(child.privateKey)}`;
      return { address, privateKey };
    },

    validateAddress(addr: string): boolean {
      // Accepts any destination type a merchant might pay TO: P2PKH (1...),
      // P2SH (3.../M.../L...), P2WPKH (bc1q.../tb1q.../ltc1q.../tltc1q...),
      // P2WSH (bech32 32-byte program), and P2TR (bech32m, bc1p.../tb1p...).
      // Receive addresses we GENERATE are still strictly P2WPKH — see
      // deriveAddress / addressFromPrivateKey below.
      return isValidDestinationAddress(addr, chain);
    },

    canonicalizeAddress(addr: string): Address {
      // Decode handles case discipline internally — bech32 path lowercases,
      // base58 path preserves case (the checksum is case-sensitive). On
      // success we return the canonical form per address family:
      //   - bech32/bech32m → lowercase (BIP173/350 forbid mixed case)
      //   - base58check    → original casing verbatim
      const decoded = decodeUtxoDestination(addr, chain);
      if (decoded === null) {
        throw new Error(
          `Invalid ${chain.slug} address: ${addr} (expected P2PKH, P2SH, P2WPKH, P2WSH, or P2TR for hrp='${chain.bech32Hrp}')`
        );
      }
      if (decoded.type === "p2wpkh" || decoded.type === "p2wsh" || decoded.type === "p2tr") {
        return addr.toLowerCase() as Address;
      }
      return addr as Address;
    },

    addressFromPrivateKey(privateKey: string): Address {
      // 32-byte secp256k1 private key (with optional 0x prefix). Compute
      // the compressed pubkey, then HASH160 + bech32 same as deriveAddress.
      const normalized = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
      if (!/^[0-9a-f]{64}$/i.test(normalized)) {
        throw new Error(
          `UTXO addressFromPrivateKey: expected 32-byte secp256k1 hex (64 chars), got length ${normalized.length}`
        );
      }
      const privBytes = hexToBytes(normalized);
      const pubCompressed = secp256k1.getPublicKey(privBytes, true);
      const programHash = hash160(pubCompressed);
      return encodeP2wpkhAddress(chain.bech32Hrp, programHash) as Address;
    },

    // ---- Native + decimals ----

    nativeSymbol(_chainId: ChainId): TokenSymbol {
      return chain.nativeSymbol as TokenSymbol;
    },

    minimumNativeReserve(_chainId: ChainId): bigint {
      // UTXO chains have no rent-exempt minimum or per-account reserve. An
      // address can be drained to zero (in fact, UTXO model means an address
      // either has UTXOs or it doesn't — there's no "balance" to minimize).
      return 0n;
    },

    gasSafetyFactor(_chainId: ChainId): { readonly num: bigint; readonly den: bigint } {
      // UTXO fees are deterministic at sign time (vSize × feeRate). No
      // EIP-1559-style baseFee growth to absorb. Use a small 1.05× margin
      // to cover mempool feerate drift between estimate and broadcast.
      return { num: 105n, den: 100n };
    },

    feeWalletCapability(_chainId: ChainId): "none" | "top-up" | "delegate" | "co-sign" {
      // UTXO has no concept of a separate fee payer — every input carries
      // the value that funds its own output's fee. Same answer as EVM today.
      return "none";
    },

    // ---- Detection ----

    async scanIncoming({ chainId, addresses, tokens, sinceMs }): Promise<readonly DetectedTransfer[]> {
      // UTXO chains have one native token per chain. If the caller didn't ask
      // for our native, there's nothing to scan. (Token detection on UTXO is
      // out of scope for v1 — no Runes/BRC-20/Omni.)
      const wantsNative = tokens.some((t) => t === chain.nativeSymbol);
      if (!wantsNative || addresses.length === 0) return [];

      const tip = await esplora.getTipHeight().catch(() => 0);
      const now = new Date();
      const ourAddresses = new Set<string>(addresses.map((a) => a.toLowerCase()));

      // Each address gets two queries: confirmed history + mempool. Both feed
      // the same DetectedTransfer projection. Order across addresses doesn't
      // matter — the ingest path dedupes on (chainId, txHash, vout).
      const results: DetectedTransfer[] = [];
      for (const address of addresses) {
        const lc = address.toLowerCase();
        // sinceMs filter: confirmed txs carry block_time (seconds); mempool
        // txs have no time so we always include them. The poll cadence is
        // ~30s so a single sinceMs window misses nothing.
        const sinceSec = Math.floor(sinceMs / 1000);
        const [confirmed, mempool] = await Promise.all([
          esplora.getAddressTxs(lc).catch(() => [] as readonly EsploraTx[]),
          esplora.getAddressMempoolTxs(lc).catch(() => [] as readonly EsploraTx[])
        ]);
        for (const tx of confirmed) {
          if (
            tx.status.confirmed &&
            tx.status.block_time !== undefined &&
            tx.status.block_time < sinceSec
          ) {
            continue;
          }
          results.push(...projectTxOutputs(tx, lc, ourAddresses, chainId, chain, tip, now));
        }
        for (const tx of mempool) {
          results.push(...projectTxOutputs(tx, lc, ourAddresses, chainId, chain, tip, now));
        }
      }
      return results;
    },

    async getConfirmationStatus(
      _chainId: ChainId,
      txHash: TxHash
    ): Promise<{ blockNumber: number | null; confirmations: number; reverted: boolean }> {
      let tx: EsploraTx;
      try {
        tx = await esplora.getTx(txHash);
      } catch (err) {
        if (err instanceof EsploraNotFoundError) {
          // Mempool eviction or pre-broadcast; report zero confirmations,
          // not reverted. Caller retries on a later tick.
          return { blockNumber: null, confirmations: 0, reverted: false };
        }
        throw err;
      }
      if (!tx.status.confirmed) {
        return { blockNumber: null, confirmations: 0, reverted: false };
      }
      const tip = await esplora.getTipHeight().catch(() => tx.status.block_height!);
      const blockHeight = tx.status.block_height!;
      const confirmations = Math.max(0, tip - blockHeight + 1);
      // UTXO chains have no execution / revert concept. A tx either confirmed
      // (at most once, modulo reorg) or it didn't. The reorg-recheck cron
      // path handles orphaning via getConfirmationStatus → tx not found.
      return { blockNumber: blockHeight, confirmations, reverted: false };
    },

    async getConsumedNativeFee(_chainId: ChainId, txHash: TxHash): Promise<AmountRaw | null> {
      try {
        const tx = await esplora.getTx(txHash);
        // tx.fee is in satoshis (uint53-safe up to 9 PB ~ way past Bitcoin's
        // 21 M cap). Stringify for AmountRaw.
        return tx.fee.toString() as AmountRaw;
      } catch (err) {
        if (err instanceof EsploraNotFoundError) return null;
        throw err;
      }
    },

    // ---- Payouts ----
    //
    // UTXO chains don't fit the account-model `buildTransfer(from, to,
    // amount)` signature: the FROM is implicit (whatever inputs coinselect
    // picks across all owned UTXOs), and the BUILD result must enumerate
    // those picked inputs. The domain layer (payout.service) handles the
    // family branch by:
    //   1. loadSpendableUtxos(deps, chainId) — local DB query
    //   2. selectCoins(utxos, targets, feeRate) — pure coinselect
    //   3. buildUtxoUnsignedTx(picked) — exported below; produces UnsignedTx
    //   4. adapter.signAndBroadcast(unsigned, "", { inputPrivateKeys }) —
    //      this method, signs each input with the matching key.
    //
    // Calling `buildTransfer` directly on a UTXO adapter is a domain bug
    // (the account-model branch of payout.service shouldn't reach here);
    // throw a helpful error so the misroute surfaces loudly.
    async buildTransfer(_args: BuildTransferArgs): Promise<UnsignedTx> {
      throw new Error(
        `utxoChainAdapter: buildTransfer is account-model only. UTXO payouts must go through ` +
          `loadSpendableUtxos → selectCoins → buildUtxoUnsignedTx → signAndBroadcast.`
      );
    },

    async signAndBroadcast(unsignedTx, _privateKey, options): Promise<TxHash> {
      const raw = unsignedTx.raw as UtxoUnsignedRaw | undefined;
      if (!raw || raw.family !== "utxo") {
        throw new Error(
          `utxoChainAdapter.signAndBroadcast: unsignedTx.raw is not a UTXO build (got ${
            raw && typeof raw === "object" && "family" in raw ? String(raw.family) : "missing"
          })`
        );
      }
      const inputPrivateKeys = options?.inputPrivateKeys;
      if (!inputPrivateKeys || inputPrivateKeys.length !== raw.inputs.length) {
        throw new Error(
          `utxoChainAdapter.signAndBroadcast: options.inputPrivateKeys must carry one key per input ` +
            `(expected ${raw.inputs.length}, got ${inputPrivateKeys?.length ?? 0})`
        );
      }
      // Order keys to match `raw.inputs` by address. The caller is expected
      // to pass them in the same order; we accept either ordering as long
      // as the addresses cover every input. Mismatches surface as a sign-
      // time error from signSegwitTx (hash160 cross-check).
      const keysByAddress = new Map<string, string>();
      for (const k of inputPrivateKeys) keysByAddress.set(k.address.toLowerCase(), k.privateKey);
      const orderedKeys: InputSigningKey[] = raw.inputs.map((input, i) => {
        const owner = raw.inputAddresses[i];
        if (!owner) {
          throw new Error(`signAndBroadcast: missing inputAddresses[${i}] for input ${input.prevTxid}:${input.prevVout}`);
        }
        const pk = keysByAddress.get(owner.toLowerCase());
        if (!pk) {
          throw new Error(`signAndBroadcast: no inputPrivateKey supplied for input owner ${owner}`);
        }
        return { address: owner, privateKey: pk };
      });

      const tx: UnsignedSegwitTx = {
        version: raw.version,
        locktime: raw.locktime,
        inputs: raw.inputs,
        outputs: raw.outputs
      };
      const signed = signSegwitTx(tx, orderedKeys);
      // Esplora returns the txid Bitcoin Core acknowledged. Cross-check
      // against the locally-computed value — a mismatch would mean the
      // server normalized our hex differently (shouldn't happen) and is
      // worth surfacing as an error rather than silently accepting.
      const remoteTxid = await esplora.broadcastTx(signed.hex);
      if (remoteTxid.toLowerCase() !== signed.txid.toLowerCase()) {
        throw new Error(
          `signAndBroadcast: remote txid ${remoteTxid} != local txid ${signed.txid} ` +
            `(this should never happen; possible server-side reserialization)`
        );
      }
      return signed.txid as TxHash;
    },

    async estimateGasForTransfer(_args: EstimateArgs): Promise<AmountRaw> {
      // Typical 1-input 2-output P2WPKH tx is ~141 vbytes. Fee = vsize ×
      // medium feeRate (sat/vB).
      //
      // On esplora failure, fall back to a conservative 2 sat/vB so the
      // gateway can still plan / broadcast payouts. See `quoteFeeTiers`
      // for the full fallback rationale.
      const TYPICAL_VBYTES = 141;
      let mediumFeeRate: number;
      try {
        const fees = await esplora.getFeeEstimates();
        mediumFeeRate = pickFeeTier(fees, "medium");
      } catch {
        mediumFeeRate = 2;
      }
      return (BigInt(Math.ceil(TYPICAL_VBYTES * mediumFeeRate))).toString() as AmountRaw;
    },

    async quoteFeeTiers(_args: EstimateArgs): Promise<FeeTierQuote> {
      const TYPICAL_VBYTES = 141;
      let lowRate: number;
      let medRate: number;
      let highRate: number;
      let degraded = false;
      try {
        const fees = await esplora.getFeeEstimates();
        lowRate = pickFeeTier(fees, "low");
        medRate = pickFeeTier(fees, "medium");
        highRate = pickFeeTier(fees, "high");
      } catch {
        // Esplora unavailable. Fall back to conservative hardcoded rates so
        // payouts can still be planned and broadcast. 1/2/3 sat/vB is well
        // above the relay-floor and low enough that we never overpay during
        // real outages — operators can RBF-bump if mempool conditions push
        // the market above 3 sat/vB while the fee oracle is down. The
        // `degraded` flag propagates up so the estimate response can carry
        // a `fee_quote_degraded` warning — quote is plannable but not
        // market-fresh.
        lowRate = 1;
        medRate = 2;
        highRate = 3;
        degraded = true;
      }
      const feeAt = (rate: number): AmountRaw =>
        BigInt(Math.ceil(TYPICAL_VBYTES * rate)).toString() as AmountRaw;
      return {
        low: { tier: "low", nativeAmountRaw: feeAt(lowRate) },
        medium: { tier: "medium", nativeAmountRaw: feeAt(medRate) },
        high: { tier: "high", nativeAmountRaw: feeAt(highRate) },
        // UTXO has real tier differentiation via mempool fee-market depth,
        // unlike Tron's flat-energy model.
        tieringSupported: true,
        nativeSymbol: chain.nativeSymbol as TokenSymbol,
        degraded
      };
    },

    async getBalance({ token, address }): Promise<AmountRaw> {
      // UTXO chains carry only the native token. Anything else returns 0n
      // since it can't have a balance on this chain by construction.
      if (token !== chain.nativeSymbol) {
        return "0" as AmountRaw;
      }
      const sats = await esplora.getAddressBalanceSats(address.toLowerCase()).catch(() => 0n);
      return sats.toString() as AmountRaw;
    },

    async getAccountBalances({ address }): Promise<readonly { token: TokenSymbol; amountRaw: AmountRaw }[]> {
      const sats = await esplora.getAddressBalanceSats(address.toLowerCase()).catch(() => 0n);
      if (sats === 0n) return [];
      return [{ token: chain.nativeSymbol as TokenSymbol, amountRaw: sats.toString() as AmountRaw }];
    }
  };
}

// ---- UTXO unsigned-tx shape carried in UnsignedTx.raw ----
//
// payout.service builds this after coinselect, then hands it to the adapter's
// signAndBroadcast. The `family: "utxo"` discriminator lets the adapter
// reject a misrouted account-model raw with a clear error.
export interface UtxoUnsignedRaw {
  readonly family: "utxo";
  readonly version: number;
  readonly locktime: number;
  readonly inputs: readonly UtxoInput[];
  readonly outputs: readonly UtxoOutput[];
  // Per-input owner address (lowercase, canonical bech32). Same order as
  // `inputs`. Used by signAndBroadcast to match each input to its private
  // key in `options.inputPrivateKeys`. We don't carry the address inside
  // UtxoInput itself because UtxoInput is also used for non-payout
  // contexts (sighash testing) where the owner isn't relevant.
  readonly inputAddresses: readonly string[];
}

// Payout.service entry point. Given the inputs coinselect chose plus the
// final outputs (target(s) + change), assemble the UTXO raw and wrap it as
// an UnsignedTx. version=2 + locktime=0 + sequence=0xfffffffd (non-final,
// signals RBF-aware) — same defaults bitcoinjs-lib uses for new txs.
export function buildUtxoUnsignedTx(
  chainId: ChainId,
  picked: ReadonlyArray<{
    readonly txid: string;
    readonly vout: number;
    readonly value: bigint;
    readonly scriptPubkey: string;
    readonly address: string;
  }>,
  outputs: ReadonlyArray<{ readonly scriptPubkey: string; readonly value: bigint }>
): UnsignedTx {
  if (picked.length === 0) {
    throw new Error("buildUtxoUnsignedTx: at least one input required");
  }
  if (outputs.length === 0) {
    throw new Error("buildUtxoUnsignedTx: at least one output required");
  }
  // sequence = 0xfffffffd → opt-in RBF (BIP125). Doesn't change current
  // behavior (we don't replace), but leaves the door open for an RBF
  // bump later without invalidating the in-mempool fingerprint of the
  // signed tx (the sequence number is part of the sighash).
  const inputs: UtxoInput[] = picked.map((p) => ({
    prevTxid: p.txid,
    prevVout: p.vout,
    prevScriptPubkey: p.scriptPubkey,
    prevValue: p.value,
    sequence: 0xfffffffd
  }));
  const txOutputs: UtxoOutput[] = outputs.map((o) => ({
    scriptPubkey: o.scriptPubkey,
    value: o.value
  }));
  const raw: UtxoUnsignedRaw = {
    family: "utxo",
    version: 2,
    locktime: 0,
    inputs,
    outputs: txOutputs,
    inputAddresses: picked.map((p) => p.address.toLowerCase())
  };
  return {
    chainId,
    raw,
    summary: `UTXO: ${picked.length} input(s) → ${outputs.length} output(s)`
  };
}

// Project Esplora's per-confirmation-target fee map onto our 3-tier model.
//   low    = ~6-block target (1-hour wait)
//   medium = ~3-block target (30-minute wait)
//   high   = ~1-block target (next-block)
// Esplora's `/fee-estimates` returns sat/vB indexed by confirmation target
// as a string ("1", "2", "3", "6", "10", ...). We pick the closest available.
// 1 sat/vB minimum prevents the floor from going below the relay rule.
function pickFeeTier(
  fees: Readonly<Record<string, number>>,
  tier: "low" | "medium" | "high"
): number {
  const targets = tier === "high" ? ["1", "2"] : tier === "medium" ? ["3", "4", "5"] : ["6", "10", "20", "144"];
  for (const t of targets) {
    const v = fees[t];
    if (typeof v === "number" && v > 0) return v;
  }
  // Fallback: any positive value, or 1 sat/vB minimum.
  for (const v of Object.values(fees)) {
    if (typeof v === "number" && v > 0) return v;
  }
  return 1;
}

// Marker for the Phase 2/3 stubs so callers can detect the in-progress family
// and skip cleanly in tests. Exposed via the family at `unsupportedFamilyError`
// so the message is uniform.
export class UtxoNotImplementedError extends Error {
  constructor(method: string) {
    super(`utxoChainAdapter: ${method} is not implemented yet (filled in Phase 2/3)`);
    this.name = "UtxoNotImplementedError";
  }
}

// Convenience constructors so app-deps wires `utxoChainAdapter({ chain: BITCOIN_CONFIG })`
// vs spelling out the import every time. Mirrors how evmChainAdapter / tronChainAdapter
// are called from src/core/app-deps.ts.
export function bitcoinChainAdapter(): ChainAdapter {
  return utxoChainAdapter({ chain: BITCOIN_CONFIG });
}

export function litecoinChainAdapter(): ChainAdapter {
  return utxoChainAdapter({ chain: LITECOIN_CONFIG });
}

export function bitcoinTestnetChainAdapter(): ChainAdapter {
  return utxoChainAdapter({ chain: BITCOIN_TESTNET_CONFIG });
}

export function litecoinTestnetChainAdapter(): ChainAdapter {
  return utxoChainAdapter({ chain: LITECOIN_TESTNET_CONFIG });
}

// ---- Internal helpers ----

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Walk a tx's outputs and emit a DetectedTransfer for each output paying one
// of OUR addresses. The same tx can carry multiple credits (rare in practice
// but happens when a sender batches). `vout` (output index in the tx) is
// carried in `logIndex` per the existing UTXO convention used by detection
// dedup (`transactions.UNIQUE(chain_id, tx_hash, log_index)`).
//
// `fromAddress` is best-effort — UTXO inputs can come from many addresses,
// none of them necessarily owned by the sender's "main wallet." We pick the
// first input with a known prevout address. Falls back to the empty string
// when no input prevout addresses are available (rare).
function projectTxOutputs(
  tx: EsploraTx,
  watchedAddress: string,
  ourAddresses: ReadonlySet<string>,
  chainId: number,
  chain: UtxoChainConfig,
  tipHeight: number,
  seenAt: Date
): DetectedTransfer[] {
  const out: DetectedTransfer[] = [];
  // Best-effort sender attribution — first input with a known address.
  const fromAddress =
    tx.vin.find((vin) => vin.prevout?.scriptpubkey_address)?.prevout?.scriptpubkey_address ?? "";
  const blockNumber = tx.status.confirmed ? (tx.status.block_height ?? null) : null;
  const confirmations =
    tx.status.confirmed && tx.status.block_height !== undefined
      ? Math.max(0, tipHeight - tx.status.block_height + 1)
      : 0;

  for (let vout = 0; vout < tx.vout.length; vout += 1) {
    const o = tx.vout[vout]!;
    const recipient = o.scriptpubkey_address?.toLowerCase();
    if (recipient === undefined) continue;
    if (recipient !== watchedAddress) continue;
    // Defensive: only emit for addresses we actually watch (the API call
    // already scoped to `watchedAddress`, but a malicious server could echo
    // unrelated outputs — the cross-check guards against trust misplacement).
    if (!ourAddresses.has(recipient)) continue;

    out.push({
      chainId: chainId as DetectedTransfer["chainId"],
      txHash: tx.txid as DetectedTransfer["txHash"],
      logIndex: vout,
      fromAddress: fromAddress as DetectedTransfer["fromAddress"],
      toAddress: recipient as DetectedTransfer["toAddress"],
      token: chain.nativeSymbol as DetectedTransfer["token"],
      amountRaw: o.value.toString() as DetectedTransfer["amountRaw"],
      blockNumber,
      confirmations,
      seenAt
    });
  }
  return out;
}

// Re-export the config helper so callers that already imported the adapter
// don't have to import the config module separately.
export { utxoConfigForChainId };
// Avoid importing-but-not-using lint warnings for findToken — the helper is
// used by Phase 2/3 code that lives elsewhere in this same module. Stub
// usage here so the import chain stays warm.
void findToken;
