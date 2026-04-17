import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { custom } from "viem";
import { evmChainAdapter } from "../../adapters/chains/evm/evm-chain.adapter.js";
import { solanaChainAdapter, SOLANA_MAINNET_CHAIN_ID } from "../../adapters/chains/solana/solana-chain.adapter.js";
import { tronChainAdapter, TRON_MAINNET_CHAIN_ID } from "../../adapters/chains/tron/tron-chain.adapter.js";
import { bootTestApp, createInvoiceViaApi, type BootedTestApp } from "../helpers/boot.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

const noopTransport = custom({
  async request() {
    throw new Error("EVM adapter touched RPC unexpectedly");
  }
});

describe("GET /checkout/:id", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp();
  });

  afterEach(async () => {
    await booted.close();
  });

  it("returns a public, merchant-free snapshot of the invoice", async () => {
    const invoice = await createInvoiceViaApi(booted, { amountRaw: "1500000" });

    const res = await booted.app.fetch(new Request(`http://test.local/checkout/${invoice.id}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invoice: Record<string, unknown> };
    expect(body.invoice).toMatchObject({
      id: invoice.id,
      status: "created",
      chainId: 999,
      token: "DEV",
      requiredAmountRaw: "1500000",
      receivedAmountRaw: "0"
    });
    // Merchant identity and internal bookkeeping must NOT appear in the public view.
    expect(body.invoice["merchantId"]).toBeUndefined();
    expect(body.invoice["updatedAt"]).toBeUndefined();
    expect(body.invoice["metadata"]).toBeUndefined();
    expect(body.invoice["addressIndex"]).toBeUndefined();
  });

  it("is unauthenticated: no API key required", async () => {
    const invoice = await createInvoiceViaApi(booted, { amountRaw: "1" });
    // Deliberately no Authorization header.
    const res = await booted.app.fetch(new Request(`http://test.local/checkout/${invoice.id}`));
    expect(res.status).toBe(200);
  });

  it("returns 404 for an unknown invoice id", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/checkout/00000000-0000-0000-0000-ffffffffffff")
    );
    expect(res.status).toBe(404);
  });

  it("leaves payableTokens null for legacy (amountRaw) invoices", async () => {
    const invoice = await createInvoiceViaApi(booted, { amountRaw: "1500000" });
    const res = await booted.app.fetch(new Request(`http://test.local/checkout/${invoice.id}`));
    const body = (await res.json()) as { invoice: { payableTokens: unknown; amountUsd: unknown } };
    expect(body.invoice.amountUsd).toBeNull();
    expect(body.invoice.payableTokens).toBeNull();
  });
});

describe("GET /checkout/:id — USD-path payableTokens", () => {
  let booted: BootedTestApp;
  let apiKey: string;

  beforeEach(async () => {
    booted = await bootTestApp({
      chains: [
        evmChainAdapter({
          chainIds: [1, 137],
          transports: { 1: noopTransport, 137: noopTransport }
        }),
        tronChainAdapter({
          chainIds: [TRON_MAINNET_CHAIN_ID],
          trongrid: { [TRON_MAINNET_CHAIN_ID]: { baseUrl: "https://unused.test" } }
        }),
        solanaChainAdapter({
          chainIds: [SOLANA_MAINNET_CHAIN_ID],
          rpc: { [SOLANA_MAINNET_CHAIN_ID]: { url: "http://unused.test/rpc" } }
        })
      ],
      poolInitialSize: 3
    });
    apiKey = booted.apiKeys[MERCHANT_ID]!;
  });

  afterEach(async () => {
    await booted.close();
  });

  async function createUsdInvoice(amountUsd: string, acceptedFamilies: string[]): Promise<string> {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ chainId: 1, token: "USDC", amountUsd, acceptedFamilies })
      })
    );
    if (res.status !== 201) throw new Error(`createUsdInvoice ${res.status}: ${await res.text()}`);
    const { invoice } = (await res.json()) as { invoice: { id: string } };
    return invoice.id;
  }

  it("renders a payable entry per (chainId, token) pair with correct amounts", async () => {
    const id = await createUsdInvoice("100.00", ["evm", "tron", "solana"]);
    const res = await booted.app.fetch(new Request(`http://test.local/checkout/${id}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invoice: {
        amountUsd: string;
        payableTokens: Array<{
          family: string;
          chainId: number;
          token: string;
          decimals: number;
          amountRawMinimum: string;
          amountDisplay: string;
          rate: string;
          address: string;
        }>;
      };
    };
    expect(body.invoice.amountUsd).toBe("100.00");
    const pts = body.invoice.payableTokens;
    expect(pts.length).toBeGreaterThan(0);

    // USDC on Ethereum at rate 1 → 100 USDC at 6 decimals = 100_000_000.
    const usdcEth = pts.find((p) => p.chainId === 1 && p.token === "USDC");
    expect(usdcEth).toBeDefined();
    expect(usdcEth!.decimals).toBe(6);
    expect(usdcEth!.amountRawMinimum).toBe("100000000");
    expect(usdcEth!.amountDisplay).toBe("100");
    expect(usdcEth!.rate).toBe("1");
    expect(usdcEth!.family).toBe("evm");

    // ETH on Ethereum at rate 2500 → 0.04 ETH at 18 decimals = 40000000000000000.
    const ethEth = pts.find((p) => p.chainId === 1 && p.token === "ETH");
    expect(ethEth).toBeDefined();
    expect(ethEth!.decimals).toBe(18);
    expect(ethEth!.amountRawMinimum).toBe("40000000000000000");
    expect(ethEth!.amountDisplay).toBe("0.04");
    expect(ethEth!.rate).toBe("2500");

    // USDT on Polygon (different chainId, same EVM address shared across
    // chains) — shows up as a distinct row with 6-decimals computation.
    const usdtPoly = pts.find((p) => p.chainId === 137 && p.token === "USDT");
    expect(usdtPoly).toBeDefined();
    expect(usdtPoly!.amountRawMinimum).toBe("100000000");
    // EVM address is the same across chains in the family.
    expect(usdtPoly!.address).toBe(usdcEth!.address);

    // Tron + Solana entries present because those families were accepted.
    const trxTron = pts.find((p) => p.family === "tron" && p.token === "TRX");
    expect(trxTron).toBeDefined();
    // 100 USD / 0.25 = 400 TRX at 6 decimals = 400_000_000.
    expect(trxTron!.amountRawMinimum).toBe("400000000");

    const solSol = pts.find((p) => p.family === "solana" && p.token === "SOL");
    expect(solSol).toBeDefined();
    // 100 USD / 150 = 0.666... SOL — ceil at 9 decimals = 666666667.
    expect(solSol!.amountRawMinimum).toBe("666666667");
  });

  it("omits chains/tokens the gateway doesn't serve", async () => {
    // Same invoice but boot with ONLY EVM chainId=1. No chainId=137, no tron,
    // no solana adapters. payableTokens should only list chainId=1 entries
    // for the evm family.
    const smaller = await bootTestApp({
      chains: [evmChainAdapter({ chainIds: [1], transports: { 1: noopTransport } })],
      poolInitialSize: 2
    });
    try {
      const keyForBoot = smaller.apiKeys[MERCHANT_ID]!;
      const res = await smaller.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${keyForBoot}` },
          body: JSON.stringify({
            chainId: 1,
            token: "USDC",
            amountUsd: "50.00",
            acceptedFamilies: ["evm"]
          })
        })
      );
      const { invoice } = (await res.json()) as { invoice: { id: string } };
      const checkoutRes = await smaller.app.fetch(new Request(`http://test.local/checkout/${invoice.id}`));
      const body = (await checkoutRes.json()) as {
        invoice: { payableTokens: Array<{ chainId: number; family: string }> };
      };
      const chainIds = new Set(body.invoice.payableTokens.map((p) => p.chainId));
      expect(chainIds).toEqual(new Set([1]));
      const families = new Set(body.invoice.payableTokens.map((p) => p.family));
      expect(families).toEqual(new Set(["evm"]));
    } finally {
      await smaller.close();
    }
  });
});
