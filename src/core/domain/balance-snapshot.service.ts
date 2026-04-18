import { and, eq, sql, type SQL } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import type { Address, ChainFamily, ChainId } from "../types/chain.js";
import { formatRawAmount } from "../types/money.js";
import type { TokenSymbol } from "../types/token.js";
import { TOKEN_REGISTRY } from "../types/token-registry.js";
import { addressPool, feeWallets } from "../../db/schema.js";

// Admin balance snapshot.
//
// Walks every gateway-owned address (pool + fee wallets) on every configured
// chain, asks each chain adapter for ALL token balances in one call (via the
// new `getAccountBalances` port method), then joins the results with the
// price oracle to compute per-token + per-chain + per-family + grand-total
// USD. The output is shaped for an operator dashboard: drill from family →
// chain → address with rolled-up subtotals at every level.
//
// Why pool + fee wallets and not invoices? Invoice receive addresses are
// pool members (the join table points back into address_pool); enumerating
// the pool already covers them. Fee wallets are separate per-chain rows
// so we surface them explicitly under each chain.
//
// Cost shape: for an EVM family with N pool addresses across C configured
// EVM chains we issue N×C calls to `getAccountBalances`. Each call is one
// alchemy_getTokenBalances + one eth_getBalance — bounded regardless of
// how many tokens the registry lists for that chain. Tron and Solana are
// one call per address per chain. The HTTP surface caches for 60s so a
// dashboard auto-refresh can't melt the RPC budget.

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
  // missing adapter config). Surfaced so operators don't read a partial
  // total as authoritative.
  errors: number;
}

export interface FamilyBalance {
  family: ChainFamily;
  totalUsd: string;
  chains: readonly ChainBalance[];
}

export interface BalanceSnapshot {
  generatedAt: string;
  totalUsd: string;
  families: readonly FamilyBalance[];
}

export interface BalanceSnapshotOptions {
  // Narrow to a single family (e.g. "evm"). Default: every family with at
  // least one configured adapter.
  family?: ChainFamily;
  // Narrow to a single chainId. Implicitly narrows family too.
  chainId?: ChainId;
  // Narrow to one address kind. Default: both "pool" and "fee".
  kind?: AddressKind;
  // Narrow to a single address. Useful when an operator wants to spot-check
  // one row without paying the full sweep cost.
  address?: string;
}

export async function computeBalanceSnapshot(
  deps: AppDeps,
  opts: BalanceSnapshotOptions = {}
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
    let chainsMap = familyMap.get(target.family);
    if (!chainsMap) {
      chainsMap = new Map();
      familyMap.set(target.family, chainsMap);
    }
    let chainAgg = chainsMap.get(target.chainId);
    if (!chainAgg) {
      chainAgg = newChainAggregator(target.chainId);
      chainsMap.set(target.chainId, chainAgg);
    }
    if (balances === null) {
      chainAgg.errors += 1;
      continue;
    }

    const tokensWithUsd = balances.map((b) => {
      const decimals = decimalsFor(target.chainId, b.token);
      const amountDecimal = formatRawAmount(b.amountRaw, decimals);
      const usdRate = usdRates[b.token] ?? null;
      const usd = computeUsd(amountDecimal, usdRate);
      return {
        token: b.token,
        decimals,
        amountRaw: b.amountRaw,
        amountDecimal,
        usd,
        usdRate
      } satisfies TokenBalance;
    });

    let addressTotal = 0;
    for (const t of tokensWithUsd) addressTotal = addUsd(addressTotal, t.usd);

    const addressRow: AddressBalance = {
      address: target.address,
      kind: target.kind,
      ...(target.kind === "pool"
        ? {
            poolStatus: target.poolStatus,
            poolAllocatedToInvoiceId: target.poolAllocatedToInvoiceId ?? null
          }
        : { feeLabel: target.feeLabel }),
      totalUsd: addressTotal.toFixed(2),
      tokens: tokensWithUsd
    };
    chainAgg.addresses.push(addressRow);
    chainAgg.totalUsd = addUsd(chainAgg.totalUsd, addressRow.totalUsd);

    for (const t of tokensWithUsd) {
      const prev = chainAgg.tokenRollup.get(t.token) ?? {
        amountRaw: 0n,
        usd: 0,
        decimals: t.decimals
      };
      prev.amountRaw += BigInt(t.amountRaw);
      prev.usd = addUsd(prev.usd, t.usd);
      prev.decimals = t.decimals;
      chainAgg.tokenRollup.set(t.token, prev);
    }
  }

  // 5. Materialize the final tree.
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

  return {
    generatedAt: deps.clock.now().toISOString(),
    totalUsd: grandTotal.toFixed(2),
    families
  };
}

// ---- Internals ----

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
  // token symbol → { amountRaw (sum), usd (sum), decimals }
  tokenRollup: Map<TokenSymbol, { amountRaw: bigint; usd: number; decimals: number }>;
  errors: number;
}

function newChainAggregator(chainId: ChainId): ChainAggregator {
  return {
    chainId,
    totalUsd: 0,
    addresses: [],
    tokenRollup: new Map(),
    errors: 0
  };
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
