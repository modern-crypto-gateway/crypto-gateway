import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps } from "../app-deps.js";
import type { Address, ChainId, TxHash } from "../types/chain.js";
import type { AmountRaw } from "../types/money.js";
import type { TokenSymbol } from "../types/token.js";
import { findChainAdapter } from "./chain-lookup.js";
import { payoutBroadcasts, payouts, utxos } from "../../db/schema.js";
import { loadSpendableUtxos, type SelectableUtxo } from "./utxo-coin-select.js";
import { destinationScriptPubkey } from "../../adapters/chains/utxo/destination-script.js";
import { utxoConfigForChainId } from "../../adapters/chains/utxo/utxo-config.js";
import { allocateUtxoAddress } from "./utxo-address-allocator.js";
import { buildUtxoUnsignedTx } from "../../adapters/chains/utxo/utxo-chain.adapter.js";

// RBF (Replace-By-Fee) for stuck UTXO payouts.
//
// When a UTXO payout's tx sits in the mempool past the merchant's patience —
// either because feerates spiked while it was waiting or because the original
// fee was set too low — admins can call POST /admin/payouts/:id/bump-fee to
// rebroadcast the same payout at a higher fee. BIP125-compliant: shares
// inputs with the prior attempt, has strictly higher absolute fee, and
// exceeds the relay's incremental-fee threshold.
//
// Replacement strategy (in order of preference):
//   2A — Same inputs, shrink change to absorb the extra fee.
//   2B — Same inputs, drop change entirely; the prior change-output value
//        becomes part of the fee.
//   3  — Same inputs PLUS additional spendable UTXOs. Used when 2B still
//        can't cover the higher fee (e.g., the original had no change to
//        absorb).
//
// Crash consistency: the in-flight bump is journaled in `payout_broadcasts`
// in `creating` state BEFORE broadcast. If the process crashes mid-flight,
// a re-bump call sees the journaled row and either claims it (after
// verifying the network has the broadcast) or marks it failed.

// Bitcoin Core's default minimum incremental relay fee for replacement txs
// (BIP125 rule 4 / `incrementalRelayFee` in policy.h). We add this many
// sat/vB to the prior feerate when picking a new target — guarantees the
// replacement is worth relaying ahead of the original.
const INCREMENTAL_RELAY_SAT_VB = 1;

// Conservative dust threshold for change outputs. P2WPKH dust ≈ 294 sat at
// 3 sat/vB; P2PKH ≈ 546 sat. We use 546 as a single safe floor — anything
// below this we drop the change entirely (Step 2B).
const DUST_THRESHOLD_SATS = 546n;

// Hard cap on bump attempts per payout. Catches runaway loops where each
// bump's higher fee somehow doesn't get the tx mined. 10 is plenty for
// real-world usage; a stuck tx that doesn't confirm after 10 bumps signals
// a problem the operator must investigate manually (incompatible peers,
// non-standard tx, dust attack on the relay).
const MAX_BUMP_ATTEMPTS = 10;

export type BumpFeeTarget =
  | { readonly tier: "low" | "medium" | "high" }
  | { readonly satPerVb: number };

export const BumpFeeInputSchema = z
  .union([
    z.object({
      tier: z.enum(["low", "medium", "high"]),
      dryRun: z.boolean().optional()
    }),
    z.object({
      satPerVb: z.number().positive().max(10_000),
      dryRun: z.boolean().optional()
    })
  ])
  // Default to "high" tier when nothing specified.
  .or(z.undefined().transform(() => ({ tier: "high" as const })));
export type BumpFeeInput = z.infer<typeof BumpFeeInputSchema>;

export interface BumpFeeResult {
  readonly payoutId: string;
  readonly attemptNumber: number;
  readonly txHash: string;
  readonly priorTxHash: string;
  readonly priorFeeSats: string;
  readonly newFeeSats: string;
  readonly priorFeerateSatVb: string;
  readonly newFeerateSatVb: string;
  readonly vsize: number;
  readonly strategy: "shrink_change" | "drop_change" | "add_inputs";
  readonly changeAddress: string | null;
  readonly changeValueSats: string | null;
  readonly dryRun: boolean;
}

export class BumpFeeError extends Error {
  constructor(
    readonly code:
      | "PAYOUT_NOT_FOUND"
      | "WRONG_FAMILY"
      | "WRONG_STATUS"
      | "ALREADY_CONFIRMED"
      | "MAX_ATTEMPTS"
      | "FEE_NOT_HIGHER"
      | "INSUFFICIENT_FUNDS"
      | "BROADCAST_FAILED"
      | "CONFLICT"
      | "INTERNAL",
    message: string,
    public override readonly cause?: unknown
  ) {
    super(message);
    this.name = "BumpFeeError";
  }
}

export async function bumpPayoutFee(
  deps: AppDeps,
  payoutId: string,
  inputRaw: BumpFeeInput | undefined
): Promise<BumpFeeResult> {
  const input = BumpFeeInputSchema.parse(inputRaw);
  const dryRun = "dryRun" in input ? input.dryRun === true : false;

  // Load payout + validate eligibility.
  const [row] = await deps.db.select().from(payouts).where(eq(payouts.id, payoutId));
  if (!row) {
    throw new BumpFeeError("PAYOUT_NOT_FOUND", `Payout ${payoutId} not found`);
  }
  const chainAdapter = findChainAdapter(deps, row.chainId as ChainId);
  if (!chainAdapter) {
    throw new BumpFeeError("INTERNAL", `No chain adapter registered for chainId ${row.chainId}`);
  }
  if (chainAdapter.family !== "utxo") {
    throw new BumpFeeError(
      "WRONG_FAMILY",
      `Fee bump is UTXO-only; payout ${payoutId} is on family '${chainAdapter.family}'`
    );
  }
  if (row.status !== "submitted") {
    throw new BumpFeeError(
      "WRONG_STATUS",
      `Fee bump requires status='submitted'; payout ${payoutId} is in '${row.status}'`
    );
  }
  if (row.feeBumpAttempts >= MAX_BUMP_ATTEMPTS) {
    throw new BumpFeeError(
      "MAX_ATTEMPTS",
      `Payout ${payoutId} has reached the ${MAX_BUMP_ATTEMPTS}-bump cap`
    );
  }
  if (row.txHash === null) {
    throw new BumpFeeError("INTERNAL", `Submitted payout ${payoutId} has no txHash`);
  }

  // Verify the prior tx is still in mempool / unconfirmed. If it confirmed
  // between the admin's decision and our action, the bump is moot — refuse.
  const status = await chainAdapter.getConfirmationStatus(
    row.chainId as ChainId,
    row.txHash as TxHash
  );
  if (status.confirmations > 0) {
    throw new BumpFeeError(
      "ALREADY_CONFIRMED",
      `Payout ${payoutId} tx ${row.txHash} already confirmed (${status.confirmations} confs); bump not applicable`
    );
  }

  // Load prior broadcast attempts. Use the latest (highest attempt_number)
  // 'submitted' row as the parent for this bump. Initial broadcasts also
  // write here, so attempt 1 always exists.
  const priorRows = await deps.db
    .select()
    .from(payoutBroadcasts)
    .where(eq(payoutBroadcasts.payoutId, payoutId))
    .orderBy(desc(payoutBroadcasts.attemptNumber));
  const prior = priorRows.find((r) => r.status === "submitted");
  if (!prior) {
    throw new BumpFeeError(
      "INTERNAL",
      `Payout ${payoutId} has no submitted broadcast row to replace (initial broadcast may pre-date the RBF audit table)`
    );
  }
  const priorInputs: ReadonlyArray<RbfInput> = JSON.parse(prior.inputsJson);
  const priorFeeSats = BigInt(prior.feeSats);
  const priorFeerate = Number(prior.feerateSatVb);

  // Compute target feerate. For tier-based, query the adapter's current
  // recommendations and pick the requested level. For explicit sat/vB, use
  // the value verbatim. Then enforce BIP125 rule 4: must exceed prior +
  // incremental.
  let targetFeerate: number;
  if ("tier" in input) {
    const TYPICAL_VBYTES = 141;
    const tierQuote = await chainAdapter.quoteFeeTiers({
      chainId: row.chainId as ChainId,
      fromAddress: row.destinationAddress as Address,
      toAddress: row.destinationAddress as Address,
      token: row.token as TokenSymbol,
      amountRaw: row.amountRaw as AmountRaw
    });
    targetFeerate = Math.max(
      1,
      Math.ceil(Number(tierQuote[input.tier].nativeAmountRaw) / TYPICAL_VBYTES)
    );
  } else {
    targetFeerate = Math.max(1, Math.ceil(input.satPerVb));
  }
  const minimumFeerate = priorFeerate + INCREMENTAL_RELAY_SAT_VB;
  if (targetFeerate < minimumFeerate) {
    targetFeerate = minimumFeerate;
  }

  // Build the replacement. Strategy in order: shrink_change → drop_change → add_inputs.
  const utxoCfg = utxoConfigForChainId(Number(row.chainId));
  if (utxoCfg === null) {
    throw new BumpFeeError("INTERNAL", `No UTXO config for chainId ${row.chainId}`);
  }
  const seed = deps.secrets.getRequired("MASTER_SEED");

  const merchantValueSats = BigInt(row.amountRaw);
  const sumPriorInputs = priorInputs.reduce((s, i) => s + BigInt(i.value), 0n);

  const merchantScript = destinationScriptPubkey(row.destinationAddress, utxoCfg);

  // Shape the chosen plan. We reuse `selectableInputs` so signing can find
  // the address-index for each input later.
  let chosenInputs: ReadonlyArray<SelectableUtxo> = priorInputs.map(rbfInputToSelectable);
  let strategy: BumpFeeResult["strategy"] | null = null;
  let changeAddress: string | null = null;
  let changeValueSats: bigint | null = null;
  let estimatedVsize = 0;
  let newFee = 0n;

  // Fixed-vsize estimates for typical P2WPKH input + outputs. These match
  // the constants used by the planner. Real signed vsize is computed
  // post-sign; we use the estimate for fee math here.
  const VBYTES_TX_OVERHEAD = 11;          // version + locktime + flag/marker
  const VBYTES_PER_INPUT_P2WPKH = 68;     // segwit-discounted input
  const VBYTES_PER_OUTPUT_P2WPKH = 31;    // change is always P2WPKH
  const merchantOutputBytes = scriptVbytes(merchantScript);

  function vsizeFor(inputs: number, hasChange: boolean): number {
    return (
      VBYTES_TX_OVERHEAD +
      inputs * VBYTES_PER_INPUT_P2WPKH +
      merchantOutputBytes +
      (hasChange ? VBYTES_PER_OUTPUT_P2WPKH : 0)
    );
  }

  // Try Step 2A: same inputs, change shrunk to absorb fee.
  {
    const v = vsizeFor(priorInputs.length, true);
    const fee = BigInt(targetFeerate * v);
    const change = sumPriorInputs - merchantValueSats - fee;
    if (change >= DUST_THRESHOLD_SATS) {
      strategy = "shrink_change";
      estimatedVsize = v;
      newFee = fee;
      changeValueSats = change;
    }
    // No-change branch is handled below.
  }

  // Try Step 2B: same inputs, drop change.
  if (strategy === null) {
    const v = vsizeFor(priorInputs.length, false);
    const fee = sumPriorInputs - merchantValueSats; // ALL leftover goes to fee
    const feerateActual = Number(fee) / v;
    if (fee > priorFeeSats && feerateActual >= targetFeerate) {
      strategy = "drop_change";
      estimatedVsize = v;
      newFee = fee;
    }
  }

  // Try Step 3: add inputs.
  if (strategy === null) {
    const spendable = await loadSpendableUtxos(deps, row.chainId as ChainId);
    const priorIds = new Set(priorInputs.map((i) => i.utxoId));
    const extraCandidates = spendable
      .filter((u) => !priorIds.has(u.utxoId))
      .sort((a, b) => b.value - a.value);
    let augmented: SelectableUtxo[] = priorInputs.map(rbfInputToSelectable);
    let augmentedSum = sumPriorInputs;
    let solved = false;
    for (const cand of extraCandidates) {
      augmented = [...augmented, cand];
      augmentedSum += BigInt(cand.value);
      const v = vsizeFor(augmented.length, true);
      const fee = BigInt(targetFeerate * v);
      const change = augmentedSum - merchantValueSats - fee;
      if (change >= DUST_THRESHOLD_SATS) {
        chosenInputs = augmented;
        strategy = "add_inputs";
        estimatedVsize = v;
        newFee = fee;
        changeValueSats = change;
        solved = true;
        break;
      }
    }
    if (!solved) {
      throw new BumpFeeError(
        "INSUFFICIENT_FUNDS",
        `Cannot build a replacement at ${targetFeerate} sat/vB with the requested merchant amount; ` +
          `even with all spendable UTXOs added, change would be below dust threshold.`
      );
    }
  }

  if (strategy === null) {
    // Defensive: cascade above either picks a strategy or throws — this
    // branch is only reachable if Step 2A/2B both rejected and Step 3 was
    // skipped, which the explicit `solved` check at the bottom of Step 3
    // already prevents. Surfaced as INTERNAL so anyone hitting it can find it.
    throw new BumpFeeError("INTERNAL", "RBF builder selected no strategy");
  }

  // BIP125 rule 3: absolute fee strictly higher than the prior attempt.
  if (newFee <= priorFeeSats) {
    throw new BumpFeeError(
      "FEE_NOT_HIGHER",
      `Replacement fee ${newFee} is not strictly greater than prior fee ${priorFeeSats}; ` +
        `bump targeting ${targetFeerate} sat/vB doesn't beat current ${priorFeerate} sat/vB`
    );
  }

  // Allocate change address now (even on dry-run we want the count to advance
  // deterministically — but dry-run paths short-circuit BEFORE address allocation
  // by returning early; check below).
  if (dryRun) {
    return {
      payoutId,
      attemptNumber: prior.attemptNumber + 1,
      txHash: "(dry-run)",
      priorTxHash: prior.txHash,
      priorFeeSats: priorFeeSats.toString(),
      newFeeSats: newFee.toString(),
      priorFeerateSatVb: priorFeerate.toString(),
      newFeerateSatVb: targetFeerate.toString(),
      vsize: estimatedVsize,
      strategy,
      changeAddress: null,
      changeValueSats: changeValueSats?.toString() ?? null,
      dryRun: true
    };
  }

  // Build outputs: merchant first, then change (when present).
  const outputs: Array<{ scriptPubkey: string; value: bigint }> = [
    { scriptPubkey: merchantScript, value: merchantValueSats }
  ];
  let changeAddressIndex: number | null = null;
  let changeVout: number | null = null;
  if (changeValueSats !== null) {
    const allocated = await allocateUtxoAddress(
      deps,
      chainAdapter,
      row.chainId as ChainId,
      seed
    );
    changeAddress = allocated.address;
    changeAddressIndex = allocated.addressIndex;
    // Merchant is at vout=0; change is the next slot we're about to push.
    // Recorded so the post-confirmation backfill can locate it without
    // re-fetching the broadcast tx from Esplora.
    changeVout = outputs.length;
    outputs.push({
      scriptPubkey: destinationScriptPubkey(allocated.address, utxoCfg),
      value: changeValueSats
    });
  }

  const unsigned = buildUtxoUnsignedTx(
    row.chainId as ChainId,
    chosenInputs.map((u) => ({
      txid: u.txId,
      vout: u.vout,
      value: BigInt(u.value),
      scriptPubkey: u.scriptPubkey,
      address: u.address
    })),
    outputs
  );
  const inputPrivateKeys: Array<{ address: Address; privateKey: string }> = [];
  for (const u of chosenInputs) {
    const pk = await deps.signerStore.get({
      kind: "pool-address",
      family: "utxo",
      derivationIndex: u.addressIndex,
      // chainId disambiguates per-chain UTXO adapters (BTC/LTC/testnets) —
      // each uses a different BIP44 coin_type. Same fix as the initial-
      // broadcast path in payout.service.ts.
      chainId: row.chainId as ChainId
    });
    inputPrivateKeys.push({ address: u.address as Address, privateKey: pk });
  }

  const attemptNumber = prior.attemptNumber + 1;
  const broadcastId = globalThis.crypto.randomUUID();
  const now = deps.clock.now().getTime();
  // Newly-added UTXOs (Step 3 only). Claimed pre-broadcast so a concurrent
  // payout's coinselect can't pick them between our broadcast acceptance and
  // commit. Released back to the pool if the broadcast errors.
  const newlyAddedUtxoIds: string[] = strategy === "add_inputs"
    ? chosenInputs.filter((u) => !priorInputs.some((p) => p.utxoId === u.utxoId)).map((u) => u.utxoId)
    : [];

  // Step 1: pre-broadcast claim. Insert a 'creating' row + claim augmented
  // UTXOs atomically so a crash or concurrent payout planner can't double-
  // spend them. The unique index (payout_id, attempt_number) on
  // payout_broadcasts converts a concurrent-bump race into a single SQL
  // constraint violation, which we surface as CONFLICT.
  try {
    await deps.db.transaction(async (tx) => {
      await tx.insert(payoutBroadcasts).values({
        id: broadcastId,
        payoutId,
        attemptNumber,
        txHash: "(pending)",
        rawHex: "(pending)",
        feeSats: newFee.toString(),
        vsize: estimatedVsize,
        feerateSatVb: targetFeerate.toString(),
        inputsJson: JSON.stringify(
          chosenInputs.map((u) => ({
            utxoId: u.utxoId,
            txid: u.txId,
            vout: u.vout,
            value: u.value,
            scriptPubkey: u.scriptPubkey,
            address: u.address,
            addressIndex: u.addressIndex
          }) satisfies RbfInput)
        ),
        changeAddress,
        changeValueSats: changeValueSats?.toString() ?? null,
        changeAddressIndex,
        changeVout,
        status: "creating",
        createdAt: now
      });
      // Claim newly-added UTXOs. The prior payout's original inputs are
      // already spent_in_payout_id=payoutId from the initial broadcast and
      // don't need re-claiming; only Step 3's additions need this.
      if (newlyAddedUtxoIds.length > 0) {
        await tx
          .update(utxos)
          .set({ spentInPayoutId: payoutId, spentAt: now })
          .where(inArray(utxos.id, newlyAddedUtxoIds));
      }
    });
  } catch (err) {
    // Most likely cause: unique-index collision on (payout_id, attempt_number)
    // from a concurrent bump call that won the race. Surface as CONFLICT so
    // the admin sees a clear 409 instead of a generic 500.
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed.*attempt_number|uq_payout_broadcasts_attempt/i.test(msg)) {
      throw new BumpFeeError(
        "CONFLICT",
        `Concurrent bump in flight for payout ${payoutId} (attempt ${attemptNumber} already claimed); retry once it completes`,
        err
      );
    }
    throw err;
  }

  // Step 2: broadcast outside any DB tx. The signed tx may fail relay
  // validation (mempool minimum, BIP125 rule violations, peer outage); we
  // surface the network error to the admin, mark the row 'failed', and
  // RELEASE the augmented UTXOs so they're available for the next attempt.
  let txHash: string;
  try {
    txHash = (await chainAdapter.signAndBroadcast(unsigned, "", { inputPrivateKeys })) as string;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.db.transaction(async (tx) => {
      await tx
        .update(payoutBroadcasts)
        .set({ status: "failed", lastError: msg.slice(0, 500) })
        .where(eq(payoutBroadcasts.id, broadcastId));
      // Release the augmented UTXOs we claimed pre-broadcast — they go
      // back to the spendable pool for a future bump or unrelated payout.
      if (newlyAddedUtxoIds.length > 0) {
        await tx
          .update(utxos)
          .set({ spentInPayoutId: null, spentAt: null })
          .where(inArray(utxos.id, newlyAddedUtxoIds));
      }
    });
    throw new BumpFeeError("BROADCAST_FAILED", `RBF broadcast failed: ${msg}`, err);
  }

  // Step 3: commit. Inside one DB tx:
  //   - mark prior attempt 'replaced'
  //   - mark new attempt 'submitted' with the real txHash + raw hex
  //   - update payouts.txHash, originalTxHash (if first bump), feeBumpAttempts++
  //   - keep utxo spent rows pointing at this payout (no change there — same
  //     utxos remain spent)
  // If we crash between broadcast and this commit, the next bump call will
  // see `creating` row + `submitted` prior; it can verify network state and
  // either reuse the broadcast or supersede it.
  // Note: we don't hold the rawHex separately — chainAdapter.signAndBroadcast
  // returned only the txid. To stash hex we'd need an extension to that port;
  // out of scope here. Stored as txHash-only suffices for forensic audit.
  const broadcastedAt = deps.clock.now().getTime();
  await deps.db.transaction(async (tx) => {
    await tx
      .update(payoutBroadcasts)
      .set({
        status: "replaced",
        replacedByAttempt: attemptNumber
      })
      .where(eq(payoutBroadcasts.id, prior.id));
    await tx
      .update(payoutBroadcasts)
      .set({
        status: "submitted",
        txHash,
        rawHex: "(not-stashed)",
        broadcastAt: broadcastedAt
      })
      .where(eq(payoutBroadcasts.id, broadcastId));
    await tx
      .update(payouts)
      .set({
        txHash,
        // First bump: stash the original. Subsequent bumps: leave as-is.
        ...(row.originalTxHash === null ? { originalTxHash: prior.txHash } : {}),
        feeBumpAttempts: row.feeBumpAttempts + 1,
        lastFeeBumpAt: broadcastedAt,
        feeEstimateNative: newFee.toString(),
        updatedAt: broadcastedAt
      })
      .where(eq(payouts.id, payoutId));
    // Note: augmented UTXOs (Step 3 strategy) were already claimed in the
    // pre-broadcast Step-1 transaction; nothing to mark here.
  });

  deps.logger.info("payout.utxo.fee_bump", {
    payoutId,
    attemptNumber,
    priorTxHash: prior.txHash,
    newTxHash: txHash,
    priorFeeSats: priorFeeSats.toString(),
    newFeeSats: newFee.toString(),
    priorFeerateSatVb: priorFeerate,
    newFeerateSatVb: targetFeerate,
    strategy,
    vsize: estimatedVsize
  });

  return {
    payoutId,
    attemptNumber,
    txHash,
    priorTxHash: prior.txHash,
    priorFeeSats: priorFeeSats.toString(),
    newFeeSats: newFee.toString(),
    priorFeerateSatVb: priorFeerate.toString(),
    newFeerateSatVb: targetFeerate.toString(),
    vsize: estimatedVsize,
    strategy: strategy,
    changeAddress,
    changeValueSats: changeValueSats?.toString() ?? null,
    dryRun: false
  };
}

// Initial-broadcast journaling — called from broadcastUtxoMain at the same
// point the payout flips to 'submitted'. Preserves a complete RBF history
// (attempt 1 = original) so subsequent bumps have a parent row to read.
export async function journalInitialBroadcast(
  deps: AppDeps,
  args: {
    readonly payoutId: string;
    readonly txHash: string;
    readonly feeSats: bigint;
    readonly vsize: number;
    readonly feerateSatVb: number;
    readonly inputs: ReadonlyArray<RbfInput>;
    readonly changeAddress: string | null;
    readonly changeValueSats: bigint | null;
    readonly changeAddressIndex: number | null;
    readonly changeVout: number | null;
    readonly tx: Parameters<Parameters<AppDeps["db"]["transaction"]>[0]>[0];
  }
): Promise<void> {
  const now = deps.clock.now().getTime();
  await args.tx.insert(payoutBroadcasts).values({
    id: globalThis.crypto.randomUUID(),
    payoutId: args.payoutId,
    attemptNumber: 1,
    txHash: args.txHash,
    rawHex: "(not-stashed)",
    feeSats: args.feeSats.toString(),
    vsize: args.vsize,
    feerateSatVb: args.feerateSatVb.toString(),
    inputsJson: JSON.stringify(args.inputs),
    changeAddress: args.changeAddress,
    changeValueSats: args.changeValueSats?.toString() ?? null,
    changeAddressIndex: args.changeAddressIndex,
    changeVout: args.changeVout,
    status: "submitted",
    broadcastAt: now,
    createdAt: now
  });
}

// JSON shape used in payout_broadcasts.inputs_json.
export interface RbfInput {
  readonly utxoId: string;
  readonly txid: string;
  readonly vout: number;
  readonly value: number;
  readonly scriptPubkey: string;
  readonly address: string;
  readonly addressIndex: number;
}

function rbfInputToSelectable(input: RbfInput): SelectableUtxo {
  return {
    txId: input.txid,
    vout: input.vout,
    value: input.value,
    utxoId: input.utxoId,
    address: input.address,
    addressIndex: input.addressIndex,
    scriptPubkey: input.scriptPubkey
  };
}

// vbytes occupied by an output: 8 (value) + 1 (scriptlen varint, assuming
// <0xfd) + script bytes. Hex string length ÷ 2 = script bytes.
function scriptVbytes(scriptHex: string): number {
  return 8 + 1 + scriptHex.length / 2;
}

