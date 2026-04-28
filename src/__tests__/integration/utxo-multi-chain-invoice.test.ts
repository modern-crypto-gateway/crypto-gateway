import { describe, expect, it, afterEach } from "vitest";
import { bootTestApp, createInvoiceViaApi, type BootedTestApp } from "../helpers/boot.js";
import {
  bitcoinChainAdapter,
  litecoinChainAdapter,
  bitcoinTestnetChainAdapter,
  litecoinTestnetChainAdapter
} from "../../adapters/chains/utxo/utxo-chain.adapter.js";

// Regression test for the family-vs-chainId adapter-lookup bug.
//
// Pre-fix behavior: invoice.service.ts picked the family adapter via
//   deps.chains.find((c) => c.family === family)
// which returned the FIRST UTXO adapter (Bitcoin, by registration order)
// for every UTXO chain. A Litecoin invoice (chainId 801) got a `bc1q…`
// (Bitcoin mainnet bech32) address — wrong-network funds bridge.
//
// Fix: when allocating for the primary family, use the chainId-specific
// adapter resolved via findChainAdapter(deps, chainId). Each UTXO adapter
// owns ONE chainId in its `supportedChainIds`, so this disambiguates.

describe("UTXO invoice creation — per-chain adapter routing", () => {
  let booted: BootedTestApp;

  afterEach(async () => {
    await booted.close();
  });

  it("Litecoin invoice (chainId 801) yields an ltc1q… address (not bc1q…)", async () => {
    booted = await bootTestApp({
      // Register BTC FIRST so the buggy `find by family` would pick it for
      // every UTXO chain. The fix uses chainId routing instead.
      chains: [bitcoinChainAdapter(), litecoinChainAdapter()]
    });
    const invoice = await createInvoiceViaApi(booted, {
      chainId: 801,
      token: "LTC",
      amountRaw: "100000"
    });
    expect(invoice.receiveAddress.startsWith("ltc1q")).toBe(true);
    expect(invoice.receiveAddress.startsWith("bc1q")).toBe(false);
  });

  it("Bitcoin invoice (chainId 800) yields a bc1q… address", async () => {
    booted = await bootTestApp({
      chains: [bitcoinChainAdapter(), litecoinChainAdapter()]
    });
    const invoice = await createInvoiceViaApi(booted, {
      chainId: 800,
      token: "BTC",
      amountRaw: "100000"
    });
    expect(invoice.receiveAddress.startsWith("bc1q")).toBe(true);
  });

  it("Bitcoin testnet invoice (chainId 802) yields a tb1q… address", async () => {
    booted = await bootTestApp({
      chains: [
        bitcoinChainAdapter(),
        litecoinChainAdapter(),
        bitcoinTestnetChainAdapter()
      ]
    });
    const invoice = await createInvoiceViaApi(booted, {
      chainId: 802,
      token: "BTC",
      amountRaw: "10000"
    });
    expect(invoice.receiveAddress.startsWith("tb1q")).toBe(true);
  });

  it("Litecoin testnet invoice (chainId 803) yields a tltc1q… address", async () => {
    booted = await bootTestApp({
      chains: [
        bitcoinChainAdapter(),
        litecoinChainAdapter(),
        bitcoinTestnetChainAdapter(),
        litecoinTestnetChainAdapter()
      ]
    });
    const invoice = await createInvoiceViaApi(booted, {
      chainId: 803,
      token: "LTC",
      amountRaw: "10000"
    });
    expect(invoice.receiveAddress.startsWith("tltc1q")).toBe(true);
  });

  it("USD-pegged UTXO invoice snapshots BTC + LTC rates (rate-window includes utxo natives)", async () => {
    // Pre-fix: rate-window.ts's `familyForChainId` had a `chainId > 0 → "evm"`
    // catch-all that swallowed UTXO chainIds (800-803). USD-pegged UTXO
    // invoices booted with `rates: {}` empty, and detected payments arrived
    // with `usd_rate=null` so the invoice never credited toward its USD target.
    booted = await bootTestApp({
      chains: [bitcoinChainAdapter(), litecoinChainAdapter()]
    });
    const merchantId = "00000000-0000-0000-0000-000000000001";
    const apiKey = booted.apiKeys[merchantId]!;
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          chainId: 801,
          token: "LTC",
          amountUsd: "10"
        })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invoice: { rates: Record<string, string>; amountUsd: string } };
    expect(body.invoice.amountUsd).toBe("10");
    // The rate window MUST be populated for at least the invoice's primary
    // token (LTC). Pre-fix this map was `{}` because tokensForFamilies returned
    // no symbols for `["utxo"]`.
    expect(body.invoice.rates["LTC"]).toBeDefined();
    expect(Number(body.invoice.rates["LTC"])).toBeGreaterThan(0);
  });

  it("invoice_receive_addresses.address_index is populated per-row so multi-family UTXO non-primary signing recovers the right key", async () => {
    // Pre-fix: detection ingest read `invoices.address_index` (the legacy
    // denormalized primary-family-only column) and stamped it on the utxos
    // row. For a universal/USD-pegged invoice with EVM primary + UTXO non-
    // primary, the BTC receive address has a UTXO-counter index (e.g. 0)
    // but `invoices.address_index` carries the EVM pool index (e.g. 17 or
    // similar). Signing then derived at index 17 over BIP44 coin_type=0
    // and produced an address whose hash160 didn't match the input's
    // scriptPubkey — the broadcast aborted with "signing-key/scriptPubkey
    // mismatch".
    //
    // Fix: persist addressIndex on `invoice_receive_addresses` and read
    // from there at ingest. Single-family invoices keep working unchanged
    // (per-row value matches the legacy column anyway).
    booted = await bootTestApp({
      chains: [bitcoinChainAdapter(), litecoinChainAdapter()]
    });
    // Mint two single-family UTXO invoices to bump each chain's counter.
    await createInvoiceViaApi(booted, { chainId: 800, token: "BTC", amountRaw: "1" });
    await createInvoiceViaApi(booted, { chainId: 800, token: "BTC", amountRaw: "1" });
    await createInvoiceViaApi(booted, { chainId: 801, token: "LTC", amountRaw: "1" });
    // Now create one more on each — these should be at indices 2 and 1
    // respectively, and the per-row `address_index` must match.
    const btc = await createInvoiceViaApi(booted, { chainId: 800, token: "BTC", amountRaw: "1" });
    const ltc = await createInvoiceViaApi(booted, { chainId: 801, token: "LTC", amountRaw: "1" });
    expect(btc["addressIndex"]).toBe(2);
    expect(ltc["addressIndex"]).toBe(1);

    // Read the rx rows directly and assert per-row addressIndex matches the
    // invoice's primary-family value (single-family case — same row).
    const { eq } = await import("drizzle-orm");
    const { invoiceReceiveAddresses } = await import("../../db/schema.js");
    const btcRx = await booted.deps.db
      .select()
      .from(invoiceReceiveAddresses)
      .where(eq(invoiceReceiveAddresses.invoiceId, btc.id));
    const ltcRx = await booted.deps.db
      .select()
      .from(invoiceReceiveAddresses)
      .where(eq(invoiceReceiveAddresses.invoiceId, ltc.id));
    expect(btcRx).toHaveLength(1);
    expect(btcRx[0]!.addressIndex).toBe(2);
    expect(ltcRx).toHaveLength(1);
    expect(ltcRx[0]!.addressIndex).toBe(1);
  });

  it("address-index counters increment INDEPENDENTLY per chain", async () => {
    // BTC invoice → index N for chain 800; LTC invoice → index 0 for chain
    // 801 (separate counter row). Pre-fix the LTC invoice would have used
    // the BTC adapter and bumped the BTC counter — both invoices would
    // share a counter and have wrong-HRP addresses.
    booted = await bootTestApp({
      chains: [bitcoinChainAdapter(), litecoinChainAdapter()]
    });
    const btc1 = await createInvoiceViaApi(booted, { chainId: 800, token: "BTC", amountRaw: "1" });
    const ltc1 = await createInvoiceViaApi(booted, { chainId: 801, token: "LTC", amountRaw: "1" });
    const btc2 = await createInvoiceViaApi(booted, { chainId: 800, token: "BTC", amountRaw: "1" });
    const ltc2 = await createInvoiceViaApi(booted, { chainId: 801, token: "LTC", amountRaw: "1" });

    // Each chain gets index 0 then 1; BTC's and LTC's counters are independent.
    expect(btc1["addressIndex"]).toBe(0);
    expect(btc2["addressIndex"]).toBe(1);
    expect(ltc1["addressIndex"]).toBe(0);
    expect(ltc2["addressIndex"]).toBe(1);

    // And HRPs are correct for each chain.
    expect(btc1.receiveAddress.startsWith("bc1q")).toBe(true);
    expect(btc2.receiveAddress.startsWith("bc1q")).toBe(true);
    expect(ltc1.receiveAddress.startsWith("ltc1q")).toBe(true);
    expect(ltc2.receiveAddress.startsWith("ltc1q")).toBe(true);
  });
});
