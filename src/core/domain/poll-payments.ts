import { and, eq, gt, inArray, or } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import type { ChainFamily, ChainId } from "../types/chain.js";
import type { TokenSymbol } from "../types/token.js";
import type { DetectedTransfer } from "../types/transaction.js";
import { findChainAdapter } from "./chain-lookup.js";
import { ingestDetectedTransfer } from "./payment.service.js";
import { LATE_PAYMENT_WATCH_MS, PROCESSING_EXPIRY_GRACE_MS } from "./payment-config.js";
import { invoices, invoiceReceiveAddresses } from "../../db/schema.js";

// Cron-triggered orchestrator:
//   1. Enumerate active per-family receive addresses across all non-terminal invoices
//   2. For each chainId with a registered DetectionStrategy.poll, select addresses
//      whose family matches that chain's family and invoke the strategy
//   3. Hand every returned DetectedTransfer to PaymentService.ingestDetectedTransfer
//
// Multi-family compatible: an invoice with acceptedFamilies=["evm","tron"]
// gets its EVM address polled on every EVM chain that has a poll strategy,
// and its Tron address polled on the Tron chain — all in a single tick.

export interface PollPaymentsResult {
  chainsPolled: number;
  addressesWatched: number;
  transfersFound: number;
  transfersIngested: number;
  duplicates: number;
}

export async function pollPayments(deps: AppDeps): Promise<PollPaymentsResult> {
  // Gather every family+address for invoices that are still open, plus each
  // invoice's `token` and `ratesJson` so we can derive the *minimum* set of
  // tokens worth polling per family. The join table is the authoritative
  // source — `invoices.receive_address` is just the primary-family
  // denormalization for legacy single-chain reads.
  const rows = await deps.db
    .select({
      family: invoiceReceiveAddresses.family,
      address: invoiceReceiveAddresses.address,
      token: invoices.token,
      ratesJson: invoices.ratesJson
    })
    .from(invoices)
    .innerJoin(invoiceReceiveAddresses, eq(invoiceReceiveAddresses.invoiceId, invoices.id))
    .where(
      or(
        and(
          // Active invoices for the poll loop. Includes `completed` because
          // a reorg-recheck can demote a completed invoice and we still want
          // to poll its addresses for any incoming top-ups during the window.
          inArray(invoices.status, ["pending", "completed"]),
          gt(invoices.expiresAt, deps.clock.now().getTime())
        ),
        // `processing` = payment detected inside the window, confirmations
        // pending. Keep watching through the grace window (mirrors
        // sweepExpiredInvoices) — otherwise slow-confirming chains (BTC 6
        // confs ≈ 60 min vs 30-min default expiry) lose detection coverage
        // exactly when the crediting tx is about to confirm.
        and(
          eq(invoices.status, "processing"),
          gt(invoices.expiresAt, deps.clock.now().getTime() - PROCESSING_EXPIRY_GRACE_MS)
        ),
        // Recently-expired invoices stay watched briefly so a payment
        // broadcast around/after expiry is still ingested — it records as
        // an orphaned transaction (or cooldown-credits on pooled families)
        // instead of landing invisibly on a gateway-controlled address.
        and(
          eq(invoices.status, "expired"),
          gt(invoices.expiresAt, deps.clock.now().getTime() - LATE_PAYMENT_WATCH_MS)
        )
      )
    );

  // Group addresses + relevant tokens by family. Address lists are deduped
  // (same address can appear via multiple invoices); token sets capture
  // both legacy single-token invoices (via `token`) and USD-pegged invoices
  // (every key in `ratesJson` — the symbols the merchant told the customer
  // they'd accept). The poll strategy uses `tokensByFamily` to skip RPC
  // calls for tokens nobody is currently watching; an EVM chain that has
  // USDT/USDC/DAI registered but only one active USDC invoice produces 1
  // getLogs call per tick instead of 3.
  const addressesByFamily = new Map<ChainFamily, Set<string>>();
  const tokensByFamily = new Map<ChainFamily, Set<TokenSymbol>>();
  for (const row of rows) {
    const family = row.family as ChainFamily;
    let addrSet = addressesByFamily.get(family);
    if (!addrSet) {
      addrSet = new Set();
      addressesByFamily.set(family, addrSet);
    }
    addrSet.add(row.address);

    let tokSet = tokensByFamily.get(family);
    if (!tokSet) {
      tokSet = new Set();
      tokensByFamily.set(family, tokSet);
    }
    tokSet.add(row.token as TokenSymbol);
    if (row.ratesJson !== null) {
      try {
        const parsed = JSON.parse(row.ratesJson) as Record<string, string>;
        for (const sym of Object.keys(parsed)) {
          tokSet.add(sym as TokenSymbol);
        }
      } catch {
        // Malformed ratesJson is a data-shape bug, not a polling concern —
        // ignore here so a single bad row can't shut off detection. The
        // payment-attribution path will surface the same row's issue
        // separately if it tries to use the rates.
      }
    }
  }

  let chainsPolled = 0;
  let transfersFound = 0;
  let transfersIngested = 0;
  let duplicates = 0;
  let addressesWatched = 0;

  // Iterate each chain that has a registered poll strategy. For each,
  // resolve its family via the adapter and pass the family-matching
  // address set. A Tron chainId gets the Tron addresses; an EVM chainId
  // gets the shared EVM address list (valid across every EVM chain).
  for (const [chainIdKey, strategy] of Object.entries(deps.detectionStrategies)) {
    const chainIdNumber = Number(chainIdKey);
    if (!strategy?.poll) continue;
    // adapter tells us which family this chain belongs to
    let family: ChainFamily;
    try {
      family = findChainAdapter(deps, chainIdNumber).family;
    } catch {
      // No adapter wired for this chain — skip. (A rare configuration
      // drift where detectionStrategies references an unwired chainId.)
      continue;
    }
    const addrSet = addressesByFamily.get(family);
    if (!addrSet || addrSet.size === 0) continue;
    const addresses = Array.from(addrSet);
    const tokenSet = tokensByFamily.get(family) ?? new Set<TokenSymbol>();
    const tokens = Array.from(tokenSet);

    chainsPolled += 1;
    addressesWatched += addresses.length;

    // Per-chain error isolation. Without this wrapper, ANY chain throwing
    // (e.g. TronGrid rate-limiting with HTTP 429, an Esplora outage, a
    // Monero public-node DNS hiccup) propagates out of the entire job and
    // every chain after it in the iteration order silently goes unscanned
    // for that tick. The chains have nothing in common — there's no reason
    // a Tron 429 should silence Monero detection — so we catch + log + move
    // on. Same shape per-transfer below: a single ingest failure (FK
    // collision, malformed amountRaw, …) shouldn't block sibling transfers
    // in the same batch.
    let transfers: readonly DetectedTransfer[];
    try {
      transfers = await strategy.poll(deps, chainIdNumber as ChainId, addresses, tokens);
    } catch (err) {
      deps.logger.warn("pollPayments: chain poll failed; continuing with next chain", {
        chainId: chainIdNumber,
        family,
        error: err instanceof Error ? err.message : String(err)
      });
      continue;
    }
    transfersFound += transfers.length;

    for (const transfer of transfers) {
      try {
        const result = await ingestDetectedTransfer(deps, transfer);
        if (result.inserted) {
          transfersIngested += 1;
        } else {
          duplicates += 1;
        }
      } catch (err) {
        deps.logger.warn("pollPayments: ingestDetectedTransfer failed; continuing with next transfer", {
          chainId: chainIdNumber,
          txHash: transfer.txHash,
          logIndex: transfer.logIndex,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  return { chainsPolled, addressesWatched, transfersFound, transfersIngested, duplicates };
}
