import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { custom } from "viem";
import { evmChainAdapter } from "../../adapters/chains/evm/evm-chain.adapter.js";
import { solanaChainAdapter, SOLANA_MAINNET_CHAIN_ID } from "../../adapters/chains/solana/solana-chain.adapter.js";
import { tronChainAdapter, TRON_MAINNET_CHAIN_ID } from "../../adapters/chains/tron/tron-chain.adapter.js";
import { ingestDetectedTransfer } from "../../core/domain/payment.service.js";
import type { AmountRaw } from "../../core/types/money.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

// A viem transport that throws on any RPC call — the EVM adapter builds
// addresses locally (HD derivation), so no network is needed in these tests.
const noopTransport = custom({
  async request() {
    throw new Error("EVM adapter touched RPC unexpectedly");
  }
});

function authHeader(apiKey: string): HeadersInit {
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
}

async function bootMultiFamily(): Promise<BootedTestApp> {
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

describe("POST /api/v1/invoices — multi-family acceptance", () => {
  let booted: BootedTestApp;
  let apiKey: string;

  beforeEach(async () => {
    booted = await bootMultiFamily();
    apiKey = booted.apiKeys[MERCHANT_ID]!;
  });

  afterEach(async () => {
    await booted.close();
  });

  it("allocates one receive address per accepted family and returns them all", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({
          chainId: 1,
          token: "USDT",
          amountRaw: "1000000",
          acceptedFamilies: ["evm", "tron", "solana"]
        })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invoice: {
        acceptedFamilies: string[];
        receiveAddresses: Array<{ family: string; address: string }>;
        chainId: number;
        receiveAddress: string;
      };
    };
    expect(body.invoice.acceptedFamilies.sort()).toEqual(["evm", "solana", "tron"]);
    expect(body.invoice.receiveAddresses).toHaveLength(3);
    const families = body.invoice.receiveAddresses.map((r) => r.family).sort();
    expect(families).toEqual(["evm", "solana", "tron"]);
    // Primary denormalized fields reflect the first family (chainId=1 → evm).
    expect(body.invoice.chainId).toBe(1);
    // The EVM entry's address matches the denormalized primary.
    const evmEntry = body.invoice.receiveAddresses.find((r) => r.family === "evm");
    expect(evmEntry?.address).toBe(body.invoice.receiveAddress);
  });

  it("defaults to single-family [familyOf(chainId)] when acceptedFamilies is omitted", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({ chainId: 1, token: "USDT", amountRaw: "1000000" })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invoice: { acceptedFamilies: string[]; receiveAddresses: Array<{ family: string }> };
    };
    expect(body.invoice.acceptedFamilies).toEqual(["evm"]);
    expect(body.invoice.receiveAddresses).toHaveLength(1);
    expect(body.invoice.receiveAddresses[0]?.family).toBe("evm");
  });

  it("rejects the token-family combo when the token isn't registered on any chain in the family", async () => {
    // Made-up token that passes TokenSymbol regex (uppercase/digits, <=16)
    // but isn't in the registry — triggers TOKEN_NOT_SUPPORTED at creation.
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({
          chainId: 1,
          token: "FAKE",
          amountRaw: "1000000",
          acceptedFamilies: ["evm"]
        })
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TOKEN_NOT_SUPPORTED");
  });

  it("persists one row per family in invoice_receive_addresses", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({
          chainId: 1,
          token: "USDT",
          amountRaw: "1000000",
          acceptedFamilies: ["evm", "tron"]
        })
      })
    );
    const body = (await res.json()) as { invoice: { id: string } };

    const rows = await booted.deps.db
      .prepare(
        "SELECT family, address FROM invoice_receive_addresses WHERE invoice_id = ? ORDER BY family ASC"
      )
      .bind(body.invoice.id)
      .all<{ family: string; address: string }>();
    expect(rows.results.map((r) => r.family)).toEqual(["evm", "tron"]);
  });

  it("returns the invoiceId's pool rows to 'available' on expire (release-on-terminal)", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({
          chainId: 1,
          token: "USDT",
          amountRaw: "1000000",
          acceptedFamilies: ["evm", "tron"]
        })
      })
    );
    const { invoice } = (await res.json()) as { invoice: { id: string } };
    // Expire the invoice → pool-release event handler flips both pool rows
    // back to 'available'.
    const expireRes = await booted.app.fetch(
      new Request(`http://test.local/api/v1/invoices/${invoice.id}/expire`, {
        method: "POST",
        headers: authHeader(apiKey)
      })
    );
    expect(expireRes.status).toBe(200);

    const allocated = await booted.deps.db
      .prepare("SELECT COUNT(*) AS cnt FROM address_pool WHERE allocated_to_invoice_id = ?")
      .bind(invoice.id)
      .first<{ cnt: number }>();
    expect(allocated?.cnt).toBe(0);
  });
});

describe("detection reconciliation — multi-family join lookup", () => {
  let booted: BootedTestApp;
  let apiKey: string;

  beforeEach(async () => {
    booted = await bootMultiFamily();
    apiKey = booted.apiKeys[MERCHANT_ID]!;
  });

  afterEach(async () => {
    await booted.close();
  });

  it("matches a transfer on any accepted family's chain back to the invoice", async () => {
    // Create an invoice accepting EVM + Tron. We'll then submit a synthetic
    // detected transfer on chainId=1 (EVM) to the EVM receive address and
    // verify it matches this specific invoice — even though the invoice's
    // primary chainId is also 1. The key is: the matcher resolves by
    // (family, address), not by the chainId directly.
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({
          chainId: 1,
          token: "USDT",
          amountRaw: "1000000",
          acceptedFamilies: ["evm", "tron"]
        })
      })
    );
    const { invoice } = (await res.json()) as {
      invoice: { id: string; receiveAddresses: Array<{ family: string; address: string }> };
    };
    const evmAddress = invoice.receiveAddresses.find((r) => r.family === "evm")!.address;

    const result = await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0x" + "ab".repeat(32),
      logIndex: 0,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: evmAddress,
      token: "USDT",
      amountRaw: "1000000" as AmountRaw,
      blockNumber: 1000,
      confirmations: 5,
      seenAt: new Date()
    });
    expect(result.inserted).toBe(true);
    expect(result.invoiceId).toBe(invoice.id);
  });

  it("cross-chain match: USDT on Arbitrum (42161) hits an invoice with primary chainId=1", async () => {
    // This is the headline feature — an EVM pool address is the same pubkey
    // on every EVM chain, so the invoice created for ETH mainnet can also be
    // paid on Arbitrum. Requires the Arbitrum EVM adapter to be in deps;
    // we wire one just for this test case.
    const boot = await bootTestApp({
      chains: [
        evmChainAdapter({
          chainIds: [1, 42161],
          transports: { 1: noopTransport, 42161: noopTransport }
        })
      ],
      poolInitialSize: 3
    });
    const keyForBoot = boot.apiKeys[MERCHANT_ID]!;
    try {
      const res = await boot.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: authHeader(keyForBoot),
          body: JSON.stringify({
            chainId: 1,
            token: "USDT",
            amountRaw: "1000000",
            acceptedFamilies: ["evm"]
          })
        })
      );
      const { invoice } = (await res.json()) as {
        invoice: { id: string; receiveAddress: string };
      };

      // Submit a detected transfer on chain 42161 to the same address — the
      // family-based matcher should hit this invoice.
      const ingest = await ingestDetectedTransfer(boot.deps, {
        chainId: 42161,
        txHash: "0x" + "cd".repeat(32),
        logIndex: 0,
        fromAddress: "0x2222222222222222222222222222222222222222",
        toAddress: invoice.receiveAddress,
        token: "USDT",
        amountRaw: "1000000" as AmountRaw,
        blockNumber: 5000,
        confirmations: 20,
        seenAt: new Date()
      });
      expect(ingest.inserted).toBe(true);
      expect(ingest.invoiceId).toBe(invoice.id);
    } finally {
      await boot.close();
    }
  });
});
