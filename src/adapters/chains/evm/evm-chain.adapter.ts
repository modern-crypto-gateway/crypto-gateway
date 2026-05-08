import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  type Hex,
  type PublicClient,
  type Transport
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { bytesToHex } from "../../crypto/subtle.js";
import type { ChainAdapter, FeeTierQuote } from "../../../core/ports/chain.port.ts";
import type { Address, ChainId, TxHash } from "../../../core/types/chain.js";
import type { AmountRaw } from "../../../core/types/money.js";
import type { TokenSymbol } from "../../../core/types/token.js";
import { findToken, tokenDustThreshold, TOKEN_REGISTRY } from "../../../core/types/token-registry.js";
import type { DetectedTransfer } from "../../../core/types/transaction.js";
import type { BuildTransferArgs, EstimateArgs, UnsignedTx } from "../../../core/types/unsigned-tx.js";
import { ERC20_ABI } from "./erc20.js";

// Native token symbols per chainId. Anything not listed defaults to ETH —
// correct for Ethereum mainnet + most L2s (Optimism, Arbitrum, Base).
const NATIVE_SYMBOLS: Readonly<Record<number, string>> = {
  1: "ETH",
  10: "ETH",
  42161: "ETH",
  8453: "ETH",
  11155111: "ETH",
  56: "BNB",
  137: "POL",
  43114: "AVAX"
};

// Per-chain gas floors. These encode network-level consensus rules (e.g.
// Polygon's Heimdall v2 mandatory 25 gwei priority) and a small "panic
// minimum" so a misbehaving RPC reporting 0 gwei doesn't produce a starved
// reservation. They are NOT the primary mechanism for matching provider-side
// pre-send simulation — that role is now played by the dynamic eth_gasPrice
// floor in `buildFeeBinding`, which queries the same value Alchemy/QuickNode/
// Infura use in their submission checks and bands above it with 10% headroom.
//
// Why the dynamic floor matters: RPC providers run their own balance
// simulation using `eth_gasPrice` rather than the tx's bound maxFeePerGas,
// rejecting tight-balance txs at the submission layer even when our own
// math is a clear pass. Pinning each chain to a static "comfortable" gwei
// number (the previous design) overpays during quiet periods — observed: BSC
// quoting $0.06 vs Trust Wallet's $0.01 for the same transfer because the
// hardcoded 3 gwei floor was 6× the network's real-time spot gas price.
//
// What stays in this map: only consensus-enforced floors and a sub-gwei
// safety net. Real-world inclusion price is now driven by the dynamic floor,
// which moves with the network instead of waiting for an operator to retune.
interface GasFloor {
  readonly minPriorityFeePerGas: bigint;
  readonly minMaxFeePerGas: bigint;
}
const CHAIN_GAS_FLOORS: Readonly<Record<number, GasFloor>> = {
  // Ethereum mainnet: ~1 gwei priority is the conventional minimum tip; the
  // dynamic floor handles the rest. maxFee floor stays small — the 1559-
  // derived 2×baseFee + priority always dominates in real usage.
  1:     { minPriorityFeePerGas:  1_000_000_000n, minMaxFeePerGas:    100_000_000n },
  // Optimism: L2 priority essentially free, sub-gwei base.
  10:    { minPriorityFeePerGas:      1_000_000n, minMaxFeePerGas:        100_000n },
  // BSC: consensus floor is 0.05 gwei (Oct-2025 validator vote), BEP-226 pins
  // baseFee to 0. We hold a 0.1 gwei priority floor as a "non-zero tip" safety
  // (some validator implementations occasionally reject zero-tip txs) and let
  // the dynamic eth_gasPrice floor in buildFeeBinding drive the real
  // inclusion price. This produces ~$0.01 quotes during quiet periods (vs
  // the previous static 3 gwei → $0.06) and naturally rises during congestion.
  56:    { minPriorityFeePerGas:    100_000_000n, minMaxFeePerGas:    100_000_000n },
  // Polygon PoS: Heimdall v2 enforces a hard 25 gwei mandatory priority fee
  // at the network layer. Below this, txs are rejected outright. Keep this
  // hardcoded — the dynamic floor would also typically read ~25 gwei here,
  // but the consensus rule must hold even on a misbehaving RPC.
  137:   { minPriorityFeePerGas: 25_000_000_000n, minMaxFeePerGas: 30_000_000_000n },
  // Base: L2 priority essentially free.
  8453:  { minPriorityFeePerGas:      1_000_000n, minMaxFeePerGas:        100_000n },
  // Arbitrum One: priority tiny (sequencer ordering); keep a small panic min.
  42161: { minPriorityFeePerGas:     10_000_000n, minMaxFeePerGas:     10_000_000n },
  // Avalanche C-Chain: post-ACP-125 baseFee floor is 1 nAVAX (gwei). The
  // dynamic floor handles real-world inclusion; the hardcoded priority floor
  // keeps a baseline tip in case eth_maxPriorityFeePerGas reads 0.
  43114: { minPriorityFeePerGas:  1_000_000_000n, minMaxFeePerGas:    100_000_000n }
};

// The zero-floor lookup lets unknown / dev chains pass through without a
// floor applied — matches pre-floors behavior for anything not in the map.
const NO_FLOOR: GasFloor = { minPriorityFeePerGas: 0n, minMaxFeePerGas: 0n };
function gasFloorFor(chainId: number): GasFloor {
  return CHAIN_GAS_FLOORS[chainId] ?? NO_FLOOR;
}

// How many recent blocks `sampleFees` inspects via `eth_feeHistory`. 20 blocks
// is ~4 minutes on Ethereum, ~1 minute on BSC/Polygon — long enough to smooth
// a single-block outlier (a quiet block returning priority=0), short enough
// to track genuine fee-market movement within one minute of the payout.
const FEE_HISTORY_BLOCK_COUNT = 20;

// Priority-fee percentiles mapped onto our low/medium/high tiers. Using the
// 75th percentile for "high" is what most production bridges (Hop, Across)
// use for fast-inclusion quotes; 25/50 give a predictable spread for cheaper
// tiers. Order must be ascending — `eth_feeHistory` rejects otherwise.
const FEE_HISTORY_PERCENTILES: readonly number[] = [25, 50, 75];

// Default BIP44 derivation path prefix for EVM. addressIndex is appended.
// m/44'/60'/0'/0/{index}  — Ethereum coin type = 60.
const DEFAULT_ACCOUNT_INDEX = 0;
const DEFAULT_CHANGE_INDEX = 0;

// Bound on the block range for a single eth_getLogs call. Most providers cap
// at 1k–10k blocks; 2k is a safe middle that covers ~7 minutes on mainnet.
const DEFAULT_MAX_SCAN_BLOCKS = 2_000;

// Local nonce cache, keyed by `${chainId}:${addressLower}`. Maintained to
// avoid the "replacement transaction underpriced" failure mode that hits
// when the executor broadcasts many txs from one sender in rapid succession
// (consolidation top-ups, mass payouts) against a load-balanced RPC fleet:
// the RPC's pending-mempool view propagates between nodes asynchronously,
// so two `eth_getTransactionCount(addr, "pending")` calls can return the
// same value even after the prior tx was accepted by the mempool. Both
// txs then get signed with the same nonce; only the first lands; the rest
// fail with `replacement transaction underpriced` because their fees
// aren't ≥ 1.125× the in-mempool tx's fees.
//
// We bypass the RPC's stale view by tracking nextNonce locally. Each
// successful broadcast increments nextNonce. After the TTL the cache
// expires and the next broadcast re-queries from chain — bounding stale
// state on crash / external txs from the same wallet to one window.
//
// The cache is intentionally PROCESS-LOCAL. This breaks correctness when
// two gateway instances broadcast from the same HD address concurrently
// (each instance has its own cache, both think they own the same nonce).
// Single-writer is the assumption everywhere else in this codebase
// (executor cron is single-writer per row via reservations + status CAS),
// so this is consistent with the rest of the design.
//
// CRITICAL: the executor broadcasts up to `payoutConcurrencyPerChain` (16
// by default) txs in parallel via Promise.all. A naive cache with an
// `await` between read-cache and write-cache would hit a classic TOCTOU
// race: N concurrent calls each see "cache miss", each launch their own
// fetchPending(), each return the same on-chain nonce, each write the
// same value to the cache (last-wins). All N broadcasts get the same
// nonce; first wins, rest fail with replacement-underpriced. Mitigated
// by coalescing concurrent first-fetches into a single shared Promise:
// once that resolves and seeds the cache, the read-and-increment is
// purely synchronous so each waiter (resumed sequentially as microtasks)
// claims a unique value.
const NONCE_CACHE_TTL_MS = 60_000;
const nonceCache = new Map<string, { nextNonce: number; expiresAt: number }>();
// Tracks an in-flight fetch+seed Promise per cache key. Entries are
// removed in `.finally()` so the next cache miss after the seed completes
// starts a fresh fetch.
const inFlightSeed = new Map<string, Promise<void>>();

function nonceKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

// Read-and-increment the cached nonce, or fetch from chain if cache miss /
// expired. Caller passes a function to fetch from chain rather than a client
// so the cache module stays decoupled from viem types.
//
// Concurrency contract: when called concurrently from N parallel executor
// workers, returns N distinct nonces. The first-fetch is coalesced via
// `inFlightSeed`; once the seed Promise resolves, every waiter wakes up as
// a microtask and runs the synchronous read-and-increment block, each
// observing the cache state left by the prior microtask. Single-threaded
// JS guarantees no interleaving inside the synchronous block, so the
// claims are atomic per-waiter.
async function reserveNextNonce(
  chainId: number,
  address: string,
  fetchPending: () => Promise<number>
): Promise<number> {
  const key = nonceKey(chainId, address);

  // Fast path: cache hit. Synchronous read+increment — atomic in single-
  // threaded JS, so concurrent callers each take a distinct value.
  const cached = nonceCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    const nonce = cached.nextNonce;
    nonceCache.set(key, { nextNonce: nonce + 1, expiresAt: cached.expiresAt });
    return nonce;
  }

  // Slow path: cache miss / expired. Coalesce concurrent first-fetches so
  // only ONE eth_getTransactionCount RPC fires per (chainId, address)
  // even when 16 workers race in. The seed populates the cache with the
  // on-chain pending nonce; nothing increments inside the seed itself.
  let seed = inFlightSeed.get(key);
  if (seed === undefined) {
    seed = (async (): Promise<void> => {
      const onChain = await fetchPending();
      // Skip seeding if a successful fast-path increment refreshed the
      // cache while we were awaiting (rare, but possible if a hit-path
      // caller arrived after the original miss-path triggered the seed
      // and TTL was bumped by some other code path). Otherwise the on-
      // chain value goes in.
      const existing = nonceCache.get(key);
      if (existing === undefined || existing.expiresAt <= Date.now()) {
        nonceCache.set(key, { nextNonce: onChain, expiresAt: Date.now() + NONCE_CACHE_TTL_MS });
      }
    })();
    // void: cleanup is fire-and-forget; the awaiter below blocks on `seed`
    // itself, not on the post-cleanup chain.
    void seed.finally(() => {
      // Clean up regardless of fulfillment/rejection so the next miss
      // re-fetches rather than reusing a stale or rejected Promise.
      if (inFlightSeed.get(key) === seed) inFlightSeed.delete(key);
    });
    inFlightSeed.set(key, seed);
  }
  await seed;

  // Cache is now seeded (unless seed rejected — in which case .get below
  // returns undefined and we'd throw, propagating the original RPC error
  // up to the broadcast catch). Read-and-increment is synchronous from
  // here, so every waiter takes a distinct value.
  const after = nonceCache.get(key);
  if (after === undefined) {
    throw new Error(
      `Nonce seed failed for ${address} on chain ${chainId} — eth_getTransactionCount RPC error`
    );
  }
  const nonce = after.nextNonce;
  nonceCache.set(key, { nextNonce: nonce + 1, expiresAt: after.expiresAt });
  return nonce;
}

// Roll back a reserved nonce after a broadcast failure. Without this, a
// failed broadcast leaves a "phantom" reservation: the next call would skip
// over the reserved nonce, creating a permanent gap that no future tx fills
// (chain mining stops at the first unfilled nonce). Decrementing only when
// the cached entry's nextNonce is still exactly `nonce + 1` keeps the
// rollback safe under interleaved concurrent broadcasts (the more recent
// reservation has already advanced past us — let it own the slot, the gap
// will be repaired when the cache TTL expires and we re-fetch from chain).
function releaseNonceOnFailure(chainId: number, address: string, nonce: number): void {
  const key = nonceKey(chainId, address);
  const entry = nonceCache.get(key);
  if (entry && entry.nextNonce === nonce + 1) {
    nonceCache.set(key, { nextNonce: nonce, expiresAt: entry.expiresAt });
  }
}
// Approximate mainnet block time. Used to translate `sinceMs` into a block window.
const APPROX_BLOCK_TIME_MS: Readonly<Record<number, number>> = {
  1: 12_000,
  10: 2_000,
  42161: 250,
  8453: 2_000,
  11155111: 12_000,
  56: 3_000,
  137: 2_000
};

export interface EvmChainConfig {
  // Which chainIds this adapter serves.
  chainIds: readonly number[];
  // Per-chain RPC URL. Required unless a custom `transports` entry is supplied.
  // Also use this for a private Alchemy / QuickNode endpoint.
  rpcUrls?: Readonly<Record<number, string>>;
  // Per-chain viem Transport override. Primarily for testing: inject a mock
  // transport that responds to JSON-RPC method calls with fixtures.
  transports?: Readonly<Record<number, Transport>>;
  // BIP44 accountIndex (default 0). Use separate accounts for separate envs
  // (prod vs staging) off the same mnemonic.
  accountIndex?: number;
  // Cap on the block window `scanIncoming` will sweep in a single call.
  maxScanBlocks?: number;
}

// TTL for the per-chain latest-block-number cache used inside
// getConfirmationStatus. A single cron tick fans out one receipt+block-height
// query per active confirming tx; the block height is identical for every tx
// on the same chain in that tick, so we only need to fetch it once. ~10s
// covers tick coalescing without going stale (mainnet block ~12s).
const BLOCK_HEIGHT_CACHE_TTL_MS = 10_000;

export function evmChainAdapter(config: EvmChainConfig): ChainAdapter {
  const accountIndex = config.accountIndex ?? DEFAULT_ACCOUNT_INDEX;
  const maxScanBlocks = config.maxScanBlocks ?? DEFAULT_MAX_SCAN_BLOCKS;

  // Clients are built lazily per chainId and cached. viem's PublicClient is
  // internally memoized, so constructing once per chainId is cheap.
  const clientCache = new Map<number, PublicClient>();
  function getClient(chainId: number): PublicClient {
    const cached = clientCache.get(chainId);
    if (cached) return cached;
    const transport = config.transports?.[chainId] ?? buildHttpTransport(config.rpcUrls, chainId);
    // viem requires a chain object for some helpers; a minimal stub is enough
    // when we already know the chain id via our own registry.
    const client = createPublicClient({ transport }) as PublicClient;
    clientCache.set(chainId, client);
    return client;
  }

  const blockHeightCache = new Map<number, { value: bigint; fetchedAt: number }>();
  async function getCachedBlockNumber(chainId: number, client: PublicClient): Promise<bigint> {
    const now = Date.now();
    const entry = blockHeightCache.get(chainId);
    if (entry && now - entry.fetchedAt < BLOCK_HEIGHT_CACHE_TTL_MS) return entry.value;
    const latest = await client.getBlockNumber();
    blockHeightCache.set(chainId, { value: latest, fetchedAt: now });
    return latest;
  }

  return {
    family: "evm",
    supportedChainIds: config.chainIds as readonly ChainId[],

    // ---- Addresses ----

    deriveAddress(seed: string, index: number) {
      // viem validates the mnemonic and throws a helpful message if malformed.
      const account = mnemonicToAccount(seed, {
        accountIndex,
        changeIndex: DEFAULT_CHANGE_INDEX,
        addressIndex: index
      });
      const hdKey = account.getHdKey();
      if (!hdKey.privateKey) {
        throw new Error(`EVM derivation produced an account without a private key (index=${index})`);
      }
      const privateKey = `0x${bytesToHex(hdKey.privateKey)}`;
      // Lowercased to match `canonicalizeAddress`. On-chain EVM addresses are
      // case-insensitive (EIP-55 is just a typo-detection checksum); storing
      // one canonical case makes joins between detected transfers and
      // invoice/pool rows reliable. Turso/SQLite TEXT compares are
      // case-sensitive — a single mismatched char silently drops the join.
      return { address: account.address.toLowerCase() as Address, privateKey };
    },

    validateAddress(addr: string): boolean {
      return isAddress(addr);
    },

    canonicalizeAddress(addr: string): Address {
      // Lowercased hex. `getAddress` throws on invalid hex/length first so we
      // still reject malformed input — we just discard the EIP-55 checksum
      // case afterwards for storage. See deriveAddress comment for rationale.
      return getAddress(addr).toLowerCase() as Address;
    },

    addressFromPrivateKey(privateKey: string): Address {
      // Same lowercase canonical form pool addresses use.
      const normalized = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
      const account = privateKeyToAccount(normalized as Hex);
      return account.address.toLowerCase() as Address;
    },

    // ---- Detection ----

    async scanIncoming({ chainId, addresses, tokens, sinceMs }) {
      if (addresses.length === 0) return [];
      const client = getClient(chainId);

      // Translate `sinceMs` into a block number. A provider-reported `latest`
      // minus an estimated block count keeps us chain-agnostic without needing
      // a timestamp-to-block service.
      const latest = await client.getBlockNumber();
      const blockTimeMs = APPROX_BLOCK_TIME_MS[chainId] ?? 12_000;
      const nowMs = Date.now();
      const spanBlocks = Math.min(
        maxScanBlocks,
        Math.max(1, Math.ceil((nowMs - sinceMs) / blockTimeMs))
      );
      const fromBlock = latest - BigInt(spanBlocks) + 1n;

      // Match tokens (from our registry) on this chain. Unknown symbols silently skipped.
      const targetTokens = tokens
        .map((sym) => findToken(chainId as ChainId, sym))
        .filter((t): t is NonNullable<typeof t> => t !== null);

      // RPC-poll only handles ERC-20 (one event-log filter per token contract).
      // Native incoming (ETH/MATIC/BNB/AVAX) intentionally falls through to
      // the Alchemy webhook path (handlePush), which receives `category:
      // "external"`/`"internal"` events. Block-walking 2k blocks × ~200 txs
      // each just to find native receives would be a heavy hot path; webhooks
      // are the right tool. Chains without Alchemy coverage get no native
      // detection on this code path — accepted limitation for now.
      const erc20Targets = targetTokens.filter((t) => t.contractAddress !== null);

      // One log query per token. We could do one call across all contracts,
      // but most providers return better results per-contract. The parallelism
      // is cheap on HTTP.
      const results: DetectedTransfer[] = [];
      await Promise.all(
        erc20Targets.map(async (token) => {
          const logs = await client.getLogs({
            address: token.contractAddress! as Hex,
            event: {
              type: "event",
              name: "Transfer",
              inputs: [
                { name: "from", type: "address", indexed: true },
                { name: "to", type: "address", indexed: true },
                { name: "value", type: "uint256", indexed: false }
              ]
            },
            args: { to: [...(addresses as readonly Hex[])] },
            fromBlock,
            toBlock: latest
          });
          // Drop sub-cent stablecoin transfers — address-poisoning spam
          // sends 0.000099 USDC or similar from a vanity lookalike address
          // hoping the user later copies the spoofed sender from history.
          // See tokenDustThreshold for the scaling rationale (returns 0n for
          // non-stables, so native flow-throughs aren't affected).
          const threshold = tokenDustThreshold(token);
          for (const log of logs) {
            // viem-decoded args: { from, to, value }
            const args = log.args as { from: Hex; to: Hex; value: bigint };
            if (threshold > 0n && args.value < threshold) continue;
            results.push({
              chainId: chainId as ChainId,
              txHash: log.transactionHash,
              logIndex: log.logIndex,
              fromAddress: getAddress(args.from),
              toAddress: getAddress(args.to),
              token: token.symbol,
              amountRaw: args.value.toString() as AmountRaw,
              blockNumber: Number(log.blockNumber),
              confirmations: Number(latest - log.blockNumber) + 1,
              seenAt: new Date()
            });
          }
        })
      );

      return results;
    },

    async getConfirmationStatus(chainId: ChainId, txHash: TxHash) {
      const client = getClient(chainId);
      const [receipt, latest] = await Promise.all([
        client.getTransactionReceipt({ hash: txHash as Hex }).catch(() => null),
        getCachedBlockNumber(chainId, client)
      ]);
      if (!receipt) {
        // Not yet mined or unknown — report zero confirmations, not reverted.
        return { blockNumber: null, confirmations: 0, reverted: false };
      }
      const blockNumber = Number(receipt.blockNumber);
      const confirmations = Number(latest - receipt.blockNumber) + 1;
      return {
        blockNumber,
        confirmations: Math.max(0, confirmations),
        reverted: receipt.status === "reverted"
      };
    },

    async getConsumedNativeFee(chainId: ChainId, txHash: TxHash): Promise<AmountRaw | null> {
      // On EVM the chain charges `gasUsed × effectiveGasPrice` regardless
      // of whether the tx reverted. The receipt carries both fields
      // directly; multiplying them gives the exact wei debited from the
      // sender. When the tx isn't mined yet (or the RPC can't find it),
      // return null — the caller retries on a later tick.
      const client = getClient(chainId);
      const receipt = await client
        .getTransactionReceipt({ hash: txHash as Hex })
        .catch(() => null);
      if (!receipt) return null;
      const gasUsed = receipt.gasUsed as bigint;
      const effective = receipt.effectiveGasPrice as bigint;
      return (gasUsed * effective).toString() as AmountRaw;
    },

    // ---- Payouts ----

    async buildTransfer(args: BuildTransferArgs): Promise<UnsignedTx> {
      const token = findToken(args.chainId as ChainId, args.token);
      if (!token) {
        throw new Error(`EVM buildTransfer: unknown token ${args.token} on chain ${args.chainId}`);
      }

      const isNative = token.contractAddress === null;
      let to: Hex;
      let data: Hex;
      let value: bigint;

      if (isNative) {
        to = args.toAddress as Hex;
        data = "0x";
        value = BigInt(args.amountRaw);
      } else {
        to = token.contractAddress as unknown as Hex;
        data = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [args.toAddress as Hex, BigInt(args.amountRaw)]
        });
        value = 0n;
      }

      // Pre-bind `gas` so viem's sendTransaction does NOT call eth_estimateGas
      // at broadcast. The concrete symptom that motivates this pin: Alchemy
      // BSC's `eth_estimateGas` runs its own balance simulation using an
      // internal "sane" gas price higher than our bound maxFeePerGas, so a
      // source funded to exactly `value + our_gas × our_maxFee` still gets
      // rejected at simulation time with "insufficient funds for gas * price +
      // value" — before the tx even reaches the mempool. Bypassing viem's
      // estimateGas call forces the balance check to run at the ACTUAL
      // mempool level, where our bound maxFeePerGas is what's used.
      //
      // 21_000 is the EVM-floor cost of a native transfer and is immutable
      // for any non-contract destination. 65_000 for ERC-20 covers USDT's
      // branched impl (~45k), first-send-to-new-address USDC (~55k), and
      // exotic proxy tokens (up to 80k in the wild) with a modest pad.
      // Validators only charge for gas actually used, so a small overestimate
      // on ERC-20 is refunded on-chain and costs the merchant nothing.
      const raw: EvmUnsignedTxRaw = {
        to,
        data,
        value,
        from: args.fromAddress as Hex,
        chainId: args.chainId,
        gas: isNative ? 21_000n : 65_000n
      };

      // Bind maxFeePerGas / maxPriorityFeePerGas on every EIP-1559 broadcast,
      // not just when the merchant asked for a specific tier. Leaving these
      // unbound lets viem's sendTransaction fall back to its internal
      // `estimateFeesPerGas` (baseFeeMultiplier=1.2 + spot priority) which on
      // BSC happily produces values several-fold above what the planner
      // reserved — the exact path that failed a native BNB payout with
      // `feeTier: null` even after the per-tier floor was introduced. When
      // the merchant didn't specify a tier we default to `medium`, matching
      // `planPayout`'s picker-budget target tier so broadcast cost can never
      // exceed the reservation.
      const broadcastTier: "low" | "medium" | "high" = args.feeTier ?? "medium";
      const sample = await sampleFees(getClient(args.chainId), args.chainId);
      if (sample !== null) {
        const priority = pickPriorityForTier(sample, broadcastTier);
        const binding = buildFeeBinding(args.chainId, sample.baseFee, priority, sample.spotGasPrice);
        raw.maxFeePerGas = binding.maxFeePerGas;
        raw.maxPriorityFeePerGas = binding.maxPriorityFeePerGas;
      }
      // sample===null means neither eth_feeHistory nor estimateFeesPerGas gave
      // us 1559 data — a strictly legacy chain. Leaving fees unbound lets viem
      // fall back to the legacy gasPrice path, consistent with the
      // `tieringSupported:false` surface in quoteFeeTiers.

      return {
        chainId: args.chainId as ChainId,
        raw,
        summary: isNative
          ? `EVM: native transfer ${args.amountRaw} to ${args.toAddress}`
          : `EVM: ERC-20 ${args.token} transfer ${args.amountRaw} to ${args.toAddress}`
      };
    },

    async signAndBroadcast(
      unsignedTx: UnsignedTx,
      privateKey: string,
      options?: { readonly feePayerPrivateKey?: string }
    ): Promise<TxHash> {
      if (options?.feePayerPrivateKey !== undefined) {
        // EVM's feeWalletCapability is "none" — receiving a fee-payer key
        // here means the domain layer bypassed the capability gate. Fail
        // loudly so the bug doesn't manifest as a silently-ignored key.
        throw new Error(
          "EVM signAndBroadcast: feePayerPrivateKey is not supported on EVM (capability='none'). " +
            "The fee-wallet co-sign pattern only applies to families with native feePayer support (Solana)."
        );
      }
      const raw = unsignedTx.raw as EvmUnsignedTxRaw;
      const account = privateKeyToAccount(privateKey as Hex);
      const chainId = raw.chainId;
      const transport = config.transports?.[chainId] ?? buildHttpTransport(config.rpcUrls, chainId);

      // Signer-address invariant: the address derived from the private key
      // MUST equal the pool-stored source address the payout was planned
      // against. A mismatch means the HD seed used when the pool row was
      // created differs from the seed used to sign now — classic fallout
      // from rotating MASTER_SEED without migrating pool addresses. Without
      // this check, viem happily signs with the wrong key and broadcasts
      // a tx from an empty address, which the RPC rejects with a bland
      // "insufficient funds balance 0" that gives no hint at the root
      // cause. Raising a specific error here turns hours of debugging into
      // seconds.
      const signerAddress = account.address.toLowerCase() as Hex;
      const expectedFrom = raw.from.toLowerCase() as Hex;
      if (signerAddress !== expectedFrom) {
        throw new Error(
          `Signer-address mismatch: pool row has address=${expectedFrom} but the private key derives to ${signerAddress}. ` +
            `This indicates MASTER_SEED has rotated since the pool row was populated, or the pool row stores an externally-funded address whose key the gateway does not control. ` +
            `Fix: restore the original MASTER_SEED, OR migrate funds off ${expectedFrom} and re-plan from a pool address whose derivation matches the current seed.`
        );
      }

      // Pre-broadcast balance check: read the actual on-chain balance against
      // the SIGNER's address (== raw.from per the invariant above) and refuse
      // to broadcast when the tx can't afford itself. Strictly better than
      // passing through the vendor's truncated insufficient-funds string, and
      // catches the case where the pool row's DB-tracked spendable is ahead
      // of on-chain reality (funds moved out by an external tool / sweep /
      // failed-tx-not-reconciled).
      if (raw.gas !== undefined && raw.maxFeePerGas !== undefined) {
        const maxCost = raw.gas * raw.maxFeePerGas + raw.value;
        try {
          const client = getClient(chainId);
          const balance = await client.getBalance({ address: signerAddress });
          if (balance < maxCost) {
            const short = raw.value === 0n
              ? `balance=${balance} wei, gas_budget=${raw.gas * raw.maxFeePerGas} wei (gas=${raw.gas}, maxFeePerGas=${raw.maxFeePerGas})`
              : `balance=${balance} wei, value=${raw.value} wei, gas_budget=${raw.gas * raw.maxFeePerGas} wei (gas=${raw.gas}, maxFeePerGas=${raw.maxFeePerGas})`;
            throw new Error(
              `insufficient native balance for broadcast (balance < value + gas × maxFeePerGas): ${short}`
            );
          }
        } catch (err) {
          // The thrown-above insufficient-balance error should propagate.
          // Everything else (a getBalance RPC flap) we swallow and let the
          // real broadcast try — we don't want a transient read failure to
          // block a valid payout.
          if (err instanceof Error && err.message.startsWith("insufficient native balance for broadcast")) {
            throw err;
          }
        }
      }

      // Reserve a nonce locally. Bypassing viem's default
      // `getTransactionCount(addr, "pending")` flow because load-balanced
      // RPCs (Alchemy, QuickNode, public Polygon) propagate the mempool
      // view asynchronously across nodes; rapid back-to-back broadcasts
      // from the same sender can read the SAME pending nonce twice and
      // collide. Local cache + TTL + rollback-on-failure gives us
      // monotonic nonces within a single executor run.
      const client = getClient(chainId);
      const reservedNonce = await reserveNextNonce(chainId, account.address, () =>
        client.getTransactionCount({ address: account.address, blockTag: "pending" })
      );

      const wallet = createWalletClient({ account, transport });
      let hash: Hex;
      try {
        hash = await wallet.sendTransaction({
          to: raw.to,
          data: raw.data,
          value: raw.value,
          nonce: reservedNonce,
          ...(raw.gas !== undefined ? { gas: raw.gas } : {}),
          ...(raw.maxFeePerGas !== undefined && raw.maxPriorityFeePerGas !== undefined
            ? { maxFeePerGas: raw.maxFeePerGas, maxPriorityFeePerGas: raw.maxPriorityFeePerGas }
            : {}),
          // viem requires a chain; build a minimal stub since we only need the id.
          chain: { id: chainId, name: `evm-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } }
        });
      } catch (err) {
        // Roll back the reservation so the next broadcast doesn't skip
        // over an unused nonce, which would create a permanent gap that
        // stalls every future tx from this sender.
        releaseNonceOnFailure(chainId, account.address, reservedNonce);
        throw err;
      }
      return hash as TxHash;
    },

    // ---- Fees ----

    nativeSymbol(chainId: ChainId): TokenSymbol {
      return (NATIVE_SYMBOLS[chainId] ?? "ETH") as TokenSymbol;
    },

    minimumNativeReserve(_chainId: ChainId): bigint {
      // EVM has no rent-exempt concept — an account can hold any balance.
      return 0n;
    },

    gasSafetyFactor(chainId: ChainId) {
      // Per-chain safety factor for the picker's gas-budget reservation.
      // Sized to cover the gap between the gas quote at PLAN time and a
      // re-quote at BROADCAST time — the inherent race in account-model
      // payouts where the executor builds the broadcast tx with a fresh
      // gas snapshot, not the planned one. The fixed 1.5× we used to
      // quote on every chain was empirically too tight on Polygon: a
      // ~2.7× plan-to-broadcast gas spike during a 2026-05 consolidation
      // run failed 9 of 15 legs with `insufficient native balance for
      // broadcast` because the top-ups (sized at quote × 1.5 × 1.2) were
      // ~2× short of what broadcast actually charged.
      //
      // The picker multiplies this by the chosen tier's gas quote to
      // compute the source's gas reserve, then adds a 20% cushion in
      // the planner. Total top-up = quote × safety × 1.2 — needs to
      // cover the worst plan-to-broadcast gas movement we expect on
      // each chain.
      //
      // Math: pure EIP-1559 baseFee can grow at most 12.5%/block → six
      // blocks compounded gives 1.125^6 ≈ 2.03×. Priority fees and
      // congestion-driven mempool spikes layer on top. Polygon and BSC
      // routinely show 2-3× spikes within a tight time window during
      // congestion (USDT migrations, NFT mints); L2s have tightly
      // controlled gas markets and stay within 1.5×. Per-chain values
      // reflect observed worst-case-spike multipliers from production:
      const PER_CHAIN: Readonly<Record<number, { num: bigint; den: bigint }>> = {
        // L2s — sequenced rollups with predictable batched gas,
        // baseFee moves slowly, 1.5× covers normal drift.
        10: { num: 150n, den: 100n },     // Optimism
        42161: { num: 150n, den: 100n },  // Arbitrum
        8453: { num: 150n, den: 100n },   // Base
        // Mainnet — moderate volatility, 2× covers typical 6-block
        // baseFee growth + a margin for priority-fee spikes.
        1: { num: 200n, den: 100n },      // Ethereum
        11155111: { num: 200n, den: 100n }, // Sepolia
        // High-volatility chains — Polygon's gas can 2-3× in a few
        // blocks during congestion (the failure mode that drove this
        // change). 3× safety leaves ~50% headroom on top of an
        // observed 2× spike — combined with the 20% cushion in the
        // planner, total top-up is quote × 3.6.
        137: { num: 300n, den: 100n },    // Polygon
        56: { num: 250n, den: 100n },     // BSC
        43114: { num: 250n, den: 100n }   // Avalanche
      };
      // Default for unknown chainIds is conservative 2.0× — matches
      // mainnet ETH. Operators adding a new EVM chain should update
      // PER_CHAIN if they observe different volatility characteristics.
      return PER_CHAIN[chainId] ?? { num: 200n, den: 100n };
    },

    feeWalletCapability(_chainId: ChainId) {
      // EVM has no native fee-payer separation prior to account abstraction
      // (EIP-4337 / EIP-3074 aren't universal across every EVM chain we
      // serve). The current sponsor-topup flow IS the EVM fee-wallet
      // pattern; a dedicated fee-wallet row adds no mechanism here today.
      return "none" as const;
    },

    async estimateGasForTransfer(args: EstimateArgs): Promise<AmountRaw> {
      const client = getClient(args.chainId);
      const token = findToken(args.chainId as ChainId, args.token);
      if (!token) {
        throw new Error(`EVM estimateGas: unknown token ${args.token} on chain ${args.chainId}`);
      }
      // Fallback gas units when live estimation can't run (sender has no
      // balance, RPC flap, etc.). These are industry-standard defaults:
      // - Native transfer: 21000 (EVM floor)
      // - ERC-20 transfer: 65000 covers most ERC-20s; USDT's branched impl
      //   lands around 45k, a first-send-to-new-address USDC around 55k,
      //   exotic proxy tokens up to 80k. 65000 is the safe middle — any
      //   single-digit percent overquote at broadcast time is absorbed by
      //   the 2× baseFee margin in buildTransfer.
      const FALLBACK_GAS_UNITS = token.contractAddress === null ? 21_000n : 65_000n;
      const isInsufficientFundsError = (err: unknown): boolean => {
        const message = err instanceof Error ? err.message : String(err);
        return /insufficient funds|balance/i.test(message);
      };
      try {
        if (token.contractAddress === null) {
          const gas = await client.estimateGas({
            account: args.fromAddress as Hex,
            to: args.toAddress as Hex,
            value: BigInt(args.amountRaw)
          });
          return gas.toString() as AmountRaw;
        }
        const data = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [args.toAddress as Hex, BigInt(args.amountRaw)]
        });
        const gas = await client.estimateGas({
          account: args.fromAddress as Hex,
          to: token.contractAddress as unknown as Hex,
          data
        });
        return gas.toString() as AmountRaw;
      } catch (err) {
        // A zero-balance fee wallet (just registered, not yet funded) causes
        // viem's estimateGas to throw "insufficient funds for gas * price +
        // value". That's a valid operational state — return the safe
        // fallback so the estimate endpoint can still quote a tier and tell
        // the operator how much to fund. Real broadcasts re-run estimation
        // against the actual reserved wallet, which by then has funds.
        if (isInsufficientFundsError(err)) {
          return FALLBACK_GAS_UNITS.toString() as AmountRaw;
        }
        throw err;
      }
    },

    async quoteFeeTiers(args: EstimateArgs): Promise<FeeTierQuote> {
      const client = getClient(args.chainId);
      const gasUnits = BigInt(await this.estimateGasForTransfer(args));
      const nativeSymbol = this.nativeSymbol(args.chainId as ChainId);
      const floor = gasFloorFor(args.chainId);

      const sample = await sampleFees(client, args.chainId);

      // Non-1559 fallback: the chain doesn't implement eth_feeHistory AND
      // estimateFeesPerGas didn't return a 1559-shaped pair. Quote a flat
      // single-tier fee using whatever legacy gasPrice is available (or the
      // floor, whichever is higher).
      if (sample === null) {
        const legacy = await client
          .estimateFeesPerGas()
          .then((f) => (f as unknown as { gasPrice?: bigint; maxFeePerGas?: bigint }))
          .catch(() => ({} as { gasPrice?: bigint; maxFeePerGas?: bigint }));
        const legacyGasPrice = legacy.maxFeePerGas ?? legacy.gasPrice ?? 0n;
        const flooredGasPrice =
          legacyGasPrice > floor.minMaxFeePerGas ? legacyGasPrice : floor.minMaxFeePerGas;
        const flat = (gasUnits * flooredGasPrice).toString() as AmountRaw;
        return {
          low: { tier: "low", nativeAmountRaw: flat },
          medium: { tier: "medium", nativeAmountRaw: flat },
          high: { tier: "high", nativeAmountRaw: flat },
          tieringSupported: false,
          nativeSymbol
        };
      }

      const nativeAt = (priority: bigint): AmountRaw => {
        const { maxFeePerGas } = buildFeeBinding(args.chainId, sample.baseFee, priority, sample.spotGasPrice);
        return (gasUnits * maxFeePerGas).toString() as AmountRaw;
      };
      const lowFee = nativeAt(sample.priorityLow);
      const midFee = nativeAt(sample.priorityMid);
      const highFee = nativeAt(sample.priorityHigh);

      // Tiering is meaningful only when the three tiers produce distinct
      // numbers. When every percentile returned 0 priority AND the chain's
      // floor is also zero (unknown / dev chains), low/medium/high all collapse
      // to the baseFee-only value — surface `tieringSupported: false` so the
      // frontend renders a single option instead of three identical ones.
      const tieringSupported = lowFee !== midFee || midFee !== highFee;

      return {
        low: { tier: "low", nativeAmountRaw: lowFee },
        medium: { tier: "medium", nativeAmountRaw: midFee },
        high: { tier: "high", nativeAmountRaw: highFee },
        tieringSupported,
        nativeSymbol
      };
    },

    async getBalance(args): Promise<AmountRaw> {
      const client = getClient(args.chainId);
      // Native gas token short-circuit. TOKEN_REGISTRY lists only payment
      // tokens (USDC/USDT) — native gas (ETH/MATIC/BNB/AVAX) isn't there
      // because the gateway doesn't accept native as a payment token. Fee-
      // wallet balance checks still need to read native, so route around
      // findToken when the requested symbol matches the chain's native.
      const nativeSym = NATIVE_SYMBOLS[args.chainId] ?? "ETH";
      if (args.token === nativeSym) {
        const balance = await client.getBalance({ address: args.address as Hex });
        return balance.toString() as AmountRaw;
      }
      const token = findToken(args.chainId as ChainId, args.token);
      if (!token) {
        throw new Error(`EVM getBalance: unknown token ${args.token} on chain ${args.chainId}`);
      }
      if (token.contractAddress === null) {
        const balance = await client.getBalance({ address: args.address as Hex });
        return balance.toString() as AmountRaw;
      }
      const balance = (await client.readContract({
        address: token.contractAddress as unknown as Hex,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [args.address as Hex]
      })) as bigint;
      return balance.toString() as AmountRaw;
    },

    async getAccountBalances(args): Promise<readonly { token: TokenSymbol; amountRaw: AmountRaw }[]> {
      const client = getClient(args.chainId);
      const chainId = args.chainId as ChainId;
      const tokensOnChain = TOKEN_REGISTRY.filter((t) => t.chainId === chainId);
      const erc20Tokens = tokensOnChain.filter((t) => t.contractAddress !== null);
      const nativeSym = (NATIVE_SYMBOLS[args.chainId] ?? "ETH") as TokenSymbol;

      // Try alchemy_getTokenBalances first (single call covers every requested
      // ERC-20). Falls back to per-token balanceOf when the RPC isn't an
      // Alchemy endpoint or rejects the method — non-Alchemy callers still
      // get correct results, just at one call per ERC-20 instead of one total.
      let erc20Balances: ReadonlyMap<string, bigint> | null = null;
      if (erc20Tokens.length > 0) {
        try {
          const contracts = erc20Tokens.map((t) => t.contractAddress! as Hex);
          const result = (await client.request({
            method: "alchemy_getTokenBalances" as never,
            params: [args.address as Hex, contracts] as never
          })) as { tokenBalances: Array<{ contractAddress: string; tokenBalance: string | null; error?: string | null }> };
          const m = new Map<string, bigint>();
          for (const entry of result.tokenBalances) {
            if (entry.tokenBalance === null || entry.error) continue;
            try {
              m.set(entry.contractAddress.toLowerCase(), BigInt(entry.tokenBalance));
            } catch {
              // Skip malformed entries; the caller treats absence as 0.
            }
          }
          erc20Balances = m;
        } catch {
          erc20Balances = null;
        }
      }

      // Native + ERC-20 fallback (if alchemy_getTokenBalances was unavailable)
      // run in parallel. A single failure throws; the caller treats that as
      // "couldn't snapshot this address" and skips it.
      const calls: Array<Promise<{ token: TokenSymbol; amountRaw: AmountRaw }>> = [];
      calls.push(
        client.getBalance({ address: args.address as Hex }).then((b) => ({
          token: nativeSym,
          amountRaw: b.toString() as AmountRaw
        }))
      );
      if (erc20Balances !== null) {
        for (const t of erc20Tokens) {
          const balance = erc20Balances.get((t.contractAddress as string).toLowerCase()) ?? 0n;
          calls.push(Promise.resolve({ token: t.symbol, amountRaw: balance.toString() as AmountRaw }));
        }
      } else {
        for (const t of erc20Tokens) {
          calls.push(
            (client.readContract({
              address: t.contractAddress as unknown as Hex,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [args.address as Hex]
            }) as Promise<bigint>).then((b) => ({
              token: t.symbol,
              amountRaw: b.toString() as AmountRaw
            }))
          );
        }
      }
      return Promise.all(calls);
    }
  };
}

// ---- Shared internals ----

function buildHttpTransport(
  rpcUrls: EvmChainConfig["rpcUrls"],
  chainId: number
): Transport {
  const url = rpcUrls?.[chainId];
  if (!url) {
    throw new Error(`evmChainAdapter: no rpcUrl or transport configured for chainId ${chainId}`);
  }
  return http(url);
}

// The shape the EVM adapter stores inside UnsignedTx.raw. Only this adapter
// inspects it — core/domain treats `raw` as opaque.
interface EvmUnsignedTxRaw {
  to: Hex;
  data: Hex;
  value: bigint;
  from: Hex;
  chainId: number;
  gas?: bigint;
  // EIP-1559 fee binding from the chosen tier. Both must be present together;
  // viem's sendTransaction rejects partial sets.
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

// ---- Fee sampling & binding (shared by quoteFeeTiers + buildTransfer) ----

// One rolling-window fee sample for a chain: next-block baseFee + three
// priority-fee percentiles. Tiered priorities come from `eth_feeHistory` on
// the happy path (stable across single-block noise), falling back to the
// single spot value from `eth_maxPriorityFeePerGas` scaled 0.8×/1.0×/1.5×
// only when feeHistory is unavailable.
//
// `spotGasPrice` carries the chain's current `eth_gasPrice` reading — the
// same value RPC providers use in their pre-send balance simulation. We
// floor maxFeePerGas against `spotGasPrice × 1.1` so our broadcast can never
// be cheaper than what the provider thinks it should be, which was the root
// cause of the original BSC tight-balance rejection. 0n when the RPC doesn't
// support `eth_gasPrice` (rare; degrades to the hardcoded floor).
interface FeeSample {
  readonly baseFee: bigint;
  readonly priorityLow: bigint;
  readonly priorityMid: bigint;
  readonly priorityHigh: bigint;
  readonly spotGasPrice: bigint;
}

// Read per-tier fees from the chain. Returns `null` ONLY when neither
// feeHistory nor estimateFeesPerGas produced a 1559-shaped result — i.e.
// the chain is strictly legacy-gasPrice. In every other case we return a
// best-effort sample (floors are applied in `buildFeeBinding`, not here).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function sampleFees(client: PublicClient, chainId: number): Promise<FeeSample | null> {
  // Run the gas-price probe in parallel with feeHistory so the dynamic floor
  // doesn't add latency. Best-effort: if the RPC doesn't implement
  // eth_gasPrice (very rare on EVM-compatible chains), fall back to 0n and
  // the hardcoded floor still applies.
  const spotGasPricePromise = client.getGasPrice().catch(() => 0n);
  // Happy path: eth_feeHistory gives us per-percentile priority fees + a
  // "next block" baseFee, both smoothed over a 20-block window.
  try {
    const history = await client.getFeeHistory({
      blockCount: FEE_HISTORY_BLOCK_COUNT,
      rewardPercentiles: FEE_HISTORY_PERCENTILES as number[]
    });
    // `baseFeePerGas` has blockCount+1 entries — last one is the estimated
    // next-block baseFee. Using that (not an average) matches viem's own
    // `estimateFeesPerGas` convention and tracks current network conditions
    // instead of lagging behind a stale average.
    const baseFeeArr = history.baseFeePerGas ?? [];
    const baseFee = baseFeeArr.length > 0 ? baseFeeArr[baseFeeArr.length - 1] ?? 0n : 0n;
    const rewards = history.reward ?? [];
    if (rewards.length > 0) {
      // Median across the window per percentile column. Median beats mean
      // because a single spike block doesn't pull the tier off realistic
      // values, and beats max because we don't want to overpay on one
      // outlier either.
      const median = (column: 0 | 1 | 2): bigint => {
        const vals: bigint[] = [];
        for (const row of rewards) {
          const v = row?.[column];
          if (v !== undefined && v !== null) vals.push(v);
        }
        if (vals.length === 0) return 0n;
        vals.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        return vals[Math.floor(vals.length / 2)]!;
      };
      return {
        baseFee,
        priorityLow: median(0),
        priorityMid: median(1),
        priorityHigh: median(2),
        spotGasPrice: await spotGasPricePromise
      };
    }
    // feeHistory responded but with empty `reward` rows (a fully quiet
    // window on some RPC implementations). Fall through to spot below.
  } catch (err) {
    // eth_feeHistory not implemented on this RPC. Fall through to spot.
    // Don't propagate — many private RPCs & some sidechains lack it, and
    // the fallback still produces a usable quote with floors applied.
    void err;
  }
  // Fallback path: spot eth_maxPriorityFeePerGas + latest block baseFee,
  // scaled into three tiers. Noisier than feeHistory but still floored in
  // buildFeeBinding, so a bad spot read can't starve the reservation.
  try {
    const spot = await client.estimateFeesPerGas();
    if (spot.maxPriorityFeePerGas === undefined || spot.maxFeePerGas === undefined) {
      return null;
    }
    const priority = spot.maxPriorityFeePerGas;
    const rawBase = spot.maxFeePerGas - priority;
    const baseFee = rawBase < 0n ? 0n : rawBase;
    return {
      baseFee,
      priorityLow: (priority * 4n) / 5n,
      priorityMid: priority,
      priorityHigh: (priority * 3n) / 2n,
      spotGasPrice: await spotGasPricePromise
    };
  } catch {
    return null;
  }
}

// Apply the chain's gas floor to a (baseFee, priority) pair and return the
// maxPriorityFeePerGas / maxFeePerGas values to bind on the tx. The 2×
// baseFee multiplier covers ~6 blocks of EIP-1559 baseFee growth (baseFee
// rises at most 12.5% per block, so `2 × baseFee` > `baseFee × 1.125^6`).
//
// Three flooring layers stacked on maxFeePerGas (winner is the largest):
//   1. raw = 2×baseFee + flooredPriority (the 1559-derived target)
//   2. hardcoded `minMaxFeePerGas` (panic minimum / consensus rule)
//   3. dynamic `spotGasPrice × 1.1` (provider-compatibility floor)
//
// Layer 3 is what makes our maxFeePerGas track real-time provider behavior:
// Alchemy/QuickNode/Infura all run pre-send balance simulation using
// `eth_gasPrice`, and a tx with maxFeePerGas below that simulation's price
// is rejected at the submission layer. 10% headroom covers single-block
// drift between when we sample and when the tx actually broadcasts.
function buildFeeBinding(
  chainId: number,
  baseFee: bigint,
  priority: bigint,
  spotGasPrice: bigint
): { maxPriorityFeePerGas: bigint; maxFeePerGas: bigint } {
  const floor = gasFloorFor(chainId);
  const flooredPriority =
    priority > floor.minPriorityFeePerGas ? priority : floor.minPriorityFeePerGas;
  const raw = 2n * baseFee + flooredPriority;
  let maxFeePerGas = raw > floor.minMaxFeePerGas ? raw : floor.minMaxFeePerGas;
  if (spotGasPrice > 0n) {
    const providerFloor = (spotGasPrice * 110n) / 100n;
    if (providerFloor > maxFeePerGas) maxFeePerGas = providerFloor;
  }
  return { maxPriorityFeePerGas: flooredPriority, maxFeePerGas };
}

function pickPriorityForTier(sample: FeeSample, tier: "low" | "medium" | "high"): bigint {
  if (tier === "low") return sample.priorityLow;
  if (tier === "high") return sample.priorityHigh;
  return sample.priorityMid;
}
