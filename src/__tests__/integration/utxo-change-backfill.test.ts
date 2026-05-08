import { describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { utxoChainAdapter } from "../../adapters/chains/utxo/utxo-chain.adapter.js";
import { BITCOIN_CONFIG } from "../../adapters/chains/utxo/utxo-config.js";
import type {
  EsploraClient,
  EsploraTx
} from "../../adapters/chains/utxo/esplora-rpc.js";
import { rpcPollDetection } from "../../adapters/detection/rpc-poll.adapter.js";
import { ingestDetectedTransfer } from "../../core/domain/payment.service.js";
import {
  backfillChangeUtxo,
  confirmPayouts,
  executeReservedPayouts,
  planPayout
} from "../../core/domain/payout.service.js";
import { computeBalanceSnapshot } from "../../core/domain/balance-snapshot.service.js";
import { findChainAdapter } from "../../core/domain/chain-lookup.js";
import {
  payoutBroadcasts,
  payouts,
  transactions,
  utxos
} from "../../db/schema.js";
import type { AppDeps } from "../../core/app-deps.js";
import type { AmountRaw } from "../../core/types/money.js";
import type { ChainId } from "../../core/types/chain.js";
import { signSegwitTx } from "../../adapters/chains/utxo/utxo-sign.js";
import { drizzleRowToPayout } from "../../core/domain/mappers.js";
import { decodeP2wpkhAddress } from "../../adapters/chains/utxo/bech32-address.js";
import { bootTestApp } from "../helpers/boot.js";

// On UTXO payouts the change output goes to a fresh BIP84 address that the
// gateway derives at broadcast time. Until this backfill landed, that change
// was on-chain at a gateway-controlled address but invisible to balance and
// to coinselect (the detection scanner only watches addresses listed in
// invoice_receive_addresses).
//
// This test drives a payout end to end and asserts that confirmation reads
// back the change as a spendable UTXO:
//   1. Plan + broadcast a UTXO payout that produces change.
//   2. Verify payout_broadcasts records change_address_index + change_vout.
//   3. Confirm the payout. backfillChangeUtxo runs, writes a transactions
//      row for the change vout and a utxos row for the change address.
//   4. Re-running the backfill is a no-op (idempotency).
//   5. Balance snapshot now includes the change value.

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const BTC_CHAIN_ID = 800 as ChainId;
const DESTINATION = "bc1q4w46h2at4w46h2at4w46h2at4w46h2at25y74s";

interface FakeEsplora {
  client: EsploraClient;
  addIncoming(args: {
    txid: string;
    address: string;
    valueSats: number;
    blockHeight?: number;
    fromAddress?: string;
  }): { txid: string; vout: number };
  // Register a broadcast tx with its outputs so getConfirmationStatus can
  // resolve it post-broadcast. Used to drive confirmPayouts.
  registerConfirmedTx(args: {
    txid: string;
    blockHeight: number;
    outputs: ReadonlyArray<{ address: string; valueSats: number }>;
  }): void;
  setTipHeight(height: number): void;
  setBroadcastReturnTxid(txid: string | null): void;
  broadcasts: Array<{ hex: string; returnedTxid: string }>;
}

function buildFakeEsplora(): FakeEsplora {
  const txsByAddress = new Map<string, EsploraTx[]>();
  const txsById = new Map<string, EsploraTx>();
  let tipHeight = 0;
  let pendingBroadcastReturnTxid: string | null = null;
  const broadcasts: Array<{ hex: string; returnedTxid: string }> = [];

  const client: EsploraClient = {
    async getAddressTxs(address) {
      return (txsByAddress.get(address.toLowerCase()) ?? []).filter(
        (t) => t.status.confirmed
      );
    },
    async getAddressMempoolTxs(address) {
      return (txsByAddress.get(address.toLowerCase()) ?? []).filter(
        (t) => !t.status.confirmed
      );
    },
    async getTx(txid) {
      const tx = txsById.get(txid);
      if (!tx) {
        const { EsploraNotFoundError } = await import(
          "../../adapters/chains/utxo/esplora-rpc.js"
        );
        throw new EsploraNotFoundError(`/tx/${txid}`);
      }
      return tx;
    },
    async getTipHeight() {
      return tipHeight;
    },
    async broadcastTx(hex) {
      const returnedTxid = pendingBroadcastReturnTxid ?? "00".repeat(32);
      broadcasts.push({ hex, returnedTxid });
      return returnedTxid;
    },
    async getFeeEstimates() {
      return { "1": 50, "3": 25, "6": 10 };
    },
    async getAddressBalanceSats() {
      return 0n;
    }
  };

  return {
    client,
    addIncoming({ txid, address, valueSats, blockHeight, fromAddress }) {
      const lc = address.toLowerCase();
      const tx: EsploraTx = {
        txid,
        status:
          blockHeight !== undefined
            ? { confirmed: true, block_height: blockHeight, block_time: 1_700_000_000 }
            : { confirmed: false },
        vin: [
          {
            txid: "0".repeat(64),
            vout: 0,
            prevout: {
              scriptpubkey: "0014" + "00".repeat(20),
              scriptpubkey_address: fromAddress ?? "bc1qyqsjygeyy5nzw2pf9g4jctfw9ucrzv3ncm6wfx",
              value: valueSats + 1_000
            },
            witness: [],
            sequence: 0xffffffff
          }
        ],
        vout: [
          {
            scriptpubkey: "0014" + "ff".repeat(20),
            scriptpubkey_address: lc,
            value: valueSats
          }
        ],
        fee: 1_000
      };
      const list = txsByAddress.get(lc) ?? [];
      list.push(tx);
      txsByAddress.set(lc, list);
      txsById.set(txid, tx);
      return { txid, vout: 0 };
    },
    registerConfirmedTx({ txid, blockHeight, outputs }) {
      const tx: EsploraTx = {
        txid,
        status: { confirmed: true, block_height: blockHeight, block_time: 1_700_000_001 },
        vin: [],
        vout: outputs.map((o) => ({
          scriptpubkey: "0014" + "ff".repeat(20),
          scriptpubkey_address: o.address.toLowerCase(),
          value: o.valueSats
        })),
        fee: 0
      };
      txsById.set(txid, tx);
    },
    setTipHeight(h) {
      tipHeight = h;
    },
    setBroadcastReturnTxid(v) {
      pendingBroadcastReturnTxid = v;
    },
    broadcasts
  };
}

// Re-derives the deterministic txid + change address the broadcast pipeline
// will produce, so the test can echo the right txid back from broadcastTx
// (the adapter cross-checks). Same approach as utxo-payment.test.ts.
async function precomputeBroadcast(
  deps: AppDeps,
  payoutId: string
): Promise<{ hex: string; txid: string; changeAddress: string; changeIndex: number; changeValueSats: number; changeVout: number }> {
  const { selectCoins, loadSpendableUtxos } = await import(
    "../../core/domain/utxo-coin-select.js"
  );

  const [row] = await deps.db
    .select()
    .from(payouts)
    .where(eq(payouts.id, payoutId))
    .limit(1);
  if (!row) throw new Error("payout not found");

  const adapter = findChainAdapter(deps, row.chainId);
  const tier: "low" | "medium" | "high" =
    (row.feeTier as "low" | "medium" | "high" | null) ?? "medium";
  const tierQuote = await adapter.quoteFeeTiers({
    chainId: row.chainId as ChainId,
    fromAddress: row.destinationAddress as never,
    toAddress: row.destinationAddress as never,
    token: row.token as never,
    amountRaw: row.amountRaw as never
  });
  const TYPICAL_VBYTES = 141;
  const tierEntry: { nativeAmountRaw: string } = tierQuote[tier];
  const feeRate = Math.max(
    1,
    Math.ceil(Number(tierEntry.nativeAmountRaw) / TYPICAL_VBYTES)
  );
  const spendable = await loadSpendableUtxos(deps, row.chainId as ChainId);
  const selection = selectCoins(
    spendable,
    [{ address: row.destinationAddress, value: Number(row.amountRaw) }],
    feeRate
  );
  if (!selection) throw new Error("test: coinselect failed");

  const seed = deps.secrets.getRequired("MASTER_SEED");
  const { addressIndexCounters } = await import("../../db/schema.js");
  const [counter] = await deps.db
    .select()
    .from(addressIndexCounters)
    .where(eq(addressIndexCounters.chainId, row.chainId))
    .limit(1);
  const changeIndex = counter?.nextIndex ?? 0;
  const changeDerived = adapter.deriveAddress(seed, changeIndex);
  const decodedChange = decodeP2wpkhAddress(changeDerived.address);
  if (!decodedChange) throw new Error("change address decode");
  const changeScript = "0014" + bytesToHex(decodedChange.program);

  const decodedDest = decodeP2wpkhAddress(row.destinationAddress);
  if (!decodedDest) throw new Error("destination address decode");
  const destScript = "0014" + bytesToHex(decodedDest.program);

  let changeValueSats = 0;
  let changeVout = -1;
  const outputs = selection.outputs.map((o, idx) => {
    if (o.address === undefined) {
      changeValueSats = o.value;
      changeVout = idx;
      return { scriptPubkey: changeScript, value: BigInt(o.value) };
    }
    return { scriptPubkey: destScript, value: BigInt(o.value) };
  });
  if (changeVout === -1) throw new Error("test: expected coinselect to produce change");

  const inputs = selection.chosenInputs.map((u) => ({
    prevTxid: u.txId,
    prevVout: u.vout,
    prevScriptPubkey: u.scriptPubkey,
    prevValue: BigInt(u.value),
    sequence: 0xfffffffd
  }));
  const signingKeys = await Promise.all(
    selection.chosenInputs.map(async (u) => {
      const pk = await deps.signerStore.get({
        kind: "pool-address" as const,
        family: "utxo" as const,
        derivationIndex: u.addressIndex,
        chainId: row.chainId as ChainId
      });
      return { address: u.address, privateKey: pk };
    })
  );
  const signed = signSegwitTx({ version: 2, locktime: 0, inputs, outputs }, signingKeys);
  return {
    hex: signed.hex,
    txid: signed.txid,
    changeAddress: changeDerived.address,
    changeIndex,
    changeValueSats,
    changeVout
  };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 1) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

describe("UTXO change-output backfill on payout confirmation", () => {
  it("records change index + vout at broadcast, and inserts utxos + transactions on confirmation", async () => {
    const fake = buildFakeEsplora();
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: fake.client });
    const booted = await bootTestApp({
      chains: [adapter],
      detectionStrategies: { [BTC_CHAIN_ID]: rpcPollDetection() },
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      const apiKey = booted.apiKeys[MERCHANT_ID]!;

      // ---- Seed: one invoice + one confirmed 200k-sat UTXO funding it ----
      const invoiceRes = await booted.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ chainId: BTC_CHAIN_ID, token: "BTC", amountRaw: "200000" })
        })
      );
      expect(invoiceRes.status).toBe(201);
      const invoice = ((await invoiceRes.json()) as {
        invoice: { id: string; receiveAddress: string; addressIndex: number };
      }).invoice;

      fake.setTipHeight(120);
      fake.addIncoming({
        txid: "ab".repeat(32),
        address: invoice.receiveAddress,
        valueSats: 200_000,
        blockHeight: 110
      });
      await ingestDetectedTransfer(booted.deps, {
        chainId: BTC_CHAIN_ID,
        txHash: "ab".repeat(32),
        logIndex: 0,
        fromAddress: "bc1qzqg3yyc5z5tpwxqergd3c8g7ruszzg3r8jj72z" as never,
        toAddress: invoice.receiveAddress as never,
        token: "BTC" as never,
        amountRaw: "200000" as AmountRaw,
        blockNumber: 110,
        confirmations: 11,
        seenAt: new Date()
      });

      // ---- Plan + broadcast a 100k-sat payout (leaves change) ----
      const payout = await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: BTC_CHAIN_ID,
        token: "BTC",
        amountRaw: "100000",
        destinationAddress: DESTINATION
      });
      expect(payout.status).toBe("reserved");

      const expected = await precomputeBroadcast(booted.deps, payout.id);
      fake.setBroadcastReturnTxid(expected.txid);

      const result = await executeReservedPayouts(booted.deps);
      expect(result.submitted).toBe(1);

      // payout_broadcasts now carries the new fields populated.
      const [broadcastRow] = await booted.deps.db
        .select()
        .from(payoutBroadcasts)
        .where(eq(payoutBroadcasts.payoutId, payout.id))
        .limit(1);
      expect(broadcastRow).toBeDefined();
      expect(broadcastRow!.changeAddress).toBe(expected.changeAddress);
      expect(broadcastRow!.changeAddressIndex).toBe(expected.changeIndex);
      expect(broadcastRow!.changeVout).toBe(expected.changeVout);
      expect(broadcastRow!.changeValueSats).toBe(String(expected.changeValueSats));

      // Pre-confirmation: no utxos row for the change address (the fix
      // hasn't run yet — confirmPayouts is what triggers the backfill).
      const preConfirmUtxosForChange = await booted.deps.db
        .select()
        .from(utxos)
        .where(eq(utxos.address, expected.changeAddress));
      expect(preConfirmUtxosForChange).toHaveLength(0);

      // ---- Drive confirmation: register the broadcast tx + advance tip ----
      fake.registerConfirmedTx({
        txid: expected.txid,
        blockHeight: 200,
        outputs: [
          { address: DESTINATION, valueSats: 100_000 },
          { address: expected.changeAddress, valueSats: expected.changeValueSats }
        ]
      });
      // Bitcoin mainnet (chainId 800) needs 6 confirmations. Tip 210 over
      // block 200 → 11 confirmations, comfortably past threshold.
      fake.setTipHeight(210);

      const sweep = await confirmPayouts(booted.deps);
      expect(sweep.confirmed).toBe(1);

      // Payout flipped to confirmed.
      const [confirmedRow] = await booted.deps.db
        .select()
        .from(payouts)
        .where(eq(payouts.id, payout.id))
        .limit(1);
      expect(confirmedRow!.status).toBe("confirmed");

      // ---- Backfill assertions ----

      // 1. transactions row was written for the change vout, status=confirmed,
      //    invoice_id=NULL (it's a self-send to ourselves; no merchant invoice).
      const [changeTx] = await booted.deps.db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.chainId, BTC_CHAIN_ID),
            eq(transactions.txHash, expected.txid),
            eq(transactions.logIndex, expected.changeVout)
          )
        )
        .limit(1);
      expect(changeTx).toBeDefined();
      expect(changeTx!.status).toBe("confirmed");
      expect(changeTx!.invoiceId).toBeNull();
      expect(changeTx!.toAddress).toBe(expected.changeAddress);
      expect(changeTx!.token).toBe("BTC");
      expect(changeTx!.amountRaw).toBe(String(expected.changeValueSats));

      // 2. utxos row exists for the change outpoint, marked spendable.
      const [changeUtxo] = await booted.deps.db
        .select()
        .from(utxos)
        .where(eq(utxos.id, `${expected.txid}:${expected.changeVout}`))
        .limit(1);
      expect(changeUtxo).toBeDefined();
      expect(changeUtxo!.address).toBe(expected.changeAddress);
      expect(changeUtxo!.addressIndex).toBe(expected.changeIndex);
      expect(changeUtxo!.spentInPayoutId).toBeNull();
      expect(changeUtxo!.valueSats).toBe(String(expected.changeValueSats));
      // P2WPKH scriptPubkey: OP_0 (00) + push-20 (14) + 20-byte program.
      expect(changeUtxo!.scriptPubkey).toMatch(/^0014[0-9a-f]{40}$/);

      // 3. Balance snapshot reflects the recovered change. The original
      //    200k UTXO is now spent (input to this payout), and the change
      //    output replaces it as the only spendable row on the chain.
      const snapshot = await computeBalanceSnapshot(booted.deps);
      const utxoFamily = snapshot.families.find((f) => f.family === "utxo");
      expect(utxoFamily).toBeDefined();
      const btcChain = utxoFamily!.chains.find((c) => c.chainId === BTC_CHAIN_ID);
      expect(btcChain).toBeDefined();
      const btcRollup = btcChain!.tokens.find((t) => t.token === "BTC");
      expect(btcRollup).toBeDefined();
      expect(BigInt(btcRollup!.amountRaw)).toBe(BigInt(expected.changeValueSats));

      // ---- Idempotency: re-running the backfill must be a clean no-op ----
      const adapterRef = findChainAdapter(booted.deps, BTC_CHAIN_ID);
      await backfillChangeUtxo(booted.deps, drizzleRowToPayout(confirmedRow!), adapterRef);

      const utxosAfterReplay = await booted.deps.db
        .select()
        .from(utxos)
        .where(eq(utxos.id, `${expected.txid}:${expected.changeVout}`));
      expect(utxosAfterReplay).toHaveLength(1);
      const txnsAfterReplay = await booted.deps.db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.chainId, BTC_CHAIN_ID),
            eq(transactions.txHash, expected.txid),
            eq(transactions.logIndex, expected.changeVout)
          )
        );
      expect(txnsAfterReplay).toHaveLength(1);
    } finally {
      await booted.close();
    }
  });

  it("skips backfill cleanly when payout_broadcasts has no change (fee consumed it)", async () => {
    // Pre-migration rows can have NULL change_address/change_address_index/
    // change_vout. The backfill must skip them silently — no transactions
    // row, no utxos row, no log error, no thrown.
    const fake = buildFakeEsplora();
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: fake.client });
    const booted = await bootTestApp({
      chains: [adapter],
      detectionStrategies: { [BTC_CHAIN_ID]: rpcPollDetection() },
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      // Insert a confirmed payout + a payout_broadcasts row with NULL change
      // fields, mimicking a row that landed before the backfill rolled out.
      const payoutId = "00000000-0000-0000-0000-0000000000aa";
      const txHash = "ee".repeat(32);
      const now = booted.deps.clock.now().getTime();
      await booted.deps.db.insert(payouts).values({
        id: payoutId,
        merchantId: MERCHANT_ID,
        kind: "standard",
        status: "confirmed",
        chainId: BTC_CHAIN_ID,
        token: "BTC",
        amountRaw: "100000",
        destinationAddress: DESTINATION,
        sourceAddress: null,
        txHash,
        feeEstimateNative: "200",
        confirmedAt: now,
        createdAt: now,
        updatedAt: now
      });
      await booted.deps.db.insert(payoutBroadcasts).values({
        id: "00000000-0000-0000-0000-0000000000bb",
        payoutId,
        attemptNumber: 1,
        txHash,
        rawHex: "(not-stashed)",
        feeSats: "200",
        vsize: 110,
        feerateSatVb: "2",
        inputsJson: "[]",
        // All change-* fields NULL — this is the pre-migration shape.
        changeAddress: null,
        changeValueSats: null,
        changeAddressIndex: null,
        changeVout: null,
        status: "submitted",
        broadcastAt: now,
        createdAt: now
      });

      const [row] = await booted.deps.db
        .select()
        .from(payouts)
        .where(eq(payouts.id, payoutId))
        .limit(1);
      const adapterRef = findChainAdapter(booted.deps, BTC_CHAIN_ID);
      await backfillChangeUtxo(booted.deps, drizzleRowToPayout(row!), adapterRef);

      // No new transactions row, no new utxos row.
      const txns = await booted.deps.db
        .select()
        .from(transactions)
        .where(eq(transactions.txHash, txHash));
      expect(txns).toHaveLength(0);
      const owned = await booted.deps.db
        .select()
        .from(utxos)
        .where(isNull(utxos.spentInPayoutId));
      expect(owned).toHaveLength(0);
    } finally {
      await booted.close();
    }
  });
});
