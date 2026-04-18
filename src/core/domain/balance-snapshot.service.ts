import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import type { Address, ChainFamily, ChainId } from "../types/chain.js";
import { formatRawAmount } from "../types/money.js";
import type { TokenSymbol } from "../types/token.js";
import { TOKEN_REGISTRY } from "../types/token-registry.js";
import { addressPool, feeWallets, payouts, transactions } from "../../db/schema.js";

// Admin balance snapshot.
//
// Two modes:
//
//   source="db" (default): balances are computed from recorded on-chain
//     activity. For each pool/fee address we sum confirmed `transactions`
//     credits by (address, chainId, token) and — for fee wallets only —
//     subtract confirmed `payouts` debits. No RPC traffic; one Alchemy /
//     Tron / Solana call per address × chain saved. Returns in ~50ms. Caveat:
//     off-system movements are invisible (manual topups of fee wallets,
//     dust to unsubscribed addresses). Sufficient for dashboards; use
//     source="rpc" when reconciling.
//
//   source="rpc" (opts.live=true): asks every wired chain adapter for the
//     live on-chain balance of every (address, chainId) pair. Authoritative,
//     slow (15–30s with a cold Alchemy connection pool on a full pool),
//     cached 60s at the HTTP layer.
//
// Tree shape is identical across modes: family → chainId → address → tokens,
// with per-chain and per-family USD roll-ups. The top-level `source` field
// tells the caller which math produced the numbers.

export type AddressKind = "pool" | "fee";

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
  // Pool-only metadata, omitted on fee-wallet rows.
  poolStatus?: "available" | "allocated" | "quarantined";
  poolAllocatedToInvoiceId?: string | null;
  // Fee-wallet-only metadata, omitted on pool rows.
  feeLabel?: string;
  totalUsd: string;
  tokens: readonly TokenBalance[];
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
  // Narrow to one address kind. Default: both "pool" and "fee".
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
  const wantPool = opts.kind === undefined || opts.kind === "pool";
  const wantFee = opts.kind === undefined || opts.kind === "fee";

  // 1. Load pool + fee-wallet rows (same filters as the rpc path, minus the
  //    cross-product with chainIds — chainIds come from the transactions
  //    table instead).
  const poolRowsPromise = wantPool ? loadPoolRows(deps, opts) : Promise.resolve([]);
  const feeRowsPromise = wantFee ? loadFeeRows(deps, opts) : Promise.resolve([]);
  const [poolRows, feeRows] = await Promise.all([poolRowsPromise, feeRowsPromise]);

  const poolAddressSet = new Set(poolRows.map((r) => r.address));
  const feeAddressKeys = new Set(feeRows.map((r) => key3(r.address, r.chainId)));
  const allAddresses = [...new Set([...poolRows.map((r) => r.address), ...feeRows.map((r) => r.address)])];

  if (allAddresses.length === 0) {
    return {
      generatedAt: deps.clock.now().toISOString(),
      source: "db",
      totalUsd: "0.00",
      families: []
    };
  }

  // 2. Sum confirmed incoming transfers by (toAddress, chainId, token).
  //    One grouped query covers every address we care about.
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
      amountRaw: sql<string>`COALESCE(SUM(CAST(${transactions.amountRaw} AS TEXT)), '0')`
    })
    .from(transactions)
    .where(and(...creditConds))
    .groupBy(transactions.toAddress, transactions.chainId, transactions.token);

  // 3. Sum confirmed outgoing payouts by (sourceAddress, chainId, token).
  //    Only applies to fee wallets (pool addresses never appear as a payout
  //    source — payouts fund from fee wallets). Guard on source not being
  //    null so the planned/reserved rows don't contribute.
  const debitConds: SQL[] = [
    eq(payouts.status, "confirmed"),
    sql`${payouts.sourceAddress} IS NOT NULL`
  ];
  if (opts.chainId !== undefined) debitConds.push(eq(payouts.chainId, opts.chainId));
  const debitRowsRaw = feeRows.length > 0
    ? await deps.db
        .select({
          address: payouts.sourceAddress,
          chainId: payouts.chainId,
          token: payouts.token,
          amountRaw: sql<string>`COALESCE(SUM(CAST(${payouts.amountRaw} AS TEXT)), '0')`
        })
        .from(payouts)
        .where(and(...debitConds))
        .groupBy(payouts.sourceAddress, payouts.chainId, payouts.token)
    : [];
  const debitRows = debitRowsRaw.filter((r) => r.address !== null);

  // 4. Fold credits + debits into per-(address, chainId) buckets. Pool rows
  //    use credits only; fee rows use credits − debits clamped at 0 (a
  //    negative result means the fee wallet was topped up externally and
  //    we don't have the deposit recorded — displayable as "unknown, use
  //    ?live=true" via clamp).
  type Bucket = { token: TokenSymbol; amountRaw: bigint };
  const balances = new Map<string, Map<number, Bucket[]>>();
  // address → chainId → tokens[]
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

  // Credits: pool addresses get them outright; fee wallets only if we have
  // a matching (address, chainId) row (prevents pool-credited transactions
  // from leaking onto fee wallets that happen to share no chainId scope).
  for (const r of creditRows) {
    const isPool = poolAddressSet.has(r.address);
    const isFee = feeAddressKeys.has(key3(r.address, r.chainId));
    if (!isPool && !isFee) continue;
    if (opts.chainId !== undefined && opts.chainId !== r.chainId) continue;
    const amount = BigInt(r.amountRaw);
    if (amount <= 0n) continue;
    const list = ensure(r.address, r.chainId);
    const existing = list.find((e) => e.token === r.token);
    if (existing) existing.amountRaw += amount;
    else list.push({ token: r.token as TokenSymbol, amountRaw: amount });
  }

  // Debits: subtract from fee rows only.
  for (const r of debitRows) {
    if (r.address === null) continue;
    if (!feeAddressKeys.has(key3(r.address, r.chainId))) continue;
    if (opts.chainId !== undefined && opts.chainId !== r.chainId) continue;
    const amount = BigInt(r.amountRaw);
    if (amount <= 0n) continue;
    const list = ensure(r.address, r.chainId);
    const existing = list.find((e) => e.token === r.token);
    if (existing) {
      existing.amountRaw -= amount;
      if (existing.amountRaw < 0n) existing.amountRaw = 0n;
    }
    // No existing credit means we've paid out funds we never saw arrive —
    // external topup. Showing it as a negative row is misleading; omit.
  }

  // 5. Shape into the family → chain → address tree. chainId → family
  //    comes from addressPool rows for pool entries, and from adapter
  //    lookup for fee wallets.
  const familyMap = new Map<ChainFamily, Map<ChainId, ChainAggregator>>();
  const poolFamilyByAddr = new Map(poolRows.map((r) => [r.address, r.family] as const));

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
    if (!byChain) continue; // pristine — skip in db mode
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

  for (const feeRow of feeRows) {
    const family = familyForChain(deps, feeRow.chainId);
    if (family === null) continue;
    if (opts.family !== undefined && family !== opts.family) continue;
    const byChain = balances.get(feeRow.address);
    const list = byChain?.get(feeRow.chainId);
    if (!list || list.length === 0) continue;
    if (opts.chainId !== undefined && opts.chainId !== feeRow.chainId) continue;
    const agg = ensureAggregator(familyMap, family, feeRow.chainId as ChainId);
    pushAddressRow(agg, {
      address: feeRow.address,
      kind: "fee",
      feeLabel: feeRow.label
    }, list, feeRow.chainId as ChainId, usdRates);
  }

  return materialize(familyMap, deps.clock.now().toISOString(), "db");
}

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

async function loadFeeRows(
  deps: AppDeps,
  opts: BalanceSnapshotOptions
): Promise<readonly { chainId: number; address: string; label: string }[]> {
  const conds: SQL[] = [sql`${feeWallets.active} = 1`];
  if (opts.chainId !== undefined) conds.push(eq(feeWallets.chainId, opts.chainId));
  if (opts.address !== undefined) conds.push(eq(feeWallets.address, opts.address));
  return await deps.db
    .select({ chainId: feeWallets.chainId, address: feeWallets.address, label: feeWallets.label })
    .from(feeWallets)
    .where(and(...conds));
}

function familyForChain(deps: AppDeps, chainId: number): ChainFamily | null {
  const adapter = deps.chains.find((a) => a.supportedChainIds.includes(chainId as ChainId));
  return adapter ? adapter.family : null;
}

function key3(address: string, chainId: number): string {
  return `${address}::${chainId}`;
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
  const perAddressResults = await Promise.all(
    targets.map(async (t) => {
      const adapter = deps.chains.find((a) => a.supportedChainIds.includes(t.chainId));
      if (!adapter) {
        return { target: t, balances: null as readonly { token: TokenSymbol; amountRaw: string }[] | null };
      }
      try {
        const balances = await adapter.getAccountBalances({
          chainId: t.chainId,
          address: t.address as Address
        });
        return { target: t, balances };
      } catch (err) {
        deps.logger.warn("balance snapshot: getAccountBalances failed", {
          chainId: t.chainId,
          address: t.address,
          error: err instanceof Error ? err.message : String(err)
        });
        return { target: t, balances: null };
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
    const { target, balances } = result;
    const agg = ensureAggregator(familyMap, target.family, target.chainId);
    if (balances === null) {
      agg.errors += 1;
      continue;
    }
    const tokens = balances.map((b) => ({
      token: b.token,
      amountRaw: BigInt(b.amountRaw)
    }));
    pushAddressRow(
      agg,
      target.kind === "pool"
        ? {
            address: target.address,
            kind: "pool",
            poolStatus: target.poolStatus,
            poolAllocatedToInvoiceId: target.poolAllocatedToInvoiceId ?? null
          }
        : { address: target.address, kind: "fee", feeLabel: target.feeLabel },
      tokens,
      target.chainId,
      usdRates
    );
  }

  return materialize(familyMap, deps.clock.now().toISOString(), "rpc");
}

// ---- Shared aggregation ----

type SnapshotTarget =
  | {
      family: ChainFamily;
      chainId: ChainId;
      address: string;
      kind: "pool";
      poolStatus: "available" | "allocated" | "quarantined";
      poolAllocatedToInvoiceId: string | null;
    }
  | {
      family: ChainFamily;
      chainId: ChainId;
      address: string;
      kind: "fee";
      feeLabel: string;
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
  meta:
    | { address: string; kind: "pool"; poolStatus: "available" | "allocated" | "quarantined"; poolAllocatedToInvoiceId: string | null }
    | { address: string; kind: "fee"; feeLabel: string },
  tokens: readonly { token: TokenSymbol; amountRaw: bigint | string }[],
  chainId: ChainId,
  usdRates: Record<string, string>
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

  const addressRow: AddressBalance =
    meta.kind === "pool"
      ? {
          address: meta.address,
          kind: "pool",
          poolStatus: meta.poolStatus,
          poolAllocatedToInvoiceId: meta.poolAllocatedToInvoiceId,
          totalUsd: addressTotal.toFixed(2),
          tokens: tokensWithUsd
        }
      : {
          address: meta.address,
          kind: "fee",
          feeLabel: meta.feeLabel,
          totalUsd: addressTotal.toFixed(2),
          tokens: tokensWithUsd
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
  // Group registered chain adapters by family, and per family list the
  // chainIds we'll snapshot pool addresses against. Tron and Solana have one
  // chainId each in practice; EVM has 7+. The set is whatever the entrypoint
  // wired into deps.chains.
  const chainIdsByFamily = new Map<ChainFamily, ChainId[]>();
  for (const adapter of deps.chains) {
    const list = chainIdsByFamily.get(adapter.family) ?? [];
    list.push(...adapter.supportedChainIds);
    chainIdsByFamily.set(adapter.family, list);
  }

  const targets: SnapshotTarget[] = [];
  const wantPool = opts.kind === undefined || opts.kind === "pool";
  const wantFee = opts.kind === undefined || opts.kind === "fee";

  if (wantPool) {
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
    const poolRows = conds.length === 0
      ? await baseQuery
      : await baseQuery.where(and(...conds));

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
  }

  if (wantFee) {
    const conds: SQL[] = [sql`${feeWallets.active} = 1`];
    if (opts.chainId !== undefined) conds.push(eq(feeWallets.chainId, opts.chainId));
    if (opts.address !== undefined) conds.push(eq(feeWallets.address, opts.address));
    const feeRows = await deps.db
      .select({
        chainId: feeWallets.chainId,
        address: feeWallets.address,
        label: feeWallets.label
      })
      .from(feeWallets)
      .where(and(...conds));

    for (const row of feeRows) {
      const adapter = deps.chains.find((a) => a.supportedChainIds.includes(row.chainId));
      if (!adapter) continue;
      if (opts.family !== undefined && opts.family !== adapter.family) continue;
      targets.push({
        family: adapter.family,
        chainId: row.chainId as ChainId,
        address: row.address,
        kind: "fee",
        feeLabel: row.label
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
