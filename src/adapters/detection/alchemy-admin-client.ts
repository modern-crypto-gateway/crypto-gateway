// Thin fetch wrapper around Alchemy's webhook-management API (distinct from
// their JSON-RPC API — different base URL, different auth).
//
// Auth: `X-Alchemy-Token: <auth-token>` where the token comes from
// https://dashboard.alchemy.com/webhooks > Auth Token.
//
// Used by `bootstrapAlchemyWebhooks` to list + create webhooks idempotently,
// and by future address-sync jobs to add/remove addresses on the existing
// webhooks.

import { ALCHEMY_NETWORK_BY_CHAIN_ID } from "./alchemy-network.js";

export type AlchemyAdminFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface AlchemyAdminClientConfig {
  // Auth token from the Alchemy dashboard. NOT the JSON-RPC API key.
  authToken: string;
  // Base URL. Defaults to https://dashboard.alchemy.com/api. Injectable for
  // testing + for pointing at a recorded replay in CI.
  baseUrl?: string;
  // Injectable fetch for tests.
  fetch?: AlchemyAdminFetch;
  // Per-request timeout in ms. Defaults to 15s.
  timeoutMs?: number;
}

export interface AlchemyWebhookSummary {
  id: string;
  network: string;        // e.g. "ETH_MAINNET"
  webhook_type: string;   // e.g. "ADDRESS_ACTIVITY"
  webhook_url: string;
  is_active: boolean;
  signing_key?: string;   // only present on create-webhook response; list endpoint hides it
}

export interface CreateWebhookArgs {
  chainId: number;
  webhookUrl: string;
  // Initial address list. Alchemy requires at least one address at create time;
  // supply a placeholder if you plan to add real addresses later via update.
  addresses: readonly string[];
}

export interface AlchemyAdminClient {
  listWebhooks(): Promise<readonly AlchemyWebhookSummary[]>;
  createWebhook(args: CreateWebhookArgs): Promise<AlchemyWebhookSummary>;
}

export function alchemyAdminClient(config: AlchemyAdminClientConfig): AlchemyAdminClient {
  const doFetch: AlchemyAdminFetch = config.fetch ?? ((u, i) => globalThis.fetch(u, i));
  const baseUrl = (config.baseUrl ?? "https://dashboard.alchemy.com/api").replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 15_000;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "X-Alchemy-Token": config.authToken,
          ...(init?.headers ?? {})
        }
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Alchemy admin ${path} returned ${res.status}: ${text.slice(0, 256)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async listWebhooks() {
      const body = await request<{ data?: readonly AlchemyWebhookSummary[] }>("/team-webhooks");
      return body.data ?? [];
    },

    async createWebhook(args) {
      const network = ALCHEMY_NETWORK_BY_CHAIN_ID[args.chainId];
      if (network === undefined) {
        throw new Error(`Alchemy does not support chainId ${args.chainId}`);
      }
      if (args.addresses.length === 0) {
        throw new Error("Alchemy createWebhook requires at least one address");
      }
      const body = await request<{ data: AlchemyWebhookSummary }>("/create-webhook", {
        method: "POST",
        body: JSON.stringify({
          network,
          webhook_type: "ADDRESS_ACTIVITY",
          webhook_url: args.webhookUrl,
          addresses: args.addresses
        })
      });
      return body.data;
    }
  };
}
