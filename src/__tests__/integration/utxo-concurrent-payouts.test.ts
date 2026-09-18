import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { sha256 } from "@noble/hashes/sha2.js";
import { utxoChainAdapter } from "../../adapters/chains/utxo/utxo-chain.adapter.js";
import { BITCOIN_CONFIG } from "../../adapters/chains/utxo/utxo-config.js";
import type { EsploraClient, EsploraTx } from "../../adapters/chains/utxo/esplora-rpc.js";
import { rpcPollDetection } from "../../adapters/detection/rpc-poll.adapter.js";
import { ingestDetectedTransfer } from "../../core/domain/payment.service.js";
import {
  confirmPayouts,
  executeReservedPayouts,
  planPayout
} from "../../core/domain/payout.service.js";
import { payouts, transactions, utxos } from "../../db/schema.js";
import type { AmountRaw } from "../../core/types/money.js";
import type { ChainId } from "../../core/types/chain.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

// Concurrent UTXO payouts must never double-select the same coins.
//
// The production failure this guards against: N payouts in one executor tick
// each ran coinselect against the same spendable set (inputs are only marked
// spent AFTER a successful broadcast), all picked the same largest UTXOs,
// and every tx after the first was rejected by the node with
// `txn-mempool-conflict` (observed: 7 of 10 parallel LTC payouts failed).
// broadcastUtxoMain now serializes coinselect → broadcast → mark-spent under
// a per-chain lock (utxo-broadcast-lock.ts), so each broadcast re-selects
// against a ledger that already excludes the previous winner's inputs.
//
// The second suite covers UTXO_SPEND_UNCONFIRMED_CHANGE: with the knob on,
// the gateway's own change output is spendable while the parent payout is
// still in the mempool (0-conf chaining), and the confirmation-time backfill
// converges the broadcast-time 'detected' rows to 'confirmed'.

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const BTC_CHAIN_ID = 800 as ChainId;
const DESTINATION = "bc1q4w46h2at4w46h2at4w46h2at4w46h2at25y74s";

// ---- Raw segwit tx parsing (test-side mirror of the broadcast wire format).
// The adapter cross-checks the txid Esplora returns against its locally
// computed one, so the fake backend must derive the REAL txid from the hex
// it is handed: double-SHA256 over the non-witness serialization, reversed.

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 1) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

interface ParsedTx {
  readonly txid: string;
  readonly inputs: ReadonlyArray<{ prevTxid: string; vout: number }>;
}

function parseSegwitTx(hex: string): ParsedTx {
  const b = hexToBytes(hex);
  let o = 0;
  const readVarint = (): number => {
    const first = b[o]!;
    o += 1;
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const v = b[o]! | (b[o + 1]! << 8);
      o += 2;
      return v;
    }
    throw new Error("test parseSegwitTx: varint larger than 0xfd not expected here");
  };

  const version = b.slice(o, o + 4);
  o += 4;
  const hasWitness = b[o] === 0x00 && b[o + 1] === 0x01;
  if (hasWitness) o += 2;
  const nonWitnessStart = o;

  const inputCount = readVarint();
  const inputs: Array<{ prevTxid: string; vout: number }> = [];
  for (let i = 0; i < inputCount; i += 1) {
    // Outpoint txid is serialized little-endian; display order is reversed.
    const prevTxid = bytesToHex(b.slice(o, o + 32).reverse());
    o += 32;
    const vout = b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24);
    o += 4;
    const scriptLen = readVarint();
    o += scriptLen;
    o += 4; // sequence
    inputs.push({ prevTxid, vout });
  }
  const outputCount = readVarint();
  for (let i = 0; i < outputCount; i += 1) {
    o += 8;
    const scriptLen = readVarint();
    o += scriptLen;
  }
  const nonWitnessEnd = o; // witness data (if any) sits between here and locktime
  const locktime = b.slice(b.length - 4);

  const preimage = new Uint8Array(4 + (nonWitnessEnd - nonWitnessStart) + 4);
  preimage.set(version, 0);
  preimage.set(b.slice(nonWitnessStart, nonWitnessEnd), 4);
  preimage.set(locktime, 4 + (nonWitnessEnd - nonWitnessStart));
  const txid = bytesToHex(sha256(sha256(preimage)).reverse());
  return { txid, inputs };
}

// ---- Fake Esplora backend. broadcastTx computes the real txid from the
// submitted hex (satisfying the adapter's cross-check) after an artificial
// delay that widens the race window concurrent broadcasts would exploit if
// the per-chain lock were missing.

interface FakeEsplora {
  client: EsploraClient;
  broadcasts: ParsedTx[];
  registerConfirmedTx(args: {
    txid: string;
    blockHeight: number;
    outputs: ReadonlyArray<{ address: string; valueSats: number }>;
  }): void;
  setTipHeight(height: number): void;
}

function buildFakeEsplora(opts: { broadcastDelayMs?: number } = {}): FakeEsplora {
  const txsById = new Map<string, EsploraTx>();
  let tipHeight = 0;
  const broadcasts: ParsedTx[] = [];

  const client: EsploraClient = {
    async getAddressTxs() {
      return [];
    },
    async getAddressMempoolTxs() {
      return [];
    },
    async getTx(txid) {
      const tx = txsById.get(String(txid));
      if (!tx) {
        const { EsploraNotFoundError } = await import("../../adapters/chains/utxo/esplora-rpc.js");
        throw new EsploraNotFoundError(`/tx/${String(txid)}`);
      }
      return tx;
    },
    async getTipHeight() {
      return tipHeight;
    },
    async broadcastTx(hex) {
      if (opts.broadcastDelayMs !== undefined) {
        await new Promise((r) => setTimeout(r, opts.broadcastDelayMs));
      }
      const parsed = parseSegwitTx(hex);
      broadcasts.push(parsed);
      return parsed.txid;
    },
    async getFeeEstimates() {
      // Keep rates tiny so fees stay negligible next to the seeded values.
      return { "1": 2, "3": 1, "6": 1 };
    },
    async getAddressBalanceSats() {
      return 0n;
    }
  };

  return {
    client,
    broadcasts,
    registerConfirmedTx({ txid, blockHeight, outputs }) {
      txsById.set(txid, {
        txid,
        status: { confirmed: true, block_height: blockHeight, block_time: 1_700_000_001 },
        vin: [],
        vout: outputs.map((o) => ({
          scriptpubkey: "0014" + "ff".repeat(20),
          scriptpubkey_address: o.address.toLowerCase(),
          value: o.valueSats
        })),
        fee: 0
      });
    },
    setTipHeight(h) {
      tipHeight = h;
    }
  };
}

// Seed one invoice + one confirmed incoming UTXO of `valueSats`, credited to
// the merchant, spendable by coinselect. Returns nothing the tests need —
// the utxos ledger rows are the interesting output.
async function seedConfirmedUtxo(
  booted: BootedTestApp,
  apiKey: string,
  txid: string,
  valueSats: number
): Promise<void> {
  const invoiceRes = await booted.app.fetch(
    new Request("http://test.local/api/v1/invoices", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ chainId: BTC_CHAIN_ID, token: "BTC", amountRaw: String(valueSats) })
    })
  );
  expect(invoiceRes.status).toBe(201);
  const invoice = ((await invoiceRes.json()) as {
    invoice: { receiveAddress: string };
  }).invoice;

  await ingestDetectedTransfer(booted.deps, {
    chainId: BTC_CHAIN_ID,
    txHash: txid,
    logIndex: 0,
    fromAddress: "bc1qzqg3yyc5z5tpwxqergd3c8g7ruszzg3r8jj72z" as never,
    toAddress: invoice.receiveAddress as never,
    token: "BTC" as never,
    amountRaw: String(valueSats) as AmountRaw,
    blockNumber: 110,
    confirmations: 11,
    seenAt: new Date()
  });
}

describe("concurrent UTXO payout broadcasts", () => {
  it("never double-selects the same inputs across parallel payouts in one tick", async () => {
    const fake = buildFakeEsplora({ broadcastDelayMs: 25 });
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: fake.client });
    const booted = await bootTestApp({
      chains: [adapter],
      detectionStrategies: { [BTC_CHAIN_ID]: rpcPollDetection() },
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      const apiKey = booted.apiKeys[MERCHANT_ID]!;
      fake.setTipHeight(120);
      await seedConfirmedUtxo(booted, apiKey, "aa".repeat(32), 120_000);
      await seedConfirmedUtxo(booted, apiKey, "bb".repeat(32), 80_000);

      // Two payouts, both comfortably coverable by EITHER seeded UTXO —
      // without the per-chain lock both would coinselect the same coins.
      const payoutA = await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: BTC_CHAIN_ID,
        token: "BTC",
        amountRaw: "50000",
        destinationAddress: DESTINATION
      });
      const payoutB = await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: BTC_CHAIN_ID,
        token: "BTC",
        amountRaw: "50000",
        destinationAddress: DESTINATION
      });
      expect(payoutA.status).toBe("reserved");
      expect(payoutB.status).toBe("reserved");

      // One tick runs both concurrently (default per-chain cap is 16).
      const result = await executeReservedPayouts(booted.deps);
      expect(result.submitted).toBe(2);
      expect(result.failed).toBe(0);
      expect(fake.broadcasts).toHaveLength(2);

      // The two broadcast txs must spend disjoint outpoints.
      const seen = new Set<string>();
      for (const tx of fake.broadcasts) {
        for (const input of tx.inputs) {
          const outpoint = `${input.prevTxid}:${input.vout}`;
          expect(seen.has(outpoint)).toBe(false);
          seen.add(outpoint);
        }
      }

      // And the ledger agrees: every spent utxos row points at exactly one
      // payout, and both payouts hold at least one input.
      const spentRows = await booted.deps.db
        .select({ id: utxos.id, spentInPayoutId: utxos.spentInPayoutId })
        .from(utxos)
        .where(eq(utxos.chainId, BTC_CHAIN_ID));
      const byPayout = new Map<string, number>();
      for (const row of spentRows) {
        if (row.spentInPayoutId === null) continue;
        byPayout.set(row.spentInPayoutId, (byPayout.get(row.spentInPayoutId) ?? 0) + 1);
      }
      expect(byPayout.get(payoutA.id) ?? 0).toBeGreaterThan(0);
      expect(byPayout.get(payoutB.id) ?? 0).toBeGreaterThan(0);
    } finally {
      await booted.close();
    }
  });
});

describe("UTXO_SPEND_UNCONFIRMED_CHANGE (0-conf change chaining)", () => {
  it("lets the next payout spend the gateway's own unconfirmed change, and the backfill converges the pending rows", async () => {
    const fake = buildFakeEsplora();
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: fake.client });
    const booted = await bootTestApp({
      chains: [adapter],
      detectionStrategies: { [BTC_CHAIN_ID]: rpcPollDetection() },
      merchants: [{ id: MERCHANT_ID }],
      utxoSpendUnconfirmedChange: true
    });
    try {
      const apiKey = booted.apiKeys[MERCHANT_ID]!;
      fake.setTipHeight(120);
      await seedConfirmedUtxo(booted, apiKey, "cc".repeat(32), 200_000);

      // Payout A consumes the only confirmed UTXO and leaves ~99k change.
      const payoutA = await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: BTC_CHAIN_ID,
        token: "BTC",
        amountRaw: "100000",
        destinationAddress: DESTINATION
      });
      const firstTick = await executeReservedPayouts(booted.deps);
      expect(firstTick.submitted).toBe(1);
      const txidA = fake.broadcasts[0]!.txid;

      // Broadcast-time pending rows: a 'detected' transactions row and a
      // spendable utxos row with origin='change' exist BEFORE confirmation.
      const [pendingChangeUtxo] = await booted.deps.db
        .select()
        .from(utxos)
        .where(eq(utxos.origin, "change"));
      expect(pendingChangeUtxo).toBeDefined();
      expect(pendingChangeUtxo!.id.startsWith(`${txidA}:`)).toBe(true);
      expect(pendingChangeUtxo!.spentInPayoutId).toBeNull();
      const [pendingChangeTx] = await booted.deps.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, pendingChangeUtxo!.transactionId));
      expect(pendingChangeTx!.status).toBe("detected");

      // Payout B fits inside the unconfirmed change — planning and
      // broadcasting must both succeed while A is still in the mempool.
      const payoutB = await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: BTC_CHAIN_ID,
        token: "BTC",
        amountRaw: "50000",
        destinationAddress: DESTINATION
      });
      const secondTick = await executeReservedPayouts(booted.deps);
      expect(secondTick.submitted).toBe(1);
      expect(fake.broadcasts).toHaveLength(2);

      // B's tx spends A's change outpoint (mempool chaining).
      const txB = fake.broadcasts[1]!;
      expect(txB.inputs.some((i) => i.prevTxid === txidA)).toBe(true);
      const [spentChange] = await booted.deps.db
        .select()
        .from(utxos)
        .where(eq(utxos.id, pendingChangeUtxo!.id));
      expect(spentChange!.spentInPayoutId).toBe(payoutB.id);

      // Confirm A: the backfill's transactions insert collides with the
      // broadcast-time pending row and must flip it to 'confirmed' instead
      // of leaving it 'detected' forever.
      const [rowA] = await booted.deps.db
        .select({ changeVout: utxos.vout, valueSats: utxos.valueSats })
        .from(utxos)
        .where(eq(utxos.id, pendingChangeUtxo!.id));
      fake.registerConfirmedTx({
        txid: txidA,
        blockHeight: 200,
        outputs: [
          { address: DESTINATION, valueSats: 100_000 },
          { address: pendingChangeUtxo!.address, valueSats: Number(rowA!.valueSats) }
        ]
      });
      fake.setTipHeight(210);
      const sweep = await confirmPayouts(booted.deps);
      expect(sweep.confirmed).toBeGreaterThanOrEqual(1);
      const [payoutARow] = await booted.deps.db
        .select({ status: payouts.status })
        .from(payouts)
        .where(eq(payouts.id, payoutA.id));
      expect(payoutARow!.status).toBe("confirmed");

      const [convergedTx] = await booted.deps.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, pendingChangeUtxo!.transactionId));
      expect(convergedTx!.status).toBe("confirmed");
      // The spend marker must survive the backfill replay untouched.
      const [changeAfterConfirm] = await booted.deps.db
        .select()
        .from(utxos)
        .where(eq(utxos.id, pendingChangeUtxo!.id));
      expect(changeAfterConfirm!.spentInPayoutId).toBe(payoutB.id);
    } finally {
      await booted.close();
    }
  });

  it("keeps unconfirmed change unspendable with the knob off (default)", async () => {
    const fake = buildFakeEsplora();
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: fake.client });
    const booted = await bootTestApp({
      chains: [adapter],
      detectionStrategies: { [BTC_CHAIN_ID]: rpcPollDetection() },
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      const apiKey = booted.apiKeys[MERCHANT_ID]!;
      fake.setTipHeight(120);
      await seedConfirmedUtxo(booted, apiKey, "dd".repeat(32), 200_000);

      await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: BTC_CHAIN_ID,
        token: "BTC",
        amountRaw: "100000",
        destinationAddress: DESTINATION
      });
      const firstTick = await executeReservedPayouts(booted.deps);
      expect(firstTick.submitted).toBe(1);

      // No pending change rows are written with the knob off …
      const changeRows = await booted.deps.db
        .select()
        .from(utxos)
        .where(eq(utxos.origin, "change"));
      expect(changeRows).toHaveLength(0);

      // … so a follow-up payout has zero spendable balance until the
      // change confirms.
      await expect(
        planPayout(booted.deps, {
          merchantId: MERCHANT_ID,
          chainId: BTC_CHAIN_ID,
          token: "BTC",
          amountRaw: "50000",
          destinationAddress: DESTINATION
        })
      ).rejects.toThrow();
    } finally {
      await booted.close();
    }
  });
});
