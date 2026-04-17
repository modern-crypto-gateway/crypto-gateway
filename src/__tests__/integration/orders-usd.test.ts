import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { custom } from "viem";
import { invoices } from "../../db/schema.js";
import { evmChainAdapter } from "../../adapters/chains/evm/evm-chain.adapter.js";
import { solanaChainAdapter, SOLANA_MAINNET_CHAIN_ID } from "../../adapters/chains/solana/solana-chain.adapter.js";
import { tronChainAdapter, TRON_MAINNET_CHAIN_ID } from "../../adapters/chains/tron/tron-chain.adapter.js";
import { RATE_WINDOW_DURATION_MS } from "../../core/domain/rate-window.js";
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

async function bootWithAllFamilies(): Promise<BootedTestApp> {
  return bootTestApp({
    chains: [
      evmChainAdapter({ chainIds: [1], transports: { 1: noopTransport } }),
      tronChainAdapter({
        chainIds: [TRON_MAINNET_CHAIN_ID],
        trongrid: { [TRON_MAINNET_CHAIN_ID]: { baseUrl: "https://unused.test" } }
      }),
      solanaChainAdapter({
        chainIds: [SOLANA_MAINNET_CHAIN_ID],
        rpc: { [SOLANA_MAINNET_CHAIN_ID]: { url: "http://unused.test/rpc" } }
      })
    ],
    poolInitialSize: 5
  });
}

describe("POST /api/v1/invoices — USD-pegged path (A2.a)", () => {
  let booted: BootedTestApp;
  let apiKey: string;

  beforeEach(async () => {
    booted = await bootWithAllFamilies();
    apiKey = booted.apiKeys[MERCHANT_ID]!;
  });

  afterEach(async () => {
    await booted.close();
  });

  it("creates a USD-pegged invoice, snapshots current rates, and pins a 10-minute window", async () => {
    const before = Date.now();
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({
          chainId: 1,
          token: "USDC",
          amountUsd: "100.00",
          acceptedFamilies: ["evm", "tron", "solana"]
        })
      })
    );
    const after = Date.now();
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invoice: {
        amountUsd: string;
        paidUsd: string;
        overpaidUsd: string;
        rateWindowExpiresAt: string | null;
        rates: Record<string, string> | null;
        requiredAmountRaw: string;
      };
    };
    expect(body.invoice.amountUsd).toBe("100.00");
    expect(body.invoice.paidUsd).toBe("0");
    expect(body.invoice.overpaidUsd).toBe("0");
    expect(body.invoice.requiredAmountRaw).toBe("0"); // meaningless for USD-path
    expect(body.invoice.rateWindowExpiresAt).toBeTruthy();

    const expiresAt = new Date(body.invoice.rateWindowExpiresAt!).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + RATE_WINDOW_DURATION_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + RATE_WINDOW_DURATION_MS);

    // Snapshot should include stables (pegged 1:1) for every family + native tokens.
    expect(body.invoice.rates).toBeTruthy();
    const rates = body.invoice.rates!;
    expect(rates["USDC"]).toBe("1");
    expect(rates["USDT"]).toBe("1");
    // EVM natives from DEFAULT_NATIVE_RATES in the static oracle.
    expect(rates["ETH"]).toBe("2500");
    expect(rates["BNB"]).toBe("600");
    // Solana + Tron natives included because their families are accepted.
    expect(rates["SOL"]).toBe("150");
    expect(rates["TRX"]).toBe("0.25");
  });

  it("persists amount_usd, paid_usd, rates_json, rate_window_expires_at on the row", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({
          chainId: 1,
          token: "USDC",
          amountUsd: "49.99",
          acceptedFamilies: ["evm"]
        })
      })
    );
    const { invoice } = (await res.json()) as { invoice: { id: string } };
    const [row] = await booted.deps.db
      .select({
        amount_usd: invoices.amountUsd,
        paid_usd: invoices.paidUsd,
        overpaid_usd: invoices.overpaidUsd,
        rate_window_expires_at: invoices.rateWindowExpiresAt,
        rates_json: invoices.ratesJson
      })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(row?.amount_usd).toBe("49.99");
    expect(row?.paid_usd).toBe("0");
    expect(row?.overpaid_usd).toBe("0");
    expect(row?.rate_window_expires_at).toBeGreaterThan(Date.now());
    const parsed = JSON.parse(row!.rates_json!) as Record<string, string>;
    expect(parsed["USDC"]).toBe("1");
    expect(parsed["ETH"]).toBe("2500");
  });

  it("rejects when more than one pricing mode is supplied", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({
          chainId: 1,
          token: "USDC",
          amountUsd: "100.00",
          amountRaw: "100000000",
          acceptedFamilies: ["evm"]
        })
      })
    );
    expect(res.status).toBe(400);
  });

  it("legacy amountRaw path keeps amount_usd NULL and rates_json NULL", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({
          chainId: 1,
          token: "USDC",
          amountRaw: "100000000"
        })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invoice: { amountUsd: string | null; rates: unknown; rateWindowExpiresAt: unknown };
    };
    expect(body.invoice.amountUsd).toBeNull();
    expect(body.invoice.rates).toBeNull();
    expect(body.invoice.rateWindowExpiresAt).toBeNull();
  });

  it("legacy fiat path sets quotedRate and keeps amount_usd NULL", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({
          chainId: 1,
          token: "USDC",
          fiatAmount: "25.00",
          fiatCurrency: "USD"
        })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invoice: { amountUsd: string | null; quotedRate: string | null; requiredAmountRaw: string };
    };
    expect(body.invoice.amountUsd).toBeNull();
    expect(body.invoice.quotedRate).toBe("1");
    // 25 USDC at 6 decimals = 25_000_000.
    expect(body.invoice.requiredAmountRaw).toBe("25000000");
  });
});

describe("staticPegPriceOracle — USD rates for A2", () => {
  let booted: BootedTestApp;
  beforeEach(async () => {
    booted = await bootTestApp({ skipPoolInit: true });
  });
  afterEach(async () => {
    await booted.close();
  });

  it("returns 1 for registered stables (USDC/USDT/DAI)", async () => {
    const rates = await booted.deps.priceOracle.getUsdRates(["USDC", "USDT", "DAI"]);
    expect(rates).toEqual({ USDC: "1", USDT: "1", DAI: "1" });
  });

  it("returns hardcoded dev rates for volatile natives (ETH, BNB, SOL, …)", async () => {
    const rates = await booted.deps.priceOracle.getUsdRates(["ETH", "BNB", "SOL", "TRX", "AVAX", "MATIC"]);
    expect(rates["ETH"]).toBe("2500");
    expect(rates["BNB"]).toBe("600");
    expect(rates["SOL"]).toBe("150");
    expect(rates["TRX"]).toBe("0.25");
    expect(rates["AVAX"]).toBe("30");
    expect(rates["MATIC"]).toBe("0.60");
  });

  it("omits tokens the oracle doesn't recognize (caller treats as 'not priced')", async () => {
    const rates = await booted.deps.priceOracle.getUsdRates(["USDC", "MYSTERY"]);
    expect(rates["USDC"]).toBe("1");
    expect(rates["MYSTERY"]).toBeUndefined();
  });
});
