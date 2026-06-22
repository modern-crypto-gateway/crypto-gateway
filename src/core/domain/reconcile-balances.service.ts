import { and, eq, sql, type SQL } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import type { Address, ChainFamily, ChainId } from "../types/chain.js";
import type { TokenSymbol } from "../types/token.js";
import { addressPool, balanceAdjustments, payouts, transactions } from "../../db/schema.js";
import { findChainAdapter } from "./chain-lookup.js";

// Ledger ⇄ chain reconciliation.
//
// The derived ledger (confirmed inbound + intra-pool credits − confirmed
// outbound + prior adjustments) can drift from on-chain reality — unrecorded
// ambiguous-broadcast sweeps, self-ingested payout txs, gas-accounting gaps.
// This pass reads each account-model pool address's LIVE on-chain balance, and
// for every token writes a single SIGNED `balance_adjustments` row equal to
// (on-chain − settled-ledger). After it runs, the ledger reads exactly the
// chain. It is:
//   - append-only — never edits transaction/payout history;
//   - idempotent — a second run sees delta 0 and writes nothing;
//   - reservation-agnostic — compares the SETTLED ledger (no in-flight holds)
//     against the chain, so an in-flight reservation isn't mistaken for drift.
//
// UTXO chains are intentionally out of scope (their spendability is the `utxos`
// table joined to confirmed parents, not address_pool arithmetic).
//
// Default is dry-run: callers preview the deltas, then re-invoke with
// dryRun=false to apply. Run it while consolidation schedules are paused so
// balances are quiescent.

export interface ReconcileBalancesOptions {
  readonly family?: ChainFamily;
  readonly chainId?: number;
  readonly address?: string;
  // When false, write the adjustment rows. Defaults to true (preview only).
  readonly dryRun?: boolean;
}

export interface ReconcileBalanceDelta {
  readonly chainId: number;
  readonly address: string;
  readonly token: string;
  readonly onChainRaw: string;
  readonly ledgerRaw: string;
  readonly deltaRaw: string; // signed
}

export interface ReconcileBalancesResult {
  readonly dryRun: boolean;
  readonly checked: number; // (address, chain) pairs probed
  readonly adjusted: number; // adjustment rows written (0 on dry run)
  readonly deltas: readonly ReconcileBalanceDelta[];
  readonly errors: readonly { chainId: number; address: string; error: string }[];
}

export async function reconcileLedgerToChain(
  deps: AppDeps,
  opts: ReconcileBalancesOptions = {}
): Promise<ReconcileBalancesResult> {
  const dryRun = opts.dryRun ?? true;

  // Account-model chainIds per family (UTXO excluded — not address_pool-based).
  const chainIdsByFamily = new Map<ChainFamily, ChainId[]>();
  for (const adapter of deps.chains) {
    if (adapter.family === "utxo" || adapter.family === "monero") continue;
    const list = chainIdsByFamily.get(adapter.family) ?? [];
    list.push(...adapter.supportedChainIds);
    chainIdsByFamily.set(adapter.family, list);
  }

  const poolConds: SQL[] = [];
  if (opts.family !== undefined) poolConds.push(eq(addressPool.family, opts.family));
  if (opts.address !== undefined) poolConds.push(eq(addressPool.address, opts.address));
  const poolQuery = deps.db
    .select({ family: addressPool.family, address: addressPool.address })
    .from(addressPool);
  const poolRows = poolConds.length === 0 ? await poolQuery : await poolQuery.where(and(...poolConds));

  const deltas: ReconcileBalanceDelta[] = [];
  const errors: { chainId: number; address: string; error: string }[] = [];
  let checked = 0;
  let adjusted = 0;

  for (const row of poolRows) {
    const chainIds = chainIdsByFamily.get(row.family) ?? [];
    for (const chainId of chainIds) {
      if (opts.chainId !== undefined && opts.chainId !== chainId) continue;
      checked += 1;
      try {
        const adapter = findChainAdapter(deps, chainId);
        const onChain = await adapter.getAccountBalances({
          chainId: chainId as ChainId,
          address: row.address as Address
        });
        const onChainByToken = new Map<string, bigint>();
        for (const b of onChain) onChainByToken.set(b.token as string, BigInt(b.amountRaw));

        // Tokens to reconcile = union of what's on-chain and what the ledger
        // has ever touched for this address (so an over-count where on-chain is
        // now 0 is still caught).
        const ledgerTokens = await distinctLedgerTokens(deps, chainId, row.address);
        const tokens = new Set<string>([...onChainByToken.keys(), ...ledgerTokens]);

        for (const token of tokens) {
          const onChainRaw = onChainByToken.get(token) ?? 0n;
          const ledgerRaw = await computeSettledLedger(deps, chainId, row.address, token);
          const delta = onChainRaw - ledgerRaw;
          if (delta === 0n) continue;
          deltas.push({
            chainId,
            address: row.address,
            token,
            onChainRaw: onChainRaw.toString(),
            ledgerRaw: ledgerRaw.toString(),
            deltaRaw: delta.toString()
          });
          if (!dryRun) {
            await deps.db.insert(balanceAdjustments).values({
              id: globalThis.crypto.randomUUID(),
              chainId,
              address: row.address,
              token,
              deltaRaw: delta.toString(),
              onChainRaw: onChainRaw.toString(),
              ledgerRaw: ledgerRaw.toString(),
              reason: "rpc-reconciliation",
              createdAt: deps.clock.now().getTime()
            });
            adjusted += 1;
            deps.logger.info("balance.reconciled", {
              chainId,
              address: row.address,
              token,
              onChainRaw: onChainRaw.toString(),
              ledgerRaw: ledgerRaw.toString(),
              deltaRaw: delta.toString()
            });
          }
        }
      } catch (err) {
        errors.push({
          chainId,
          address: row.address,
          error: err instanceof Error ? err.message : String(err)
        });
        deps.logger.warn("balance.reconcile.address_failed", {
          chainId,
          address: row.address,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  return { dryRun, checked, adjusted, deltas, errors };
}

// Settled ledger balance for (chainId, address, token): confirmed inbound +
// intra-pool credits − confirmed outbound + prior adjustments. NO reservations
// (those are in-flight holds, not settled movements) and NO zero-clamp (the
// true signed value is what we compare to the chain).
async function computeSettledLedger(
  deps: AppDeps,
  chainId: number,
  address: string,
  token: string
): Promise<bigint> {
  const [credits, internalCredits, debits, adjustments] = await Promise.all([
    deps.db
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
    deps.db
      .select({ amountRaw: payouts.amountRaw })
      .from(payouts)
      .where(
        and(
          eq(payouts.status, "confirmed"),
          eq(payouts.chainId, chainId),
          eq(payouts.token, token),
          sql`${payouts.kind} IN ('consolidation_sweep','gas_top_up')`,
          sql`${payouts.destinationAddress} = ${address}`
        )
      ),
    deps.db
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
    deps.db
      .select({ deltaRaw: balanceAdjustments.deltaRaw })
      .from(balanceAdjustments)
      .where(
        and(
          eq(balanceAdjustments.chainId, chainId),
          eq(balanceAdjustments.address, address),
          eq(balanceAdjustments.token, token)
        )
      )
  ]);

  let total = 0n;
  for (const r of credits) total += BigInt(r.amountRaw);
  for (const r of internalCredits) total += BigInt(r.amountRaw);
  for (const r of debits) total -= BigInt(r.amountRaw);
  for (const r of adjustments) total += BigInt(r.deltaRaw);
  return total;
}

async function distinctLedgerTokens(
  deps: AppDeps,
  chainId: number,
  address: string
): Promise<Set<string>> {
  const [inbound, outbound, inboundPayout, adj] = await Promise.all([
    deps.db
      .selectDistinct({ token: transactions.token })
      .from(transactions)
      .where(and(eq(transactions.chainId, chainId), eq(transactions.toAddress, address))),
    deps.db
      .selectDistinct({ token: payouts.token })
      .from(payouts)
      .where(and(eq(payouts.chainId, chainId), sql`${payouts.sourceAddress} = ${address}`)),
    deps.db
      .selectDistinct({ token: payouts.token })
      .from(payouts)
      .where(and(eq(payouts.chainId, chainId), sql`${payouts.destinationAddress} = ${address}`)),
    deps.db
      .selectDistinct({ token: balanceAdjustments.token })
      .from(balanceAdjustments)
      .where(and(eq(balanceAdjustments.chainId, chainId), eq(balanceAdjustments.address, address)))
  ]);
  const tokens = new Set<string>();
  for (const r of [...inbound, ...outbound, ...inboundPayout, ...adj]) tokens.add(r.token);
  return tokens;
}
