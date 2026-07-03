import { HDKey } from "@scure/bip32";
import { cachedMnemonicToSeed } from "../../crypto/mnemonic-cache.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { ChainAdapter, FeeTierQuote, GasPrepResult } from "../../../core/ports/chain.port.ts";
import type { Logger } from "../../../core/ports/logger.port.js";
import type { EnergyRentalEstimate, EnergyRentalProvider } from "../../energy-rental/energy-rental.port.js";
import type { Address, ChainId, TxHash } from "../../../core/types/chain.js";
import type { AmountRaw } from "../../../core/types/money.js";
import type { TokenSymbol } from "../../../core/types/token.js";
import { findToken, TOKEN_REGISTRY } from "../../../core/types/token-registry.js";
import type { DetectedTransfer } from "../../../core/types/transaction.js";
import type { BuildTransferArgs, EstimateArgs, UnsignedTx } from "../../../core/types/unsigned-tx.js";
import { bytesToHex } from "../../crypto/subtle.js";
import {
  decodeTronAddress,
  hexAddressToTron,
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

// Tron-family extension surface. The Tron adapter implements both
// ChainAdapter (the cross-family contract) and this interface (Tron-only
// resource / delegation operations). Admin endpoints that touch Stake 2.0
// look for this shape via `isTronChainAdapter()` and call the backend
// directly — avoids pushing Tron-specific methods onto the generic
// ChainAdapter port.
export interface TronChainAdapter extends ChainAdapter {
  readonly family: "tron";
  tronBackend(chainId: number): TronRpcBackend;
}

export function isTronChainAdapter(adapter: ChainAdapter): adapter is TronChainAdapter {
  return adapter.family === "tron" && typeof (adapter as unknown as { tronBackend?: unknown }).tronBackend === "function";
}

const DEFAULT_FEE_LIMIT_SUN = 100_000_000; // 100 TRX cap per payout tx (generous, rarely consumed)
// Hard energy cap for TRC-20 `transfer(address,uint256)`. Standard SRC-20
// transfers use 14k-65k energy in the common case but real on-chain payments
// have been observed at 106k+ (USDT to a fresh destination, plus contract-
// internal blacklist/freeze checks). 250k is the refusal ceiling: above this
// the target is almost certainly NOT a standard TRC-20 (proxy, fee-on-transfer,
// or a loop contract that would burn the full fee_limit). Refusing to
// broadcast turns a silent fee burn into a loud build-time error.
const MAX_EXPECTED_TRANSFER_ENERGY = 250_000;

// Floor for the TRC-20 `transfer` energy estimate. `triggerConstantContract`
// underreports real on-chain energy across the board, but especially when:
//   - the destination is a fresh account (Tron charges a 1 TRX activation
//     fee + extra cold-slot SSTORE that the simulation doesn't include)
//   - cold-slot writes on the recipient's balance slot (~15-20k extra energy)
//   - USDT-specific overhead (blacklist + freeze + deprecated() guards)
// Production observations: a USDT transfer where simulation reported ~14k
// energy actually burned > 106 782 energy on chain (10.68 TRX consumed at
// 100 SUN/energy, then OUT_OF_ENERGY revert). Without a floor, the planner
// sizes the top-up off the simulation, the source runs out of TRX mid-
// execution, the tx reverts, the source's TRX is consumed, USDT stays stuck.
//
// 200 000 covers observed real on-chain costs (~107k seen in production)
// with comfortable headroom for the 1 TRX account-activation fee, occasional
// USDT freeze-list checks, and SR-voted energyFee changes between estimate
// and broadcast. Sized just below MAX_EXPECTED_TRANSFER_ENERGY so any
// simulation reporting MORE than the floor still has room to grow into the
// ceiling before being refused. At the current 100 SUN/energy this reserves
// ~20 TRX per payout (×1.30 safety ×1.20 cushion = ~31 TRX top-up); high
// for warm-slot transfers but the right floor for reliability.
const MIN_EXPECTED_TRC20_ENERGY = 135_000;
const DEFAULT_ACCOUNT_INDEX = 0;
const DEFAULT_CHANGE_INDEX = 0;

// ---- Energy-rental sizing (prepareGasForBroadcast) ----
//
// Rental sizing deliberately does NOT reuse MIN_EXPECTED_TRC20_ENERGY. That
// floor (×1.30 safety) exists to size BURN-path TRX reservations, where the
// reserve is refunded at reconciliation if unspent — over-reserving is free.
// Rented energy is PAID for up front, so renting the reservation-sized 135k
// for a warm 65k transfer would hand most of the rental savings back.
//
// Instead we size off the two deterministic USDT/TRC-20 cost classes, picked
// by reading the receiver's token balance right before renting:
//   - warm receiver (already holds the token): ~64.3k energy observed —
//     the balance-slot SSTORE is a 5k "non-zero → non-zero" write.
//   - cold receiver (zero balance): ~130.3k — the slot write is the 20k
//     "zero → non-zero" class plus contract-internal first-touch overhead.
// We take max(simulation, class constant) so a contract that genuinely
// reports MORE than the class cost is still fully covered, then add a small
// buffer for the dynamic-energy-model drift: popular contracts (USDT) carry
// an energy_factor penalty recalculated every 6h maintenance cycle, so the
// cost observed at sizing time can grow a few percent by broadcast.
//
// The buffer is deliberately THIN. An undershoot is not fatal: Tron spends
// the delegated energy first and burns the source's TRX only for the GAP
// (at the chain rate, under fee_limit) — and the planner's burn-path
// reservation always covers that worst case. The expected gap-burn from a
// rare maintenance-cycle drift is far smaller than paying rent on a fat
// buffer for every payout: production data showed the original 8% buffer
// over-buying ~11k energy (~0.75 TRX) on a cold USDT transfer whose class
// constant alone already exceeded the actual on-chain consumption.
const RENTAL_ENERGY_WARM_RECEIVER = 65_000;
const RENTAL_ENERGY_COLD_RECEIVER = 131_000;
const RENTAL_ENERGY_BUFFER_PERCENT = 2;

// Never bid above this fraction of the chain's live burn rate (getEnergyFee,
// 100 SUN/unit today) for rented energy. Passed to the provider as a hard
// server-side price ceiling (maxPriceAccepted), so a filled order is
// mathematically guaranteed ≥10% cheaper per unit than burning. Market rates
// run ~60-70% of burn, so this cap doesn't reject normal fills — it only
// guards squeezed markets.
const RENTAL_MAX_UNIT_PRICE_PERCENT = 90n;

// Don't bother renting unless the estimate beats the burn path by at least
// this much (SUN). Sub-0.5-TRX wins aren't worth the added provider round
// trips + fill latency on the executor hot path; skipping rental === the
// pre-rental burn behavior, so this can never make a payout dearer.
const RENTAL_DEFAULT_MIN_SAVINGS_SUN = 500_000n;

// 10 minutes. Live TronSave order-book reads (2026-06) priced 131k energy at
// 65 SUN for 600s vs 67.25 for 1h vs 86.5 for 1 day — sub-day pricing is
// mostly flat with a small duration premium, so 10min is the cheapest bucket
// that still matters. Duration is only load-bearing between fill and
// broadcast (seconds in the happy path — energy, once consumed, doesn't care
// when the delegation expires) and 600s still covers a deferred retry on the
// next executor tick. Going shorter saves ~nothing further.
const RENTAL_DEFAULT_DURATION_SEC = 600;

// Fill + on-chain-visibility polling. All-or-nothing orders match against
// live supply at creation, so fills land in seconds; the timeout exists for
// provider hiccups, after which the payout defers to the next tick rather
// than burning on top of a paid order.
const RENTAL_DEFAULT_FILL_TIMEOUT_MS = 30_000;
const RENTAL_DEFAULT_VERIFY_TIMEOUT_MS = 15_000;
const RENTAL_DEFAULT_POLL_INTERVAL_MS = 3_000;

// Bandwidth a TRC-20 transfer consumes (~345 bytes) with margin. Used by the
// rental-aware free-gas probe: a source whose remaining daily bandwidth
// covers the tx bytes needs NO liquid TRX at plan time when energy is rented
// at broadcast (every activated account regenerates 600 free bandwidth/day).
const TRON_BANDWIDTH_PER_TRANSFER = 400;

// Sun burned for bandwidth when the free allowance is exhausted
// (~345 bytes × 1000 SUN/byte, rounded up).
const TRON_BANDWIDTH_BURN_SUN = 350_000n;

// TTL for the prepareGasForBroadcast → buildTransfer sizing handoff. Both
// run in the same executor pass seconds apart; the TTL only bounds staleness
// across crashed/retried passes.
const PREP_SIZING_TTL_MS = 120_000;

// TTL for the per-chain latest-block cache used inside getConfirmationStatus.
// One cron tick fans out one info+nowblock query per active confirming tx;
// nowblock is identical for every tx in that tick, so coalesce calls within
// ~10s. Tron block time is ~3s, so this is at most one stale-by-3-blocks read.
const NOW_BLOCK_CACHE_TTL_MS = 10_000;

// TTL for the energyFee chain-parameter cache. Tron's energy price only
// changes via a Super Representative vote (rare — the 420→210 change took
// years), so caching for a minute keeps quoteFeeTiers from hitting an RPC
// on every single /payouts/estimate call without meaningfully stale data.
const CHAIN_PARAM_CACHE_TTL_MS = 60_000;

// Fallback SUN-per-energy rate used when /wallet/getchainparameters is
// unavailable. 100 SUN/energy is the current mainnet value (post the
// round-2 SR halving in late 2024). The live rate from getChainParameters
// takes precedence; this fallback only applies during RPC flaps. Sizing it
// LOW (matches reality) is safer than HIGH for fee estimation here because
// the energy floor (MIN_EXPECTED_TRC20_ENERGY) is the dominant term in the
// quote, and a too-high fallback rate would over-quote and reject viable
// sources during transient RPC failures.
const ENERGY_FEE_FALLBACK_SUN = 100n;

// Dust threshold for address-poisoning spam on Tron. TRX sun and USDT/USDC
// base units (both 6 decimals on Tron) below this are dropped at scan time.
// Rationale: legitimate payment flows on Tron never send sub-milli-unit
// amounts — wallets don't expose that precision in their UIs. The spam wave
// we observe uses amountRaw="1" (1 sun / 0.000001 TRX) explicitly to defeat
// a naive "> 0" filter. 1000 base units = 0.001 token ≈ $0.0003 at current
// prices, comfortably below the smallest real checkout amount (typically
// $0.01+). Applies uniformly to TRX and all 6-decimal TRC-20 tokens.
const TRON_DUST_THRESHOLD = 1_000n;

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
  // Cap on the lookback window for `scanIncoming`, ms. Defaults to 30 days
  // so /admin/audit-address (which passes a 30-day sinceMs by default) can
  // actually see its requested window. The cap exists as a runaway guard
  // against "rewind to epoch" calls; 30 days still prevents that while
  // accommodating realistic forensic use. Poll-path callers (rpc-poll) pass
  // a much shorter sinceMs via the cached checkpoint, so this cap only ever
  // matters for the audit path.
  maxScanWindowMs?: number;
  // Fee limit in sun for payout txs. Defaults to 100 TRX.
  feeLimitSun?: number;
  // Optional energy-rental market integration. When set, the executor's
  // prepareGasForBroadcast hook rents delegated energy for TRC-20 payouts
  // whenever that's strictly cheaper than burning TRX — and falls back to
  // the burn path on any provider failure. Absent = pure burn (pre-rental
  // behavior).
  energyRental?: TronEnergyRentalConfig;
}

export interface TronEnergyRentalConfig {
  // Rental markets to quote. Every provider estimates the same shortfall
  // and the cheapest viable quote wins the order — the others are the
  // fallback when its book is thin or its API is down. Order in the array
  // is irrelevant (selection is by price).
  providers: readonly EnergyRentalProvider[];
  // Absolute operator cap in SUN per energy unit, applied on top of the
  // dynamic ceiling (RENTAL_MAX_UNIT_PRICE_PERCENT of the live burn rate).
  maxUnitPriceSun?: number;
  // Rental duration (default 10min — see RENTAL_DEFAULT_DURATION_SEC).
  durationSec?: number;
  // Minimum SUN the rental must save vs burning before it's attempted.
  minSavingsSun?: bigint;
  fillTimeoutMs?: number;
  verifyTimeoutMs?: number;
  pollIntervalMs?: number;
  logger?: Logger;
}

export function tronChainAdapter(config: TronChainConfig = {}): TronChainAdapter {
  const chainIds = (config.chainIds ?? [TRON_MAINNET_CHAIN_ID]) as readonly ChainId[];
  const accountIndex = config.accountIndex ?? DEFAULT_ACCOUNT_INDEX;
  const feeLimit = config.feeLimitSun ?? DEFAULT_FEE_LIMIT_SUN;
  const maxScanWindowMs = config.maxScanWindowMs ?? 30 * 24 * 60 * 60 * 1000;

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

  const nowBlockCache = new Map<number, { value: number; fetchedAt: number }>();
  async function getCachedNowBlock(chainId: number, client: TronRpcBackend): Promise<number> {
    const now = Date.now();
    const entry = nowBlockCache.get(chainId);
    if (entry && now - entry.fetchedAt < NOW_BLOCK_CACHE_TTL_MS) return entry.value;
    const block = await client.getNowBlock();
    const number = block.block_header.raw_data.number;
    nowBlockCache.set(chainId, { value: number, fetchedAt: now });
    return number;
  }

  // Cache the chain's current SUN-per-energy price. Queried from
  // /wallet/getchainparameters at most once per minute per chain.
  const energyFeeCache = new Map<number, { value: bigint; fetchedAt: number }>();
  async function getCachedEnergyFee(chainId: number, client: TronRpcBackend): Promise<bigint> {
    const now = Date.now();
    const entry = energyFeeCache.get(chainId);
    if (entry && now - entry.fetchedAt < CHAIN_PARAM_CACHE_TTL_MS) return entry.value;
    try {
      const params = await client.getChainParameters();
      const raw = params.params["getEnergyFee"];
      const energyFee = typeof raw === "number" && raw > 0 ? BigInt(raw) : ENERGY_FEE_FALLBACK_SUN;
      energyFeeCache.set(chainId, { value: energyFee, fetchedAt: now });
      return energyFee;
    } catch {
      // RPC flap — don't poison the cache with the fallback; just return it
      // for this call and retry next time. A chain-param read failure is
      // transient; stamping a permanent fallback would mask a real recovery.
      return ENERGY_FEE_FALLBACK_SUN;
    }
  }

  // Sizing handoff from prepareGasForBroadcast to buildTransfer's
  // burn-coverage guard (same executor pass, seconds apart). Without the
  // handoff the guard would have to assume the conservative
  // MIN_EXPECTED_TRC20_ENERGY floor, demanding burn-level TRX even on
  // sources whose rented energy covers the precise (smaller) need.
  // `verified` marks entries where prep CONFIRMED on-chain that the source's
  // delegated energy covers `required` (covered/rented outcomes) — the
  // burn-coverage guard then skips its own resource + balance reads, saving
  // 1-2 RPCs on every rented broadcast.
  const prepSizingCache = new Map<string, { required: number; verified: boolean; at: number }>();
  function prepSizingKey(args: {
    chainId: number;
    fromAddress: string;
    toAddress: string;
    token: string;
    amountRaw: string;
  }): string {
    return `${args.chainId}:${args.fromAddress}:${args.toAddress}:${args.token}:${args.amountRaw}`;
  }
  function rememberPrepSizing(key: string, required: number, verified = false): void {
    if (prepSizingCache.size > 1024) {
      const now = Date.now();
      for (const [k, v] of prepSizingCache) {
        if (now - v.at > PREP_SIZING_TTL_MS) prepSizingCache.delete(k);
      }
    }
    prepSizingCache.set(key, { required, verified, at: Date.now() });
  }
  function recallPrepSizing(key: string): { required: number; verified: boolean } | null {
    const entry = prepSizingCache.get(key);
    if (entry === undefined || Date.now() - entry.at > PREP_SIZING_TTL_MS) return null;
    return { required: entry.required, verified: entry.verified };
  }

  return {
    family: "tron",
    supportedChainIds: chainIds,

    // Tron-only extension: exposes the configured RPC backend so admin
    // endpoints handling Stake 2.0 ops (freeze / delegate / resources) can
    // talk to it without rebuilding the same backend from scratch. Guarded
    // at the call site by `isTronChainAdapter`.
    tronBackend(chainId: number): TronRpcBackend {
      return getClient(chainId);
    },

    // ---- Addresses ----

    deriveAddress(seed: string, index: number) {
      // BIP44 path for Tron = m/44'/195'/{account}'/{change}/{index}. Coin type 195.
      const seedBytes = cachedMnemonicToSeed(seed);
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

    addressFromPrivateKey(privateKey: string): Address {
      // Reuse the exact primitive `deriveAddress` already uses. Unlike EVM,
      // Tron's privateKey-to-address path doesn't need any further
      // normalization — privateKeyToTronAddress handles the `0x` prefix
      // transparently.
      const normalized = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
      return privateKeyToTronAddress(normalized) as Address;
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

      // Resolve requested token symbols against the registry, then split into
      // TRC-20 (contractAddress !== null) and native TRX (contractAddress === null).
      // Each takes a different TronGrid endpoint so we fan out separately.
      const targets = tokens
        .map((sym) => findToken(chainId as ChainId, sym))
        .filter((t): t is NonNullable<typeof t> => t !== null);
      const trc20Targets = targets.filter((t) => t.contractAddress !== null);
      const wantsNative = targets.some((t) => t.contractAddress === null);

      const allowedContracts = new Set(trc20Targets.map((t) => t.contractAddress!));
      const addressSet = new Set(addresses.map((a) => a));
      const symbolByContract = new Map(trc20Targets.map((t) => [t.contractAddress!, t.symbol]));

      // Fan out: one listTrc20Transfers call per (address x contract). TronGrid
      // doesn't offer a multi-contract filter, so this is the natural shape.
      const calls: Array<Promise<readonly DetectedTransfer[]>> = [];
      for (const addr of addresses) {
        for (const target of trc20Targets) {
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
                  // Drop dust TRC-20 address-poisoning spam. Common on Tron:
                  // attackers blast 0- or 1-unit USDT/USDC transfers (1 unit
                  // = 0.000001 stablecoin) to pollute wallet tx histories.
                  // A naive "> 0" filter is defeated by amount=1; threshold
                  // at 0.001 token (TRON_DUST_THRESHOLD) blocks the pattern
                  // without touching any plausible payment amount.
                  .filter((t) => {
                    try { return BigInt(t.value) >= TRON_DUST_THRESHOLD; }
                    catch { return false; }
                  })
                  .map<DetectedTransfer>((t) => ({
                    chainId: chainId as ChainId,
                    txHash: t.transaction_id,
                    logIndex: null, // Tron TRC-20 transfers are 1 per tx in the v1 endpoint; no logIndex concept
                    fromAddress: t.from,
                    toAddress: t.to,
                    token: symbolByContract.get(t.token_info.address) ?? target.symbol,
                    amountRaw: t.value as AmountRaw,
                    // TronGrid's /trc20 endpoint returns `block` undefined for
                    // unconfirmed txs (it has no `only_confirmed` filter — that's
                    // only on /transactions). Coerce to null so DetectedTransfer's
                    // Zod schema (blockNumber: nullable number) accepts it; the
                    // sweeper's getConfirmationStatus will fill in the real block
                    // once the tx confirms. Without this, a single in-flight TRC-20
                    // tx fails Zod and aborts the entire scan batch.
                    blockNumber: t.block ?? null,
                    // `v1/.../transactions/trc20` doesn't expose a confirmation count directly.
                    // We record what we can see and let the sweeper call `getConfirmationStatus`
                    // for authoritative depth on each tx.
                    confirmations: 0,
                    seenAt: new Date(t.block_timestamp),
                    // block_timestamp is the real on-chain block time; trust it
                    // only once the tx is in a block (block present).
                    onchainTime: t.block != null ? new Date(t.block_timestamp) : null
                  }))
              )
          );
        }
      }

      // Native TRX path: `/v1/accounts/{addr}/transactions` already returns
      // one row per native TransferContract crediting `addr` (the backend
      // does the filtering). TronGrid emits hex 41-prefix addresses; convert
      // back to base58check so they match invoice receive addresses.
      if (wantsNative) {
        for (const addr of addresses) {
          calls.push(
            client.listTrxTransfers(addr, { minTimestamp, limit: 200 }).then((transfers) =>
              transfers.flatMap<DetectedTransfer>((t) => {
                let toCanonical: string;
                let fromCanonical: string;
                try {
                  toCanonical = hexAddressToTron(t.to);
                  fromCanonical = hexAddressToTron(t.from);
                } catch {
                  return [];
                }
                if (!addressSet.has(toCanonical as Address)) return [];
                // Drop dust native TRX address-poisoning spam. The active
                // spam pattern sends amountRaw="1" (1 sun) specifically to
                // slip past a naive "> 0" filter. TRON_DUST_THRESHOLD pins
                // the floor at 0.001 TRX — well below the smallest real
                // checkout amount, well above the spam traffic.
                let amount: bigint;
                try { amount = BigInt(t.value); } catch { return []; }
                if (amount < TRON_DUST_THRESHOLD) return [];
                return [
                  {
                    chainId: chainId as ChainId,
                    txHash: t.txID,
                    logIndex: null,
                    fromAddress: fromCanonical,
                    toAddress: toCanonical,
                    token: "TRX" as TokenSymbol,
                    amountRaw: t.value as AmountRaw,
                    // Parallel to the TRC-20 branch: TronGrid's tx listing can
                    // return undefined blockNumber for unconfirmed txs. Coerce
                    // to null so Zod accepts it; sweeper fills later.
                    blockNumber: t.blockNumber ?? null,
                    confirmations: 0,
                    seenAt: new Date(t.blockTimestamp),
                    onchainTime: t.blockNumber != null ? new Date(t.blockTimestamp) : null
                  }
                ];
              })
            )
          );
        }
      }

      const arrays = await Promise.all(calls);
      return arrays.flat();
    },

    async getConfirmationStatus(chainId: ChainId, txHash: TxHash) {
      const client = getClient(chainId);
      const [info, latest] = await Promise.all([
        client.getTransactionInfo(txHash),
        getCachedNowBlock(chainId, client)
      ]);
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

    async getConsumedNativeFee(chainId: ChainId, txHash: TxHash): Promise<AmountRaw | null> {
      // Tron separates the total fee across three fields:
      //   - `fee`                    (account activation, contract deploy)
      //   - `receipt.net_fee`        (bandwidth burned past the free allowance)
      //   - `receipt.energy_fee`     (energy burned past the delegation pool)
      // Any of them can be zero on a given tx; sum them to get the total
      // sun actually debited from the owner. Unlike EVM, Tron returns the
      // energy/net fees even when the tx reverted due to out-of-energy —
      // which is exactly the case this path handles.
      const client = getClient(chainId);
      const info = await client.getTransactionInfo(txHash).catch(() => null);
      if (!info || info.blockNumber === undefined) return null;
      const fee = info.fee ?? 0;
      const netFee = info.receipt?.net_fee ?? 0;
      const energyFee = info.receipt?.energy_fee ?? 0;
      return String(fee + netFee + energyFee) as AmountRaw;
    },

    // ---- Payouts ----

    // Pre-broadcast energy acquisition (see ChainAdapter.prepareGasForBroadcast
    // for the cross-family contract). Rents delegated energy from the
    // configured market when — and only when — the all-in rental cost beats
    // burning TRX at the chain rate by at least `minSavingsSun`. Every other
    // outcome (no provider, native TRX payout, market too thin, price too
    // high, provider error) resolves to {kind:"none"}: the payout proceeds on
    // the exact pre-rental burn path, whose worst case the planner has
    // already reserved for. Rental can therefore lower a payout's cost but
    // structurally cannot raise it.
    async prepareGasForBroadcast(args: BuildTransferArgs): Promise<GasPrepResult> {
      const rental = config.energyRental;
      if (rental === undefined || rental.providers.length === 0) return { kind: "none" };
      const log = rental.logger;
      try {
        // Native TRX payouts don't consume energy — gas IS the asset.
        const token = findToken(args.chainId as ChainId, args.token);
        if (!token || token.contractAddress === null) return { kind: "none" };
        const client = getClient(args.chainId);

        // Size the rental off the receiver's actual state, not the burn-
        // reservation floor (see the RENTAL_ENERGY_* comment block). The
        // four reads are independent — one concurrent round trip instead of
        // four sequential ones. A doomed transfer (insufficient balance /
        // blacklisted account) still rejects the whole batch via the
        // simulation, before any provider money moves.
        const [simulated, receiverBalance, resources, energyFeeSun] = await Promise.all([
          simulateTrc20TransferEnergy(client, token.contractAddress, args),
          readTrc20Balance(client, args.toAddress, token.contractAddress),
          client.getAccountResources(args.fromAddress),
          getCachedEnergyFee(args.chainId, client)
        ]);
        const classEnergy = receiverBalance > 0n ? RENTAL_ENERGY_WARM_RECEIVER : RENTAL_ENERGY_COLD_RECEIVER;
        const required = Math.ceil(
          (Math.max(simulated, classEnergy) * (100 + RENTAL_ENERGY_BUFFER_PERCENT)) / 100
        );
        // Hand the precise sizing to buildTransfer's burn-coverage guard so
        // it doesn't fall back to the (much larger) reservation floor.
        rememberPrepSizing(prepSizingKey(args), required);
        // Above the standard-TRC-20 ceiling, buildTransfer is going to refuse
        // the tx anyway — don't spend rental money ahead of that refusal.
        if (required > MAX_EXPECTED_TRANSFER_ENERGY) return { kind: "none" };

        // Only rent the shortfall: operator-staked delegations, leftover
        // energy from a previous rental on this source, and the daily
        // regeneration all count toward the transfer for free.
        const shortfall = required - resources.energyAvailable;
        if (shortfall <= 0) {
          // On-chain coverage confirmed — let buildTransfer's guard skip
          // its duplicate resource/balance reads.
          rememberPrepSizing(prepSizingKey(args), required, true);
          return { kind: "covered" };
        }

        // The number to beat: burning the shortfall at the live chain rate.
        const burnCostSun = BigInt(shortfall) * energyFeeSun;
        const dynamicCapSun = Number((energyFeeSun * RENTAL_MAX_UNIT_PRICE_PERCENT) / 100n);
        const maxUnitPriceSun = Math.min(dynamicCapSun, rental.maxUnitPriceSun ?? Number.POSITIVE_INFINITY);
        if (!Number.isFinite(maxUnitPriceSun) || maxUnitPriceSun < 1) return { kind: "none" };

        const durationSec = rental.durationSec ?? RENTAL_DEFAULT_DURATION_SEC;
        const minSavingsSun = rental.minSavingsSun ?? RENTAL_DEFAULT_MIN_SAVINGS_SUN;
        // Every configured market quotes the same shortfall concurrently and
        // the cheapest viable estimate wins the order. A provider that
        // errors, or whose book can't supply the shortfall, is skipped —
        // with none left the payout takes the burn path.
        const quotes = await Promise.allSettled(
          rental.providers.map(async (candidate) => ({
            candidate,
            estimate: await candidate.estimateEnergyOrder({
              receiver: args.fromAddress,
              energyAmount: shortfall,
              durationSec
            })
          }))
        );
        const skippedProviders: Record<string, string> = {};
        const viable: Array<{ candidate: EnergyRentalProvider; estimate: EnergyRentalEstimate }> = [];
        for (let i = 0; i < quotes.length; i++) {
          const quote = quotes[i]!;
          if (quote.status === "rejected") {
            skippedProviders[rental.providers[i]!.name] =
              quote.reason instanceof Error ? quote.reason.message : String(quote.reason);
            continue;
          }
          if (quote.value.estimate.availableEnergy < shortfall) {
            skippedProviders[quote.value.candidate.name] =
              `supply ${quote.value.estimate.availableEnergy} below shortfall ${shortfall}`;
            continue;
          }
          viable.push(quote.value);
        }
        if (Object.keys(skippedProviders).length > 0) {
          log?.info("tron energy rental: providers skipped", { skipped: skippedProviders });
        }
        if (viable.length === 0) return { kind: "none" };
        viable.sort((a, b) =>
          a.estimate.totalCostSun < b.estimate.totalCostSun
            ? -1
            : a.estimate.totalCostSun > b.estimate.totalCostSun
              ? 1
              : 0
        );
        const { candidate: provider, estimate } = viable[0]!;
        if (estimate.totalCostSun + minSavingsSun > burnCostSun) {
          log?.info("tron energy rental skipped: not cheaper than burning", {
            provider: provider.name,
            shortfall,
            rentalCostSun: estimate.totalCostSun.toString(),
            burnCostSun: burnCostSun.toString(),
            minSavingsSun: minSavingsSun.toString()
          });
          return { kind: "none" };
        }

        // Buy. The provider enforces all-or-nothing + the unit-price ceiling
        // server-side, so a created order is already guaranteed cheaper than
        // the burn it replaces.
        const pollMs = rental.pollIntervalMs ?? RENTAL_DEFAULT_POLL_INTERVAL_MS;
        let orderId: string;
        try {
          ({ orderId } = await provider.createEnergyOrder({
            receiver: args.fromAddress,
            energyAmount: shortfall,
            durationSec,
            maxUnitPriceSun
          }));
        } catch (err) {
          // Ambiguity guard: a transport error here can't tell us whether
          // the order was created server-side before the connection died.
          // If it was, the delegation lands within ~one block — re-read the
          // source's resources once before falling back to burn, so a paid
          // order can't be doubled by a burn in the same tick. The common
          // failure (provider down / order rejected) passes straight
          // through to the burn path after this single recheck.
          await sleep(pollMs);
          const recheck = await client.getAccountResources(args.fromAddress).catch(() => null);
          if (recheck !== null && recheck.energyAvailable >= required) {
            log?.info("tron energy rental order errored but delegation landed; using it", {
              provider: provider.name,
              error: err instanceof Error ? err.message : String(err)
            });
            rememberPrepSizing(prepSizingKey(args), required, true);
            return { kind: "covered" };
          }
          log?.warn("tron energy rental order failed; falling back to TRX burn", {
            provider: provider.name,
            error: err instanceof Error ? err.message : String(err)
          });
          return { kind: "none" };
        }

        // From this point money is committed — failures no longer fall back
        // to burn (that would pay BOTH rails). They defer the payout to the
        // next executor tick, where the landed delegation resolves "covered".
        const fillDeadline = Date.now() + (rental.fillTimeoutMs ?? RENTAL_DEFAULT_FILL_TIMEOUT_MS);
        let paidSun: bigint | null = null;
        let filled = false;
        for (;;) {
          const status = await provider.getOrderStatus(orderId).catch(() => null);
          if (status !== null && status.fulfilledPercent >= 100) {
            filled = true;
            paidSun = status.paidSun;
            break;
          }
          if (Date.now() >= fillDeadline) break;
          await sleep(pollMs);
        }
        if (!filled) {
          // Order-book providers (TEM) can leave an order sitting unfilled.
          // When the provider supports cancellation, reclaim the committed
          // payment and take the burn path THIS tick — strictly better than
          // deferring, and it prevents a zombie order from double-buying on
          // the next tick's retry. A failed cancel usually means the order
          // filled right at the deadline → defer; next tick sees "covered".
          if (typeof provider.cancelOrder === "function") {
            const cancelled = await provider.cancelOrder(orderId).catch(() => false);
            if (cancelled) {
              log?.warn("tron energy rental fill timed out; order cancelled, burning instead", {
                provider: provider.name,
                orderId
              });
              return { kind: "none" };
            }
          }
          return {
            kind: "deferred",
            reason: `energy rental order ${orderId} (${provider.name}) not confirmed filled within timeout`
          };
        }

        // Trust on-chain state, not the provider's word: poll the source's
        // resource view until the delegation is actually spendable. Fills
        // are on-chain DelegateResource txs that land within ~1 block (3s).
        const verifyDeadline = Date.now() + (rental.verifyTimeoutMs ?? RENTAL_DEFAULT_VERIFY_TIMEOUT_MS);
        for (;;) {
          const after = await client.getAccountResources(args.fromAddress).catch(() => null);
          if (after !== null && after.energyAvailable >= required) {
            rememberPrepSizing(prepSizingKey(args), required, true);
            const costSun = paidSun ?? estimate.totalCostSun;
            log?.info("tron energy rented for broadcast", {
              provider: provider.name,
              orderId,
              energyRented: shortfall,
              rentalCostSun: costSun.toString(),
              burnCostSun: burnCostSun.toString(),
              savedSun: (burnCostSun - costSun).toString()
            });
            return {
              kind: "rented",
              provider: provider.name,
              orderId,
              costNativeRaw: costSun.toString() as AmountRaw
            };
          }
          if (Date.now() >= verifyDeadline) break;
          await sleep(pollMs);
        }
        return {
          kind: "deferred",
          reason: `energy rental order ${orderId} (${provider.name}) filled but delegation not yet visible on-chain`
        };
      } catch (err) {
        // Pre-spend failures only (post-spend paths return "deferred" above):
        // fall back to the burn path and surface the provider error loudly.
        log?.warn("tron energy rental failed; falling back to TRX burn", {
          providers: rental.providers.map((p) => p.name),
          error: err instanceof Error ? err.message : String(err)
        });
        return { kind: "none" };
      }
    },

    async buildTransfer(args: BuildTransferArgs): Promise<UnsignedTx> {
      const token = findToken(args.chainId as ChainId, args.token);
      if (!token) {
        throw new Error(`Tron buildTransfer: unknown token ${args.token} on chain ${args.chainId}`);
      }
      const client = getClient(args.chainId);

      if (token.contractAddress === null) {
        // Native TRX — /wallet/createtransaction builds the unsigned tx directly.
        // Amount is in sun; we pass the raw value as a number because TronGrid's
        // JSON rejects strings here. BigInt -> Number is safe up to 9e15 sun
        // (9 billion TRX), which is ~100x the total supply, so no overflow risk
        // for any realistic payout.
        const amountSun = Number(args.amountRaw);
        if (!Number.isFinite(amountSun) || amountSun <= 0) {
          throw new Error(`Tron buildTransfer: invalid TRX amount ${args.amountRaw}`);
        }
        const tx = await client.createTransaction({
          owner_address: base58ToHex(args.fromAddress),
          to_address: base58ToHex(args.toAddress),
          amount: amountSun
        });
        if (tx.Error !== undefined) {
          throw new Error(`Tron createtransaction failed: ${tx.Error}`);
        }
        return {
          chainId: args.chainId as ChainId,
          raw: {
            txID: tx.txID,
            raw_data_hex: tx.raw_data_hex,
            raw_data: tx.raw_data,
            fromAddress: args.fromAddress
          },
          summary: `TRON: native TRX transfer ${args.amountRaw} sun to ${args.toAddress}`
        };
      }

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

      // Burn-coverage guard. fee_limit doesn't protect the source: a
      // broadcast whose energy isn't covered by delegation burns liquid TRX
      // mid-execution, and if THAT runs out the tx reverts OUT_OF_ENERGY
      // with the TRX consumed and the token stuck (observed in production
      // pre-floor). Verify coverage up-front and throw the
      // executor-recognized "insufficient native balance" error instead —
      // broadcastMain responds by scheduling a sponsor top-up and retrying,
      // so the payout still completes (one tick later) instead of stranding
      // funds. Sizing comes from prepareGasForBroadcast when it ran for this
      // exact transfer (rental flows delegate less than the reservation
      // floor); otherwise the conservative floor applies, which burn-path
      // reservations always cover.
      const sized = recallPrepSizing(prepSizingKey(args));
      // prepareGasForBroadcast already verified on-chain coverage for this
      // exact transfer moments ago (covered/rented outcomes) — skip the
      // duplicate resource + balance reads entirely.
      const skipGuard = sized !== null && sized.verified;
      const neededEnergy =
        sized !== null ? sized.required : Math.max(resp.energy_used ?? 0, MIN_EXPECTED_TRC20_ENERGY);
      const resources = skipGuard
        ? null
        : await client.getAccountResources(args.fromAddress).catch(() => null);
      // RPC flap on the resource read → don't block the broadcast on a
      // guard; the chain remains the final arbiter as before this check.
      if (resources !== null) {
        const energyGap = neededEnergy - resources.energyAvailable;
        if (energyGap > 0) {
          const energyFeeSun = await getCachedEnergyFee(args.chainId, client);
          const bandwidthCushion =
            resources.bandwidthAvailable >= TRON_BANDWIDTH_PER_TRANSFER ? 0n : TRON_BANDWIDTH_BURN_SUN;
          const burnNeededSun = BigInt(energyGap) * energyFeeSun + bandwidthCushion;
          const acct = await client.getAccount(args.fromAddress).catch(() => null);
          let balanceSun: bigint | null = null;
          if (acct !== null) {
            try {
              balanceSun = BigInt(acct.balanceSun);
            } catch {
              balanceSun = null;
            }
          }
          if (balanceSun !== null && balanceSun < burnNeededSun) {
            throw new Error(
              `Tron buildTransfer: insufficient native balance on ${args.fromAddress} to cover the energy burn ` +
                `(~${burnNeededSun} sun needed for a ${energyGap}-energy gap, balance ${balanceSun} sun). ` +
                `Energy rental did not cover this broadcast; a gas top-up is required.`
            );
          }
        }
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

    async signAndBroadcast(
      unsignedTx: UnsignedTx,
      privateKey: string,
      options?: { readonly feePayerPrivateKey?: string }
    ): Promise<TxHash> {
      if (options?.feePayerPrivateKey !== undefined) {
        // Tron uses resource delegation, not co-signing: a fee wallet stakes
        // TRX and pre-delegates energy via DelegateResource. At broadcast
        // time the tx has a single signer (the source). Supplying a
        // feePayerPrivateKey here is a caller bug — Tron has no co-sign path.
        throw new Error(
          "Tron signAndBroadcast: feePayerPrivateKey is not supported on Tron. " +
            "Tron has no co-sign capability — fee wallets provide resources via DelegateResource. " +
            "If you see this error, the domain layer is treating Tron like a co-sign chain (Solana)."
        );
      }
      const raw = unsignedTx.raw as { txID: string; raw_data_hex: string; raw_data: unknown };
      // Tron signs the sha256 of the raw_data bytes with secp256k1. The txID
      // is already sha256(raw_data_hex) per TronGrid, so we sign that
      // directly with `prehash: false` (re-hashing would corrupt the sig).
      const privBytes = hexToBytesLocal(privateKey);
      const txIdBytes = hexToBytesLocal(raw.txID);
      // Noble 2.x returns a 65-byte array in `[recovery, r..., s...]` order
      // when format='recovered'. Tron's `/wallet/broadcasttransaction`
      // expects signatures in `r || s || v` order (recovery byte LAST).
      // Feeding Noble's output directly to Tron makes java-tron's
      // SignatureValidator read r, s and v from misaligned byte ranges —
      // surfaced as "Validate signature error: ... Header byte out of range"
      // where the "header" byte is whatever garbage the misalignment
      // happens to produce. Rearrange to the layout Tron wants.
      const nobleSig = secp256k1.sign(txIdBytes, privBytes, { format: "recovered", prehash: false, lowS: true });
      if (nobleSig.length !== 65) {
        throw new Error(`Tron signing: unexpected noble signature length ${nobleSig.length}, want 65`);
      }
      const tronSig = new Uint8Array(65);
      tronSig.set(nobleSig.subarray(1, 33), 0);  // r
      tronSig.set(nobleSig.subarray(33, 65), 32); // s
      tronSig[64] = nobleSig[0]!;                  // v (recovery)
      const signatureHex = bytesToHex(tronSig);

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

    minimumNativeReserve(_chainId: ChainId): bigint {
      // Tron has no rent-exempt concept; accounts can hold any balance.
      return 0n;
    },

    gasSafetyFactor(_chainId: ChainId) {
      // 1.30× covers the gap between `triggerConstantContract`'s reported
      // energy_used and what's actually consumed on broadcast. The simulation
      // is supposed to mirror VM execution, but in practice it underreports
      // cold-slot SSTOREs and first-time-recipient activation by 3-7×: we've
      // seen ~4k reported on USDT transfers that burned ~14-31k. The energy
      // floor (MIN_EXPECTED_TRC20_ENERGY = 135 000) handles the worst case;
      // this multiplier covers the remaining nondeterminism:
      //   - fractional SUN rounding in (energy × energyFee)
      //   - source's own token slot going cold between plan and broadcast
      //   - SR-voted energyFee changes between estimate cache hit and broadcast
      //   - bandwidth burning slightly more than the 345-byte estimate when
      //     the tx is signed with a longer expiration window
      // The previous 1.05× was based on the (incorrect) belief that
      // triggerConstantContract was exact for warm-slot transfers; production
      // payouts proved otherwise. 30% over-reservation is the right floor
      // for delegate/co-sign-less Tron payouts.
      return { num: 130n, den: 100n };
    },

    feeWalletCapability(_chainId: ChainId) {
      // Tron's near-term fee-wallet topology: the registered wallet just
      // holds TRX and acts as a sponsor for top-up txs to source pool
      // addresses. The source still burns TRX for energy/bandwidth — same
      // mechanic as a pool-address sponsor — but the operator funds one
      // dedicated wallet instead of seeding every pool address.
      //
      // The full "delegate" path (operator stakes TRX into the fee wallet,
      // calls DelegateResource per-source, planner verifies energyAvailable
      // before picking) is deferred to Phase 4. Until that ships, the
      // `delegate` capability is unsafe to enable: the picker would drop
      // the source's TRX requirement on the (incorrect) assumption that
      // delegation exists, and broadcasts would fail with "Account resource
      // insufficient error" when no delegation was actually done.
      return "top-up" as const;
    },

    async hasSufficientFreeGas(args: {
      readonly chainId: ChainId;
      readonly address: Address;
      readonly token: TokenSymbol;
    }): Promise<boolean> {
      // Native (TRX) transfers don't go through this path — gas IS the
      // asset, so "free gas" doesn't apply. Bail false to keep the
      // planner on its standard native-balance check.
      if (args.token === "TRX") return false;

      // Only TRC-20 transfers benefit from delegated energy. Anything we
      // can't price is treated as "no free gas" — the planner will fall
      // back to the standard top-up flow. Same conservative default as
      // the per-call estimate path uses.
      const token = findToken(args.chainId as ChainId, args.token);
      if (!token || token.contractAddress === null) return false;

      try {
        const client = getClient(args.chainId);
        const resources = await client.getAccountResources(args.address);
        // The MIN floor used by quoteFeeTiers is the right comparator —
        // it matches what the gateway is willing to broadcast for a
        // standard TRC-20 transfer. Sources delegated less than this
        // would still need to burn TRX to cover the gap; treating them
        // as "free gas" would set up a same-tx revert. Bandwidth is a
        // minor factor (free 600/day usually covers the ~345-byte tx),
        // so we don't gate on it; Tron's protocol charges TRX for
        // bandwidth shortfall but the source's mid-tx auto-burn there
        // is dust (~1 TRX worst case) and acceptable noise.
        if (resources.energyAvailable >= MIN_EXPECTED_TRC20_ENERGY) return true;
        // Rental-enabled: energy is sourced at broadcast time —
        // prepareGasForBroadcast rents the shortfall, and when the market
        // fails, buildTransfer's burn-coverage guard routes the payout
        // through the sponsor top-up rail instead of broadcasting
        // unfunded. The source itself therefore needs no liquid TRX at
        // plan time, ONLY bandwidth for the tx bytes (600 free/day per
        // activated account). Bandwidth-dry sources fall back to the
        // burn-path planner, which funds them with TRX they'd need for
        // bandwidth anyway. This is what eliminates the per-payout
        // ~burn-sized top-up transactions when a rental market is wired.
        if ((config.energyRental?.providers.length ?? 0) > 0) {
          return resources.bandwidthAvailable >= TRON_BANDWIDTH_PER_TRANSFER;
        }
        return false;
      } catch {
        // RPC flap on getAccountResource → return false. Planner falls
        // back to native-gas-or-top-up; a payout that would have worked
        // via delegation lands in the regular flow and either succeeds
        // (top-up sponsor available) or surfaces a clean
        // no_gas_sponsor_available, which the operator can act on.
        return false;
      }
    },

    async getBalance(args): Promise<AmountRaw> {
      const client = getClient(args.chainId);
      // Native gas (TRX) isn't in TOKEN_REGISTRY (only USDC/USDT for Tron),
      // so route around findToken when fee-wallet checks ask for "TRX".
      if (args.token === "TRX") {
        const acct = await client.getAccount(args.address);
        return acct.balanceSun as AmountRaw;
      }
      const token = findToken(args.chainId as ChainId, args.token);
      if (!token) {
        throw new Error(`Tron getBalance: unknown token ${args.token} on chain ${args.chainId}`);
      }
      if (token.contractAddress === null) {
        // Non-TRX native case — only applies if a future registry entry
        // adds another native asset on a Tron-family chain. Fall back to
        // getAccount's sun balance for correctness.
        const acct = await client.getAccount(args.address);
        return acct.balanceSun as AmountRaw;
      }
      // TRC-20: read balanceOf(address) directly. Reading from
      // getAccount().trc20 would be wrong on both backends — Alchemy's
      // /wallet/getaccount returns no TRC-20 data at all, and TronGrid's
      // /v1/accounts trc20 list is a lagging secondary index.
      return (await readTrc20Balance(client, args.address, token.contractAddress)).toString() as AmountRaw;
    },

    async getAccountBalances(args): Promise<readonly { token: TokenSymbol; amountRaw: AmountRaw }[]> {
      const client = getClient(args.chainId);
      const chainId = args.chainId as ChainId;
      const tokensOnChain = TOKEN_REGISTRY.filter((t) => t.chainId === chainId);

      // Native TRX comes from /wallet/getaccount — that field is authoritative
      // (pulled straight from the node state, not a secondary index). TRC-20
      // balances are NOT reliable from that endpoint: TronGrid's /v1/accounts
      // trc20 list is a lagging index, and Alchemy's /wallet/getaccount
      // returns no TRC-20 data at all. For those we call balanceOf directly
      // via triggerConstantContract — same path wallets use, consistent with
      // what holders see on Tronscan. 1 call for TRX + 1 per registered
      // TRC-20 token; for the current registry that's 3 calls per address
      // on Tron mainnet (TRX + USDT + USDC).
      const acct = await client.getAccount(args.address);
      const out: { token: TokenSymbol; amountRaw: AmountRaw }[] = [];

      // Native TRX first, whether or not it's in the registry.
      out.push({ token: "TRX" as TokenSymbol, amountRaw: acct.balanceSun as AmountRaw });

      for (const t of tokensOnChain) {
        if (t.contractAddress === null) continue; // TRX handled above
        const amount = await readTrc20Balance(client, args.address, t.contractAddress);
        out.push({ token: t.symbol, amountRaw: amount.toString() as AmountRaw });
      }
      return out;
    },

    async estimateGasForTransfer(args: EstimateArgs): Promise<AmountRaw> {
      // Use /wallet/triggerconstantcontract (NOT triggersmartcontract) for
      // energy estimation. triggerSmartContract BUILDS an unsigned tx and
      // routinely returns `energy_used: 0` — it's not a true simulation,
      // so using it here undersells the real energy burn by ~14-65k units.
      // triggerConstantContract actually executes the call in the VM and
      // reports `energy_used`, but it still underreports cold-slot SSTOREs
      // and first-time-recipient costs (we've observed ~4k reported vs
      // ~14-31k actual for USDT). The MIN_EXPECTED_TRC20_ENERGY floor at the
      // bottom of this function corrects for that. Historical regression:
      // we were quoting ~345 000 sun for USDT transfers (bandwidth only,
      // energy=0), planner reserved the tiny amount, real broadcast burned
      // ~12-27 TRX of energy, ran out on under-funded sources, and the tx
      // reverted on-chain with the source's TRX consumed and USDT stuck.
      const token = findToken(args.chainId as ChainId, args.token);
      if (!token || token.contractAddress === null) {
        return "0" as AmountRaw;
      }
      const client = getClient(args.chainId);
      // Revert detection happens inside the simulation helper — same
      // rationale as buildTransfer: if the simulated call reverts
      // (insufficient balance, frozen/blacklisted account, destination-
      // contract reject), quoting a fee for a doomed tx would just mislead
      // the merchant.
      const reportedEnergy = await simulateTrc20TransferEnergy(client, token.contractAddress, args);
      const energy = Math.max(reportedEnergy, MIN_EXPECTED_TRC20_ENERGY);
      return energy.toString() as AmountRaw;
    },

    async quoteFeeTiers(args: EstimateArgs): Promise<FeeTierQuote> {
      // Tron has no concept of priority tiers — TRX txs either fit under the
      // account's staked bandwidth/energy allowance or burn SUN at a fixed
      // rate. We quote the burn-all-SUN worst case so the estimate never
      // undersells what the operator will pay if the account's stake is
      // insufficient. The SUN-per-energy rate is fetched live from
      // /wallet/getchainparameters (cached ~1min) so we track Tron's
      // periodic SR-voted changes — hardcoding 420 silently doubled quotes
      // after the 2024 halving to 210.
      const energy = BigInt(await this.estimateGasForTransfer(args));
      const client = getClient(args.chainId);
      const energyBurnSun = await getCachedEnergyFee(args.chainId, client);
      // Bandwidth for a TRC-20 transfer is ~345 bytes × 1000 SUN/byte.
      const BANDWIDTH_SUN = 345n * 1000n;
      const totalSun = (energy * energyBurnSun + BANDWIDTH_SUN).toString() as AmountRaw;
      return {
        low: { tier: "low", nativeAmountRaw: totalSun },
        medium: { tier: "medium", nativeAmountRaw: totalSun },
        high: { tier: "high", nativeAmountRaw: totalSun },
        tieringSupported: false,
        nativeSymbol: this.nativeSymbol(args.chainId as ChainId)
      };
    }
  };
}

// ---- Local helpers ----

// Run the read-only VM simulation for a TRC-20 `transfer(address,uint256)`
// and return the reported `energy_used`. Uses triggerConstantContract (NOT
// triggerSmartContract — that one builds an unsigned tx and routinely
// reports energy_used=0). The result includes the dynamic-energy-model
// penalty for the CURRENT 6h maintenance cycle but still underreports
// cold-slot SSTOREs; callers must apply their own floor (estimateGasForTransfer
// uses MIN_EXPECTED_TRC20_ENERGY for burn reservations, prepareGasForBroadcast
// uses the warm/cold receiver class constants for rental sizing).
// Throws when the simulated call reverts.
async function simulateTrc20TransferEnergy(
  client: TronRpcBackend,
  contractAddress: string,
  args: { readonly fromAddress: string; readonly toAddress: string; readonly amountRaw: string }
): Promise<number> {
  const toCoreHex = tronToEvmCoreHex(args.toAddress).slice(2).padStart(64, "0");
  const amountHex = BigInt(args.amountRaw).toString(16).padStart(64, "0");
  const resp = await client.triggerConstantContract({
    owner_address: base58ToHex(args.fromAddress),
    contract_address: base58ToHex(contractAddress),
    function_selector: "transfer(address,uint256)",
    parameter: `${toCoreHex}${amountHex}`
  });
  if (resp.result.result !== true) {
    const message = resp.result.message ?? "unknown";
    throw new Error(`Tron simulation failed: ${message}`);
  }
  return resp.energy_used ?? 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Read a TRC-20 balance via `balanceOf(address)` on the token contract. Used
// in place of reading getAccount().trc20[contract] because that secondary
// index is either lagging (TronGrid) or not populated at all (Alchemy's
// /wallet/getaccount returns only native TRX). A transient RPC failure, an
// empty/short hex result, or an unparseable value collapses to 0n — the
// snapshot-level error bookkeeping is the right place to surface per-address
// failures, not per-token-on-a-good-address failures.
async function readTrc20Balance(
  client: TronRpcBackend,
  ownerBase58: string,
  contractBase58: string
): Promise<bigint> {
  try {
    const resp = await client.triggerConstantContract({
      owner_address: base58ToHex(ownerBase58),
      contract_address: base58ToHex(contractBase58),
      function_selector: "balanceOf(address)",
      parameter: tronToEvmCoreHex(ownerBase58).slice(2).padStart(64, "0")
    });
    const hex = resp.constant_result?.[0];
    if (hex === undefined || hex.length === 0) return 0n;
    try {
      return BigInt(`0x${hex}`);
    } catch {
      return 0n;
    }
  } catch {
    return 0n;
  }
}

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

