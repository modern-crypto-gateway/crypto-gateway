import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { confirmPayouts, executeReservedPayouts } from "../../core/domain/payout.service.js";
import { addressPool, payoutReservations, payouts } from "../../db/schema.js";
import {
  solanaChainAdapter,
  SOLANA_MAINNET_CHAIN_ID
} from "../../adapters/chains/solana/solana-chain.adapter.js";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import type { SolanaRpcClient } from "../../adapters/chains/solana/solana-rpc-client.js";

// Dropped-tx detection: a Solana payout whose tx the chain has never seen
// must flip submitted → failed (reservations released) once the tx is
// PROVABLY dead — finalized tip past the row's last_valid_block_height, or
// (only when no height answer is available) absent far longer than any
// blockhash can live. The verdict is debounced over two sweep ticks, a
// SUCCESSFUL "still valid" height reading vetoes the age clock (cluster
// halt), recovered rows get a fresh observation window via the updatedAt
// anchor, and non-expiring families (EVM) never enter the branch.
// Regression context: a dropped consolidation leg previously sat in
// `submitted` forever, its source blocked from every future sweep by the
// never-released reservation.

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const SIG = "3DXdYBuUjMiPqT6rjxG9sv54xB4LoYtF6y9w1idRvMEZm8rKq4jnRm11uNVsXSscFhpe1uGivUpWnU13iNCMDobY";
const FIFTEEN_MIN_MS = 15 * 60_000;

function fakeClient(overrides: Partial<SolanaRpcClient>): SolanaRpcClient {
  const base: SolanaRpcClient = {
    async getSlot() { return 5_000; },
    async getBlockHeight() { throw new Error("unexpected getBlockHeight"); },
    async getLatestBlockhash() { throw new Error("unexpected getLatestBlockhash"); },
    async getSignaturesForAddress() { throw new Error("unexpected getSignaturesForAddress"); },
    async getTransaction() { throw new Error("unexpected getTransaction"); },
    async getSignatureStatuses() { return [null]; },
    async sendTransaction() { throw new Error("unexpected sendTransaction"); },
    async getBalance() { throw new Error("unexpected getBalance"); },
    async getTokenAccountsByOwner() { throw new Error("unexpected getTokenAccountsByOwner"); },
    async accountExists() { return true; },
    async getRecentPrioritizationFees() { return []; }
  };
  return { ...base, ...overrides };
}

function bootSolana(client: SolanaRpcClient, opts: { now?: Date } = {}): Promise<BootedTestApp> {
  return bootTestApp({
    skipPoolInit: true,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    chains: [
      solanaChainAdapter({
        chainIds: [SOLANA_MAINNET_CHAIN_ID],
        clients: { [SOLANA_MAINNET_CHAIN_ID]: client }
      })
    ]
  });
}

async function insertSubmittedPayout(
  booted: BootedTestApp,
  args: {
    lastValidBlockHeight: number | null;
    submittedAgoMs?: number;
    // When set, updatedAt diverges from submittedAt — models rows the
    // unknown-broadcast reconciler promoted with a BACKDATED submittedAt
    // but a fresh updatedAt (the expiry age anchor).
    updatedAgoMs?: number;
    chainId?: number;
    token?: string;
  }
): Promise<string> {
  const id = globalThis.crypto.randomUUID();
  const now = booted.deps.clock.now().getTime();
  const submittedAt = now - (args.submittedAgoMs ?? 0);
  const updatedAt = now - (args.updatedAgoMs ?? args.submittedAgoMs ?? 0);
  await booted.deps.db.insert(payouts).values({
    id,
    merchantId: MERCHANT_ID,
    kind: "consolidation_sweep",
    parentPayoutId: null,
    status: "submitted",
    chainId: args.chainId ?? SOLANA_MAINNET_CHAIN_ID,
    token: args.token ?? "SOL",
    amountRaw: "1321669650",
    destinationAddress: "4LLm2rsDjYxSp3N5yXYBY4xA3mo7JLEhRaVA3yZJvZfV",
    sourceAddress: "6UQJxnM4fZMzWWLMb72Lhzk9hWV1tJmwSZH3AGHNzR9G",
    txHash: SIG,
    lastValidBlockHeight: args.lastValidBlockHeight,
    confirmationThreshold: 1,
    createdAt: submittedAt,
    submittedAt,
    updatedAt
  });
  await booted.deps.db.insert(payoutReservations).values({
    id: globalThis.crypto.randomUUID(),
    payoutId: id,
    role: "source",
    chainId: args.chainId ?? SOLANA_MAINNET_CHAIN_ID,
    address: "6UQJxnM4fZMzWWLMb72Lhzk9hWV1tJmwSZH3AGHNzR9G",
    token: args.token ?? "SOL",
    amountRaw: "1321669650",
    createdAt: submittedAt,
    releasedAt: null
  });
  return id;
}

async function readOutcome(booted: BootedTestApp, id: string) {
  const [row] = await booted.deps.db.select().from(payouts).where(eq(payouts.id, id));
  const [reservation] = await booted.deps.db
    .select()
    .from(payoutReservations)
    .where(eq(payoutReservations.payoutId, id));
  return { row: row!, reservation: reservation! };
}

describe("confirmPayouts — Solana dropped-tx detection", () => {
  it("height proof: suspects on the first tick, fails on the second, releasing reservations + tombstoning gas", async () => {
    // Margin is 150 blocks: watermark 1000 → expiry proof needs tip > 1150.
    const booted = await bootSolana(fakeClient({ async getBlockHeight() { return 1_151; } }));
    try {
      const eventTypes: string[] = [];
      booted.deps.events.subscribeAll((evt) => { eventTypes.push(evt.type); });
      const id = await insertSubmittedPayout(booted, { lastValidBlockHeight: 1_000 });

      // Tick 1 — expiry proven, but absence evidence is debounced: marker
      // only, row stays submitted, reservation intact, no event.
      let result = await confirmPayouts(booted.deps);
      expect(result).toEqual({ checked: 1, confirmed: 0, failed: 0 });
      let outcome = await readOutcome(booted, id);
      expect(outcome.row.status).toBe("submitted");
      expect(outcome.row.lastError).toMatch(/^\[TX_EXPIRY_SUSPECTED\]/);
      expect(outcome.reservation.releasedAt).toBeNull();
      expect(eventTypes).not.toContain("payout.failed");

      // Tick 2 — independent re-proof → terminal.
      result = await confirmPayouts(booted.deps);
      expect(result).toEqual({ checked: 1, confirmed: 0, failed: 1 });
      outcome = await readOutcome(booted, id);
      expect(outcome.row.status).toBe("failed");
      expect(outcome.row.lastError).toMatch(/^\[TX_EXPIRED\]/);
      expect(outcome.reservation.releasedAt).not.toBeNull();
      expect(eventTypes).toContain("payout.failed");

      // The fee is provably zero — a gas_burn tombstone must exist so the
      // failed-gas-burn reconciler never probes this receipt-less tx.
      const tombstones = await booted.deps.db
        .select()
        .from(payouts)
        .where(and(eq(payouts.parentPayoutId, id), eq(payouts.kind, "gas_burn")));
      expect(tombstones).toHaveLength(1);
      expect(tombstones[0]!.amountRaw).toBe("0");
    } finally {
      await booted.close();
    }
  });

  it("leaves an absent row untouched while the tip is inside the safety margin", async () => {
    const booted = await bootSolana(fakeClient({ async getBlockHeight() { return 1_150; } }));
    try {
      const id = await insertSubmittedPayout(booted, { lastValidBlockHeight: 1_000 });
      const result = await confirmPayouts(booted.deps);
      expect(result).toEqual({ checked: 1, confirmed: 0, failed: 0 });
      const { row, reservation } = await readOutcome(booted, id);
      expect(row.status).toBe("submitted");
      expect(row.lastError).toBeNull(); // not even suspected
      expect(reservation.releasedAt).toBeNull();
    } finally {
      await booted.close();
    }
  });

  it("a successful 'still valid' height reading VETOES the age clock (cluster-halt safety)", async () => {
    // Block production stalled: the row is 16 wall-clock minutes old but the
    // finalized tip says its blockhash is still referencable — the tx could
    // still land, so nothing may fail it, no matter how much time passed.
    const booted = await bootSolana(fakeClient({ async getBlockHeight() { return 1_100; } }));
    try {
      const id = await insertSubmittedPayout(booted, {
        lastValidBlockHeight: 1_000,
        submittedAgoMs: 16 * 60_000
      });
      await confirmPayouts(booted.deps);
      await confirmPayouts(booted.deps);
      const { row, reservation } = await readOutcome(booted, id);
      expect(row.status).toBe("submitted");
      expect(row.lastError).toBeNull();
      expect(reservation.releasedAt).toBeNull();
    } finally {
      await booted.close();
    }
  });

  it("age fallback: fails a watermark-less row absent 16 minutes after submit, over two ticks (pre-column rows)", async () => {
    // getBlockHeight stays at the throwing base — the fallback must not need it.
    const booted = await bootSolana(fakeClient({}));
    try {
      const id = await insertSubmittedPayout(booted, {
        lastValidBlockHeight: null,
        submittedAgoMs: 16 * 60_000
      });
      await confirmPayouts(booted.deps);
      let outcome = await readOutcome(booted, id);
      expect(outcome.row.status).toBe("submitted");
      expect(outcome.row.lastError).toMatch(/^\[TX_EXPIRY_SUSPECTED\]/);

      const result = await confirmPayouts(booted.deps);
      expect(result).toEqual({ checked: 1, confirmed: 0, failed: 1 });
      outcome = await readOutcome(booted, id);
      expect(outcome.row.status).toBe("failed");
      expect(outcome.row.lastError).toMatch(/^\[TX_EXPIRED\]/);
      expect(outcome.reservation.releasedAt).not.toBeNull();
    } finally {
      await booted.close();
    }
  });

  it("age fallback: leaves a watermark-less row submitted while younger than the window", async () => {
    const booted = await bootSolana(fakeClient({}));
    try {
      const id = await insertSubmittedPayout(booted, {
        lastValidBlockHeight: null,
        submittedAgoMs: 5 * 60_000
      });
      await confirmPayouts(booted.deps);
      const { row, reservation } = await readOutcome(booted, id);
      expect(row.status).toBe("submitted");
      expect(reservation.releasedAt).toBeNull();
    } finally {
      await booted.close();
    }
  });

  it("age anchor: a reconciler-recovered row (backdated submittedAt, fresh updatedAt) gets a fresh window", async () => {
    // The unknown-broadcast reconciler promotes held rows with submittedAt
    // backdated to the original broadcast attempt — and only ever because
    // the tx was POSITIVELY seen on-chain. A spurious absent read right
    // after recovery must not instantly satisfy the age proof.
    const booted = await bootSolana(fakeClient({}));
    try {
      const id = await insertSubmittedPayout(booted, {
        lastValidBlockHeight: null,
        submittedAgoMs: 20 * 60_000,
        updatedAgoMs: 0
      });
      await confirmPayouts(booted.deps);
      await confirmPayouts(booted.deps);
      const { row, reservation } = await readOutcome(booted, id);
      expect(row.status).toBe("submitted");
      expect(row.lastError).toBeNull();
      expect(reservation.releasedAt).toBeNull();
    } finally {
      await booted.close();
    }
  });

  it("age boundary is strictly greater-than: exactly 15:00 stays submitted, 15:00.001 is suspected", async () => {
    // Fixed clock so the insert-time and sweep-time reads are identical.
    const booted = await bootSolana(fakeClient({}), { now: new Date("2026-07-21T12:00:00Z") });
    try {
      const exactlyAtBoundary = await insertSubmittedPayout(booted, {
        lastValidBlockHeight: null,
        submittedAgoMs: FIFTEEN_MIN_MS
      });
      const pastBoundary = await insertSubmittedPayout(booted, {
        lastValidBlockHeight: null,
        submittedAgoMs: FIFTEEN_MIN_MS + 1
      });
      await confirmPayouts(booted.deps);
      const atBoundary = await readOutcome(booted, exactlyAtBoundary);
      expect(atBoundary.row.status).toBe("submitted");
      expect(atBoundary.row.lastError).toBeNull();
      const past = await readOutcome(booted, pastBoundary);
      expect(past.row.status).toBe("submitted");
      expect(past.row.lastError).toMatch(/^\[TX_EXPIRY_SUSPECTED\]/);
    } finally {
      await booted.close();
    }
  });

  it("a sighting between two absence proofs resets the debounce — strikes must be consecutive", async () => {
    // Tick 1: absent + expired → suspected. Tick 2: SEEN below threshold →
    // exonerated (marker cleared, still submitted). Tick 3: absent again →
    // fresh FIRST strike, not a terminal second one. Tick 4: terminal.
    let tick = 0;
    const booted = await bootSolana(
      fakeClient({
        async getBlockHeight() { return 1_151; },
        async getSignatureStatuses() {
          tick += 1;
          return tick === 2
            ? [{ slot: 4_000, confirmations: 5, err: null, confirmationStatus: "confirmed" }]
            : [null];
        }
      })
    );
    try {
      const id = await insertSubmittedPayout(booted, { lastValidBlockHeight: 1_000 });
      // Raise the threshold so the tick-2 sighting does NOT confirm.
      await booted.deps.db
        .update(payouts)
        .set({ confirmationThreshold: 50 })
        .where(eq(payouts.id, id));

      await confirmPayouts(booted.deps); // tick 1 → suspected
      let { row } = await readOutcome(booted, id);
      expect(row.lastError).toMatch(/^\[TX_EXPIRY_SUSPECTED\]/);

      await confirmPayouts(booted.deps); // tick 2 → seen → exonerated
      ({ row } = await readOutcome(booted, id));
      expect(row.status).toBe("submitted");
      expect(row.lastError).toBeNull();

      await confirmPayouts(booted.deps); // tick 3 → absent again → fresh first strike
      ({ row } = await readOutcome(booted, id));
      expect(row.status).toBe("submitted");
      expect(row.lastError).toMatch(/^\[TX_EXPIRY_SUSPECTED\]/);

      await confirmPayouts(booted.deps); // tick 4 → consecutive second strike → terminal
      ({ row } = await readOutcome(booted, id));
      expect(row.status).toBe("failed");
      expect(row.lastError).toMatch(/^\[TX_EXPIRED\]/);
    } finally {
      await booted.close();
    }
  });

  it("an already-suspected row is un-marked when the height proof answers 'alive'", async () => {
    // Suspicion alone must never carry the verdict: a marked row whose
    // second-tick evidence does NOT re-prove expiry is exonerated, not
    // failed. (Guards the `if (!expired) return` ordering against a
    // marked-plus-absent-equals-fail regression.)
    const booted = await bootSolana(fakeClient({ async getBlockHeight() { return 1_100; } }));
    try {
      const id = await insertSubmittedPayout(booted, { lastValidBlockHeight: 1_000 });
      await booted.deps.db
        .update(payouts)
        .set({ lastError: "[TX_EXPIRY_SUSPECTED] pre-seeded marker" })
        .where(eq(payouts.id, id));
      const result = await confirmPayouts(booted.deps);
      expect(result).toEqual({ checked: 1, confirmed: 0, failed: 0 });
      const { row, reservation } = await readOutcome(booted, id);
      expect(row.status).toBe("submitted");
      expect(row.lastError).toBeNull();
      expect(reservation.releasedAt).toBeNull();
    } finally {
      await booted.close();
    }
  });

  it("a rescued row confirms with a CLEAN lastError — the suspicion marker never reaches the merchant", async () => {
    let tick = 0;
    const booted = await bootSolana(
      fakeClient({
        async getBlockHeight() { return 1_151; },
        async getSignatureStatuses() {
          tick += 1;
          return tick === 1
            ? [null]
            : [{ slot: 4_000, confirmations: null, err: null, confirmationStatus: "finalized" }];
        }
      })
    );
    try {
      const id = await insertSubmittedPayout(booted, { lastValidBlockHeight: 1_000 });
      await confirmPayouts(booted.deps); // suspected
      const result = await confirmPayouts(booted.deps); // seen finalized → confirmed
      expect(result).toEqual({ checked: 1, confirmed: 1, failed: 0 });
      const { row } = await readOutcome(booted, id);
      expect(row.status).toBe("confirmed");
      expect(row.lastError).toBeNull();
    } finally {
      await booted.close();
    }
  });

  it("skips the row on a block-height RPC outage instead of failing it", async () => {
    const booted = await bootSolana(
      fakeClient({ async getBlockHeight() { throw new Error("rpc down"); } })
    );
    try {
      const id = await insertSubmittedPayout(booted, { lastValidBlockHeight: 1_000 });
      const result = await confirmPayouts(booted.deps);
      expect(result).toEqual({ checked: 1, confirmed: 0, failed: 0 });
      const { row } = await readOutcome(booted, id);
      expect(row.status).toBe("submitted");
      expect(row.lastError).toBeNull();
    } finally {
      await booted.close();
    }
  });

  it("still confirms a row the chain DOES see — the expiry branch only touches absent txs", async () => {
    const booted = await bootSolana(
      fakeClient({
        async getSignatureStatuses() {
          return [{ slot: 4_000, confirmations: null, err: null, confirmationStatus: "finalized" }];
        },
        // Tip far past the watermark: were the expiry branch to misfire on a
        // found tx, this test would fail the payout instead of confirming it.
        async getBlockHeight() { return 99_999; }
      })
    );
    try {
      const id = await insertSubmittedPayout(booted, { lastValidBlockHeight: 1_000 });
      const result = await confirmPayouts(booted.deps);
      expect(result).toEqual({ checked: 1, confirmed: 1, failed: 0 });
      const { row, reservation } = await readOutcome(booted, id);
      expect(row.status).toBe("confirmed");
      expect(reservation.releasedAt).not.toBeNull();
    } finally {
      await booted.close();
    }
  });

  it("never expires non-Solana families: an absent EVM tx stays submitted at any age", async () => {
    // EVM txs don't expire — an absent tx may still be sitting in a mempool,
    // so failing it would risk a double payout. Family gate must hold.
    const booted = await bootTestApp({ skipPoolInit: true, chains: [devChainAdapter()] });
    try {
      const id = await insertSubmittedPayout(booted, {
        lastValidBlockHeight: null,
        submittedAgoMs: 16 * 60_000,
        chainId: 999,
        token: "DEVT"
      });
      await confirmPayouts(booted.deps);
      await confirmPayouts(booted.deps);
      const { row, reservation } = await readOutcome(booted, id);
      expect(row.status).toBe("submitted");
      expect(row.lastError).toBeNull();
      expect(reservation.releasedAt).toBeNull();
    } finally {
      await booted.close();
    }
  });
});

describe("executeTopUp — Solana dropped top-up detection", () => {
  const SPONSOR = "GWbk6imVCagBJGGkGuP2npGiJVBRfsBy6Lz2B1CFtszo";
  const SOURCE = "6UQJxnM4fZMzWWLMb72Lhzk9hWV1tJmwSZH3AGHNzR9G";

  // Parent in `topping-up` polling topUpTxHash, plus the gas_top_up sibling
  // carrying the top-up tx's watermark, plus the sponsor reservation the
  // fail path must release.
  async function insertToppingUpPayout(
    booted: BootedTestApp,
    args: { topUpTxHash: string; siblingWatermark: number | null }
  ) {
    const parentId = globalThis.crypto.randomUUID();
    const siblingId = globalThis.crypto.randomUUID();
    const now = booted.deps.clock.now().getTime();
    await booted.deps.db.insert(payouts).values({
      id: parentId,
      merchantId: MERCHANT_ID,
      kind: "standard",
      status: "topping-up",
      chainId: SOLANA_MAINNET_CHAIN_ID,
      token: "USDC",
      amountRaw: "1000000",
      destinationAddress: "4LLm2rsDjYxSp3N5yXYBY4xA3mo7JLEhRaVA3yZJvZfV",
      sourceAddress: SOURCE,
      topUpTxHash: args.topUpTxHash,
      topUpSponsorAddress: SPONSOR,
      topUpAmountRaw: "5000",
      confirmationThreshold: 1,
      createdAt: now,
      updatedAt: now
    });
    await booted.deps.db.insert(payouts).values({
      id: siblingId,
      merchantId: MERCHANT_ID,
      kind: "gas_top_up",
      parentPayoutId: parentId,
      status: "submitted",
      chainId: SOLANA_MAINNET_CHAIN_ID,
      token: "SOL",
      amountRaw: "5000",
      destinationAddress: SOURCE,
      sourceAddress: SPONSOR,
      txHash: args.topUpTxHash,
      lastValidBlockHeight: args.siblingWatermark,
      confirmationThreshold: 1,
      createdAt: now,
      submittedAt: now,
      updatedAt: now
    });
    await booted.deps.db.insert(payoutReservations).values({
      id: globalThis.crypto.randomUUID(),
      payoutId: parentId,
      role: "top_up_sponsor",
      chainId: SOLANA_MAINNET_CHAIN_ID,
      address: SPONSOR,
      token: "SOL",
      amountRaw: "5000",
      createdAt: now,
      releasedAt: null
    });
    return { parentId, siblingId };
  }

  it("fails the leg when the absent top-up tx's blockhash expired, cascading sibling + reservations + tombstone", async () => {
    const booted = await bootSolana(fakeClient({ async getBlockHeight() { return 1_151; } }));
    try {
      const { parentId, siblingId } = await insertToppingUpPayout(booted, {
        topUpTxHash: "topUpSig2Expired",
        siblingWatermark: 1_000
      });
      await executeReservedPayouts(booted.deps);

      const [parent] = await booted.deps.db.select().from(payouts).where(eq(payouts.id, parentId));
      expect(parent!.status).toBe("failed");
      expect(parent!.lastError).toMatch(/expired before inclusion/);
      const [sib] = await booted.deps.db.select().from(payouts).where(eq(payouts.id, siblingId));
      expect(sib!.status).toBe("failed");
      const [sponsorReservation] = await booted.deps.db
        .select()
        .from(payoutReservations)
        .where(eq(payoutReservations.payoutId, parentId));
      expect(sponsorReservation!.releasedAt).not.toBeNull();
      // Zero-fee tombstone under the SIBLING (the failed row carrying the
      // txHash) so the failed-gas-burn reconciler skips it.
      const tombstones = await booted.deps.db
        .select()
        .from(payouts)
        .where(and(eq(payouts.parentPayoutId, siblingId), eq(payouts.kind, "gas_burn")));
      expect(tombstones).toHaveLength(1);
      expect(tombstones[0]!.amountRaw).toBe("0");
    } finally {
      await booted.close();
    }
  });

  it("re-top-up rounds: reads the CURRENT round's sibling, not a stale confirmed one", async () => {
    // Round 1's sibling confirmed long ago with a stale watermark (500 —
    // tip is far past it). Round 2's tx has a fresh watermark (2000 — tip
    // is NOT past it). The expiry proof must read round 2's sibling and
    // answer "alive": nothing may be failed, and round 1's CONFIRMED
    // sibling must not be touched.
    const booted = await bootSolana(fakeClient({ async getBlockHeight() { return 1_151; } }));
    try {
      // Insert order matters for the regression: round 1's stale sibling
      // FIRST (lower rowid) so an unfiltered `LIMIT 1` lookup would return
      // it — the bug being pinned — before round 2's rows exist.
      const parentId = globalThis.crypto.randomUUID();
      const staleSiblingId = globalThis.crypto.randomUUID();
      const now = booted.deps.clock.now().getTime();
      await booted.deps.db.insert(payouts).values({
        id: parentId,
        merchantId: MERCHANT_ID,
        kind: "standard",
        status: "topping-up",
        chainId: SOLANA_MAINNET_CHAIN_ID,
        token: "USDC",
        amountRaw: "1000000",
        destinationAddress: "4LLm2rsDjYxSp3N5yXYBY4xA3mo7JLEhRaVA3yZJvZfV",
        sourceAddress: SOURCE,
        topUpTxHash: "topUpSig2Fresh",
        topUpSponsorAddress: SPONSOR,
        topUpAmountRaw: "5000",
        confirmationThreshold: 1,
        createdAt: now - 600_000,
        updatedAt: now
      });
      await booted.deps.db.insert(payouts).values({
        id: staleSiblingId,
        merchantId: MERCHANT_ID,
        kind: "gas_top_up",
        parentPayoutId: parentId,
        status: "confirmed",
        chainId: SOLANA_MAINNET_CHAIN_ID,
        token: "SOL",
        amountRaw: "5000",
        destinationAddress: SOURCE,
        sourceAddress: SPONSOR,
        txHash: "topUpSig1Round1",
        lastValidBlockHeight: 500, // stale — tip 1151 is far past 500+150
        confirmationThreshold: 1,
        createdAt: now - 600_000, // round 1 predates round 2
        submittedAt: now - 600_000,
        confirmedAt: now - 540_000,
        updatedAt: now - 540_000
      });
      const siblingId = globalThis.crypto.randomUUID();
      await booted.deps.db.insert(payouts).values({
        id: siblingId,
        merchantId: MERCHANT_ID,
        kind: "gas_top_up",
        parentPayoutId: parentId,
        status: "submitted",
        chainId: SOLANA_MAINNET_CHAIN_ID,
        token: "SOL",
        amountRaw: "5000",
        destinationAddress: SOURCE,
        sourceAddress: SPONSOR,
        txHash: "topUpSig2Fresh",
        lastValidBlockHeight: 2_000, // fresh — tip 1151 is NOT past 2000+150
        confirmationThreshold: 1,
        createdAt: now,
        submittedAt: now,
        updatedAt: now
      });
      await booted.deps.db.insert(payoutReservations).values({
        id: globalThis.crypto.randomUUID(),
        payoutId: parentId,
        role: "top_up_sponsor",
        chainId: SOLANA_MAINNET_CHAIN_ID,
        address: SPONSOR,
        token: "SOL",
        amountRaw: "5000",
        createdAt: now,
        releasedAt: null
      });

      await executeReservedPayouts(booted.deps);

      const [parent] = await booted.deps.db.select().from(payouts).where(eq(payouts.id, parentId));
      expect(parent!.status).toBe("topping-up"); // deferred, not failed
      const [freshSib] = await booted.deps.db.select().from(payouts).where(eq(payouts.id, siblingId));
      expect(freshSib!.status).toBe("submitted");
      const [staleSib] = await booted.deps.db.select().from(payouts).where(eq(payouts.id, staleSiblingId));
      expect(staleSib!.status).toBe("confirmed"); // untouched
    } finally {
      await booted.close();
    }
  });
});

describe("broadcastMain — Solana watermark persistence", () => {
  it("persists UnsignedTx.lastValidBlockHeight onto the payout row when the executor broadcasts", async () => {
    // Full executor path: reserved row → broadcastMain → submitted. Pins the
    // middle link of the chain (adapter → UnsignedTx → DB column) that the
    // hand-inserted rows above bypass — without this, dropping the column
    // from broadcastMain's .set() would leave every test green while the
    // height proof silently degraded to the 15-minute fallback.
    const WATERMARK = 777_000;
    const client = fakeClient({
      async getLatestBlockhash() {
        return { blockhash: "4LLm2rsDjYxSp3N5yXYBY4xA3mo7JLEhRaVA3yZJvZfV", lastValidBlockHeight: WATERMARK };
      },
      async getBalance() { return 10_000_000_000; }, // 10 SOL — clears amount+fee+rent checks
      async sendTransaction() { return "rpcEchoIgnored"; }
    });
    const booted = await bootTestApp({
      poolInitialSize: 2,
      chains: [
        solanaChainAdapter({
          chainIds: [SOLANA_MAINNET_CHAIN_ID],
          broadcastResend: { maxResends: 0 },
          clients: { [SOLANA_MAINNET_CHAIN_ID]: client }
        })
      ]
    });
    try {
      const [poolRow] = await booted.deps.db
        .select()
        .from(addressPool)
        .where(eq(addressPool.family, "solana"))
        .limit(1);
      expect(poolRow).toBeDefined();

      const id = globalThis.crypto.randomUUID();
      const now = booted.deps.clock.now().getTime();
      await booted.deps.db.insert(payouts).values({
        id,
        merchantId: MERCHANT_ID,
        kind: "standard",
        status: "reserved",
        chainId: SOLANA_MAINNET_CHAIN_ID,
        token: "SOL",
        amountRaw: "1000000",
        destinationAddress: "4LLm2rsDjYxSp3N5yXYBY4xA3mo7JLEhRaVA3yZJvZfV",
        sourceAddress: poolRow!.address,
        confirmationThreshold: 1,
        createdAt: now,
        updatedAt: now
      });
      await booted.deps.db.insert(payoutReservations).values({
        id: globalThis.crypto.randomUUID(),
        payoutId: id,
        role: "source",
        chainId: SOLANA_MAINNET_CHAIN_ID,
        address: poolRow!.address,
        token: "SOL",
        amountRaw: "1000000",
        createdAt: now,
        releasedAt: null
      });

      const result = await executeReservedPayouts(booted.deps);
      expect(result.submitted).toBe(1);

      const [row] = await booted.deps.db.select().from(payouts).where(eq(payouts.id, id));
      expect(row!.status).toBe("submitted");
      expect(row!.txHash).toBeTruthy();
      expect(row!.lastValidBlockHeight).toBe(WATERMARK);
    } finally {
      await booted.close();
    }
  });
});
