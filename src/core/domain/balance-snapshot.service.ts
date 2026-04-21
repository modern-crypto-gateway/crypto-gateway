import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import type { Address, ChainFamily, ChainId } from "../types/chain.js";
import { formatRawAmount } from "../types/money.js";
import type { TokenSymbol } from "../types/token.js";
import { TOKEN_REGISTRY } from "../types/token-registry.js";
import { addressPool, payoutReservations, payouts, transactions } from "../../db/schema.js";

// Admin balance snapshot.
//
// Every gateway-controlled address lives in `address_pool`. The same row
// can serve a customer-paid invoice (inbound) AND back outbound payouts
// (the picker treats every pool row as a candidate source). Spendable
// balance = confirmed inbound − confirmed outbound − active reservations,
// per (chainId, address, token).
//
// Two modes:
//
//   source="db" (default): pure ledger arithmetic. No RPC traffic; runs
//     in ~50ms. Caveat: deposits the watcher missed are invisible — use
//     source="rpc" to reconcile.
//
//   source="rpc" (opts.live=true): asks every wired chain adapter for the
//     live on-chain balance of every (address, chainId) pair. Authoritative,
//     slow (15–30s with a cold Alchemy connection pool on a full pool),
//     cached 60s at the HTTP layer.
//
// Tree shape is identical across modes: family → chainId → address → tokens,
// with per-chain and per-family USD roll-ups.

export type AddressKind = "pool";

export interface TokenBalance {
  token: TokenSymbol;
  decimals: number;
  amountRaw: string;
  amountDecimal: string;
  // USD value of this balance. "0.00" when the token isn't priced (oracle
  // miss) — `usdRate` is null in that case so the caller can distinguish
  // "really zero" from "couldn't price".
  usd: string;
  usdRate: string | null;
}

export interface AddressBalance {
  address: string;
  kind: AddressKind;
  poolStatus?: "available" | "allocated" | "quarantined";
  poolAllocatedToInvoiceId?: string | null;
  totalUsd: string;
  tokens: readonly TokenBalance[];
  // Set (rpc mode only) when getAccountBalances failed for this address —
  // TronGrid rate-limit, network timeout, malformed response. Without this
  // field the address was silently dropped from the rendered list, which
  // looked like "the snapshot ignored that address" to operators. Presence
  // of `error` means the tokens array is empty / un-reconciled, not "zero".
  error?: string;
}

export interface ChainBalance {
  chainId: ChainId;
  totalUsd: string;
  // Roll-up per token across every address on this chain.
  tokens: readonly { token: TokenSymbol; amountRaw: string; amountDecimal: string; usd: string }[];
  addresses: readonly AddressBalance[];
  // Number of addresses we tried to snapshot but couldn't (RPC error,
  // missing adapter config). Always 0 in source="db" mode.
  errors: number;
}

export interface FamilyBalance {
  family: ChainFamily;
  totalUsd: string;
  chains: readonly ChainBalance[];
}

export interface BalanceSnapshot {
  generatedAt: string;
  source: "db" | "rpc";
  totalUsd: string;
  families: readonly FamilyBalance[];
}

export interface BalanceSnapshotOptions {
  // Narrow to a single family (e.g. "evm"). Default: every family with at
  // least one configured adapter (rpc mode) or any recorded activity (db mode).
  family?: ChainFamily;
  // Narrow to a single chainId. Implicitly narrows family too.
  chainId?: ChainId;
  // Narrow to one address kind. Currently only "pool" exists; option is
  // kept for API stability with prior callers.
  kind?: AddressKind;
  // Narrow to a single address. Useful when an operator wants to spot-check
  // one row without paying the full sweep cost.
  address?: string;
  // Opt into live on-chain RPC reconciliation. Off by default — the DB-
  // derived computation is ~300× faster and covers the common dashboard
  // case. Flip to true for ad-hoc reconciliation or after an external topup.
  live?: boolean;
}

export async function computeBalanceSnapshot(
  deps: AppDeps,
  opts: BalanceSnapshotOptions = {}
): Promise<BalanceSnapshot> {
  if (opts.live === true) {
    return computeBalanceSnapshotRpc(deps, opts);
  }
  return computeBalanceSnapshotDb(deps, opts);
}

// ---- DB-derived path ----

async function computeBalanceSnapshotDb(
  deps: AppDeps,
  opts: BalanceSnapshotOptions
): Promise<BalanceSnapshot> {
  // 1. Load pool rows. Every gateway-controlled HD address lives here; the
  //    snapshot has no other source.
  const poolRows = await loadPoolRows(deps, opts);
  const poolAddressSet = new Set(poolRows.map((r) => r.address));
  const allAddresses = poolRows.map((r) => r.address);

  if (allAddresses.length === 0) {
    return {
      generatedAt: deps.clock.now().toISOString(),
      source: "db",
      totalUsd: "0.00",
      families: []
    };
  }

  // 2. Confirmed inbound credits, scoped to our addresses.
  const creditConds: SQL[] = [
    eq(transactions.status, "confirmed"),
    inArray(transactions.toAddress, allAddresses)
  ];
  if (opts.chainId !== undefined) creditConds.push(eq(transactions.chainId, opts.chainId));
  const creditRows = await deps.db
    .select({
      address: transactions.toAddress,
      chainId: transactions.chainId,
      token: transactions.token,
      amountRaw: transactions.amountRaw
    })
    .from(transactions)
    .where(and(...creditConds));

  // 3. Confirmed outbound payouts. Every pool address is a candidate
  //    source, so we apply this debit to ANY pool row that matches.
  const debitConds: SQL[] = [
    eq(payouts.status, "confirmed"),
    sql`${payouts.sourceAddress} IS NOT NULL`
  ];
  if (opts.chainId !== undefined) debitConds.push(eq(payouts.chainId, opts.chainId));
  const debitRows = await deps.db
    .select({
      address: payouts.sourceAddress,
      chainId: payouts.chainId,
      token: payouts.token,
      amountRaw: payouts.amountRaw
    })
    .from(payouts)
    .where(and(...debitConds));

  // 4. Active reservations (in-flight debits the operator should see as
  //    "spoken for, not available to spend"). Same shape as debits.
  const resConds: SQL[] = [
    isNull(payoutReservations.releasedAt),
    inArray(payoutReservations.address, allAddresses)
  ];
  if (opts.chainId !== undefined) resConds.push(eq(payoutReservations.chainId, opts.chainId));
  const reservationRows = await deps.db
    .select({
      address: payoutReservations.address,
      chainId: payoutReservations.chainId,
      token: payoutReservations.token,
      amountRaw: payoutReservations.amountRaw
    })
    .from(payoutReservations)
    .where(and(...resConds));

  // 5. Fold credits, debits, and reservations into per-(address, chainId)
  //    buckets. Negative results clamp to 0 — a negative would mean the
  //    ledger missed a top-up; flag it via the rpc=true path on demand.
  type Bucket = { token: TokenSymbol; amountRaw: bigint };
  const balances = new Map<string, Map<number, Bucket[]>>();
  const ensure = (addr: string, chainId: number) => {
    let byChain = balances.get(addr);
    if (!byChain) {
      byChain = new Map();
      balances.set(addr, byChain);
    }
    let list = byChain.get(chainId);
    if (!list) {
      list = [];
      byChain.set(chainId, list);
    }
    return list;
  };

  for (const r of creditRows) {
    if (!poolAddressSet.has(r.address)) continue;
    if (opts.chainId !== undefined && opts.chainId !== r.chainId) continue;
    const amount = BigInt(r.amountRaw);
    if (amount <= 0n) continue;
    const list = ensure(r.address, r.chainId);
    const existing = list.find((e) => e.token === r.token);
    if (existing) existing.amountRaw += amount;
    else list.push({ token: r.token as TokenSymbol, amountRaw: amount });
  }

  for (const r of debitRows) {
    if (r.address === null) continue;
    if (!poolAddressSet.has(r.address)) continue;
    if (opts.chainId !== undefined && opts.chainId !== r.chainId) continue;
    const amount = BigInt(r.amountRaw);
    if (amount <= 0n) continue;
    const list = ensure(r.address, r.chainId);
    const existing = list.find((e) => e.token === r.token);
    if (existing) {
      existing.amountRaw -= amount;
      if (existing.amountRaw < 0n) existing.amountRaw = 0n;
    }
  }

  for (const r of reservationRows) {
    if (opts.chainId !== undefined && opts.chainId !== r.chainId) continue;
    const amount = BigInt(r.amountRaw);
    if (amount <= 0n) continue;
    const list = ensure(r.address, r.chainId);
    const existing = list.find((e) => e.token === r.token);
    if (existing) {
      existing.amountRaw -= amount;
      if (existing.amountRaw < 0n) existing.amountRaw = 0n;
    }
  }

  const familyMap = new Map<ChainFamily, Map<ChainId, ChainAggregator>>();

  const allSymbols = new Set<TokenSymbol>();
  for (const [, byChain] of balances) {
    for (const [, list] of byChain) {
      for (const b of list) allSymbols.add(b.token);
    }
  }
  const usdRates = allSymbols.size > 0
    ? await deps.priceOracle.getUsdRates([...allSymbols]).catch(() => ({} as Record<string, string>))
    : ({} as Record<string, string>);

  for (const poolRow of poolRows) {
    if (opts.family !== undefined && poolRow.family !== opts.family) continue;
    const byChain = balances.get(poolRow.address);
    if (!byChain) continue;
    for (const [chainId, list] of byChain) {
      if (opts.chainId !== undefined && opts.chainId !== chainId) continue;
      if (list.length === 0) continue;
      const agg = ensureAggregator(familyMap, poolRow.family, chainId as ChainId);
      pushAddressRow(agg, {
        address: poolRow.address,
        kind: "pool",
        poolStatus: poolRow.status,
        poolAllocatedToInvoiceId: poolRow.allocatedToInvoiceId ?? null
      }, list, chainId as ChainId, usdRates);
    }
  }

  return materialize(familyMap, deps.clock.now().toISOString(), "db");
}

// Spendable balance for a single (chainId, address, token) tuple.
// Used by the payout source picker.
//
// Computation: confirmed inbound − confirmed outbound − active reservations.
// Negative results clamp to zero (a negative would mean we somehow paid out
// funds we never observed arriving; treat as zero spendable until reconciled).
//
// Accepts EITHER `deps` (the common case) OR a raw `Db`/transaction handle.
// The transaction overload is what `selectSource`/`planPayout` use to keep
// the read+insert atomic under a `BEGIN IMMEDIATE` lock — without it, two
// parallel plans on the same source can both observe "fits" and both insert,
// over-reserving.
export async function computeSpendable(
  depsOrDb: AppDeps | SpendableQueryRunner,
  args: { chainId: number; address: string; token: string }
): Promise<bigint> {
  const db: SpendableQueryRunner =
    "db" in depsOrDb ? (depsOrDb as AppDeps).db : depsOrDb;
  const { chainId, address, token } = args;

  const [creditRowsRaw, debitRowsRaw, resRowsRaw] = await Promise.all([
    db
      .select({ amountRaw: transactions.amountRaw })
      .from(transactions)
      .where(
        and(
          eq(transactions.status, "confirmed"),
          eq(transactions.toAddress, address),
          eq(transactions.chainId, chainId),
          eq(transactions.token, token)
        )
      ),
    db
      .select({ amountRaw: payouts.amountRaw })
      .from(payouts)
      .where(
        and(
          eq(payouts.status, "confirmed"),
          eq(payouts.chainId, chainId),
          eq(payouts.token, token),
          sql`${payouts.sourceAddress} = ${address}`
        )
      ),
    db
      .select({ amountRaw: payoutReservations.amountRaw })
      .from(payoutReservations)
      .where(
        and(
          isNull(payoutReservations.releasedAt),
          eq(payoutReservations.chainId, chainId),
          eq(payoutReservations.address, address),
          eq(payoutReservations.token, token)
        )
      )
  ]);

  let total = 0n;
  for (const r of creditRowsRaw) total += BigInt(r.amountRaw);
  for (const r of debitRowsRaw) total -= BigInt(r.amountRaw);
  for (const r of resRowsRaw) total -= BigInt(r.amountRaw);
  return total < 0n ? 0n : total;
}

// Minimal subset of the drizzle Db / transaction surface that
// `computeSpendable` actually uses. Both `LibSQLDatabase` and the transaction
// handle returned by `db.transaction()` satisfy this — we type-narrow rather
// than name-import the transaction type so this stays portable across
// drizzle-orm minor versions.
type SpendableQueryRunner = {
  select: AppDeps["db"]["select"];
};

async function loadPoolRows(
  deps: AppDeps,
  opts: BalanceSnapshotOptions
): Promise<readonly {
  family: ChainFamily;
  address: string;
  status: "available" | "allocated" | "quarantined";
  allocatedToInvoiceId: string | null;
}[]> {
  const conds: SQL[] = [];
  if (opts.family !== undefined) conds.push(eq(addressPool.family, opts.family));
  if (opts.address !== undefined) conds.push(eq(addressPool.address, opts.address));
  const base = deps.db
    .select({
      family: addressPool.family,
      address: addressPool.address,
      status: addressPool.status,
      allocatedToInvoiceId: addressPool.allocatedToInvoiceId
    })
    .from(addressPool);
  return conds.length === 0 ? await base : await base.where(and(...conds));
}


// ---- RPC path (live reconciliation) ----

async function computeBalanceSnapshotRpc(
  deps: AppDeps,
  opts: BalanceSnapshotOptions
): Promise<BalanceSnapshot> {
  // 1. Discover the universe of (chainId, address, kind) tuples to snapshot.
  const targets = await collectTargets(deps, opts);

  // 2. Fan out one getAccountBalances call per (chainId, address). Errors
  //    are caught per-tuple so one bad RPC doesn't poison the whole report.
  //    We carry the error message forward so the rendered snapshot can mark
  //    the specific row that failed, instead of silently dropping it.
  const perAddressResults = await Promise.all(
    targets.map(async (t) => {
      const adapter = deps.chains.find((a) => a.supportedChainIds.includes(t.chainId));
      if (!adapter) {
        return {
          target: t,
          balances: null as readonly { token: TokenSymbol; amountRaw: string }[] | null,
          errorMessage: "no adapter wired for chainId"
        };
      }
      try {
        const balances = await adapter.getAccountBalances({
          chainId: t.chainId,
          address: t.address as Address
        });
        return { target: t, balances, errorMessage: null as string | null };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        deps.logger.warn("balance snapshot: getAccountBalances failed", {
          chainId: t.chainId,
          address: t.address,
          error: errorMessage
        });
        return { target: t, balances: null, errorMessage };
      }
    })
  );

  // 3. Pull a single batch of USD rates for every symbol we observed. One
  //    oracle call covers the whole snapshot — much cheaper than per-row
  //    `tokenToFiat` lookups.
  const symbols = new Set<TokenSymbol>();
  for (const r of perAddressResults) {
    if (r.balances === null) continue;
    for (const b of r.balances) {
      if (BigInt(b.amountRaw) > 0n) symbols.add(b.token);
    }
  }
  const usdRates = symbols.size > 0
    ? await deps.priceOracle.getUsdRates([...symbols]).catch(() => ({} as Record<string, string>))
    : ({} as Record<string, string>);

  // 4. Group by (family, chainId) and aggregate.
  const familyMap = new Map<ChainFamily, Map<ChainId, ChainAggregator>>();

  for (const result of perAddressResults) {
    const { target, balances, errorMessage } = result;
    const agg = ensureAggregator(familyMap, target.family, target.chainId);
    if (balances === null) {
      agg.errors += 1;
      pushAddressRow(
        agg,
        {
          address: target.address,
          kind: "pool",
          poolStatus: target.poolStatus,
          poolAllocatedToInvoiceId: target.poolAllocatedToInvoiceId ?? null
        },
        [],
        target.chainId,
        usdRates,
        errorMessage ?? "unknown error"
      );
      continue;
    }
    const tokens = balances.map((b) => ({
      token: b.token,
      amountRaw: BigInt(b.amountRaw)
    }));
    pushAddressRow(
      agg,
      {
        address: target.address,
        kind: "pool",
        poolStatus: target.poolStatus,
        poolAllocatedToInvoiceId: target.poolAllocatedToInvoiceId ?? null
      },
      tokens,
      target.chainId,
      usdRates
    );
  }

  return materialize(familyMap, deps.clock.now().toISOString(), "rpc");
}

// ---- Shared aggregation ----

type SnapshotTarget = {
  family: ChainFamily;
  chainId: ChainId;
  address: string;
  kind: "pool";
  poolStatus: "available" | "allocated" | "quarantined";
  poolAllocatedToInvoiceId: string | null;
};

interface ChainAggregator {
  chainId: ChainId;
  totalUsd: number;
  addresses: AddressBalance[];
  tokenRollup: Map<TokenSymbol, { amountRaw: bigint; usd: number; decimals: number }>;
  errors: number;
}

function newChainAggregator(chainId: ChainId): ChainAggregator {
  return { chainId, totalUsd: 0, addresses: [], tokenRollup: new Map(), errors: 0 };
}

function ensureAggregator(
  familyMap: Map<ChainFamily, Map<ChainId, ChainAggregator>>,
  family: ChainFamily,
  chainId: ChainId
): ChainAggregator {
  let chainsMap = familyMap.get(family);
  if (!chainsMap) {
    chainsMap = new Map();
    familyMap.set(family, chainsMap);
  }
  let chainAgg = chainsMap.get(chainId);
  if (!chainAgg) {
    chainAgg = newChainAggregator(chainId);
    chainsMap.set(chainId, chainAgg);
  }
  return chainAgg;
}

function pushAddressRow(
  agg: ChainAggregator,
  meta: {
    address: string;
    kind: "pool";
    poolStatus: "available" | "allocated" | "quarantined";
    poolAllocatedToInvoiceId: string | null;
  },
  tokens: readonly { token: TokenSymbol; amountRaw: bigint | string }[],
  chainId: ChainId,
  usdRates: Record<string, string>,
  errorMessage?: string
): void {
  const tokensWithUsd = tokens.map((b) => {
    const decimals = decimalsFor(chainId, b.token);
    const amountRaw = typeof b.amountRaw === "bigint" ? b.amountRaw.toString() : b.amountRaw;
    const amountDecimal = formatRawAmount(amountRaw, decimals);
    const usdRate = usdRates[b.token] ?? null;
    const usd = computeUsd(amountDecimal, usdRate);
    return { token: b.token, decimals, amountRaw, amountDecimal, usd, usdRate } satisfies TokenBalance;
  });

  let addressTotal = 0;
  for (const t of tokensWithUsd) addressTotal = addUsd(addressTotal, t.usd);

  const addressRow: AddressBalance = {
    address: meta.address,
    kind: "pool",
    poolStatus: meta.poolStatus,
    poolAllocatedToInvoiceId: meta.poolAllocatedToInvoiceId,
    totalUsd: addressTotal.toFixed(2),
    tokens: tokensWithUsd,
    ...(errorMessage !== undefined ? { error: errorMessage } : {})
  };
  agg.addresses.push(addressRow);
  agg.totalUsd = addUsd(agg.totalUsd, addressRow.totalUsd);

  for (const t of tokensWithUsd) {
    const prev = agg.tokenRollup.get(t.token) ?? { amountRaw: 0n, usd: 0, decimals: t.decimals };
    prev.amountRaw += BigInt(t.amountRaw);
    prev.usd = addUsd(prev.usd, t.usd);
    prev.decimals = t.decimals;
    agg.tokenRollup.set(t.token, prev);
  }
}

function materialize(
  familyMap: Map<ChainFamily, Map<ChainId, ChainAggregator>>,
  generatedAt: string,
  source: "db" | "rpc"
): BalanceSnapshot {
  const families: FamilyBalance[] = [];
  let grandTotal = 0;
  for (const [family, chainsMap] of familyMap) {
    const chains: ChainBalance[] = [];
    let familyTotal = 0;
    for (const [chainId, agg] of chainsMap) {
      const tokens = [...agg.tokenRollup.entries()]
        .map(([token, v]) => ({
          token,
          amountRaw: v.amountRaw.toString(),
          amountDecimal: formatRawAmount(v.amountRaw.toString(), v.decimals),
          usd: v.usd.toFixed(2)
        }))
        .sort((a, b) => Number(b.usd) - Number(a.usd));
      chains.push({
        chainId,
        totalUsd: agg.totalUsd.toFixed(2),
        tokens,
        addresses: agg.addresses.sort((a, b) => Number(b.totalUsd) - Number(a.totalUsd)),
        errors: agg.errors
      });
      familyTotal = addUsd(familyTotal, agg.totalUsd.toFixed(2));
    }
    chains.sort((a, b) => Number(b.totalUsd) - Number(a.totalUsd));
    families.push({ family, totalUsd: familyTotal.toFixed(2), chains });
    grandTotal = addUsd(grandTotal, familyTotal.toFixed(2));
  }
  families.sort((a, b) => a.family.localeCompare(b.family));

  return { generatedAt, source, totalUsd: grandTotal.toFixed(2), families };
}

async function collectTargets(
  deps: AppDeps,
  opts: BalanceSnapshotOptions
): Promise<readonly SnapshotTarget[]> {
  const chainIdsByFamily = new Map<ChainFamily, ChainId[]>();
  for (const adapter of deps.chains) {
    const list = chainIdsByFamily.get(adapter.family) ?? [];
    list.push(...adapter.supportedChainIds);
    chainIdsByFamily.set(adapter.family, list);
  }

  const conds: SQL[] = [];
  if (opts.family !== undefined) conds.push(eq(addressPool.family, opts.family));
  if (opts.address !== undefined) conds.push(eq(addressPool.address, opts.address));
  const baseQuery = deps.db
    .select({
      family: addressPool.family,
      address: addressPool.address,
      status: addressPool.status,
      allocatedToInvoiceId: addressPool.allocatedToInvoiceId
    })
    .from(addressPool);
  const poolRows = conds.length === 0 ? await baseQuery : await baseQuery.where(and(...conds));

  const targets: SnapshotTarget[] = [];
  for (const row of poolRows) {
    const chainsForFamily = chainIdsByFamily.get(row.family) ?? [];
    for (const chainId of chainsForFamily) {
      if (opts.chainId !== undefined && opts.chainId !== chainId) continue;
      targets.push({
        family: row.family,
        chainId,
        address: row.address,
        kind: "pool",
        poolStatus: row.status,
        poolAllocatedToInvoiceId: row.allocatedToInvoiceId
      });
    }
  }
  return targets;
}

function decimalsFor(chainId: ChainId, symbol: TokenSymbol): number {
  const t = TOKEN_REGISTRY.find((r) => r.chainId === chainId && r.symbol === symbol);
  if (t) return t.decimals;
  // Native gas tokens that aren't always present in the registry (e.g. TRX
  // on Tron mainnet). Fall back to known per-symbol defaults so a missing
  // registry entry doesn't render the rendered amount as an integer.
  if (symbol === "TRX") return 6;
  if (symbol === "ETH" || symbol === "BNB" || symbol === "POL") return 18;
  if (symbol === "SOL") return 9;
  return 0;
}

function computeUsd(amountDecimal: string, usdRate: string | null): string {
  if (usdRate === null) return "0.00";
  // Multiply two decimal strings without losing precision: scale to a fixed
  // number of fractional digits, multiply as bigints, then format.
  const SCALE = 1_000_000_000_000n; // 12 fractional digits is plenty for USD
  const a = scaleToBigInt(amountDecimal, 12n);
  const b = scaleToBigInt(usdRate, 12n);
  const product = (a * b) / SCALE; // result is in SCALE units
  // round to 2 decimal places
  const roundedHundredths = (product + 5_000_000_000n) / 10_000_000_000n; // +0.5 cent then /1e10
  const cents = roundedHundredths;
  const whole = cents / 100n;
  const frac = cents % 100n;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

function scaleToBigInt(decimalStr: string, fracDigits: bigint): bigint {
  const [whole, frac = ""] = decimalStr.split(".");
  const padded = (frac + "0".repeat(Number(fracDigits))).slice(0, Number(fracDigits));
  return BigInt(whole ?? "0") * 10n ** fracDigits + BigInt(padded || "0");
}

function addUsd(prev: number | string, next: string): number {
  const p = typeof prev === "number" ? prev : Number(prev);
  return p + Number(next);
}
