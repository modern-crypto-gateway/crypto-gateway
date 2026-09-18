// @ts-expect-error — coinselect ships its own types but vite-node sometimes
//   resolves the JS file directly; the runtime shape is documented below.
import coinselect from "coinselect";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import type { ChainId } from "../types/chain.js";
import { transactions, utxos } from "../../db/schema.js";

// Coin selection for UTXO payouts. Queries the local `utxos` ledger for
// confirmed-and-unspent outputs across all owned addresses on the given
// chain, then runs branch-and-bound + largest-first via the `coinselect`
// package. Returns the picked input set, the output set (with a synthesized
// change output if needed), and the calculated fee.
//
// Why query locally instead of asking Esplora per-address: the local utxos
// table is the source of truth for spendability. It's populated by the
// detection layer's ingest extension (writes `utxos` rows alongside
// `transactions`) and updated by the payout broadcast path (sets
// `spent_in_payout_id` atomically with the broadcast attempt). One indexed
// SELECT replaces N HTTP calls.

// Shape coinselect expects on inputs. The package's algorithm only consults
// `value` for selection; we carry our own enrichment fields (utxoId,
// addressIndex, address, scriptPubkey, txid, vout) through so the caller
// can build + sign without a second DB lookup.
export interface SelectableUtxo {
  // coinselect-required fields
  readonly txId: string;
  readonly vout: number;
  readonly value: number; // satoshis (uint53-safe; UTXO values fit)
  // Our enrichment, used post-selection
  readonly utxoId: string;
  readonly address: string;
  readonly addressIndex: number;
  readonly scriptPubkey: string;
}

export interface CoinSelectionTarget {
  readonly address: string;
  readonly value: number; // satoshis
}

export interface CoinSelectionResult {
  readonly chosenInputs: readonly SelectableUtxo[];
  // Outputs as planned. The first N entries correspond 1:1 to the caller's
  // targets (same order). A trailing entry with no `address` is the change
  // back to ourselves — caller assigns a change address before signing.
  readonly outputs: ReadonlyArray<{ address?: string; value: number }>;
  readonly fee: number; // total fee in satoshis
}

// Load every spendable UTXO for the given chain. JOIN against transactions
// to filter on `status='confirmed'` (the source of truth for inclusion).
// Reverted/orphaned txs naturally drop out via the JOIN.
//
// `includeUnconfirmedOwnChange` additionally admits 'detected' (mempool)
// rows whose origin is 'change' — outputs the gateway created for itself in
// a payout it broadcast. Safe to chain off (we authored the parent tx;
// third-party deposits stay confirmed-only because their sender could
// RBF-replace them). Callers: the payout plan/broadcast path passes the
// UTXO_SPEND_UNCONFIRMED_CHANGE knob here; the RBF bump path must NOT —
// BIP125 rule 2 forbids a replacement from adding new unconfirmed inputs.
export async function loadSpendableUtxos(
  deps: AppDeps,
  chainId: ChainId,
  opts: { readonly includeUnconfirmedOwnChange?: boolean } = {}
): Promise<readonly SelectableUtxo[]> {
  const confirmedOnly = eq(transactions.status, "confirmed");
  const statusCondition = opts.includeUnconfirmedOwnChange === true
    ? or(
        confirmedOnly,
        and(eq(transactions.status, "detected"), eq(utxos.origin, "change"))
      )!
    : confirmedOnly;
  const rows = await deps.db
    .select({
      utxoId: utxos.id,
      txid: transactions.txHash,
      vout: utxos.vout,
      value: utxos.valueSats,
      address: utxos.address,
      addressIndex: utxos.addressIndex,
      scriptPubkey: utxos.scriptPubkey
    })
    .from(utxos)
    .innerJoin(transactions, eq(transactions.id, utxos.transactionId))
    .where(
      and(
        eq(utxos.chainId, chainId),
        isNull(utxos.spentInPayoutId),
        statusCondition
      )
    )
    .orderBy(asc(utxos.createdAt));

  // coinselect wants `value` as a JS number. Bitcoin's max supply is
  // 21M × 1e8 = 2.1e15 sats, well within Number.MAX_SAFE_INTEGER (9e15).
  // No precision loss for any realistic UTXO value.
  return rows.map((r) => ({
    txId: r.txid,
    vout: r.vout,
    value: Number(r.value),
    utxoId: r.utxoId,
    address: r.address,
    addressIndex: r.addressIndex,
    scriptPubkey: r.scriptPubkey
  }));
}

// Run the coin-selection algorithm. Returns null on insufficient funds — the
// caller surfaces this as an INSUFFICIENT_FUNDS payout-create error. The
// `feeRate` is in sats/vbyte (whole-byte rounding inside coinselect; we
// pass the rounded value our quoteFeeTiers chose).
export function selectCoins(
  spendable: readonly SelectableUtxo[],
  targets: readonly CoinSelectionTarget[],
  feeRate: number
): CoinSelectionResult | null {
  // coinselect mutates neither arg; safe to pass shared arrays.
  // The package returns { inputs, outputs, fee } on success, or { fee }
  // alone when no selection is possible (insufficient funds for the
  // target + fee). We treat any missing inputs/outputs as "no plan."
  const result = (coinselect as unknown as (
    utxos: ReadonlyArray<{ txId: string; vout: number; value: number }>,
    targets: ReadonlyArray<{ address?: string; value: number }>,
    feeRate: number
  ) => {
    inputs?: ReadonlyArray<{ txId: string; vout: number; value: number }>;
    outputs?: ReadonlyArray<{ address?: string; value: number }>;
    fee: number;
  })(spendable, targets, feeRate);

  if (!result.inputs || !result.outputs) return null;

  // Re-attach our enrichment fields by index. coinselect preserves input
  // identity by reference, but the result type has a narrower shape; we
  // cross-reference `(txId, vout)` to recover the original SelectableUtxo.
  const byKey = new Map<string, SelectableUtxo>();
  for (const u of spendable) byKey.set(`${u.txId}:${u.vout}`, u);
  const chosenInputs: SelectableUtxo[] = [];
  for (const i of result.inputs) {
    const enriched = byKey.get(`${i.txId}:${i.vout}`);
    if (!enriched) {
      throw new Error(
        `selectCoins: coinselect returned an input not in the spendable set (${i.txId}:${i.vout})`
      );
    }
    chosenInputs.push(enriched);
  }

  return { chosenInputs, outputs: result.outputs, fee: result.fee };
}
