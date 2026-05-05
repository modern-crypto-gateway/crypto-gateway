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
  deriveSharedSecret,
  expectedOutputPubkey,
  parseAddress,
  viewKeyMatchesAddress
} from "./monero-crypto.js";
import { MONERO_MAINNET_CONFIG, type MoneroChainConfig } from "./monero-config.js";
import type { MoneroDaemonRpcClient, MoneroParsedTx } from "./monero-rpc.js";
import type { MoneroNetwork } from "./monero-crypto.js";

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
}

export function isMoneroChainAdapter(a: ChainAdapter): a is MoneroChainAdapter {
  return a.family === "monero";
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

    async scanIncoming({ chainId, addresses, tokens }) {
      if (chainId !== chain.chainId) return [];
      if (addresses.length === 0) return [];
      // We only credit XMR — there are no SPL/ERC-20 equivalents on Monero
      // in v1. If the caller didn't ask for XMR, nothing to do.
      const wantsXmr = tokens.includes("XMR" as TokenSymbol);
      if (!wantsXmr) return [];

      const tipHeight = await daemonClient.getTipHeight().catch((err) => {
        logger?.warn("monero scanIncoming: tip fetch failed", {
          chainId, error: err instanceof Error ? err.message : String(err)
        });
        return null;
      });
      if (tipHeight === null) return [];

      // Resolve the from-height checkpoint. Cold cache (or fresh boot)
      // starts from `restoreHeight`; otherwise resume from the persisted
      // height + 1.
      //
      // Default-zero footgun guard: if the operator left
      // MONERO_RESTORE_HEIGHT unset (default 0) AND we have no cached
      // checkpoint, snap to `tipHeight - 100` (a few hours of grace).
      // Otherwise the first detection tick attempts to scan from genesis
      // and burns ~11 days of public-node budget catching up at
      // maxBlocksPerTick=200 / minute. Operators who genuinely need to
      // backfill from an older height set MONERO_RESTORE_HEIGHT
      // explicitly to the wallet's birthday block.
      const lastScanned = (await cache.getJSON<{ h: number }>(heightCacheKey))?.h;
      let fromHeight: number;
      // Stale-checkpoint guard. If the gateway had no live Monero invoices
      // for a while (a quiet period), pollPayments skips the Monero chain
      // entirely in its for loop — scanIncoming is never called and the
      // cache `lastScanned` value freezes. When a fresh invoice is created
      // later, naive resume-from-(lastScanned+1) means the scanner has to
      // walk through the entire idle gap (potentially hundreds of blocks
      // at 40 blocks/min) before reaching the customer's actual payment
      // block. A 10h quiet gap = ~300 blocks = ~8 min of customer-facing
      // detection lag. Bad UX.
      //
      // Fix: if the gap exceeds ~2h of Monero blocks (60 blocks at 2 min
      // each), assume the gap is "no live invoices" and snap forward to
      // within the recent window. Anything in the gap that we'd skip is
      // safely either:
      //   (a) a payment to an expired invoice's subaddress — already
      //       excluded by the cron's live-invoice filter, so skipping
      //       it changes nothing; or
      //   (b) a payment to a never-issued address — cryptographically
      //       impossible to land on one of our subaddresses by accident.
      //
      // The one risk this trades against: a multi-hour RPC outage where
      // a live invoice WAS being paid during the gap, in which case the
      // snap would skip those real payments. Operators who hit this can
      // recover via POST /admin/debug/monero/force-ingest-tx with the
      // missed txHash — every "block fetch failed" log line during the
      // outage points to a window worth force-ingesting from the wallet
      // history. That's a much better default than imposing 8+ minutes
      // of detection lag on every merchant after every idle period.
      const STALE_GAP_BLOCKS = 60;
      const SNAP_WINDOW = 100;
      if (lastScanned !== undefined && tipHeight - lastScanned > STALE_GAP_BLOCKS) {
        const snappedFrom = Math.max(lastScanned + 1, tipHeight - SNAP_WINDOW);
        logger?.warn(
          "monero scanIncoming: stale checkpoint detected; snapping forward to recent window",
          { chainId, lastScanned, tipHeight, gapBlocks: tipHeight - lastScanned, snappedFromHeight: snappedFrom }
        );
        fromHeight = snappedFrom;
      } else if (lastScanned !== undefined) {
        fromHeight = lastScanned + 1;
      } else if (restoreHeight === 0) {
        fromHeight = Math.max(0, tipHeight - 100);
        logger?.warn(
          "monero scanIncoming: MONERO_RESTORE_HEIGHT not set; snapping cold-start scan to tip-100 to avoid hammering public nodes. Set MONERO_RESTORE_HEIGHT to the wallet's birthday block to backfill earlier history.",
          { chainId, snappedFromHeight: fromHeight, tipHeight }
        );
      } else {
        fromHeight = restoreHeight;
      }
      if (fromHeight > tipHeight) return []; // already up to date

      const toHeight = Math.min(tipHeight, fromHeight + maxBlocksPerTick - 1);

      // Visibility for operators who can't easily grep logs: emit one
      // info-level line per tick whenever there are Monero addresses to scan.
      // Captures tip, scan window, and address count so a "nothing detected
      // for 10 min" report can be diagnosed by tailing the gateway log.
      logger?.info("monero scanIncoming tick", {
        chainId,
        addressCount: addresses.length,
        tipHeight,
        fromHeight,
        toHeight
      });

      // Build a map (subaddressBytes → subaddressString) so we can match
      // incoming output pubkeys back to the receive address that originally
      // appeared on the invoice. The `addresses` list comes from
      // invoice_receive_addresses where family='monero' — the strings are
      // the encoded subaddresses we minted at invoice-create time.
      type AddressInfo = {
        readonly addressStr: Address;
        readonly spendPub: Uint8Array;
      };
      const subaddrInfos: AddressInfo[] = [];
      for (const a of addresses) {
        try {
          const p = parseAddress(a);
          subaddrInfos.push({ addressStr: a, spendPub: p.publicSpendKey });
        } catch {
          // Malformed address in the join — log and skip. Shouldn't happen
          // with addresses we minted ourselves, but defense in depth.
          logger?.warn("monero scanIncoming: skip malformed address", { address: a });
        }
      }
      if (subaddrInfos.length === 0) return [];

      const transfers: DetectedTransfer[] = [];

      // Progressive checkpoint: walk one block at a time, persist height after
      // each block so a CPU-limit kill mid-walk doesn't lose all progress.
      // This matters on Workers where the scheduled handler has a hard
      // ceiling — without per-block checkpointing, a long catch-up could
      // re-do the same blocks forever (each tick walks 40 blocks, gets
      // killed at block 25, never persists, next tick starts over from 0).
      let lastSuccessfullyScanned = fromHeight - 1;
      for (let height = fromHeight; height <= toHeight; height += 1) {
        let txHashes: readonly string[];
        try {
          txHashes = await daemonClient.getBlockTxHashesByHeight(height);
        } catch (err) {
          logger?.warn("monero scanIncoming: block fetch failed; halting tick", {
            chainId, height, error: err instanceof Error ? err.message : String(err)
          });
          // Don't advance the checkpoint past the failed block — next tick retries.
          break;
        }
        if (txHashes.length === 0) {
          // Empty block — still counts as fully scanned. Advance the
          // checkpoint so the next tick doesn't re-fetch this block.
          lastSuccessfullyScanned = height;
          await cache.putJSON(heightCacheKey, { h: height }, { ttlSeconds: 60 * 60 * 24 * 30 });
          continue;
        }
        let txs: readonly MoneroParsedTx[];
        try {
          txs = await daemonClient.getTransactions(txHashes);
        } catch (err) {
          logger?.warn("monero scanIncoming: tx batch fetch failed; halting tick", {
            chainId, height, error: err instanceof Error ? err.message : String(err)
          });
          break;
        }
        for (const tx of txs) {
          if (tx.isCoinbase) continue; // miner txs never credit a view-key holder
          // Each output has up to TWO candidate tx pubkeys to try:
          //   1. The primary R (tx_extra tag 0x01) — used when the sender
          //      treats the recipient as a primary address.
          //   2. additional_pubkeys[i] (tx_extra tag 0x04) — used when the
          //      sender treats output i's recipient as a subaddress.
          // Modern wallets emit (2) for every output that pays a subaddress,
          // and our gateway always pays subaddresses, so the additional
          // pubkey path is the dominant one in practice. We still try the
          // primary first because some legacy senders skip 0x04 entirely.
          let primaryTxPub: Uint8Array | null = null;
          if (tx.txPubkey.length > 0) {
            try {
              primaryTxPub = hexToBytes(tx.txPubkey);
            } catch {
              primaryTxPub = null;
            }
          }
          for (let i = 0; i < tx.outputs.length; i += 1) {
            const output = tx.outputs[i]!;
            let outputPubBytes: Uint8Array;
            try {
              outputPubBytes = hexToBytes(output.publicKey);
            } catch {
              continue;
            }
            // Build the candidate tx pubkey list for THIS output. Order:
            // primary first (cheap rejection for legacy txs), then this
            // output's additional pubkey if available.
            const candidates: Uint8Array[] = [];
            if (primaryTxPub !== null) candidates.push(primaryTxPub);
            const addtl = tx.additionalPubkeys[i];
            if (addtl !== undefined && addtl.length > 0) {
              try {
                candidates.push(hexToBytes(addtl));
              } catch {
                // ignore — primary candidate may still match
              }
            }
            if (candidates.length === 0) continue;

            let matched: AddressInfo | null = null;
            let matchedSharedSecret: Uint8Array | null = null;
            outer: for (const txPubBytes of candidates) {
              let sharedSecret: Uint8Array;
              try {
                sharedSecret = deriveSharedSecret({
                  viewKeySecret: viewKey,
                  txPubkey: txPubBytes,
                  outputIndex: i
                });
              } catch {
                continue;
              }
              for (const info of subaddrInfos) {
                const expected = expectedOutputPubkey({
                  sharedSecret,
                  subaddressSpendPub: info.spendPub
                });
                if (bytesEqual(expected, outputPubBytes)) {
                  matched = info;
                  matchedSharedSecret = sharedSecret;
                  break outer;
                }
              }
            }
            if (!matched || !matchedSharedSecret) continue;
            const sharedSecret = matchedSharedSecret;
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
              amountRaw = decodeRctAmount({ sharedSecret, encryptedAmount: encrypted });
            } catch {
              continue;
            }
            if (amountRaw <= 0n) continue;
            const blockHeight = tx.blockHeight ?? height;
            transfers.push({
              chainId: chain.chainId,
              txHash: tx.txHash,
              // Monero outputs aren't EVM-style "log indices" but we use
              // the same column to disambiguate multiple outputs from one
              // tx to the same subaddress (rare but possible).
              logIndex: i,
              // Monero outputs don't expose the sender to a view-key holder
              // (privacy by design — the only thing we can prove is "this
              // shared secret + our subaddress reproduces this output").
              // Use the MONERO_UNKNOWN_SENDER sentinel rather than empty
              // string because DetectedTransferSchema enforces min(1) on
              // every address field. canonicalizeAddress short-circuits on
              // this exact value so it round-trips through ingest unchanged.
              fromAddress: MONERO_UNKNOWN_SENDER as Address,
              toAddress: matched.addressStr,
              token: "XMR" as TokenSymbol,
              amountRaw: amountRaw.toString() as AmountRaw,
              blockNumber: blockHeight,
              confirmations: Math.max(0, tipHeight - blockHeight),
              seenAt: new Date()
            });
          }
        }
        // Block fully processed — persist progress before advancing.
        // Crash/kill after this point loses at most the next block's work.
        lastSuccessfullyScanned = height;
        await cache.putJSON(heightCacheKey, { h: height }, { ttlSeconds: 60 * 60 * 24 * 30 });
      }

      // Final checkpoint write is technically redundant (the per-block
      // write above already covers `toHeight` after a clean walk) but kept
      // for clarity about the exit invariant: after scanIncoming returns,
      // `lastSuccessfullyScanned` reflects the highest block we know is
      // fully processed.
      void lastSuccessfullyScanned;

      // Tick-summary log — pairs with the `monero scanIncoming tick` line
      // emitted at the start of the scan. Together they let an operator
      // tail and answer: "did the cron walk the block I expected? did
      // anything match? how many credits did it find?" without having to
      // build a separate per-output debug stream. transfersFound stays at
      // INFO when > 0 (rare event, worth surfacing); idle ticks log at
      // DEBUG so they don't drown out the production log stream.
      const summaryFields = {
        chainId,
        fromHeight,
        toHeight,
        addressCount: addresses.length,
        transfersFound: transfers.length
      };
      if (transfers.length > 0) {
        logger?.info("monero scanIncoming summary (matches found)", summaryFields);
      } else {
        logger?.debug("monero scanIncoming summary (no matches)", summaryFields);
      }

      return transfers;
    },

    async getConfirmationStatus(chainId: ChainId, txHash: TxHash) {
      if (chainId !== chain.chainId) {
        return { blockNumber: null, confirmations: 0, reverted: false };
      }
      const [tipHeight, txs] = await Promise.all([
        daemonClient.getTipHeight().catch(() => null),
        daemonClient.getTransactions([String(txHash)]).catch(() => [])
      ]);
      const tx = txs[0];
      if (!tx || tx.blockHeight === null) {
        // Mempool only or unknown — caller treats as "still pending".
        return { blockNumber: null, confirmations: 0, reverted: false };
      }
      const tip = tipHeight ?? tx.blockHeight;
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
