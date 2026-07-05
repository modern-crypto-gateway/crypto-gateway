import type { ChainAdapter, FeeTierQuote } from "../../../core/ports/chain.port.js";
import type { Address, ChainId, TxHash } from "../../../core/types/chain.js";
import type { AmountRaw } from "../../../core/types/money.js";
import type { TokenSymbol } from "../../../core/types/token.js";
import type { DetectedTransfer } from "../../../core/types/transaction.js";
import type { BuildTransferArgs, EstimateArgs, UnsignedTx } from "../../../core/types/unsigned-tx.js";
import type { CacheStore } from "../../../core/ports/cache.port.js";
import type { Logger } from "../../../core/ports/logger.port.js";

import {
  decodeRctAmount,
  deriveKeyDerivation,
  derivationToScalar,
  deriveViewTag,
  outputToSubaddressSpendPub,
  parseAddress,
  verifyRctCommitment,
  viewKeyMatchesAddress
} from "./monero-crypto.js";
import { MONERO_MAINNET_CONFIG, type MoneroChainConfig } from "./monero-config.js";
import type { MoneroDaemonRpcClient, MoneroParsedTx } from "./monero-rpc.js";
import type { MoneroNetwork } from "./monero-crypto.js";

// Result of a checkpoint-free block-range scan. `scannedTo` is the highest
// height whose block was FULLY processed (fetch + match) — the caller
// persists it as its cursor only after the returned transfers were ingested.
export interface MoneroBlockRangeScan {
  readonly transfers: readonly DetectedTransfer[];
  readonly scannedTo: number;
  readonly tipHeight: number;
}

// ChainAdapter extension exposing the gateway's Monero key material so the
// subaddress allocator (domain code, no chain-adapter DB dep) can call
// `deriveSubaddress` directly with the stored view key + primary spend
// pub. invoice.service.ts narrows `adapter.family === "monero"` to this
// shape — every other path treats the adapter as the generic ChainAdapter.
export interface MoneroChainAdapter extends ChainAdapter {
  readonly family: "monero";
  readonly moneroNetwork: MoneroNetwork;
  readonly moneroPrimarySpendPub: Uint8Array;
  readonly moneroViewKey: Uint8Array;
  // Exposed so the admin diagnostic endpoint can fetch arbitrary txs
  // through the same RPC stack the cron uses, without instantiating a
  // second client.
  readonly moneroDaemonClient: MoneroDaemonRpcClient;
  // Configured backfill start (0 = unset). The txpool watcher uses it to
  // seed a cold checkpoint the same way scanIncoming's cold-start does.
  readonly moneroRestoreHeight: number;
  // Checkpoint-free block walk: scan [fromHeight, fromHeight+maxBlocks) up
  // to the live tip, matching outputs against `addresses`. Owns NO cursor
  // state — callers (the txpool watcher's block pass, the poll strategy)
  // persist `scannedTo` in their own storage AFTER ingesting the transfers,
  // so a crash between scan and ingest re-scans instead of losing payments.
  scanBlockRange(args: {
    readonly addresses: readonly Address[];
    readonly fromHeight: number;
    readonly maxBlocks?: number;
  }): Promise<MoneroBlockRangeScan>;
  // scanIncoming minus the checkpoint write: same cold-start/cursor
  // resolution against the shared cache, but the caller decides when the
  // cursor advances (see commitScanCheckpoint). Used by the Monero block-
  // scan detection strategy to commit only after pollPayments ingested.
  scanIncomingDetailed(args: {
    readonly chainId: ChainId;
    readonly addresses: readonly Address[];
    readonly tokens: readonly TokenSymbol[];
  }): Promise<{ readonly transfers: readonly DetectedTransfer[]; readonly scannedTo: number | null }>;
  // Persist the block cursor for this chain. No-op for null.
  commitScanCheckpoint(scannedTo: number | null): Promise<void>;
}

export function isMoneroChainAdapter(a: ChainAdapter): a is MoneroChainAdapter {
  return a.family === "monero";
}

// ---- Shared view-key matcher ----
//
// One pure function decides "does this tx pay any of our watched
// subaddresses" for EVERY detection surface: the block walk (here and in
// the txpool watcher's block pass), the txpool instant-detection pass, and
// the admin force-ingest endpoint. Keeping it pure (no RPC, no DB) means
// the mempool and block paths cannot drift apart cryptographically.
//
// Scanning algorithm (wallet2-equivalent):
//   per candidate tx pubkey R: derivation D = 8·a·R  (ONE point mult —
//     hoisted per tx for the primary key, per output for additional keys,
//     never recomputed per watched subaddress)
//   per output i:
//     view-tag prefilter — keccak("view_tag"||D||varint(i))[0] vs the
//       output's tag byte; mismatch skips the EC work below. Sender derives
//       the tag from the same D, so a real payment to us never mismatches
//       (zero false negatives); ~1/256 foreign outputs slip through and are
//       rejected by the full check. Bypassed when the output has no tag
//       (pre-v15 txs).
//     Hs = Hs(D||i); candidate spend pub D' = P − Hs·G; O(1) lookup in the
//       watched map (vs the old O(N-subaddresses) forward loop).
//     on hit: decode the RingCT amount and verify it against the output's
//       consensus-validated Pedersen commitment (fake-deposit defense).

export interface MoneroScanContext {
  readonly chainId: ChainId;
  readonly viewKey: Uint8Array;
  // hex(subaddress public spend key) → the encoded subaddress string that
  // appeared on the invoice.
  readonly spendPubToAddress: ReadonlyMap<string, Address>;
  readonly logger?: Logger;
}

export function buildMoneroScanContext(args: {
  readonly chainId: ChainId;
  readonly viewKey: Uint8Array;
  readonly addresses: readonly Address[];
  readonly logger?: Logger;
}): MoneroScanContext {
  const spendPubToAddress = new Map<string, Address>();
  for (const a of args.addresses) {
    try {
      const p = parseAddress(a);
      spendPubToAddress.set(bytesToHex(p.publicSpendKey), a);
    } catch {
      // Malformed address in the join — log and skip. Shouldn't happen with
      // addresses we minted ourselves, but defense in depth.
      args.logger?.warn("monero scan: skip malformed watched address", { address: a });
    }
  }
  return {
    chainId: args.chainId,
    viewKey: args.viewKey,
    spendPubToAddress,
    ...(args.logger !== undefined ? { logger: args.logger } : {})
  };
}

export function matchMoneroTxOutputs(
  ctx: MoneroScanContext,
  tx: MoneroParsedTx,
  args: {
    // Height to stamp on the transfer when the tx record itself carries
    // none. Pool txs pass null → blockNumber null, confirmations 0.
    readonly fallbackBlockHeight: number | null;
    readonly tipHeight: number | null;
    // Block-header time (unix seconds) for mined txs; null for pool txs.
    readonly blockTimestampSec?: number | null;
    readonly seenAt: Date;
  }
): DetectedTransfer[] {
  if (ctx.spendPubToAddress.size === 0) return [];
  if (tx.isCoinbase) return []; // miner txs never credit a view-key holder
  // unlock_time policy: skip ANY tx with a non-zero unlock_time.
  // unlock_time delays spendability of every output in the tx — crediting a
  // locked output would let a "payer" show a confirmed deposit the merchant
  // cannot actually spend for years. Legitimate payers never set it, and
  // the FCMP++ fork consensus-bans it outright; fail closed.
  if (tx.unlockTime !== 0) {
    ctx.logger?.warn(
      "monero scan: tx has non-zero unlock_time; skipping all outputs (time-locked funds are not creditable)",
      { chainId: ctx.chainId, txHash: tx.txHash, unlockTime: tx.unlockTime }
    );
    return [];
  }

  // Primary tx pubkey derivation (tx_extra tag 0x01) — one point mult,
  // shared by every output. Additional pubkeys (tag 0x04) are per-output;
  // their derivation is computed inside the loop only when needed.
  let primaryDerivation: Uint8Array | null = null;
  if (tx.txPubkey.length === 64) {
    try {
      primaryDerivation = deriveKeyDerivation({
        viewKeySecret: ctx.viewKey,
        txPubkey: hexToBytes(tx.txPubkey)
      });
    } catch {
      primaryDerivation = null; // not a valid point — legacy/garbage extra
    }
  }

  const transfers: DetectedTransfer[] = [];
  for (let i = 0; i < tx.outputs.length; i += 1) {
    const output = tx.outputs[i]!;
    if (output.publicKey.length !== 64) continue;
    let outputPubBytes: Uint8Array;
    try {
      outputPubBytes = hexToBytes(output.publicKey);
    } catch {
      continue;
    }

    // Candidate derivations for THIS output. Primary first (already
    // computed, cheap rejection via view tag), then this output's
    // additional pubkey — the dominant path in practice, since modern
    // wallets emit tag 0x04 for every tx that pays a subaddress and our
    // gateway always pays subaddresses.
    const candidates: Uint8Array[] = [];
    if (primaryDerivation !== null) candidates.push(primaryDerivation);
    const addtl = tx.additionalPubkeys[i];
    if (addtl !== undefined && addtl.length === 64) {
      try {
        candidates.push(
          deriveKeyDerivation({ viewKeySecret: ctx.viewKey, txPubkey: hexToBytes(addtl) })
        );
      } catch {
        // ignore — primary candidate may still match
      }
    }
    if (candidates.length === 0) continue;

    let matched: Address | null = null;
    let matchedSharedSecret: Uint8Array | null = null;
    for (const derivation of candidates) {
      // View-tag prefilter: one keccak instead of the scalar-mult +
      // point-subtract below. Skip only on a definite mismatch — outputs
      // without a tag (pre-v15) always take the full check.
      if (output.viewTag !== null &&
          deriveViewTag({ derivation, outputIndex: i }) !== output.viewTag) {
        continue;
      }
      const hs = derivationToScalar({ derivation, outputIndex: i });
      const candidateSpendPub = outputToSubaddressSpendPub({
        hsScalar: hs,
        outputPubkey: outputPubBytes
      });
      if (candidateSpendPub === null) continue;
      const hit = ctx.spendPubToAddress.get(bytesToHex(candidateSpendPub));
      if (hit !== undefined) {
        matched = hit;
        matchedSharedSecret = hs;
        break;
      }
    }
    if (matched === null || matchedSharedSecret === null) continue;

    // Decode the encrypted amount. Coinbase already filtered out.
    // RingCT v2 uses 8-byte encryptedAmount; if missing, skip.
    if (!output.encryptedAmount) continue;
    let encrypted: Uint8Array;
    try {
      encrypted = hexToBytes(output.encryptedAmount);
    } catch {
      continue;
    }
    if (encrypted.length !== 8) continue;
    let amountRaw: bigint;
    try {
      amountRaw = decodeRctAmount({ sharedSecret: matchedSharedSecret, encryptedAmount: encrypted });
    } catch {
      continue;
    }
    if (amountRaw <= 0n) continue;
    // SECURITY: verify the decoded amount against the output's Pedersen
    // commitment (rct_signatures.outPk[i]). ecdhInfo is NOT consensus-
    // validated — a malicious payer who knows the tx secret can commit
    // ~0 XMR while encoding the full invoice amount in ecdhInfo (fake
    // deposit). The commitment IS consensus-validated; recomputing
    // C' = Hs("commitment_mask"||ss)·G + amount·H and comparing byte-equal
    // proves the amount is real. On mismatch, wallet2 treats the output as
    // amount 0 — we skip it. Fail closed when the commitment is missing.
    if (!output.commitment) {
      ctx.logger?.warn(
        "monero scan: output has no Pedersen commitment from RPC; skipping (fail closed, cannot verify amount)",
        { chainId: ctx.chainId, txHash: tx.txHash, outputIndex: i }
      );
      continue;
    }
    let commitmentBytes: Uint8Array;
    try {
      commitmentBytes = hexToBytes(output.commitment);
    } catch {
      ctx.logger?.warn(
        "monero scan: output commitment is not valid hex; skipping (fail closed)",
        { chainId: ctx.chainId, txHash: tx.txHash, outputIndex: i }
      );
      continue;
    }
    if (!verifyRctCommitment({
      sharedSecret: matchedSharedSecret,
      amount: amountRaw,
      commitment: commitmentBytes
    })) {
      ctx.logger?.warn(
        "monero scan: decoded ecdhInfo amount does NOT match the output's Pedersen commitment; skipping (possible fake-deposit attempt)",
        { chainId: ctx.chainId, txHash: tx.txHash, outputIndex: i }
      );
      continue;
    }

    const blockHeight = tx.blockHeight ?? args.fallbackBlockHeight;
    transfers.push({
      chainId: ctx.chainId,
      txHash: tx.txHash,
      // Monero outputs aren't EVM-style "log indices" but we use the same
      // column to disambiguate multiple outputs from one tx to the same
      // subaddress (rare but possible).
      logIndex: i,
      // Monero outputs don't expose the sender to a view-key holder
      // (privacy by design — the only thing we can prove is "this shared
      // secret + our subaddress reproduces this output"). See the sentinel
      // note on MONERO_UNKNOWN_SENDER.
      fromAddress: MONERO_UNKNOWN_SENDER as Address,
      toAddress: matched,
      token: "XMR" as TokenSymbol,
      amountRaw: amountRaw.toString() as AmountRaw,
      blockNumber: blockHeight,
      confirmations:
        blockHeight === null || args.tipHeight === null
          ? 0
          : Math.max(0, args.tipHeight - blockHeight),
      seenAt: args.seenAt,
      // Block-header time for mined txs — enables time-correct re-ingest
      // attribution (previously always null → re-ingests fail-closed to
      // orphan). Pool txs stay null until the block pass re-observes them.
      onchainTime:
        typeof args.blockTimestampSec === "number" && args.blockTimestampSec > 0
          ? new Date(args.blockTimestampSec * 1000)
          : null
    });
  }
  return transfers;
}

// Monero chain adapter. v1 inbound-only — see plan
// `sleepy-petting-spindle.md`. Outbound methods throw a typed error so the
// `family !== "monero"` guard in payout.service.ts surfaces a clean 400 to
// the merchant and we never accidentally try to sign with absent keys.
//
// Detection model: a single gateway-managed Monero wallet (operator
// configures the primary address + view key via env vars). Subaddresses
// are minted per-invoice; detection scans every unprocessed block for
// outputs to ANY of those subaddresses. Public daemon RPC + view-key
// decoding only — no spend authority is held in the gateway.
//
// Constructor accepts `daemonClient` so tests can stub the RPC layer
// without spinning up a real Monero node. All view-key cryptography runs
// in pure JavaScript (`@noble/curves` ed25519 + `@noble/hashes` keccak),
// so this adapter works on Node, Cloudflare Workers, and Vercel-Edge
// identically.

// Sentinel for `DetectedTransfer.fromAddress` on Monero credits — the
// sender is unknowable from the view key alone, but the schema requires
// a non-empty string. Underscores are outside Monero's base58 alphabet,
// so any code path that DOES try to parse this will fail loudly rather
// than silently treating it as a real address.
export const MONERO_UNKNOWN_SENDER = "monero_unknown_sender";

export class MoneroPayoutNotSupportedError extends Error {
  constructor() {
    super(
      "Monero payouts are not supported in v1. The operator settles XMR " +
      "out-of-band via their own wallet (the gateway holds only the view key)."
    );
    this.name = "MoneroPayoutNotSupportedError";
  }
}

export interface MoneroChainAdapterConfig {
  readonly chain: MoneroChainConfig;
  // Operator's Monero primary address (95 chars base58, network-specific
  // prefix). Validated at construction.
  readonly primaryAddress: string;
  // 32-byte secret view key. Validated at construction (must derive back to
  // the address's public view component) — mismatch = boot-time error so
  // the merchant never sees a silent "no payments detected" failure.
  readonly viewKey: Uint8Array;
  // First block height to scan from. Stored so a fresh deployment doesn't
  // re-scan years of pre-creation history.
  readonly restoreHeight: number;
  // RPC client (see monero-rpc.ts). Tests inject a stub.
  readonly daemonClient: MoneroDaemonRpcClient;
  // Cache for the per-chain "last scanned height" checkpoint. Same shape
  // the rpc-poll detection adapter uses for its `poll:last_since_ms:` keys.
  readonly cache: CacheStore;
  readonly logger?: Logger;
  // Hard cap on how many blocks we'll fetch in a single scanIncoming call.
  // Keeps a single cron tick from spending its whole CPU budget on a
  // 50,000-block backfill after a long outage.
  //
  // Default is **40 blocks** — sized for Cloudflare Workers, where the
  // scheduled-handler CPU budget is 30ms by default and even with
  // `[limits] cpu_ms = 30000` the per-output ed25519 scalar multiplications
  // add up fast (each block has tens of txs, each tx has multiple outputs,
  // each output costs ~1ms of CPU per owned subaddress). A long outage
  // backfill walks through at ~40 blocks/min × 60 min/hr ≈ 1.3 hr of
  // chain history per real hour — slow but never CPU-exhausting.
  //
  // Node deployments can safely set this much higher (e.g. 500) since
  // they aren't subject to the 30s scheduled-handler ceiling.
  readonly maxBlocksPerTick?: number;
}

export function moneroChainAdapter(config: MoneroChainAdapterConfig): MoneroChainAdapter {
  const { chain, primaryAddress, viewKey, restoreHeight, daemonClient, cache, logger } = config;
  const maxBlocksPerTick = config.maxBlocksPerTick ?? 40;

  // Validate primary address shape + network at construction.
  const parsed = parseAddress(primaryAddress);
  if (parsed.isSubaddress) {
    throw new Error(
      `moneroChainAdapter: MONERO_PRIMARY_ADDRESS must be the merchant's PRIMARY address, not a subaddress`
    );
  }
  if (parsed.network !== chain.network) {
    throw new Error(
      `moneroChainAdapter: MONERO_PRIMARY_ADDRESS network mismatch — expected ${chain.network}, got ${parsed.network}`
    );
  }
  // Cross-check the view key derives back to the embedded public view key.
  // A misconfigured key here would silently miss every incoming payment.
  if (!viewKeyMatchesAddress(viewKey, primaryAddress)) {
    throw new Error(
      `moneroChainAdapter: MONERO_VIEW_KEY does not correspond to MONERO_PRIMARY_ADDRESS — ` +
      `the secret view key must derive back to the public view key embedded in the address`
    );
  }
  const primarySpendPub = parsed.publicSpendKey;

  // Cache key for the per-chain last-scanned-height checkpoint. The cron
  // calls scanIncoming on every tick; this advances forward as blocks are
  // processed. Cold cache → start from `restoreHeight`.
  const heightCacheKey = `monero:last_scanned_height:${chain.chainId}`;

  return {
    family: "monero",
    supportedChainIds: [chain.chainId] as readonly ChainId[],
    moneroNetwork: chain.network,
    moneroPrimarySpendPub: primarySpendPub,
    moneroViewKey: viewKey,
    moneroDaemonClient: daemonClient,
    moneroRestoreHeight: restoreHeight,

    // ---- Addresses ----

    // For Monero, `seed` is ignored — the gateway-wide view key + primary
    // spend pub are baked into the adapter closure. `index` is the
    // subaddress index under account 0; the allocator (monero-subaddress-
    // allocator.ts) calls into this with monotonic 1, 2, 3, ...
    deriveAddress(_seed: string, _index: number) {
      // Subaddress derivation uses the closure-captured keys. The allocator
      // imports `deriveSubaddress` directly so it has structured args
      // (account/index/network) — this method exists to satisfy the port
      // shape for code paths that introspect chains[] generically.
      throw new Error(
        "moneroChainAdapter.deriveAddress: call deriveSubaddress() from monero-crypto directly; " +
        "the gateway uses an explicit account+index API that the generic ChainAdapter shape doesn't carry."
      );
    },

    validateAddress(addr: string): boolean {
      try {
        const p = parseAddress(addr);
        return p.network === chain.network;
      } catch {
        return false;
      }
    },

    canonicalizeAddress(addr: string): Address {
      // Sentinel: Monero outputs don't expose the sender to a view-key
      // holder, so scanIncoming emits MONERO_UNKNOWN_SENDER as fromAddress.
      // ingest calls canonicalizeAddress on every transfer field including
      // `from`; the sentinel must round-trip without going through base58
      // parsing (it contains underscores, which are outside the Monero
      // base58 alphabet). Stored as-is on `transactions.from_address`
      // (informational only — no business logic keys off it).
      // Empty string also tolerated for legacy callers; both are harmless.
      if (addr === MONERO_UNKNOWN_SENDER || addr === "") return addr as Address;
      // Validate by re-parsing; throw on failure with a structured error.
      const p = parseAddress(addr);
      if (p.network !== chain.network) {
        throw new Error(
          `Monero address network mismatch: expected ${chain.network}, got ${p.network}`
        );
      }
      // Monero base58 is case-sensitive (mixed Bitcoin alphabet) — no
      // canonicalization needed beyond the parse-and-reject step. Return as-is.
      return addr as Address;
    },

    addressFromPrivateKey(_privateKey: string): Address {
      throw new MoneroPayoutNotSupportedError();
    },

    // ---- Detection ----

    async scanBlockRange({ addresses, fromHeight, maxBlocks }) {
      const cap = maxBlocks ?? maxBlocksPerTick;
      const tipHeight = await daemonClient.getTipHeight();
      const ctx = buildMoneroScanContext({
        chainId: chain.chainId,
        viewKey,
        addresses,
        ...(logger !== undefined ? { logger } : {})
      });
      const transfers: DetectedTransfer[] = [];
      let scannedTo = fromHeight - 1;
      if (fromHeight > tipHeight) {
        return { transfers, scannedTo, tipHeight };
      }
      const toHeight = Math.min(tipHeight, fromHeight + cap - 1);
      for (let height = fromHeight; height <= toHeight; height += 1) {
        let block;
        try {
          block = await daemonClient.getBlockByHeight(height);
        } catch (err) {
          // Don't advance past the failed block — the caller's cursor stops
          // here and the next pass retries. Never skip a height.
          logger?.warn("monero scanBlockRange: block fetch failed; halting walk", {
            chainId: chain.chainId,
            height,
            error: err instanceof Error ? err.message : String(err)
          });
          break;
        }
        if (block.txHashes.length > 0) {
          let txs: readonly MoneroParsedTx[];
          try {
            txs = await daemonClient.getTransactions(block.txHashes);
          } catch (err) {
            logger?.warn("monero scanBlockRange: tx batch fetch failed; halting walk", {
              chainId: chain.chainId,
              height,
              error: err instanceof Error ? err.message : String(err)
            });
            break;
          }
          const seenAt = new Date();
          for (const tx of txs) {
            transfers.push(
              ...matchMoneroTxOutputs(ctx, tx, {
                fallbackBlockHeight: height,
                tipHeight,
                blockTimestampSec: block.timestampSec,
                seenAt
              })
            );
          }
        }
        scannedTo = height;
      }
      return { transfers, scannedTo, tipHeight };
    },

    async scanIncomingDetailed({ chainId, addresses, tokens }) {
      if (chainId !== chain.chainId) return { transfers: [], scannedTo: null };
      if (addresses.length === 0) return { transfers: [], scannedTo: null };
      // We only credit XMR — there are no SPL/ERC-20 equivalents on Monero.
      // pollPayments force-includes XMR for monero-family addresses, so this
      // gate only trips for callers that explicitly asked for other tokens.
      if (!tokens.includes("XMR" as TokenSymbol)) return { transfers: [], scannedTo: null };

      let tipHeight: number;
      try {
        tipHeight = await daemonClient.getTipHeight();
      } catch (err) {
        logger?.warn("monero scanIncoming: tip fetch failed", {
          chainId,
          error: err instanceof Error ? err.message : String(err)
        });
        return { transfers: [], scannedTo: null };
      }

      // Resolve the from-height cursor. Cold cache (or fresh boot) starts
      // from `restoreHeight`; otherwise resume from the persisted height + 1.
      //
      // Default-zero footgun guard: if the operator left
      // MONERO_RESTORE_HEIGHT unset (default 0) AND we have no cached
      // checkpoint, snap to `tipHeight - 100` (a few hours of grace) so the
      // first detection tick doesn't attempt to scan from genesis.
      const lastScanned = (await cache.getJSON<{ h: number }>(heightCacheKey))?.h;
      let fromHeight: number;
      if (lastScanned !== undefined) {
        fromHeight = lastScanned + 1;
        // NO stale-gap snap-forward (the old gap>60 → tip-100 jump). That
        // snap silently skipped every block in the gap — a payment mined
        // there was permanently missed (the #1 correctness bug of the old
        // scanner). Catch-up now walks every block, maxBlocksPerTick per
        // tick (~40x chain production rate), trading bounded extra latency
        // for zero misses.
        const gapBlocks = tipHeight - lastScanned;
        if (gapBlocks > 200) {
          logger?.warn(
            "monero scanIncoming: checkpoint lagging tip; catching up WITHOUT skipping blocks",
            {
              chainId,
              lastScanned,
              tipHeight,
              gapBlocks,
              estCatchupTicks: Math.ceil(gapBlocks / maxBlocksPerTick)
            }
          );
        }
      } else if (restoreHeight === 0) {
        fromHeight = Math.max(0, tipHeight - 100);
        logger?.warn(
          "monero scanIncoming: MONERO_RESTORE_HEIGHT not set; snapping cold-start scan to tip-100 to avoid hammering public nodes. Set MONERO_RESTORE_HEIGHT to the wallet's birthday block to backfill earlier history.",
          { chainId, snappedFromHeight: fromHeight, tipHeight }
        );
      } else {
        fromHeight = restoreHeight;
      }
      if (fromHeight > tipHeight) return { transfers: [], scannedTo: null }; // up to date

      // Visibility for operators who can't easily grep logs: one info line
      // per tick whenever there are Monero addresses to scan.
      logger?.info("monero scanIncoming tick", {
        chainId,
        addressCount: addresses.length,
        tipHeight,
        fromHeight
      });

      const range = await this.scanBlockRange({ addresses, fromHeight });
      const scannedTo = range.scannedTo >= fromHeight ? range.scannedTo : null;

      // Tick-summary log — pairs with the tick line above so an operator can
      // answer "did the walk reach the block I expected? did anything match?"
      const summaryFields = {
        chainId,
        fromHeight,
        scannedTo,
        tipHeight: range.tipHeight,
        addressCount: addresses.length,
        transfersFound: range.transfers.length
      };
      if (range.transfers.length > 0) {
        logger?.info("monero scanIncoming summary (matches found)", summaryFields);
      } else {
        logger?.debug("monero scanIncoming summary (no matches)", summaryFields);
      }
      return { transfers: range.transfers, scannedTo };
    },

    async commitScanCheckpoint(scannedTo) {
      if (scannedTo === null) return;
      // ONE cache write per committed walk. The old scanner wrote KV once
      // PER BLOCK mid-walk (up to 40 writes/tick against KV's 1 write/sec/
      // key limit) and committed BEFORE the transfers were ingested — a
      // crash between checkpoint and ingest lost the payment permanently.
      // Callers now commit only after handing the walk's transfers to
      // ingest. TTL is a year (was 30 days — long-idle deployments lost
      // their cursor and cold-started at tip-100).
      await cache.putJSON(heightCacheKey, { h: scannedTo }, { ttlSeconds: 60 * 60 * 24 * 365 });
    },

    async scanIncoming({ chainId, addresses, tokens }) {
      // Legacy self-committing wrapper (generic DetectionStrategy shape).
      // Production paths use scanIncomingDetailed + commitScanCheckpoint via
      // the Monero block-scan strategy so the cursor advances only AFTER
      // ingest; this wrapper keeps the generic port contract working for
      // tests and ad-hoc callers.
      const { transfers, scannedTo } = await this.scanIncomingDetailed({
        chainId,
        addresses,
        tokens
      });
      await this.commitScanCheckpoint(scannedTo);
      return transfers;
    },

    async getConfirmationStatus(chainId: ChainId, txHash: TxHash) {
      if (chainId !== chain.chainId) {
        return { blockNumber: null, confirmations: 0, reverted: false };
      }
      // RPC failures THROW here — no .catch swallowing. The old code mapped
      // ANY error to the "absent" shape ({blockNumber:null, confirmations:0}),
      // which the reorg recheck reads as "tx vanished from the chain": a
      // transient public-node outage could demote/orphan a CONFIRMED
      // payment, and the detected→confirmed promotion sweep stalled on the
      // same false zeros. Callers catch per-row and skip on error; genuine
      // absence is only reported after a SUCCESSFUL lookup finds nothing.
      const [tipHeight, txs] = await Promise.all([
        daemonClient.getTipHeight(),
        daemonClient.getTransactions([String(txHash)])
      ]);
      const tx = txs[0];
      if (!tx || tx.blockHeight === null) {
        // Mempool only or genuinely unknown — caller treats as "still pending".
        return { blockNumber: null, confirmations: 0, reverted: false };
      }
      const tip = tipHeight;
      return {
        blockNumber: tx.blockHeight,
        confirmations: Math.max(0, tip - tx.blockHeight),
        // Monero has no `tx.success` flag — txs either land in a block
        // (final-via-confirmations) or stay in mempool / orphan out. Once
        // a tx is in a block, it's not reverted unless that block itself
        // reorgs (covered by reorg-recheck on the standard sweep path).
        reverted: false
      };
    },

    async getConsumedNativeFee(_chainId: ChainId, _txHash: TxHash): Promise<AmountRaw | null> {
      // Monero payouts aren't gateway-mediated in v1 — there's no failed-
      // payout fee to debit. Return null so any code path that calls this
      // for a hypothetical Monero tx silently does nothing.
      return null;
    },

    // ---- Payouts (v1 stubs) ----
    //
    // Every outbound method throws MoneroPayoutNotSupportedError. The
    // family-guard in payout.service.ts prevents these from being reached
    // in practice; this is defense in depth so a future code path that
    // didn't add the guard fails loudly rather than silently quoting/signing
    // with absent spend keys.

    async buildTransfer(_args: BuildTransferArgs): Promise<UnsignedTx> {
      throw new MoneroPayoutNotSupportedError();
    },

    async signAndBroadcast(_unsignedTx: UnsignedTx, _privateKey: string): Promise<TxHash> {
      throw new MoneroPayoutNotSupportedError();
    },

    nativeSymbol(_chainId: ChainId): TokenSymbol {
      return "XMR" as TokenSymbol;
    },

    minimumNativeReserve(_chainId: ChainId): bigint {
      return 0n;
    },

    gasSafetyFactor(_chainId: ChainId): { readonly num: bigint; readonly den: bigint } {
      // Unused in v1 (no payouts); returning 1.0× keeps the contract honest.
      return { num: 100n, den: 100n };
    },

    feeWalletCapability(_chainId: ChainId): "none" | "top-up" | "delegate" | "co-sign" {
      return "none";
    },

    async estimateGasForTransfer(_args: EstimateArgs): Promise<AmountRaw> {
      throw new MoneroPayoutNotSupportedError();
    },

    async quoteFeeTiers(_args: EstimateArgs): Promise<FeeTierQuote> {
      throw new MoneroPayoutNotSupportedError();
    },

    // ---- Balances ----
    //
    // Inbound XMR balances aren't trivially queryable from a public node
    // without re-scanning every output the merchant has ever received.
    // Defer to v2 (cache the running total during detection ticks). For
    // now return zero so admin balance dashboards render the row without
    // attempting an RPC call.

    async getBalance(_args): Promise<AmountRaw> {
      return "0" as AmountRaw;
    },

    async getAccountBalances(_args) {
      return [] as readonly { token: TokenSymbol; amountRaw: AmountRaw }[];
    }
  };
}

// ---- Convenience constructors (mirror bitcoinChainAdapter / litecoinChainAdapter) ----

export function moneroMainnetAdapter(
  args: Omit<MoneroChainAdapterConfig, "chain">
): MoneroChainAdapter {
  return moneroChainAdapter({ chain: MONERO_MAINNET_CONFIG, ...args });
}

// ---- Internal helpers ----

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex string odd length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}
