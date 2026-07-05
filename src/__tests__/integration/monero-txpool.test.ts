import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { and, eq } from "drizzle-orm";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { initializeMoneroPool } from "../../core/domain/monero-pool.service.js";
import {
  computeRctCommitment,
  encodeAddress,
  parseAddress
} from "../../adapters/chains/monero/monero-crypto.js";
import {
  moneroChainAdapter,
  type MoneroChainAdapter
} from "../../adapters/chains/monero/monero-chain.adapter.js";
import { MONERO_MAINNET_CONFIG } from "../../adapters/chains/monero/monero-config.js";
import type {
  MoneroDaemonRpcClient,
  MoneroParsedTx
} from "../../adapters/chains/monero/monero-rpc.js";
import {
  memoryCacheWatcherStorage,
  moneroTxpoolWatcher,
  type MoneroTxpoolWatcher,
  type MoneroWatcherStorage
} from "../../adapters/detection/monero-txpool.js";
import { moneroBlockScanDetection } from "../../adapters/detection/monero-block-scan.adapter.js";
import { invoices, transactions } from "../../db/schema.js";
import type { Address } from "../../core/types/chain.js";
import type { TokenSymbol } from "../../core/types/token.js";

// Monero txpool watcher (instant detection) integration tests. Cover the
// six load-bearing behaviors of `moneroTxpoolWatcher`:
//   1. Pool hit → 0-conf ingest: a payment seen in the txpool lands as a
//      `detected` transactions row with block_number NULL / confirmations 0
//      and moves its invoice to `processing` (broadcast → webhook in one
//      tick, no waiting for a block).
//   2. Seen-set dedup: an already-seen pool hash never pays the fetch+scan
//      cost again, and cannot double-credit.
//   3. Pool→block dedup + cursor: when the pool tx is later mined, the
//      block pass re-observes it, the (chain_id, tx_hash, log_index) UNIQUE
//      constraint absorbs the re-ingest (still one row), and the cursor
//      advances only after ingest (the checkpoint-ordering invariant).
//   4. Idle fast-forward: with zero watched addresses nothing in the
//      skipped blocks can match, so the cursor snaps to tip and no block
//      is fetched (the only situation where skipping heights is safe).
//   5. RPC failure isolation: a pool-endpoint failure must not take down
//      the block pass — the two passes are independent failure domains.
//   6. /ensure poke path: `refreshWatchedSet()` makes a just-created
//      invoice visible immediately, without waiting out
//      watchedRefreshIntervalMs.
//
// Infrastructure mirrors monero-inbound.test.ts: a deterministic test
// wallet, a driven stub daemon client, and outputs synthesized with the
// same view-key crypto the gateway decodes with (txPubkey = r·D for a
// subaddress recipient, real Pedersen commitment, viewTag null so the
// scanner takes the full-check bypass path).

const ED25519_L = ed25519.Point.Fn.ORDER;
const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const MONERO_CHAIN_ID = MONERO_MAINNET_CONFIG.chainId;

// ---- Deterministic wallet + scalar helpers (same shape as monero-inbound) ----

function leBytesToBigIntMod(bytes: Uint8Array, modulus: bigint): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) n = (n << 8n) | BigInt(bytes[i]!);
  return n % modulus;
}

function scalarToLEBytes32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeWallet(seedSuffix: string): {
  primaryAddress: string;
  viewKey: Uint8Array;
} {
  const spendSeed = keccak_256(new TextEncoder().encode(`monero-txpool-spend-${seedSuffix}`));
  const viewSeed = keccak_256(new TextEncoder().encode(`monero-txpool-view-${seedSuffix}`));
  const spendScalar = leBytesToBigIntMod(spendSeed, ED25519_L);
  const viewScalar = leBytesToBigIntMod(viewSeed, ED25519_L);
  const viewKey = scalarToLEBytes32(viewScalar);
  const primarySpendPub = ed25519.Point.BASE.multiply(spendScalar).toBytes();
  const publicViewKey = ed25519.Point.BASE.multiply(viewScalar).toBytes();
  const primaryAddress = encodeAddress({
    network: "mainnet",
    isSubaddress: false,
    publicSpendKey: primarySpendPub,
    publicViewKey
  });
  return { primaryAddress, viewKey };
}

// ---- Driven stub daemon client ----
//
// Each test mutates `state` to script the chain: tip height, pool hash
// list, per-height block contents, and parsed txs by hash. Call counters
// let tests assert what the watcher did NOT do (dedup, idle fast-forward),
// which is the point of half these tests.

interface DaemonStubState {
  tipHeight: number;
  poolHashes: string[];
  // Throw this from getTxPoolHashes to simulate a pool-endpoint outage.
  poolHashesError: Error | null;
  readonly blockTxs: Map<number, readonly string[]>;
  readonly txs: Map<string, MoneroParsedTx>;
  readonly calls: {
    getTipHeight: number;
    getBlockByHeight: number;
    getTransactions: number;
    getTxPoolHashes: number;
  };
}

function drivenDaemonClient(): { client: MoneroDaemonRpcClient; state: DaemonStubState } {
  const state: DaemonStubState = {
    tipHeight: 0,
    poolHashes: [],
    poolHashesError: null,
    blockTxs: new Map(),
    txs: new Map(),
    calls: { getTipHeight: 0, getBlockByHeight: 0, getTransactions: 0, getTxPoolHashes: 0 }
  };
  const client: MoneroDaemonRpcClient = {
    async getTipHeight() {
      state.calls.getTipHeight += 1;
      return state.tipHeight;
    },
    async getBlockByHeight(height) {
      state.calls.getBlockByHeight += 1;
      return { txHashes: state.blockTxs.get(height) ?? [], timestampSec: null };
    },
    async getTransactions(hashes) {
      state.calls.getTransactions += 1;
      // Real daemons silently drop unknown hashes — mirror that.
      return hashes
        .map((h) => state.txs.get(h))
        .filter((t): t is MoneroParsedTx => t !== undefined);
    },
    async getTxPoolHashes() {
      state.calls.getTxPoolHashes += 1;
      if (state.poolHashesError !== null) throw state.poolHashesError;
      return [...state.poolHashes];
    }
  };
  return { client, state };
}

// ---- Synthesize an on-chain tx output paying a gateway subaddress ----
//
// Same construction as monero-inbound.test.ts: for a subaddress recipient
// the sender's tx pubkey is r·D (NOT r·G), so the recipient's derivation
// 8·viewSecret·(r·D) equals the sender's 8r·C. The output carries a REAL
// Pedersen commitment for the amount (the scanner refuses unverifiable
// amounts) and `viewTag: null` so the pre-v15 bypass path always runs the
// full cryptographic check. Output index 0 → logIndex 0 on the ingest row.

function synthesizePayingTx(args: {
  receiveAddress: string;
  amount: bigint;
  rSeed: string;
  txHash: string;
  blockHeight: number | null; // null = txpool (0-conf), number = mined
}): MoneroParsedTx {
  const subParsed = parseAddress(args.receiveAddress);
  const r = leBytesToBigIntMod(keccak_256(new TextEncoder().encode(args.rSeed)), ED25519_L);
  const D = ed25519.Point.fromBytes(subParsed.publicSpendKey);
  const C = ed25519.Point.fromBytes(subParsed.publicViewKey);
  const txPubkeyHex = bytesToHex(D.multiply(r).toBytes());
  // derivation = 8·r·C; Hs(derivation || varint(0)) reduced mod L is the
  // shared scalar the gateway's deriveSharedSecret will produce.
  const derivationBytes = C.multiply(r).multiply(8n).toBytes();
  const sharedPreimage = new Uint8Array(derivationBytes.length + 1);
  sharedPreimage.set(derivationBytes, 0);
  sharedPreimage[derivationBytes.length] = 0; // varint(0) = single 0x00 byte
  const sharedScalarBytes = scalarToLEBytes32(
    leBytesToBigIntMod(keccak_256(sharedPreimage), ED25519_L)
  );
  const sharedScalar = leBytesToBigIntMod(sharedScalarBytes, ED25519_L);
  // K_out = sharedScalar·G + subaddressSpendPub
  const Kout = ed25519.Point.BASE.multiply(sharedScalar).add(D).toBytes();
  // encryptedAmount = amount XOR keccak("amount" || sharedScalarBytes)[0..8]
  const amountPreimage = new Uint8Array("amount".length + 32);
  amountPreimage.set(new TextEncoder().encode("amount"), 0);
  amountPreimage.set(sharedScalarBytes, "amount".length);
  const amountMask = keccak_256(amountPreimage);
  const encrypted = new Uint8Array(8);
  let av = args.amount;
  for (let i = 0; i < 8; i += 1) {
    encrypted[i] = (Number(av & 0xffn) ^ amountMask[i]!) & 0xff;
    av >>= 8n;
  }
  return {
    txHash: args.txHash,
    blockHeight: args.blockHeight,
    txPubkey: txPubkeyHex,
    additionalPubkeys: [],
    isCoinbase: false,
    unlockTime: 0,
    outputs: [
      {
        publicKey: bytesToHex(Kout),
        encryptedAmount: bytesToHex(encrypted),
        commitment: bytesToHex(
          computeRctCommitment({ sharedSecret: sharedScalarBytes, amount: args.amount })
        ),
        viewTag: null
      }
    ]
  };
}

// ---- Per-test boot: app + Monero adapter + driven daemon + seeded pool ----

async function bootMoneroWatcherApp(
  seedSuffix: string,
  opts: { restoreHeight: number }
): Promise<{ booted: BootedTestApp; adapter: MoneroChainAdapter; state: DaemonStubState }> {
  const w = makeWallet(seedSuffix);
  const booted = await bootTestApp({ merchants: [{ id: MERCHANT_ID }] });
  const { client, state } = drivenDaemonClient();
  const adapter = moneroChainAdapter({
    chain: MONERO_MAINNET_CONFIG,
    primaryAddress: w.primaryAddress,
    viewKey: w.viewKey,
    restoreHeight: opts.restoreHeight,
    daemonClient: client,
    cache: booted.deps.cache
  });
  // bootTestApp doesn't wire Monero via env vars — patch deps directly,
  // then seed the subaddress pool so invoice creation has addresses.
  (booted.deps.chains as unknown as MoneroChainAdapter[]).push(adapter);
  await initializeMoneroPool(booted.deps, { initialSize: 5 });
  return { booted, adapter, state };
}

function makeWatcher(
  booted: BootedTestApp,
  adapter: MoneroChainAdapter,
  opts: { blockPassIntervalMs?: number; watchedRefreshIntervalMs?: number } = {}
): { watcher: MoneroTxpoolWatcher; storage: MoneroWatcherStorage } {
  const storage = memoryCacheWatcherStorage(booted.deps.cache, MONERO_CHAIN_ID);
  const watcher = moneroTxpoolWatcher({
    deps: booted.deps,
    adapter,
    chainId: MONERO_CHAIN_ID,
    storage,
    // Conditional spreads keep exactOptionalPropertyTypes happy — never
    // pass an explicit `undefined` for an optional knob.
    ...(opts.blockPassIntervalMs !== undefined
      ? { blockPassIntervalMs: opts.blockPassIntervalMs }
      : {}),
    ...(opts.watchedRefreshIntervalMs !== undefined
      ? { watchedRefreshIntervalMs: opts.watchedRefreshIntervalMs }
      : {})
  });
  return { watcher, storage };
}

async function createXmrInvoice(
  booted: BootedTestApp,
  amountRaw: string
): Promise<{ id: string; receiveAddress: string }> {
  const apiKey = booted.apiKeys[MERCHANT_ID]!;
  const res = await booted.app.fetch(
    new Request("http://test.local/api/v1/invoices", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ chainId: MONERO_CHAIN_ID, token: "XMR", amountRaw })
    })
  );
  if (res.status !== 201) {
    throw new Error(`invoice create returned ${res.status}: ${await res.text()}`);
  }
  return ((await res.json()) as { invoice: { id: string; receiveAddress: string } }).invoice;
}

function txRowsFor(booted: BootedTestApp, txHash: string) {
  return booted.deps.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.chainId, MONERO_CHAIN_ID), eq(transactions.txHash, txHash)));
}

const INVOICE_AMOUNT = 150000000000n; // 0.15 XMR (12 decimals)

describe("Monero txpool watcher — instant detection", () => {
  it("ingests a txpool payment at 0-conf (block NULL, 0 confirmations) and moves the invoice to processing", async () => {
    // restoreHeight = tip+1 parks the block pass (cold cursor = tip,
    // nothing to walk) so this test observes the POOL pass in isolation.
    const { booted, adapter, state } = await bootMoneroWatcherApp("pool-hit", {
      restoreHeight: 111
    });
    try {
      state.tipHeight = 110;
      const invoice = await createXmrInvoice(booted, INVOICE_AMOUNT.toString());
      const txHash = "1a".repeat(32);
      state.txs.set(
        txHash,
        synthesizePayingTx({
          receiveAddress: invoice.receiveAddress,
          amount: INVOICE_AMOUNT,
          rSeed: "pool-hit-r",
          txHash,
          blockHeight: null // still in the pool — the 0-conf case
        })
      );
      state.poolHashes = [txHash];

      const { watcher } = makeWatcher(booted, adapter);
      const result = await watcher.tick();
      expect(result.active).toBe(true);
      expect(result.watchedAddresses).toBe(1);
      expect(result.poolNewTxs).toBe(1);
      expect(result.poolMatched).toBe(1);

      // The transfer landed as a 0-conf `detected` row. block_number stays
      // NULL until the block pass re-observes the tx mined — XMR mainnet
      // needs 10 confirmations, so 0-conf can never jump to `confirmed`.
      const rows = await txRowsFor(booted, txHash);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("detected");
      expect(rows[0]!.blockNumber).toBeNull();
      expect(rows[0]!.confirmations).toBe(0);
      expect(rows[0]!.invoiceId).toBe(invoice.id);

      // Full amount present but unconfirmed → invoice `processing` (the
      // "payment detected, awaiting confirmations" merchant-visible state).
      const [inv] = await booted.deps.db
        .select({ status: invoices.status })
        .from(invoices)
        .where(eq(invoices.id, invoice.id));
      expect(inv?.status).toBe("processing");
    } finally {
      await booted.close();
    }
  });

  it("never re-fetches or re-ingests a pool hash already in the seen-set", async () => {
    const { booted, adapter, state } = await bootMoneroWatcherApp("seen-dedup", {
      restoreHeight: 111
    });
    try {
      state.tipHeight = 110;
      const invoice = await createXmrInvoice(booted, INVOICE_AMOUNT.toString());
      const txHash = "2b".repeat(32);
      state.txs.set(
        txHash,
        synthesizePayingTx({
          receiveAddress: invoice.receiveAddress,
          amount: INVOICE_AMOUNT,
          rSeed: "seen-dedup-r",
          txHash,
          blockHeight: null
        })
      );
      state.poolHashes = [txHash];

      const { watcher } = makeWatcher(booted, adapter);
      const first = await watcher.tick();
      expect(first.poolMatched).toBe(1);
      // Exactly one tx fetch so far — the pool pass paid the cost once.
      expect(state.calls.getTransactions).toBe(1);

      // Same pool contents on the next tick: the hash-diff against the
      // seen-set must skip the fetch entirely (that's what makes polling a
      // multi-thousand-tx mainnet pool every few seconds affordable).
      const second = await watcher.tick();
      expect(second.poolNewTxs).toBe(0);
      expect(second.poolMatched).toBe(0);
      expect(state.calls.getTransactions).toBe(1); // unchanged — no re-fetch

      // And no double-credit: still exactly one transactions row.
      const rows = await txRowsFor(booted, txHash);
      expect(rows).toHaveLength(1);
    } finally {
      await booted.close();
    }
  });

  it("dedups a pool-detected tx when it is later mined, and advances the block cursor past its height", async () => {
    const { booted, adapter, state } = await bootMoneroWatcherApp("pool-then-mined", {
      restoreHeight: 111
    });
    try {
      state.tipHeight = 110;
      const invoice = await createXmrInvoice(booted, INVOICE_AMOUNT.toString());
      const txHash = "3c".repeat(32);
      // blockPassIntervalMs: 0 → the block pass runs on EVERY tick, so the
      // test doesn't need to manipulate the boot clock.
      const { watcher, storage } = makeWatcher(booted, adapter, { blockPassIntervalMs: 0 });

      // Tick 1: pool-only detection at 0-conf (block 111 doesn't exist yet;
      // the cold cursor sits at restoreHeight-1 = 110 with nothing to walk).
      state.txs.set(
        txHash,
        synthesizePayingTx({
          receiveAddress: invoice.receiveAddress,
          amount: INVOICE_AMOUNT,
          rSeed: "pool-then-mined-r",
          txHash,
          blockHeight: null
        })
      );
      state.poolHashes = [txHash];
      const first = await watcher.tick();
      expect(first.poolMatched).toBe(1);
      expect((await txRowsFor(booted, txHash))).toHaveLength(1);

      // The tx gets mined at height 111. Same rSeed → byte-identical tx
      // content, now carrying a block height (exactly what a real daemon
      // reports after inclusion). The pool still lists the hash — daemons
      // keep pool entries visible briefly around inclusion — which also
      // re-exercises the seen-set on the same tick.
      state.tipHeight = 111;
      state.blockTxs.set(111, [txHash]);
      state.txs.set(
        txHash,
        synthesizePayingTx({
          receiveAddress: invoice.receiveAddress,
          amount: INVOICE_AMOUNT,
          rSeed: "pool-then-mined-r",
          txHash,
          blockHeight: 111
        })
      );

      const second = await watcher.tick();
      // Block pass walked exactly the new block and re-matched the transfer.
      expect(second.blocksScanned).toBe(1);
      expect(second.blockMatched).toBe(1);

      // The (chain_id, tx_hash, log_index) UNIQUE constraint absorbed the
      // re-ingest: still exactly one row (inserted:false path, no throw).
      const rows = await txRowsFor(booted, txHash);
      expect(rows).toHaveLength(1);

      // Checkpoint-ordering invariant: the cursor advanced to the mined
      // height ONLY after the block's transfers were handed to ingest.
      expect(await storage.getCheckpoint()).toBe(111);
    } finally {
      await booted.close();
    }
  });

  it("fast-forwards the cursor to tip without fetching blocks when nothing is watched", async () => {
    // Fresh boot, NO invoices → zero watched addresses. Nothing in the
    // skipped blocks can match (detection requires a live
    // invoice_receive_addresses row), so snapping to tip is safe and spares
    // the next live invoice a dead-gap walk.
    const { booted, adapter, state } = await bootMoneroWatcherApp("idle-ff", {
      restoreHeight: 0
    });
    try {
      state.tipHeight = 12345;
      const { watcher, storage } = makeWatcher(booted, adapter);
      const result = await watcher.tick();
      // active:false is the host's back-off signal (idle cadence).
      expect(result.active).toBe(false);
      expect(result.watchedAddresses).toBe(0);
      // Snaps to tip MINUS the 3-block reorg/TOCTOU margin (see
      // IDLE_FAST_FORWARD_MARGIN_BLOCKS) — not exactly tip.
      expect(await storage.getCheckpoint()).toBe(12345 - 3);
      // No block was fetched — fast-forward is a cursor write, not a scan.
      expect(state.calls.getBlockByHeight).toBe(0);
    } finally {
      await booted.close();
    }
  });

  it("keeps running the block pass when the pool endpoint fails", async () => {
    // The pool pass is the latency layer; the block pass is the settlement
    // truth. A pool-endpoint outage must not silence the block walk, or a
    // flaky /get_transaction_pool_hashes would delay payments indefinitely
    // instead of by at most one block-pass interval.
    const { booted, adapter, state } = await bootMoneroWatcherApp("pool-outage", {
      restoreHeight: 105
    });
    try {
      state.tipHeight = 110;
      // An invoice must exist — with zero watched addresses the watcher
      // takes the idle path and neither pass runs at all.
      await createXmrInvoice(booted, INVOICE_AMOUNT.toString());
      state.poolHashesError = new Error("simulated monerod pool-endpoint outage");

      const { watcher, storage } = makeWatcher(booted, adapter, { blockPassIntervalMs: 0 });
      const result = await watcher.tick(); // must resolve, not throw
      expect(result.active).toBe(true);
      expect(state.calls.getTxPoolHashes).toBe(1); // pool pass was attempted...
      expect(result.poolNewTxs).toBe(0); // ...and failed without output
      // Block pass still walked restoreHeight..tip (105..110 inclusive).
      expect(state.calls.getBlockByHeight).toBe(6);
      expect(result.blocksScanned).toBe(6);
      expect(await storage.getCheckpoint()).toBe(110);
    } finally {
      await booted.close();
    }
  });

  it("detects a payment to a just-created invoice after an explicit refreshWatchedSet() poke", async () => {
    // Mirrors the DO /ensure poke: invoice created in another isolate →
    // host calls refreshWatchedSet() so the next tick watches it NOW,
    // instead of after watchedRefreshIntervalMs (default 30 s) elapses.
    const { booted, adapter, state } = await bootMoneroWatcherApp("instant-refresh", {
      restoreHeight: 0
    });
    try {
      state.tipHeight = 200;
      const { watcher } = makeWatcher(booted, adapter);

      // Tick 1: nothing watched → idle (and the cursor fast-forwards to 200,
      // so the later block pass has nothing stale to walk).
      const idle = await watcher.tick();
      expect(idle.active).toBe(false);

      const invoice = await createXmrInvoice(booted, INVOICE_AMOUNT.toString());
      // The watcher hasn't seen the invoice yet — tick 1's refresh stamped
      // lastWatchedRefreshAt, and the 30 s interval hasn't elapsed. Without
      // the poke, the next tick would idle right past the payment.
      expect(watcher.status().watchedAddresses).toBe(0);
      expect(await watcher.refreshWatchedSet()).toBe(1);

      const txHash = "4d".repeat(32);
      state.txs.set(
        txHash,
        synthesizePayingTx({
          receiveAddress: invoice.receiveAddress,
          amount: INVOICE_AMOUNT,
          rSeed: "instant-refresh-r",
          txHash,
          blockHeight: null
        })
      );
      state.poolHashes = [txHash];

      const result = await watcher.tick();
      expect(result.active).toBe(true);
      expect(result.watchedAddresses).toBe(1);
      expect(result.poolMatched).toBe(1);

      const rows = await txRowsFor(booted, txHash);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("detected");
      expect(rows[0]!.blockNumber).toBeNull();
      expect(rows[0]!.invoiceId).toBe(invoice.id);
    } finally {
      await booted.close();
    }
  });
});

// Cron block-scan fallback (MONERO_TXPOOL=off) commit discipline. Unlike the
// txpool watcher's blockPass — which holds its cursor below the lowest block
// with a failed ingest — the cron path routes ingest through pollPayments,
// which catches per-transfer errors, logs, and continues, THEN calls
// strategy.commit(). If commit advanced the cursor to the full walked height
// regardless of failures, a transient ingest error on a real payment would
// permanently skip that block (the scan strictly resumes from cursor+1, with
// no snap-back). These tests lock in the clamp: commit() reduces the cursor
// below any failed transfer's block, so the next resume re-scans it.
const CHECKPOINT_KEY = `monero:last_scanned_height:${MONERO_CHAIN_ID}`;

describe("Monero cron block-scan fallback — commit discipline", () => {
  it("clamps the committed cursor below a failed-ingest block instead of skipping it", async () => {
    // restoreHeight 100 + cold cache → the poll walks from 100. tip 110, so
    // the walk covers 100..110 and scannedTo = 110.
    const { booted, state } = await bootMoneroWatcherApp("blockscan-clamp", {
      restoreHeight: 100
    });
    try {
      state.tipHeight = 110;
      const invoice = await createXmrInvoice(booted, INVOICE_AMOUNT.toString());
      const txHash = "5e".repeat(32);
      const minedBlock = 105;
      state.blockTxs.set(minedBlock, [txHash]);
      state.txs.set(
        txHash,
        synthesizePayingTx({
          receiveAddress: invoice.receiveAddress,
          amount: INVOICE_AMOUNT,
          rSeed: "blockscan-clamp-r",
          txHash,
          blockHeight: minedBlock
        })
      );

      const strategy = moneroBlockScanDetection();
      const addresses = [invoice.receiveAddress as Address];
      const transfers = await strategy.poll!(
        booted.deps,
        MONERO_CHAIN_ID,
        addresses,
        ["XMR" as TokenSymbol]
      );
      expect(transfers).toHaveLength(1);
      expect(transfers[0]!.blockNumber).toBe(minedBlock);

      // Simulate pollPayments: this transfer's ingest THREW, so it's passed
      // back as a failed transfer. The cursor must NOT advance to scannedTo
      // (110) — it must stop below the failed block so the next tick re-scans
      // block 105.
      await strategy.commit!(booted.deps, MONERO_CHAIN_ID, transfers);
      const clamped = await booted.deps.cache.getJSON<{ h: number }>(CHECKPOINT_KEY);
      expect(clamped?.h).toBe(minedBlock - 1);
    } finally {
      await booted.close();
    }
  });

  it("advances the cursor to the full walked height when no ingest failed", async () => {
    const { booted, adapter, state } = await bootMoneroWatcherApp("blockscan-advance", {
      restoreHeight: 100
    });
    try {
      state.tipHeight = 110;
      const invoice = await createXmrInvoice(booted, INVOICE_AMOUNT.toString());
      const txHash = "6f".repeat(32);
      state.blockTxs.set(105, [txHash]);
      state.txs.set(
        txHash,
        synthesizePayingTx({
          receiveAddress: invoice.receiveAddress,
          amount: INVOICE_AMOUNT,
          rSeed: "blockscan-advance-r",
          txHash,
          blockHeight: 105
        })
      );

      const strategy = moneroBlockScanDetection();
      const addresses = [invoice.receiveAddress as Address];
      const transfers = await strategy.poll!(
        booted.deps,
        MONERO_CHAIN_ID,
        addresses,
        ["XMR" as TokenSymbol]
      );
      expect(transfers).toHaveLength(1);

      // No failures → commit advances to scannedTo (the highest fully-walked
      // height, 110).
      await strategy.commit!(booted.deps, MONERO_CHAIN_ID, []);
      const cp = await booted.deps.cache.getJSON<{ h: number }>(CHECKPOINT_KEY);
      expect(cp?.h).toBe(110);

      // Sanity: adapter reference is live (guards against an unused-var lint
      // masking a wiring mistake — the strategy resolves the adapter from
      // deps.chains, which bootMoneroWatcherApp populated).
      expect(adapter.moneroNetwork).toBe("mainnet");
    } finally {
      await booted.close();
    }
  });
});
