import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { custom } from "viem";
import { invoices, transactions } from "../../db/schema.js";
import { evmChainAdapter } from "../../adapters/chains/evm/evm-chain.adapter.js";
import { solanaChainAdapter, SOLANA_MAINNET_CHAIN_ID } from "../../adapters/chains/solana/solana-chain.adapter.js";
import { tronChainAdapter, TRON_MAINNET_CHAIN_ID } from "../../adapters/chains/tron/tron-chain.adapter.js";
import { ingestDetectedTransfer } from "../../core/domain/payment.service.js";
import { RATE_WINDOW_DURATION_MS } from "../../core/domain/rate-window.js";
import type { AmountRaw } from "../../core/types/money.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

const noopTransport = custom({
  async request() {
    throw new Error("EVM adapter touched RPC unexpectedly");
  }
});

function authHeader(apiKey: string): HeadersInit {
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
}

async function bootWithAllFamilies(options: { now?: Date; clock?: BootedTestApp["deps"]["clock"] } = {}): Promise<BootedTestApp> {
  return bootTestApp({
    chains: [
      evmChainAdapter({ chainIds: [1, 137, 56], transports: { 1: noopTransport, 137: noopTransport, 56: noopTransport } }),
      tronChainAdapter({
        chainIds: [TRON_MAINNET_CHAIN_ID],
        trongrid: { [TRON_MAINNET_CHAIN_ID]: { baseUrl: "https://unused.test" } }
      }),
      solanaChainAdapter({
        chainIds: [SOLANA_MAINNET_CHAIN_ID],
        rpc: { [SOLANA_MAINNET_CHAIN_ID]: { url: "http://unused.test/rpc" } }
      })
    ],
    poolInitialSize: 5,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {})
  });
}

async function createUsdInvoice(
  booted: BootedTestApp,
  apiKey: string,
  args: { amountUsd: string; acceptedFamilies: string[]; chainId?: number; token?: string }
): Promise<{
  id: string;
  receiveAddress: string;
  receiveAddresses: Array<{ family: string; address: string }>;
}> {
  const res = await booted.app.fetch(
    new Request("http://test.local/api/v1/invoices", {
      method: "POST",
      headers: authHeader(apiKey),
      body: JSON.stringify({
        chainId: args.chainId ?? 1,
        token: args.token ?? "USDC",
        amountUsd: args.amountUsd,
        acceptedFamilies: args.acceptedFamilies
      })
    })
  );
  if (res.status !== 201) throw new Error(`createUsdInvoice: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    invoice: {
      id: string;
      receiveAddress: string;
      receiveAddresses: Array<{ family: string; address: string }>;
    };
  };
  return body.invoice;
}

describe("USD-path ingest — single payment", () => {
  let booted: BootedTestApp;
  let apiKey: string;

  beforeEach(async () => {
    booted = await bootWithAllFamilies();
    apiKey = booted.apiKeys[MERCHANT_ID]!;
  });

  afterEach(async () => {
    await booted.close();
  });

  it("confirmed transfer covering the USD target flips status to 'completed' and records paid_usd", async () => {
    const invoice = await createUsdInvoice(booted, apiKey, {
      amountUsd: "100.00",
      acceptedFamilies: ["evm"]
    });

    const result = await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0x" + "a1".repeat(32),
      logIndex: 0,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: invoice.receiveAddress,
      token: "USDC",
      amountRaw: "100000000" as AmountRaw, // 100 USDC @ 6 decimals
      blockNumber: 100,
      confirmations: 20,
      seenAt: new Date()
    });
    expect(result.inserted).toBe(true);
    expect(result.invoiceStatusAfter).toBe("completed");

    const [row] = await booted.deps.db
      .select({
        status: invoices.status,
        extra_status: invoices.extraStatus,
        paid_usd: invoices.paidUsd,
        overpaid_usd: invoices.overpaidUsd,
        confirmed_at: invoices.confirmedAt
      })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(row?.status).toBe("completed");
    expect(row?.extra_status).toBeNull();
    expect(row?.paid_usd).toBe("100.00");
    expect(row?.overpaid_usd).toBe("0");
    expect(row?.confirmed_at).not.toBeNull();

    // amount_usd + usd_rate are pinned on the tx row at detection.
    const [txRow] = await booted.deps.db
      .select({ amount_usd: transactions.amountUsd, usd_rate: transactions.usdRate })
      .from(transactions)
      .where(eq(transactions.invoiceId, invoice.id))
      .limit(1);
    expect(txRow?.amount_usd).toBe("100.00");
    expect(txRow?.usd_rate).toBe("1");
  });

  it("underpayment transitions to processing(extra='partial'); a second transfer completes and confirms", async () => {
    const invoice = await createUsdInvoice(booted, apiKey, {
      amountUsd: "50.00",
      acceptedFamilies: ["evm"]
    });

    const r1 = await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0x" + "b1".repeat(32),
      logIndex: 0,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: invoice.receiveAddress,
      token: "USDC",
      amountRaw: "20000000" as AmountRaw,
      blockNumber: 100,
      confirmations: 20,
      seenAt: new Date()
    });
    expect(r1.invoiceStatusAfter).toBe("processing");

    const r2 = await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0x" + "b2".repeat(32),
      logIndex: 0,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: invoice.receiveAddress,
      token: "USDC",
      amountRaw: "30000000" as AmountRaw,
      blockNumber: 101,
      confirmations: 20,
      seenAt: new Date()
    });
    expect(r2.invoiceStatusAfter).toBe("completed");

    const [row] = await booted.deps.db
      .select({ paid_usd: invoices.paidUsd })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(row?.paid_usd).toBe("50.00");
  });

  it("overpayment in a single transfer flips to completed(extra='overpaid') with correct delta", async () => {
    const invoice = await createUsdInvoice(booted, apiKey, {
      amountUsd: "25.00",
      acceptedFamilies: ["evm"]
    });

    const result = await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0x" + "c1".repeat(32),
      logIndex: 0,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: invoice.receiveAddress,
      token: "USDC",
      amountRaw: "40000000" as AmountRaw, // 40 USDC, 15 over target
      blockNumber: 100,
      confirmations: 20,
      seenAt: new Date()
    });
    expect(result.invoiceStatusAfter).toBe("completed");

    const [row] = await booted.deps.db
      .select({
        status: invoices.status,
        extra_status: invoices.extraStatus,
        paid_usd: invoices.paidUsd,
        overpaid_usd: invoices.overpaidUsd,
        confirmed_at: invoices.confirmedAt
      })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(row?.status).toBe("completed");
    expect(row?.extra_status).toBe("overpaid");
    expect(row?.paid_usd).toBe("40.00");
    expect(row?.overpaid_usd).toBe("15.00");
    expect(row?.confirmed_at).not.toBeNull();
  });

  it("still-detected (below threshold) transfers DON'T move paid_usd — only confirmed ones do", async () => {
    const invoice = await createUsdInvoice(booted, apiKey, {
      amountUsd: "30.00",
      acceptedFamilies: ["evm"]
    });

    // confirmations=0 → tx lands in 'detected' state. paid_usd stays at 0.
    const result = await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0x" + "d1".repeat(32),
      logIndex: 0,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: invoice.receiveAddress,
      token: "USDC",
      amountRaw: "30000000" as AmountRaw,
      blockNumber: 100,
      confirmations: 0,
      seenAt: new Date()
    });
    // Invoice stays on 'pending' since nothing is confirmed yet (USD path
    // only counts confirmed txs toward paid_usd; unconfirmed contributes 0).
    expect(result.invoiceStatusAfter).toBe("pending");

    const [row] = await booted.deps.db
      .select({ status: invoices.status, paid_usd: invoices.paidUsd })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(row?.status).toBe("pending");
    expect(row?.paid_usd).toBe("0");
  });
});

describe("USD-path ingest — mix-and-match across chains and families", () => {
  let booted: BootedTestApp;
  let apiKey: string;

  beforeEach(async () => {
    booted = await bootWithAllFamilies();
    apiKey = booted.apiKeys[MERCHANT_ID]!;
  });

  afterEach(async () => {
    await booted.close();
  });

  it("aggregates USDC on ETH + USDT on Polygon + USDC on BSC into one invoice", async () => {
    const invoice = await createUsdInvoice(booted, apiKey, {
      amountUsd: "90.00",
      acceptedFamilies: ["evm"]
    });
    const evmAddress = invoice.receiveAddresses.find((r) => r.family === "evm")!.address;

    // 30 USDC on Ethereum
    await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0x" + "11".repeat(32),
      logIndex: 0,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: evmAddress,
      token: "USDC",
      amountRaw: "30000000" as AmountRaw,
      blockNumber: 100,
      confirmations: 20,
      seenAt: new Date()
    });

    // 30 USDT on Polygon (same EVM address, different chain)
    await ingestDetectedTransfer(booted.deps, {
      chainId: 137,
      txHash: "0x" + "22".repeat(32),
      logIndex: 0,
      fromAddress: "0x2222222222222222222222222222222222222222",
      toAddress: evmAddress,
      token: "USDT",
      amountRaw: "30000000" as AmountRaw,
      blockNumber: 200,
      confirmations: 300, // Polygon threshold is 256
      seenAt: new Date()
    });

    // 30 USDC on BSC (closes the invoice). BSC USDC is 18 decimals, not 6.
    const last = await ingestDetectedTransfer(booted.deps, {
      chainId: 56,
      txHash: "0x" + "33".repeat(32),
      logIndex: 0,
      fromAddress: "0x3333333333333333333333333333333333333333",
      toAddress: evmAddress,
      token: "USDC",
      amountRaw: "30000000000000000000" as AmountRaw,
      blockNumber: 300,
      confirmations: 25,
      seenAt: new Date()
    });
    expect(last.invoiceStatusAfter).toBe("completed");

    const [row] = await booted.deps.db
      .select({ status: invoices.status, paid_usd: invoices.paidUsd })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(row?.status).toBe("completed");
    expect(row?.paid_usd).toBe("90.00");
  });

  it("values a native-ETH transfer at the pinned rate (2500) and adds to the USD total", async () => {
    const invoice = await createUsdInvoice(booted, apiKey, {
      amountUsd: "50.00",
      acceptedFamilies: ["evm"]
    });
    const evmAddress = invoice.receiveAddresses.find((r) => r.family === "evm")!.address;

    // 0.02 ETH = 50 USD at pinned 2500. 18 decimals → 0.02 * 1e18 = 2e16.
    const result = await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0x" + "44".repeat(32),
      logIndex: 0,
      fromAddress: "0x4444444444444444444444444444444444444444",
      toAddress: evmAddress,
      token: "ETH",
      amountRaw: "20000000000000000" as AmountRaw,
      blockNumber: 500,
      confirmations: 20,
      seenAt: new Date()
    });
    expect(result.invoiceStatusAfter).toBe("completed");

    const [txRow] = await booted.deps.db
      .select({ amount_usd: transactions.amountUsd, usd_rate: transactions.usdRate })
      .from(transactions)
      .where(eq(transactions.txHash, "0x" + "44".repeat(32)))
      .limit(1);
    expect(txRow?.amount_usd).toBe("50.00");
    expect(txRow?.usd_rate).toBe("2500");
  });

  it("unpriced tokens are recorded as audit rows but don't contribute to paid_usd", async () => {
    const invoice = await createUsdInvoice(booted, apiKey, {
      amountUsd: "40.00",
      acceptedFamilies: ["evm"]
    });
    const evmAddress = invoice.receiveAddresses.find((r) => r.family === "evm")!.address;

    // MYSTERY is not in the registry and not a pegged symbol — static oracle
    // returns undefined for it, so usdValueFor yields null. The tx still writes.
    await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0x" + "55".repeat(32),
      logIndex: 0,
      fromAddress: "0x5555555555555555555555555555555555555555",
      toAddress: evmAddress,
      token: "MYSTERY",
      amountRaw: "100" as AmountRaw,
      blockNumber: 600,
      confirmations: 20,
      seenAt: new Date()
    });

    const [txRow] = await booted.deps.db
      .select({ amount_usd: transactions.amountUsd })
      .from(transactions)
      .where(eq(transactions.txHash, "0x" + "55".repeat(32)))
      .limit(1);
    expect(txRow?.amount_usd).toBeNull();

    const [invoiceRow] = await booted.deps.db
      .select({ paid_usd: invoices.paidUsd, status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(invoiceRow?.paid_usd).toBe("0");
    expect(invoiceRow?.status).toBe("pending");
  });
});

describe("USD-path ingest — invoice.payment_confirmed webhook event", () => {
  let booted: BootedTestApp;
  let apiKey: string;

  beforeEach(async () => {
    booted = await bootWithAllFamilies();
    apiKey = booted.apiKeys[MERCHANT_ID]!;
  });

  afterEach(async () => {
    await booted.close();
  });

  it("fires invoice.payment_confirmed on every confirmed contributing transfer", async () => {
    const invoice = await createUsdInvoice(booted, apiKey, {
      amountUsd: "60.00",
      acceptedFamilies: ["evm"]
    });

    const received: Array<{
      txHash: string;
      token: string;
      amountUsd: string | null;
      status: string;
    }> = [];
    booted.deps.events.subscribe("invoice.payment_confirmed", (e) => {
      received.push({
        txHash: e.payment.txHash,
        token: e.payment.token,
        amountUsd: e.payment.amountUsd,
        status: e.invoice.status
      });
    });

    await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0xpay1",
      logIndex: 0,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: invoice.receiveAddress,
      token: "USDC",
      amountRaw: "20000000" as AmountRaw,
      blockNumber: 100,
      confirmations: 20,
      seenAt: new Date()
    });

    await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0xpay2",
      logIndex: 0,
      fromAddress: "0x2222222222222222222222222222222222222222",
      toAddress: invoice.receiveAddress,
      token: "USDC",
      amountRaw: "40000000" as AmountRaw,
      blockNumber: 101,
      confirmations: 20,
      seenAt: new Date()
    });

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({
      txHash: "0xpay1",
      token: "USDC",
      amountUsd: "20.00",
      // First payment is below threshold — invoice is still processing
      // (with extra_status='partial' on the snapshot, not asserted here).
      status: "processing"
    });
    expect(received[1]).toMatchObject({
      txHash: "0xpay2",
      token: "USDC",
      amountUsd: "40.00",
      status: "completed"
    });
  });

  it("does NOT fire invoice.payment_confirmed for still-detected (below-threshold) transfers", async () => {
    const invoice = await createUsdInvoice(booted, apiKey, {
      amountUsd: "25.00",
      acceptedFamilies: ["evm"]
    });

    const received: string[] = [];
    booted.deps.events.subscribe("invoice.payment_confirmed", (e) => { received.push(e.payment.txHash); });

    await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0xunconfirmed",
      logIndex: 0,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: invoice.receiveAddress,
      token: "USDC",
      amountRaw: "25000000" as AmountRaw,
      blockNumber: 100,
      confirmations: 0,
      seenAt: new Date()
    });
    expect(received).toHaveLength(0);
  });
});

describe("rate-window refresh on detection past expiry", () => {
  it("refreshes the invoice's rates when ingest fires past rate_window_expires_at", async () => {
    // Advancing clock: first use `now` at t0 (invoice creation + initial rates),
    // then flip to t1 past the 10-minute window to force a refresh.
    const t0 = new Date("2026-04-17T10:00:00Z");
    let currentNow = t0;
    const clock = { now: () => currentNow };

    const booted = await bootWithAllFamilies({ clock });
    try {
      const apiKey = booted.apiKeys[MERCHANT_ID]!;
      const invoice = await createUsdInvoice(booted, apiKey, {
        amountUsd: "100.00",
        acceptedFamilies: ["evm"]
      });

      const [before] = await booted.deps.db
        .select({
          rate_window_expires_at: invoices.rateWindowExpiresAt,
          rates_json: invoices.ratesJson
        })
        .from(invoices)
        .where(eq(invoices.id, invoice.id))
        .limit(1);
      expect(before?.rate_window_expires_at).toBe(t0.getTime() + RATE_WINDOW_DURATION_MS);

      // Jump 11 minutes past creation — safely past the 10-minute window.
      currentNow = new Date(t0.getTime() + 11 * 60 * 1000);

      await ingestDetectedTransfer(booted.deps, {
        chainId: 1,
        txHash: "0xrefresh1",
        logIndex: 0,
        fromAddress: "0x1111111111111111111111111111111111111111",
        toAddress: invoice.receiveAddress,
        token: "USDC",
        amountRaw: "50000000" as AmountRaw,
        blockNumber: 100,
        confirmations: 20,
        seenAt: currentNow
      });

      const [after] = await booted.deps.db
        .select({ rate_window_expires_at: invoices.rateWindowExpiresAt })
        .from(invoices)
        .where(eq(invoices.id, invoice.id))
        .limit(1);
      // New window starts at the ingest clock, not t0.
      expect(after?.rate_window_expires_at).toBe(currentNow.getTime() + RATE_WINDOW_DURATION_MS);
      expect(after?.rate_window_expires_at ?? 0).toBeGreaterThan(before?.rate_window_expires_at ?? 0);
    } finally {
      await booted.close();
    }
  });

  it("does NOT refresh when ingest fires within the window", async () => {
    const t0 = new Date("2026-04-17T10:00:00Z");
    let currentNow = t0;
    const clock = { now: () => currentNow };

    const booted = await bootWithAllFamilies({ clock });
    try {
      const apiKey = booted.apiKeys[MERCHANT_ID]!;
      const invoice = await createUsdInvoice(booted, apiKey, {
        amountUsd: "100.00",
        acceptedFamilies: ["evm"]
      });

      const [before] = await booted.deps.db
        .select({ rate_window_expires_at: invoices.rateWindowExpiresAt })
        .from(invoices)
        .where(eq(invoices.id, invoice.id))
        .limit(1);

      // 2 minutes in — well within the 10-minute window.
      currentNow = new Date(t0.getTime() + 2 * 60 * 1000);

      await ingestDetectedTransfer(booted.deps, {
        chainId: 1,
        txHash: "0xnorefresh",
        logIndex: 0,
        fromAddress: "0x1111111111111111111111111111111111111111",
        toAddress: invoice.receiveAddress,
        token: "USDC",
        amountRaw: "10000000" as AmountRaw,
        blockNumber: 100,
        confirmations: 20,
        seenAt: currentNow
      });

      const [after] = await booted.deps.db
        .select({ rate_window_expires_at: invoices.rateWindowExpiresAt })
        .from(invoices)
        .where(eq(invoices.id, invoice.id))
        .limit(1);
      expect(after?.rate_window_expires_at).toBe(before?.rate_window_expires_at);
    } finally {
      await booted.close();
    }
  });
});
