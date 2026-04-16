import { describe, expect, it, vi } from "vitest";
import { alchemyAdminClient } from "../../adapters/detection/alchemy-admin-client.js";
import {
  bootstrapAlchemyWebhooks,
  type BootstrapPerChainResult
} from "../../adapters/detection/bootstrap-alchemy-webhooks.js";
import type { AlchemyAdminClient, AlchemyWebhookSummary } from "../../adapters/detection/alchemy-admin-client.js";

describe("alchemyAdminClient", () => {
  it("lists webhooks via GET /team-webhooks with the X-Alchemy-Token header", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ id: "wh_1", network: "ETH_MAINNET", webhook_type: "ADDRESS_ACTIVITY", webhook_url: "https://x", is_active: true }] }), { status: 200 })
    );
    const client = alchemyAdminClient({ authToken: "at_test", fetch });
    const result = await client.listWebhooks();
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("wh_1");

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://dashboard.alchemy.com/api/team-webhooks");
    expect(new Headers(init?.headers).get("x-alchemy-token")).toBe("at_test");
  });

  it("createWebhook POSTs the correct body and returns signing_key", async () => {
    let capturedBody: string | null = null;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = (init?.body as string) ?? null;
      return new Response(
        JSON.stringify({
          data: {
            id: "wh_new",
            network: "ETH_MAINNET",
            webhook_type: "ADDRESS_ACTIVITY",
            webhook_url: "https://gateway.example.com/webhooks/alchemy",
            is_active: true,
            signing_key: "whsec_abc"
          }
        }),
        { status: 200 }
      );
    });
    const client = alchemyAdminClient({ authToken: "at", fetch });
    const result = await client.createWebhook({
      chainId: 1,
      webhookUrl: "https://gateway.example.com/webhooks/alchemy",
      addresses: ["0x1111111111111111111111111111111111111111"]
    });
    expect(result.id).toBe("wh_new");
    expect(result.signing_key).toBe("whsec_abc");
    expect(capturedBody).not.toBeNull();
    const body = JSON.parse(capturedBody!);
    expect(body).toMatchObject({
      network: "ETH_MAINNET",
      webhook_type: "ADDRESS_ACTIVITY",
      webhook_url: "https://gateway.example.com/webhooks/alchemy"
    });
  });

  it("throws a clear error when Alchemy responds non-2xx", async () => {
    const fetch = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const client = alchemyAdminClient({ authToken: "at", fetch });
    await expect(client.listWebhooks()).rejects.toThrow(/403/);
  });

  it("refuses to create a webhook for an Alchemy-unsupported chain id", async () => {
    const client = alchemyAdminClient({ authToken: "at", fetch: vi.fn() });
    await expect(
      client.createWebhook({ chainId: 99999, webhookUrl: "https://x", addresses: ["0x01"] })
    ).rejects.toThrow(/does not support chainId/);
  });

  it("refuses an empty addresses array (Alchemy requires at least one)", async () => {
    const client = alchemyAdminClient({ authToken: "at", fetch: vi.fn() });
    await expect(
      client.createWebhook({ chainId: 1, webhookUrl: "https://x", addresses: [] })
    ).rejects.toThrow(/at least one/);
  });
});

// Fake admin client factory — tests inject one of these to drive the bootstrap
// logic without talking to Alchemy.
function fakeClient(overrides: {
  listWebhooks?: () => Promise<readonly AlchemyWebhookSummary[]>;
  createWebhook?: (args: Parameters<AlchemyAdminClient["createWebhook"]>[0]) => Promise<AlchemyWebhookSummary>;
  updateWebhookAddresses?: (args: Parameters<AlchemyAdminClient["updateWebhookAddresses"]>[0]) => Promise<void>;
}): AlchemyAdminClient {
  return {
    listWebhooks: overrides.listWebhooks ?? (async () => []),
    createWebhook:
      overrides.createWebhook ??
      (async () => {
        throw new Error("unexpected createWebhook call");
      }),
    updateWebhookAddresses:
      overrides.updateWebhookAddresses ??
      (async () => {
        throw new Error("unexpected updateWebhookAddresses call");
      })
  };
}

describe("bootstrapAlchemyWebhooks", () => {
  it("creates missing webhooks and returns signing keys for them", async () => {
    const created: Array<{ chainId: number }> = [];
    const client = fakeClient({
      listWebhooks: async () => [],
      createWebhook: async (args) => {
        created.push({ chainId: args.chainId });
        return {
          id: `wh_${args.chainId}`,
          network: "ETH_MAINNET",
          webhook_type: "ADDRESS_ACTIVITY",
          webhook_url: args.webhookUrl,
          is_active: true,
          signing_key: `whsec_${args.chainId}`
        };
      }
    });
    const results = await bootstrapAlchemyWebhooks({
      client,
      webhookUrl: "https://gateway.example.com/webhooks/alchemy",
      chainIds: [1, 137]
    });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "created")).toBe(true);
    expect(results.map((r) => r.signingKey)).toEqual(["whsec_1", "whsec_137"]);
    expect(created.map((c) => c.chainId)).toEqual([1, 137]);
  });

  it("reports existing webhooks without creating a duplicate (idempotent on re-run)", async () => {
    const client = fakeClient({
      listWebhooks: async () => [
        {
          id: "wh_existing",
          network: "ETH_MAINNET",
          webhook_type: "ADDRESS_ACTIVITY",
          webhook_url: "https://gateway.example.com/webhooks/alchemy",
          is_active: true
        }
      ],
      createWebhook: async () => {
        throw new Error("createWebhook should not be called for existing match");
      }
    });
    const results = await bootstrapAlchemyWebhooks({
      client,
      webhookUrl: "https://gateway.example.com/webhooks/alchemy",
      chainIds: [1]
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual<BootstrapPerChainResult>({
      chainId: 1,
      status: "existing",
      webhookId: "wh_existing"
    });
  });

  it("flags chainIds Alchemy does not support as 'unsupported'", async () => {
    const client = fakeClient({});
    const results = await bootstrapAlchemyWebhooks({
      client,
      webhookUrl: "https://x",
      chainIds: [999, 1]
    });
    expect(results[0]?.status).toBe("unsupported");
    // 1 also fails because our stub rejects createWebhook; verify the ordering.
    expect(results[1]?.chainId).toBe(1);
  });

  it("mixed run: creates one, skips one that exists, reports one unsupported", async () => {
    const client = fakeClient({
      listWebhooks: async () => [
        {
          id: "wh_polygon",
          network: "MATIC_MAINNET",
          webhook_type: "ADDRESS_ACTIVITY",
          webhook_url: "https://gateway.example.com/webhooks/alchemy",
          is_active: true
        }
      ],
      createWebhook: async (args) => ({
        id: `wh_${args.chainId}`,
        network: "ETH_MAINNET",
        webhook_type: "ADDRESS_ACTIVITY",
        webhook_url: args.webhookUrl,
        is_active: true,
        signing_key: `whsec_${args.chainId}`
      })
    });
    const results = await bootstrapAlchemyWebhooks({
      client,
      webhookUrl: "https://gateway.example.com/webhooks/alchemy",
      chainIds: [1, 137, 99999]
    });
    expect(results.map((r) => ({ chainId: r.chainId, status: r.status }))).toEqual([
      { chainId: 1, status: "created" },
      { chainId: 137, status: "existing" },
      { chainId: 99999, status: "unsupported" }
    ]);
  });

  it("captures createWebhook errors as per-chain 'failed' without aborting the loop", async () => {
    const client = fakeClient({
      listWebhooks: async () => [],
      createWebhook: async (args) => {
        if (args.chainId === 1) throw new Error("rate limited");
        return {
          id: `wh_${args.chainId}`,
          network: "MATIC_MAINNET",
          webhook_type: "ADDRESS_ACTIVITY",
          webhook_url: args.webhookUrl,
          is_active: true,
          signing_key: `whsec_${args.chainId}`
        };
      }
    });
    const results = await bootstrapAlchemyWebhooks({
      client,
      webhookUrl: "https://x",
      chainIds: [1, 137]
    });
    expect(results[0]).toMatchObject({ chainId: 1, status: "failed", error: expect.stringContaining("rate limited") });
    expect(results[1]).toMatchObject({ chainId: 137, status: "created" });
  });
});
