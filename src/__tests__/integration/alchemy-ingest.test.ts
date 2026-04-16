import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { custom } from "viem";
import { alchemyNotifyDetection } from "../../adapters/detection/alchemy-notify.adapter.js";
import { evmChainAdapter } from "../../adapters/chains/evm/evm-chain.adapter.js";
import { bytesToHex, hmacSha256 } from "../../adapters/crypto/subtle.js";
import { bootTestApp, createOrderViaApi, type BootedTestApp } from "../helpers/boot.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const SIGNING_KEY = "test-alchemy-signing-key";
// Real EVM derivation requires a valid BIP39 mnemonic; the default test seed
// doesn't pass viem's validation.
const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

// Viem transport that throws on any RPC call — the adapter under test must not
// touch the network from `canonicalizeAddress`.
const noopTransport = custom({
  async request() {
    throw new Error("EVM adapter touched RPC during canonicalize path");
  }
});

async function bootAlchemy(): Promise<BootedTestApp> {
  return bootTestApp({
    merchants: [
      {
        id: MERCHANT_ID,
        webhookUrl: "https://merchant.example.com/hook",
        webhookSecret: "b".repeat(64)
      }
    ],
    chains: [evmChainAdapter({ chainIds: [1], transports: { 1: noopTransport } })],
    pushStrategies: { "alchemy-notify": alchemyNotifyDetection() },
    secretsOverrides: { ALCHEMY_NOTIFY_SIGNING_KEY: SIGNING_KEY, MASTER_SEED: HARDHAT_MNEMONIC }
  });
}

function buildPayload(activity: ReadonlyArray<Record<string, unknown>>, network = "ETH_MAINNET"): string {
  return JSON.stringify({
    webhookId: "wh_test",
    id: "whevt_test",
    createdAt: "2026-04-16T10:00:00Z",
    type: "ADDRESS_ACTIVITY",
    event: { network, activity }
  });
}

async function signedRequest(body: string): Promise<Request> {
  const sig = bytesToHex(await hmacSha256(SIGNING_KEY, body));
  return new Request("http://test.local/webhooks/alchemy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-alchemy-signature": sig
    },
    body
  });
}

describe("POST /webhooks/alchemy", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootAlchemy();
  });

  afterEach(async () => {
    await booted.close();
  });

  it("rejects requests with a missing signature header (401)", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/webhooks/alchemy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: buildPayload([])
      })
    );
    expect(res.status).toBe(401);
  });

  it("rejects requests with a bad signature (401) without leaking details", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/webhooks/alchemy", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-alchemy-signature": "deadbeef".repeat(8)
        },
        body: buildPayload([])
      })
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message?: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toBeUndefined();
  });

  it("rejects bodies whose signature was computed on a different payload", async () => {
    const realBody = buildPayload([]);
    const decoyBody = buildPayload([{ fromAddress: "0x01", toAddress: "0x02" }]);
    const sig = bytesToHex(await hmacSha256(SIGNING_KEY, decoyBody));
    const res = await booted.app.fetch(
      new Request("http://test.local/webhooks/alchemy", {
        method: "POST",
        headers: { "content-type": "application/json", "x-alchemy-signature": sig },
        body: realBody
      })
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the strategy is not configured for this deployment", async () => {
    const noStrategy = await bootTestApp({
      // Deliberately omit pushStrategies.
      secretsOverrides: { ALCHEMY_NOTIFY_SIGNING_KEY: SIGNING_KEY }
    });
    try {
      const body = buildPayload([]);
      const sig = bytesToHex(await hmacSha256(SIGNING_KEY, body));
      const res = await noStrategy.app.fetch(
        new Request("http://test.local/webhooks/alchemy", {
          method: "POST",
          headers: { "content-type": "application/json", "x-alchemy-signature": sig },
          body
        })
      );
      expect(res.status).toBe(404);
    } finally {
      await noStrategy.close();
    }
  });

  it("acknowledges valid requests with 200 and ingests transfers in the background", async () => {
    // Create an order so the incoming transfer has something to match.
    const order = await createOrderViaApi(booted, {
      merchantId: MERCHANT_ID,
      chainId: 1,
      token: "USDC",
      amountRaw: "1000000"
    });

    const body = buildPayload([
      {
        fromAddress: "0x1111111111111111111111111111111111111111",
        toAddress: order.receiveAddress,
        blockNum: "0x1234",
        hash: `0x${"a".repeat(64)}`,
        asset: "USDC",
        category: "token",
        rawContract: {
          rawValue: "0xf4240", // 1_000_000 (1 USDC @ 6 decimals)
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          decimals: 6
        },
        log: { logIndex: "0x3" }
      }
    ]);

    const res = await booted.app.fetch(await signedRequest(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });

    // The ingest is deferred via jobs.defer — drain to flush.
    await booted.deps.jobs.drain(2_000);

    const tx = await booted.deps.db
      .prepare("SELECT order_id, amount_raw, status FROM transactions WHERE tx_hash = ?")
      .bind(`0x${"a".repeat(64)}`)
      .first<{ order_id: string; amount_raw: string; status: string }>();
    expect(tx).not.toBeNull();
    expect(tx?.order_id).toBe(order.id);
    expect(tx?.amount_raw).toBe("1000000");

    // Order should have progressed to 'detected' (amount met, 1 confirmation
    // below mainnet's 12-block threshold).
    const orderRow = await booted.deps.db
      .prepare("SELECT status FROM orders WHERE id = ?")
      .bind(order.id)
      .first<{ status: string }>();
    expect(orderRow?.status).toBe("detected");
  });

  it("silently drops activities for networks not mapped (unknown Alchemy network)", async () => {
    const body = buildPayload(
      [
        {
          fromAddress: "0x1111111111111111111111111111111111111111",
          toAddress: "0x2222222222222222222222222222222222222222",
          blockNum: "0x1",
          hash: "0xff",
          category: "token",
          rawContract: { rawValue: "0x1", address: "0xdead", decimals: 6 }
        }
      ],
      "BOGUS_NETWORK"
    );
    const res = await booted.app.fetch(await signedRequest(body));
    expect(res.status).toBe(200);
    await booted.deps.jobs.drain(500);

    const count = await booted.deps.db
      .prepare("SELECT COUNT(*) AS n FROM transactions")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("skips activities whose contract isn't in our token registry", async () => {
    const body = buildPayload([
      {
        fromAddress: "0x1111111111111111111111111111111111111111",
        toAddress: "0x2222222222222222222222222222222222222222",
        blockNum: "0x1",
        hash: "0xfe",
        category: "token",
        // Unknown ERC-20 contract address.
        rawContract: {
          rawValue: "0x1",
          address: "0x0000000000000000000000000000000000009999",
          decimals: 6
        },
        log: { logIndex: "0x0" }
      }
    ]);
    const res = await booted.app.fetch(await signedRequest(body));
    expect(res.status).toBe(200);
    await booted.deps.jobs.drain(500);

    const count = await booted.deps.db
      .prepare("SELECT COUNT(*) AS n FROM transactions")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("skips non-token categories (external / internal)", async () => {
    const body = buildPayload([
      {
        fromAddress: "0x1111111111111111111111111111111111111111",
        toAddress: "0x2222222222222222222222222222222222222222",
        blockNum: "0x1",
        hash: "0xfd",
        category: "external", // native transfer — not supported in Phase 4b
        rawContract: {
          rawValue: "0x1",
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          decimals: 18
        }
      }
    ]);
    const res = await booted.app.fetch(await signedRequest(body));
    expect(res.status).toBe(200);
    await booted.deps.jobs.drain(500);

    const count = await booted.deps.db
      .prepare("SELECT COUNT(*) AS n FROM transactions")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("returns 400 on malformed JSON after a valid signature", async () => {
    const body = "{not-json";
    const sig = bytesToHex(await hmacSha256(SIGNING_KEY, body));
    const res = await booted.app.fetch(
      new Request("http://test.local/webhooks/alchemy", {
        method: "POST",
        headers: { "content-type": "application/json", "x-alchemy-signature": sig },
        body
      })
    );
    expect(res.status).toBe(400);
  });

  it("413 Payload Too Large when the body exceeds the 64KB cap", async () => {
    const body = "x".repeat(64 * 1024 + 1);
    const sig = bytesToHex(await hmacSha256(SIGNING_KEY, body));
    const res = await booted.app.fetch(
      new Request("http://test.local/webhooks/alchemy", {
        method: "POST",
        headers: { "content-type": "application/json", "x-alchemy-signature": sig },
        body
      })
    );
    expect(res.status).toBe(413);
  });
});

// Per-webhook signing key resolution: when the registry has a row for the
// payload's webhookId, that key takes precedence over the ALCHEMY_NOTIFY_SIGNING_KEY
// env var. Fixes v1's single-shared-key-spoofs-every-chain issue.
describe("POST /webhooks/alchemy — per-webhook signing key from DB registry", () => {
  it("resolves the signing key from the registry by webhookId (env var NOT set)", async () => {
    const perChainKey = "per-chain-signing-key-abc";
    const booted = await bootTestApp({
      merchants: [
        {
          id: MERCHANT_ID,
          webhookUrl: "https://merchant.example.com/hook",
          webhookSecret: "b".repeat(64)
        }
      ],
      chains: [evmChainAdapter({ chainIds: [1], transports: { 1: noopTransport } })],
      pushStrategies: { "alchemy-notify": alchemyNotifyDetection() },
      // Deliberately NOT setting ALCHEMY_NOTIFY_SIGNING_KEY — forces the
      // registry path to carry the whole verification.
      secretsOverrides: { MASTER_SEED: HARDHAT_MNEMONIC }
    });
    try {
      // Seed the registry directly (simulating a prior `POST /admin/bootstrap/alchemy-webhooks`).
      // Secret is stored encrypted at rest; bootstrap would have run it through
      // deps.secretsCipher.encrypt — we replicate that here.
      const now = Date.now();
      const ciphertext = await booted.deps.secretsCipher.encrypt(perChainKey);
      await booted.deps.db
        .prepare(
          `INSERT INTO alchemy_webhook_registry
             (chain_id, webhook_id, signing_key_ciphertext, webhook_url, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(1, "wh_eth_mainnet", ciphertext, "https://test.local/webhooks/alchemy", now, now)
        .run();

      const body = JSON.stringify({
        webhookId: "wh_eth_mainnet",
        id: "whevt_test",
        createdAt: "2026-04-16T10:00:00Z",
        type: "ADDRESS_ACTIVITY",
        event: { network: "ETH_MAINNET", activity: [] }
      });
      // Sign with the DB-registered key, not the env key (which isn't set).
      const sig = bytesToHex(await hmacSha256(perChainKey, body));
      const res = await booted.app.fetch(
        new Request("http://test.local/webhooks/alchemy", {
          method: "POST",
          headers: { "content-type": "application/json", "x-alchemy-signature": sig },
          body
        })
      );
      expect(res.status).toBe(200);
    } finally {
      await booted.close();
    }
  });

  it("rejects 401 when payload's webhookId is in the registry but signature was made with the env key", async () => {
    const perChainKey = "per-chain-signing-key-abc";
    const envKey = "env-legacy-key-xyz";
    const booted = await bootTestApp({
      chains: [evmChainAdapter({ chainIds: [1], transports: { 1: noopTransport } })],
      pushStrategies: { "alchemy-notify": alchemyNotifyDetection() },
      secretsOverrides: { ALCHEMY_NOTIFY_SIGNING_KEY: envKey, MASTER_SEED: HARDHAT_MNEMONIC }
    });
    try {
      const now = Date.now();
      const ciphertext = await booted.deps.secretsCipher.encrypt(perChainKey);
      await booted.deps.db
        .prepare(
          `INSERT INTO alchemy_webhook_registry
             (chain_id, webhook_id, signing_key_ciphertext, webhook_url, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(1, "wh_registered", ciphertext, "https://x", now, now)
        .run();

      const body = JSON.stringify({ webhookId: "wh_registered", event: { network: "ETH_MAINNET", activity: [] } });
      // Attacker-style: sign with the env key to try to spoof the registered webhook.
      const sig = bytesToHex(await hmacSha256(envKey, body));
      const res = await booted.app.fetch(
        new Request("http://test.local/webhooks/alchemy", {
          method: "POST",
          headers: { "content-type": "application/json", "x-alchemy-signature": sig },
          body
        })
      );
      expect(res.status).toBe(401);
    } finally {
      await booted.close();
    }
  });

  it("falls back to env ALCHEMY_NOTIFY_SIGNING_KEY when webhookId has no registry row", async () => {
    const envKey = "env-legacy-key-xyz";
    const booted = await bootTestApp({
      chains: [evmChainAdapter({ chainIds: [1], transports: { 1: noopTransport } })],
      pushStrategies: { "alchemy-notify": alchemyNotifyDetection() },
      secretsOverrides: { ALCHEMY_NOTIFY_SIGNING_KEY: envKey, MASTER_SEED: HARDHAT_MNEMONIC }
    });
    try {
      // Registry is empty — the env fallback carries verification.
      const body = JSON.stringify({
        webhookId: "wh_unknown",
        event: { network: "ETH_MAINNET", activity: [] }
      });
      const sig = bytesToHex(await hmacSha256(envKey, body));
      const res = await booted.app.fetch(
        new Request("http://test.local/webhooks/alchemy", {
          method: "POST",
          headers: { "content-type": "application/json", "x-alchemy-signature": sig },
          body
        })
      );
      expect(res.status).toBe(200);
    } finally {
      await booted.close();
    }
  });

  it("404 when neither registry nor env has a matching signing key", async () => {
    const booted = await bootTestApp({
      chains: [evmChainAdapter({ chainIds: [1], transports: { 1: noopTransport } })],
      pushStrategies: { "alchemy-notify": alchemyNotifyDetection() },
      // No env signing key, no registry row, provider is configured though.
      secretsOverrides: { MASTER_SEED: HARDHAT_MNEMONIC }
    });
    try {
      const body = JSON.stringify({ webhookId: "wh_nothing", event: { network: "ETH_MAINNET", activity: [] } });
      const sig = bytesToHex(await hmacSha256("irrelevant", body));
      const res = await booted.app.fetch(
        new Request("http://test.local/webhooks/alchemy", {
          method: "POST",
          headers: { "content-type": "application/json", "x-alchemy-signature": sig },
          body
        })
      );
      expect(res.status).toBe(404);
    } finally {
      await booted.close();
    }
  });
});
