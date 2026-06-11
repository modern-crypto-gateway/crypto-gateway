import { beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb, createLibsqlClient } from "../../db/client.js";
import { merchants, payoutReservations, payouts, transactions } from "../../db/schema.js";
import {
  computeSpendable,
  computeSpendableBatch
} from "../../core/domain/balance-snapshot.service.js";

// computeSpendableBatch replaced ~4-queries-per-(address, token) hot-path
// calls in the payout estimator/planner. These tests pin the batch to the
// single-tuple reference implementation: same ledger, same numbers, for
// every address × token combination — including the negative-clamp and the
// intra-pool credit cases.

type Db = ReturnType<typeof createDb>;

const CHAIN = 728126428;
const A1 = "TAddrOne";
const A2 = "TAddrTwo";
const A3 = "TAddrThreeNoLedger";
const MERCHANT = "00000000-0000-0000-0000-000000000001";

async function freshDb(): Promise<Db> {
  const client = createLibsqlClient({ url: ":memory:" });
  const db = createDb(client);
  const migrationsFolder = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "drizzle",
    "migrations"
  );
  await migrate(db, { migrationsFolder });
  await db.insert(merchants).values({
    id: MERCHANT,
    name: "test",
    apiKeyHash: "hash",
    createdAt: 1,
    updatedAt: 1
  });
  return db;
}

let payoutSeq = 0;
async function insertPayout(
  db: Db,
  row: {
    kind: "standard" | "gas_top_up" | "gas_burn" | "consolidation_sweep";
    status: "confirmed" | "submitted";
    token: string;
    amountRaw: string;
    sourceAddress?: string;
    destinationAddress: string;
  }
): Promise<string> {
  payoutSeq += 1;
  const id = `payout-${payoutSeq}`;
  await db.insert(payouts).values({
    id,
    merchantId: MERCHANT,
    kind: row.kind,
    status: row.status,
    chainId: CHAIN,
    token: row.token,
    amountRaw: row.amountRaw,
    destinationAddress: row.destinationAddress,
    sourceAddress: row.sourceAddress ?? null,
    createdAt: 1,
    updatedAt: 1
  });
  return id;
}

let txSeq = 0;
async function insertCredit(
  db: Db,
  row: { toAddress: string; token: string; amountRaw: string; status?: "confirmed" | "detected" }
): Promise<void> {
  txSeq += 1;
  await db.insert(transactions).values({
    id: `tx-${txSeq}`,
    chainId: CHAIN,
    txHash: `hash-${txSeq}`,
    fromAddress: "TSomeSender",
    toAddress: row.toAddress,
    token: row.token,
    amountRaw: row.amountRaw,
    status: row.status ?? "confirmed",
    detectedAt: 1
  });
}

describe("computeSpendableBatch", () => {
  let db: Db;

  beforeEach(async () => {
    db = await freshDb();
  });

  it("matches computeSpendable for every (address, token) across all ledger row kinds", async () => {
    // A1/USDT: credits 1000 + intra-pool sweep credit 250, debit 300,
    // reservation 100 → 850. A1/TRX: top-up credit 50 → 50.
    await insertCredit(db, { toAddress: A1, token: "USDT", amountRaw: "1000" });
    await insertPayout(db, {
      kind: "consolidation_sweep",
      status: "confirmed",
      token: "USDT",
      amountRaw: "250",
      sourceAddress: A2,
      destinationAddress: A1
    });
    const debited = await insertPayout(db, {
      kind: "standard",
      status: "confirmed",
      token: "USDT",
      amountRaw: "300",
      sourceAddress: A1,
      destinationAddress: "TExternal"
    });
    await db.insert(payoutReservations).values({
      id: "res-1",
      payoutId: debited,
      role: "source",
      chainId: CHAIN,
      address: A1,
      token: "USDT",
      amountRaw: "100",
      createdAt: 1
    });
    await insertPayout(db, {
      kind: "gas_top_up",
      status: "confirmed",
      token: "TRX",
      amountRaw: "50",
      sourceAddress: A2,
      destinationAddress: A1
    });

    // A2/USDT: credit 500, sweep-out debit 250 → 250. A2/TRX: top-up-out 50 → clamp path not hit.
    await insertCredit(db, { toAddress: A2, token: "USDT", amountRaw: "500" });

    // Noise the batch must ignore: unconfirmed credit, released reservation,
    // submitted (not confirmed) debit.
    await insertCredit(db, { toAddress: A1, token: "USDT", amountRaw: "7777", status: "detected" });
    await db.insert(payoutReservations).values({
      id: "res-released",
      payoutId: debited,
      role: "source",
      chainId: CHAIN,
      address: A1,
      token: "USDT",
      amountRaw: "9999",
      createdAt: 1,
      releasedAt: 2
    });
    await insertPayout(db, {
      kind: "standard",
      status: "submitted",
      token: "USDT",
      amountRaw: "8888",
      sourceAddress: A1,
      destinationAddress: "TExternal"
    });

    const addresses = [A1, A2, A3];
    const tokens = ["USDT", "TRX"];
    const batch = await computeSpendableBatch({ db } as never, { chainId: CHAIN, addresses, tokens });

    for (const address of addresses) {
      for (const token of tokens) {
        const reference = await computeSpendable({ db } as never, { chainId: CHAIN, address, token });
        expect(batch.get(address)?.get(token), `${address}/${token}`).toBe(reference);
      }
    }
    // Spot-check the absolute numbers so a bug in BOTH implementations
    // can't pass the equivalence check unnoticed.
    expect(batch.get(A1)?.get("USDT")).toBe(850n);
    expect(batch.get(A1)?.get("TRX")).toBe(50n);
    expect(batch.get(A2)?.get("USDT")).toBe(250n);
    expect(batch.get(A3)?.get("USDT")).toBe(0n);
  });

  it("clamps negative balances to zero exactly like the reference", async () => {
    // Debit with no recorded credit → negative raw sum → clamp to 0.
    await insertPayout(db, {
      kind: "standard",
      status: "confirmed",
      token: "USDT",
      amountRaw: "400",
      sourceAddress: A1,
      destinationAddress: "TExternal"
    });

    const batch = await computeSpendableBatch({ db } as never, {
      chainId: CHAIN,
      addresses: [A1],
      tokens: ["USDT"]
    });
    const reference = await computeSpendable({ db } as never, { chainId: CHAIN, address: A1, token: "USDT" });
    expect(batch.get(A1)?.get("USDT")).toBe(0n);
    expect(reference).toBe(0n);
  });

  it("returns zeroed maps for empty inputs without querying", async () => {
    const batch = await computeSpendableBatch({ db } as never, {
      chainId: CHAIN,
      addresses: [],
      tokens: ["USDT"]
    });
    expect(batch.size).toBe(0);
  });
});
