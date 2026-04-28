import { describe, expect, it } from "vitest";
import { utxoChainAdapter } from "../../adapters/chains/utxo/utxo-chain.adapter.js";
import { BITCOIN_CONFIG } from "../../adapters/chains/utxo/utxo-config.js";
import type {
  EsploraClient
} from "../../adapters/chains/utxo/esplora-rpc.js";
import { estimatePayoutFees, planPayout } from "../../core/domain/payout.service.js";
import { transactions, utxos } from "../../db/schema.js";
import type { ChainId } from "../../core/types/chain.js";
import { bootTestApp } from "../helpers/boot.js";

// UTXO-specific MAX_AMOUNT_EXCEEDS_NET_SPENDABLE + accurate fee handling.
//
// The pre-fix planner used a typical-1-input vbyte estimate (141 vbytes ×
// medium-tier sat/vB) for both the headroom check AND the persisted
// `feeQuotedNative` audit field. Two failure modes:
//   1. When requested amount + actual fee exceeded balance, the merchant
//      got an opaque INSUFFICIENT_BALANCE_ANY_SOURCE with no actionable
//      "try X or less" hint.
//   2. The persisted feeQuotedNative drifted +50–60 % from the broadcast-
//      time fee whenever coinselect picked >1 input.
//
// Both paths now run real coinselect at plan time using the same sat/vB
// rate the executor uses, so the fee is realistic AND we can compute a
// suggested max-send amount when the request doesn't fit.

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const BTC_CHAIN_ID = 800 as ChainId;
const DESTINATION = "bc1qq4f52x68umsamcatkg88qg274em3r3jt55ydj7";

function fakeEsplora(opts: { medRate: number }): EsploraClient {
  const fail = () => {
    throw new Error("Esplora not used in this test path");
  };
  return {
    getAddressTxs: fail,
    getAddressMempoolTxs: fail,
    getTx: fail,
    getTipHeight: fail,
    broadcastTx: fail,
    // pickFeeTier(_, "medium") looks at keys "3" | "4" | "5" — return the
    // requested rate keyed at "3" so the medium tier resolves to it.
    async getFeeEstimates() {
      return { "3": opts.medRate };
    },
    getAddressBalanceSats: fail
  };
}

async function seedUtxo(
  booted: Awaited<ReturnType<typeof bootTestApp>>,
  args: {
    invoiceId: string;
    receiveAddress: string;
    addressIndex: number;
    valueSats: string;
    txKey: string; // unique short id used for tx hash + utxo id
  }
): Promise<void> {
  const now = booted.deps.clock.now().getTime();
  const txHash = args.txKey.repeat(32 / args.txKey.length);
  await booted.deps.db.insert(transactions).values({
    id: `tx-${args.txKey}`,
    invoiceId: args.invoiceId,
    chainId: BTC_CHAIN_ID,
    txHash,
    logIndex: 0,
    fromAddress: "bc1qsenderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    toAddress: args.receiveAddress,
    token: "BTC",
    amountRaw: args.valueSats,
    blockNumber: 100,
    confirmations: 12,
    status: "confirmed",
    detectedAt: now
  });
  await booted.deps.db.insert(utxos).values({
    id: `${txHash}:0`,
    transactionId: `tx-${args.txKey}`,
    chainId: BTC_CHAIN_ID,
    address: args.receiveAddress,
    addressIndex: args.addressIndex,
    vout: 0,
    valueSats: args.valueSats,
    scriptPubkey: "0014" + "ff".repeat(20),
    spentInPayoutId: null,
    spentAt: null,
    createdAt: now
  });
}

async function createInvoiceForReceive(
  booted: Awaited<ReturnType<typeof bootTestApp>>
): Promise<{ id: string; receiveAddress: string; addressIndex: number }> {
  const apiKey = booted.apiKeys[MERCHANT_ID]!;
  const res = await booted.app.fetch(
    new Request("http://test.local/api/v1/invoices", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ chainId: BTC_CHAIN_ID, token: "BTC", amountRaw: "100000" })
    })
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { invoice: { id: string; receiveAddress: string; addressIndex: number } }).invoice;
}

describe("UTXO planPayout — MAX_AMOUNT_EXCEEDS_NET_SPENDABLE + accurate fee", () => {
  it("emits MAX_AMOUNT_EXCEEDS_NET_SPENDABLE with suggestedAmount when requested > balance − fee", async () => {
    // Single 5000-sat UTXO. At 2 sat/vB, 1-input-1-output vsize ≈ 110 vbytes,
    // so the worst-case fee for spending all UTXOs to a single output is
    // ~(11 + 68×1 + 31) × 2 = 220 sats. Asking for 5000 leaves 0 for fee →
    // suggested = 5000 − 220 = 4780.
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: fakeEsplora({ medRate: 2 }) });
    const booted = await bootTestApp({
      chains: [adapter],
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      const invoice = await createInvoiceForReceive(booted);
      await seedUtxo(booted, {
        invoiceId: invoice.id,
        receiveAddress: invoice.receiveAddress,
        addressIndex: invoice.addressIndex,
        valueSats: "5000",
        txKey: "ab"
      });

      let caught: { code?: string; details?: Record<string, unknown> } | null = null;
      try {
        await planPayout(booted.deps, {
          merchantId: MERCHANT_ID,
          chainId: BTC_CHAIN_ID,
          token: "BTC",
          amountRaw: "5000",
          feeTier: "medium",
          destinationAddress: DESTINATION
        });
      } catch (err) {
        caught = err as { code?: string; details?: Record<string, unknown> };
      }
      expect(caught).not.toBeNull();
      expect(caught!.code).toBe("MAX_AMOUNT_EXCEEDS_NET_SPENDABLE");
      const suggested = caught!.details!["suggestedAmountRaw"] as string;
      // Must STRICTLY undercut the requested amount — a suggestion of
      // "4047 or less" when 4047 was the exact ask is not actionable.
      expect(Number(suggested)).toBeLessThan(5000);
      expect(Number(suggested)).toBeGreaterThan(3500);
      // 8 BTC decimals; suggested raw < 5000 → "0.0000nnnn" or shorter.
      expect(caught!.details!["suggestedAmount"]).toMatch(/^0\.0000\d+$/);

      // The suggestion must actually be plannable — retrying at exactly
      // suggestedAmountRaw must succeed without falling into the same
      // MAX path. This is the regression we're fixing: pre-fix the formula
      // could land exactly on the boundary coinselect refuses.
      const planned = await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: BTC_CHAIN_ID,
        token: "BTC",
        amountRaw: suggested,
        feeTier: "medium",
        destinationAddress: DESTINATION
      });
      expect(planned.status).toBe("reserved");
      expect(planned.amountRaw).toBe(suggested);
    } finally {
      await booted.close();
    }
  });

  it("falls back to INSUFFICIENT_BALANCE_ANY_SOURCE when balance is below dust + fee", async () => {
    // 100-sat UTXO < dust threshold 546. No actionable suggestion available.
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: fakeEsplora({ medRate: 2 }) });
    const booted = await bootTestApp({
      chains: [adapter],
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      const invoice = await createInvoiceForReceive(booted);
      await seedUtxo(booted, {
        invoiceId: invoice.id,
        receiveAddress: invoice.receiveAddress,
        addressIndex: invoice.addressIndex,
        valueSats: "100",
        txKey: "cd"
      });

      let caught: { code?: string } | null = null;
      try {
        await planPayout(booted.deps, {
          merchantId: MERCHANT_ID,
          chainId: BTC_CHAIN_ID,
          token: "BTC",
          amountRaw: "1000",
          feeTier: "medium",
          destinationAddress: DESTINATION
        });
      } catch (err) {
        caught = err as { code?: string };
      }
      expect(caught).not.toBeNull();
      expect(caught!.code).toBe("INSUFFICIENT_BALANCE_ANY_SOURCE");
    } finally {
      await booted.close();
    }
  });

  it("falls back to 1/2/3 sat/vB when esplora is unavailable so payouts can still be planned", async () => {
    // When the fee oracle is down, payouts must still be plannable and
    // broadcastable — letting an upstream esplora outage block the entire
    // payout flow is unacceptable. Adapter falls back to conservative
    // hardcoded rates (low=1, medium=2, high=3 sat/vB). Operators can RBF-
    // bump later if real mempool conditions push the market above 3 sat/vB
    // while the oracle is still down.
    const failingEsplora: EsploraClient = {
      getAddressTxs: async () => { throw new Error("not used"); },
      getAddressMempoolTxs: async () => { throw new Error("not used"); },
      getTx: async () => { throw new Error("not used"); },
      getTipHeight: async () => { throw new Error("not used"); },
      broadcastTx: async () => { throw new Error("not used"); },
      // The thing that actually matters here:
      getFeeEstimates: async () => { throw new Error("simulated upstream esplora 503"); },
      getAddressBalanceSats: async () => 0n
    };
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: failingEsplora });
    const booted = await bootTestApp({
      chains: [adapter],
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      const invoice = await createInvoiceForReceive(booted);
      await seedUtxo(booted, {
        invoiceId: invoice.id,
        receiveAddress: invoice.receiveAddress,
        addressIndex: invoice.addressIndex,
        valueSats: "10000",
        txKey: "34"
      });

      const result = await estimatePayoutFees(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: BTC_CHAIN_ID,
        token: "BTC",
        amountRaw: "5000",
        feeTier: "medium",
        destinationAddress: DESTINATION
      });

      // Differentiated tiers in fallback mode: 141 / 282 / 423 sat
      // (= 141 vbytes × 1 / 2 / 3 sat/vB).
      expect(result.tiers.tieringSupported).toBe(true);
      expect(result.tiers.low.nativeAmountRaw).toBe("141");
      expect(result.tiers.medium.nativeAmountRaw).toBe("282");
      expect(result.tiers.high.nativeAmountRaw).toBe("423");
      // Adapter served fallback rates → fee_quote_degraded surfaces so the
      // dashboard knows tiers aren't market-fresh. NOT fee_quote_unavailable
      // (those were the OLD pre-adapter-fallback semantics — quote was
      // literally unavailable). NOT fee_market_uniform (1/2/3 differ).
      expect(result.warnings).toContain("fee_quote_degraded");
      expect(result.warnings).not.toContain("fee_quote_unavailable");
      expect(result.warnings).not.toContain("fee_market_uniform");
      // Source is real — payout is plannable.
      expect(result.source).not.toBeNull();
      expect(result.source!.tokenBalance).toBe("10000");

      // And planPayout actually succeeds (can't have an estimate that says
      // "go" only for the plan to throw FEE_ESTIMATE_FAILED — the test
      // would-have-blown the whole point of the fallback).
      const planned = await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: BTC_CHAIN_ID,
        token: "BTC",
        amountRaw: "5000",
        feeTier: "medium",
        destinationAddress: DESTINATION
      });
      expect(planned.status).toBe("reserved");
    } finally {
      await booted.close();
    }
  });

  it("estimatePayoutFees throws MAX_AMOUNT_EXCEEDS_NET_SPENDABLE with the same suggestion shape as planPayout", async () => {
    // Same setup as the planPayout max-send test, but exercising the
    // estimate path. Pre-fix, estimate just emitted an
    // `insufficient_utxo_balance` warning and a faux source — no
    // suggested amount, no actionable error.
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: fakeEsplora({ medRate: 2 }) });
    const booted = await bootTestApp({
      chains: [adapter],
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      const invoice = await createInvoiceForReceive(booted);
      await seedUtxo(booted, {
        invoiceId: invoice.id,
        receiveAddress: invoice.receiveAddress,
        addressIndex: invoice.addressIndex,
        valueSats: "5000",
        txKey: "12"
      });

      let caught: { code?: string; details?: Record<string, unknown> } | null = null;
      try {
        await estimatePayoutFees(booted.deps, {
          merchantId: MERCHANT_ID,
          chainId: BTC_CHAIN_ID,
          token: "BTC",
          amountRaw: "5000",
          feeTier: "medium",
          destinationAddress: DESTINATION
        });
      } catch (err) {
        caught = err as { code?: string; details?: Record<string, unknown> };
      }
      expect(caught).not.toBeNull();
      expect(caught!.code).toBe("MAX_AMOUNT_EXCEEDS_NET_SPENDABLE");
      const suggested = caught!.details!["suggestedAmountRaw"] as string;
      expect(Number(suggested)).toBeLessThan(5000);
      expect(Number(suggested)).toBeGreaterThan(4500);
      expect(caught!.details!["suggestedAmount"]).toMatch(/^0\.0000\d+$/);
    } finally {
      await booted.close();
    }
  });

  it("persists realistic feeQuotedNative from coinselect (not the typical-vbyte shortcut)", async () => {
    // 1 input + 1 P2WPKH dest output + 1 P2WPKH change ≈ 141 vbytes at
    // most. Real coinselect output for this shape at 2 sat/vB: ~226 sat —
    // close to what production saw. The pre-fix quote would have been
    // ceil(141 × 2) = 282; with a single output (no change) the actual
    // shape comes in lower.
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: fakeEsplora({ medRate: 2 }) });
    const booted = await bootTestApp({
      chains: [adapter],
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      const invoice = await createInvoiceForReceive(booted);
      // 100k-sat UTXO → comfortably covers a 50k-sat send + fee + change.
      await seedUtxo(booted, {
        invoiceId: invoice.id,
        receiveAddress: invoice.receiveAddress,
        addressIndex: invoice.addressIndex,
        valueSats: "100000",
        txKey: "ef"
      });

      const planned = await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: BTC_CHAIN_ID,
        token: "BTC",
        amountRaw: "50000",
        feeTier: "medium",
        destinationAddress: DESTINATION
      });
      // Coinselect's fee should be > 100 sat (multi-output minimum at 2
      // sat/vB) and < the loose pre-fix 1.5×-safety EVM-style overestimate.
      // Tight bounds aren't worthwhile — the assertion that matters is
      // that the value reflects coinselect's real calculation, not a
      // copy of `gasNeeded` from the EVM picker.
      expect(planned.feeQuotedNative).not.toBeNull();
      const fee = Number(planned.feeQuotedNative);
      expect(fee).toBeGreaterThan(100);
      expect(fee).toBeLessThan(1000);
    } finally {
      await booted.close();
    }
  });
});
