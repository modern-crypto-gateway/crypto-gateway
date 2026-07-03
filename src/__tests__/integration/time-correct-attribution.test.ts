import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApp } from "../helpers/boot.js";
import { ingestDetectedTransfer } from "../../core/domain/payment.service.js";
import { addressAllocations, invoiceReceiveAddresses, invoices, transactions } from "../../db/schema.js";
import type { AppDeps } from "../../core/app-deps.js";
import type { DetectedTransfer } from "../../core/types/transaction.js";

// Time-correct invoice attribution on the re-ingest path. The bug: a historical
// transfer to a REUSED pool address was credited to whatever invoice is active
// NOW, not the invoice that owned the address when the transfer happened.
// These tests seed the ownership-window history directly and drive
// ingestDetectedTransfer with source='reingest' so the matcher is exercised in
// isolation from the pool allocator.

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
// Fixed clock so window/transfer times and the 30-day staleness gate are
// deterministic. Realistic epoch (ms) so "now - T" reflects real durations.
const NOW = 1_750_000_000_000;
const ADDR = "0x00000000000000000000000000000000000000c0";

// Seed an invoice + its receive-address row + ONE ownership window on ADDR.
async function seedInvoiceWindow(
  deps: AppDeps,
  args: {
    id: string;
    status: "pending" | "processing" | "completed" | "expired" | "canceled";
    addressIndex: number;
    allocatedAt: number;
    releasedAt: number | null;
  }
): Promise<void> {
  await deps.db.insert(invoices).values({
    id: args.id,
    merchantId: MERCHANT_ID,
    status: args.status,
    extraStatus: null,
    chainId: 999,
    token: "DEV",
    receiveAddress: ADDR,
    addressIndex: args.addressIndex,
    requiredAmountRaw: "1000",
    receivedAmountRaw: "0",
    fiatAmount: null,
    fiatCurrency: null,
    quotedRate: null,
    externalId: null,
    metadataJson: null,
    acceptedFamilies: JSON.stringify(["evm"]),
    amountUsd: null,
    paidUsd: "0",
    overpaidUsd: "0",
    rateWindowExpiresAt: null,
    ratesJson: null,
    webhookUrl: null,
    webhookSecretCiphertext: null,
    paymentToleranceUnderBps: 0,
    paymentToleranceOverBps: 0,
    confirmationThreshold: 1,
    confirmationTiersJson: null,
    createdAt: args.allocatedAt,
    expiresAt: args.allocatedAt + 3_600_000,
    confirmedAt: null,
    updatedAt: args.allocatedAt
  });
  await deps.db.insert(invoiceReceiveAddresses).values({
    invoiceId: args.id,
    family: "evm",
    chainId: 999,
    address: ADDR,
    addressIndex: args.addressIndex,
    poolAddressId: null,
    createdAt: args.allocatedAt
  });
  await deps.db.insert(addressAllocations).values({
    id: globalThis.crypto.randomUUID(),
    family: "evm",
    address: ADDR,
    chainId: null,
    poolAddressId: null,
    invoiceId: args.id,
    allocatedAt: args.allocatedAt,
    releasedAt: args.releasedAt
  });
}

function transfer(txHash: string, onchainTime: Date | null, logIndex = 0): DetectedTransfer {
  return {
    chainId: 999,
    txHash,
    logIndex,
    fromAddress: "0x0000000000000000000000000000000000000001",
    toAddress: ADDR,
    token: "DEV",
    amountRaw: "1000",
    blockNumber: 100,
    confirmations: 5,
    seenAt: new Date(NOW),
    onchainTime
  };
}

async function ingestReingest(deps: AppDeps, t: DetectedTransfer) {
  return ingestDetectedTransfer(deps, t, { source: "reingest" });
}

async function attributedInvoiceId(deps: AppDeps, txHash: string): Promise<string | null | undefined> {
  const [row] = await deps.db
    .select({ invoiceId: transactions.invoiceId, status: transactions.status })
    .from(transactions)
    .where(eq(transactions.txHash, txHash))
    .limit(1);
  return row?.invoiceId;
}

describe("time-correct re-ingest attribution", () => {
  it("credits the invoice that OWNED the address at the transfer's time, not the current owner", async () => {
    const booted = await bootTestApp({ now: new Date(NOW) });
    try {
      // A owned ADDR in the past then expired; B reused it and is active now.
      await seedInvoiceWindow(booted.deps, {
        id: "11111111-1111-1111-1111-111111111111",
        status: "expired",
        addressIndex: 1,
        allocatedAt: NOW - 100_000,
        releasedAt: NOW - 50_000
      });
      await seedInvoiceWindow(booted.deps, {
        id: "22222222-2222-2222-2222-222222222222",
        status: "pending",
        addressIndex: 2,
        allocatedAt: NOW - 50_000,
        releasedAt: null
      });

      // Transfer's on-chain time is inside A's window — must credit A, even
      // though B is the currently-active owner of the same address.
      const res = await ingestReingest(booted.deps, transfer("0xinA", new Date(NOW - 75_000)));
      expect(res.inserted).toBe(true);
      expect(await attributedInvoiceId(booted.deps, "0xinA")).toBe("11111111-1111-1111-1111-111111111111");
    } finally {
      await booted.close();
    }
  });

  it("credits the later owner for a transfer after the reuse boundary", async () => {
    const booted = await bootTestApp({ now: new Date(NOW) });
    try {
      await seedInvoiceWindow(booted.deps, {
        id: "11111111-1111-1111-1111-111111111111",
        status: "expired",
        addressIndex: 1,
        allocatedAt: NOW - 100_000,
        releasedAt: NOW - 50_000
      });
      await seedInvoiceWindow(booted.deps, {
        id: "22222222-2222-2222-2222-222222222222",
        status: "pending",
        addressIndex: 2,
        allocatedAt: NOW - 50_000,
        releasedAt: null
      });

      await ingestReingest(booted.deps, transfer("0xinB", new Date(NOW - 25_000)));
      expect(await attributedInvoiceId(booted.deps, "0xinB")).toBe("22222222-2222-2222-2222-222222222222");
    } finally {
      await booted.close();
    }
  });

  it("orphans a transfer that lands in a released gap (no owner at that time)", async () => {
    const booted = await bootTestApp({ now: new Date(NOW) });
    try {
      // A released at NOW-50_000; B not allocated until NOW-20_000 → gap.
      await seedInvoiceWindow(booted.deps, {
        id: "11111111-1111-1111-1111-111111111111",
        status: "expired",
        addressIndex: 1,
        allocatedAt: NOW - 100_000,
        releasedAt: NOW - 50_000
      });
      await seedInvoiceWindow(booted.deps, {
        id: "22222222-2222-2222-2222-222222222222",
        status: "pending",
        addressIndex: 2,
        allocatedAt: NOW - 20_000,
        releasedAt: null
      });

      const res = await ingestReingest(booted.deps, transfer("0xgap", new Date(NOW - 35_000)));
      expect(res.inserted).toBe(true);
      expect(await attributedInvoiceId(booted.deps, "0xgap")).toBeNull();
      const [row] = await booted.deps.db
        .select({ status: transactions.status })
        .from(transactions)
        .where(eq(transactions.txHash, "0xgap"))
        .limit(1);
      expect(row?.status).toBe("orphaned");
    } finally {
      await booted.close();
    }
  });

  it("orphans a transfer that predates any allocation of the address", async () => {
    const booted = await bootTestApp({ now: new Date(NOW) });
    try {
      await seedInvoiceWindow(booted.deps, {
        id: "11111111-1111-1111-1111-111111111111",
        status: "pending",
        addressIndex: 1,
        allocatedAt: NOW - 50_000,
        releasedAt: null
      });
      await ingestReingest(booted.deps, transfer("0xpredates", new Date(NOW - 90_000)));
      expect(await attributedInvoiceId(booted.deps, "0xpredates")).toBeNull();
    } finally {
      await booted.close();
    }
  });

  it("fail-closed: a re-ingest with no on-chain time orphans (never guesses the current owner)", async () => {
    const booted = await bootTestApp({ now: new Date(NOW) });
    try {
      await seedInvoiceWindow(booted.deps, {
        id: "22222222-2222-2222-2222-222222222222",
        status: "pending",
        addressIndex: 1,
        allocatedAt: NOW - 50_000,
        releasedAt: null
      });
      const res = await ingestReingest(booted.deps, transfer("0xnotime", null));
      expect(res.inserted).toBe(true);
      expect(await attributedInvoiceId(booted.deps, "0xnotime")).toBeNull();
    } finally {
      await booted.close();
    }
  });

  it("orphans a too-stale payment to a long-dead invoice (staleness gate)", async () => {
    const booted = await bootTestApp({ now: new Date(NOW) });
    try {
      // A is expired and owned the address from 60 days ago until 40 days ago.
      const sixtyDays = 60 * 24 * 3_600_000;
      const fortyDays = 40 * 24 * 3_600_000;
      await seedInvoiceWindow(booted.deps, {
        id: "11111111-1111-1111-1111-111111111111",
        status: "expired",
        addressIndex: 1,
        allocatedAt: NOW - sixtyDays,
        releasedAt: NOW - fortyDays
      });
      // Transfer 50 days ago: inside A's window, but >30 days stale AND owner
      // is dead → orphan for admin review instead of flipping a dead invoice.
      const fiftyDays = 50 * 24 * 3_600_000;
      const res = await ingestReingest(booted.deps, transfer("0xstale", new Date(NOW - fiftyDays)));
      expect(res.inserted).toBe(true);
      expect(await attributedInvoiceId(booted.deps, "0xstale")).toBeNull();
    } finally {
      await booted.close();
    }
  });

  it("still credits a still-ACTIVE owner even for an old transfer (staleness only guards dead invoices)", async () => {
    const booted = await bootTestApp({ now: new Date(NOW) });
    try {
      const sixtyDays = 60 * 24 * 3_600_000;
      const fiftyDays = 50 * 24 * 3_600_000;
      // C is still pending and has owned the address for 60 days.
      await seedInvoiceWindow(booted.deps, {
        id: "33333333-3333-3333-3333-333333333333",
        status: "pending",
        addressIndex: 1,
        allocatedAt: NOW - sixtyDays,
        releasedAt: null
      });
      await ingestReingest(booted.deps, transfer("0xactive-old", new Date(NOW - fiftyDays)));
      expect(await attributedInvoiceId(booted.deps, "0xactive-old")).toBe("33333333-3333-3333-3333-333333333333");
    } finally {
      await booted.close();
    }
  });

  it("LIVE ingest is unchanged: still credits the current active owner regardless of on-chain time", async () => {
    const booted = await bootTestApp({ now: new Date(NOW) });
    try {
      // A expired (past owner), B active now — same reuse setup as the bug.
      await seedInvoiceWindow(booted.deps, {
        id: "11111111-1111-1111-1111-111111111111",
        status: "expired",
        addressIndex: 1,
        allocatedAt: NOW - 100_000,
        releasedAt: NOW - 50_000
      });
      await seedInvoiceWindow(booted.deps, {
        id: "22222222-2222-2222-2222-222222222222",
        status: "pending",
        addressIndex: 2,
        allocatedAt: NOW - 50_000,
        releasedAt: null
      });
      // LIVE path (default source) ignores onchainTime and picks the active
      // owner — even though this transfer's time falls in A's window. This is
      // correct for live detection and proves the hot path is untouched.
      await ingestDetectedTransfer(booted.deps, transfer("0xlive", new Date(NOW - 75_000)));
      expect(await attributedInvoiceId(booted.deps, "0xlive")).toBe("22222222-2222-2222-2222-222222222222");
    } finally {
      await booted.close();
    }
  });
});
