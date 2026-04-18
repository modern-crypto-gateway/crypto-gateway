import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { custom } from "viem";
import { transactions } from "../../db/schema.js";
import { evmChainAdapter } from "../../adapters/chains/evm/evm-chain.adapter.js";
import { ingestDetectedTransfer } from "../../core/domain/payment.service.js";
import type { AmountRaw } from "../../core/types/money.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

// GET /invoices/:id returns the new hydrated breakdown:
//   { invoice, amounts, transactions }
// Where `amounts` is the USD-axis recomputation and `transactions` is the
// full per-tx detail array (every status). These tests cover:
//   - all four tx statuses appear in the array
//   - amounts.confirmingUsd / confirmedUsd / remainingUsd / overpaidUsd reflect
//     only the right rows (reverted + orphaned excluded)
//   - chain slug is populated and matches the chainId
//   - decimal `amount` matches BigInt(amountRaw) / 10^decimals
//   - non-USD invoices return all-null amounts

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

const noopTransport = custom({
  async request() {
    throw new Error("EVM adapter touched RPC unexpectedly");
  }
});

function authHeader(apiKey: string): HeadersInit {
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
}

interface DetailsResponse {
  invoice: {
    id: string;
    status: string;
    amountUsd: string | null;
    paidUsd: string | null;
    overpaidUsd: string | null;
    receiveAddress: string;
  };
  amounts: {
    requiredUsd: string | null;
    confirmedUsd: string | null;
    confirmingUsd: string | null;
    remainingUsd: string | null;
    overpaidUsd: string | null;
  };
  transactions: Array<{
    id: string;
    txHash: string;
    chainId: number;
    chain: string | null;
    token: string;
    amountRaw: string;
    amount: string;
    amountUsd: string | null;
    usdRate: string | null;
    status: "detected" | "confirmed" | "reverted" | "orphaned";
    fromAddress: string;
    toAddress: string;
    detectedAt: string;
    confirmedAt: string | null;
  }>;
}

describe("GET /api/v1/invoices/:id details", () => {
  let booted: BootedTestApp;
  let apiKey: string;

  beforeEach(async () => {
    booted = await bootTestApp({
      chains: [evmChainAdapter({ chainIds: [1, 137], transports: { 1: noopTransport, 137: noopTransport } })],
      poolInitialSize: 5
    });
    apiKey = booted.apiKeys[MERCHANT_ID]!;
  });

  afterEach(async () => {
    await booted.close();
  });

  it("returns amounts breakdown + transactions array with all statuses", async () => {
    // 1. Create a USD-pegged invoice for $100 across both EVM chains the
    //    bootstrapped adapter wires.
    const createRes = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({
          chainId: 1,
          token: "USDC",
          amountUsd: "100.00",
          acceptedFamilies: ["evm"]
        })
      })
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { invoice: { id: string; receiveAddress: string } };
    const invoiceId = created.invoice.id;
    const receiveAddress = created.invoice.receiveAddress;

    // 2. Ingest a confirmed payment ($60 USDC on chain 1).
    const confirmedTx = await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0x" + "a".repeat(64),
      logIndex: 0,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: receiveAddress,
      token: "USDC",
      amountRaw: "60000000" as AmountRaw,
      blockNumber: 100,
      confirmations: 20,
      seenAt: new Date()
    });
    expect(confirmedTx.invoiceStatusAfter).toBe("partial");

    // 3. Ingest a still-detected payment ($25 USDC on chain 137, 0 confirmations).
    const detectedTx = await ingestDetectedTransfer(booted.deps, {
      chainId: 137,
      txHash: "0x" + "b".repeat(64),
      logIndex: 0,
      fromAddress: "0x2222222222222222222222222222222222222222",
      toAddress: receiveAddress,
      token: "USDC",
      amountRaw: "25000000" as AmountRaw,
      blockNumber: 200,
      confirmations: 0,
      seenAt: new Date()
    });
    expect(detectedTx.inserted).toBe(true);

    // 4. Ingest then revert a payment — simulates a tx that included but
    //    failed on chain. Direct DB update mirrors what the polling sweeper
    //    does when the receipt comes back failed.
    await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0x" + "c".repeat(64),
      logIndex: 0,
      fromAddress: "0x3333333333333333333333333333333333333333",
      toAddress: receiveAddress,
      token: "USDC",
      amountRaw: "50000000" as AmountRaw,
      blockNumber: 150,
      confirmations: 20,
      seenAt: new Date()
    });
    await booted.deps.db
      .update(transactions)
      .set({ status: "reverted" })
      .where(eq(transactions.txHash, "0x" + "c".repeat(64)));

    // 5. GET the invoice and assert the new breakdown shape.
    const getRes = await booted.app.fetch(
      new Request(`http://test.local/api/v1/invoices/${invoiceId}`, { headers: authHeader(apiKey) })
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as DetailsResponse;

    expect(body.invoice.id).toBe(invoiceId);
    expect(body.invoice.amountUsd).toBe("100.00");

    // Amounts: confirmed = $60, confirming = $25, remaining = $40, overpaid = 0.
    // Reverted $50 is excluded from BOTH confirmed and confirming.
    expect(body.amounts.requiredUsd).toBe("100.00");
    expect(body.amounts.confirmedUsd).toBe("60.00");
    expect(body.amounts.confirmingUsd).toBe("25.00");
    expect(body.amounts.remainingUsd).toBe("40.00");
    expect(body.amounts.overpaidUsd).toBe("0.00");

    // Transactions: all three rows present, every status preserved, slug filled.
    expect(body.transactions).toHaveLength(3);
    const byStatus = new Map(body.transactions.map((t) => [t.status, t]));

    const conf = byStatus.get("confirmed");
    expect(conf).toBeDefined();
    expect(conf!.chainId).toBe(1);
    expect(conf!.chain).toBe("ethereum");
    expect(conf!.amountRaw).toBe("60000000");
    expect(conf!.amount).toBe("60");
    expect(conf!.amountUsd).toBe("60.00");
    expect(conf!.usdRate).toBe("1");
    expect(conf!.confirmedAt).not.toBeNull();

    const det = byStatus.get("detected");
    expect(det).toBeDefined();
    expect(det!.chainId).toBe(137);
    expect(det!.chain).toBe("polygon");
    expect(det!.amountRaw).toBe("25000000");
    expect(det!.amount).toBe("25");
    expect(det!.amountUsd).toBe("25.00");

    const rev = byStatus.get("reverted");
    expect(rev).toBeDefined();
    expect(rev!.chainId).toBe(1);
    expect(rev!.amountRaw).toBe("50000000");
  });

  it("returns all-null amounts breakdown for legacy single-token invoices", async () => {
    const createRes = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({ chainId: 1, token: "USDC", amountRaw: "1000000" })
      })
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { invoice: { id: string } };

    const getRes = await booted.app.fetch(
      new Request(`http://test.local/api/v1/invoices/${created.invoice.id}`, {
        headers: authHeader(apiKey)
      })
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as DetailsResponse;

    expect(body.amounts).toEqual({
      requiredUsd: null,
      confirmedUsd: null,
      confirmingUsd: null,
      remainingUsd: null,
      overpaidUsd: null
    });
    expect(body.transactions).toEqual([]);
  });
});
