// Thin fetch wrapper around Alchemy's webhook-management API (distinct from
// their JSON-RPC API — different base URL, different auth).
//
// Auth: `X-Alchemy-Token: <notify-token>` where the token comes from the top
// of https://dashboard.alchemy.com/apps/latest/webhooks (labelled "Auth
// Token"). This is distinct from the per-app JSON-RPC API key despite the
// similar-looking UI labels — env var name is `ALCHEMY_NOTIFY_TOKEN`.
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

export interface UpdateWebhookAddressesArgs {
  webhookId: string;
  // Empty arrays are allowed — Alchemy accepts a no-op call. Callers may want
  // to skip the round-trip when both lists are empty; this client does not.
  addressesToAdd?: readonly string[];
  addressesToRemove?: readonly string[];
}

export interface AlchemyAdminClient {
  listWebhooks(): Promise<readonly AlchemyWebhookSummary[]>;
  createWebhook(args: CreateWebhookArgs): Promise<AlchemyWebhookSummary>;
  // Mutate the watched-addresses set of an existing webhook. Alchemy's
  // `/update-webhook-addresses` endpoint accepts both add + remove in one
  // call, so the sweep batches both per chain.
  updateWebhookAddresses(args: UpdateWebhookAddressesArgs): Promise<void>;
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
        // 401 on this API is nearly always operator confusion between the
        // webhook auth token (X-Alchemy-Token, dashboard.alchemy.com/apps/
        // latest/webhooks — top of page) and the per-app JSON-RPC API key.
        // Both strings look similar and both are labelled "key" in the UI.
        // Surface a pointer rather than forcing the operator to grep docs.
        if (res.status === 401) {
          throw new Error(
            `Alchemy admin ${path} returned 401: invalid ALCHEMY_NOTIFY_TOKEN. ` +
              "This is the webhook management token (dashboard.alchemy.com/apps/latest/webhooks — 'Auth Token' at the top), NOT your JSON-RPC API key. " +
              `Raw: ${text.slice(0, 128)}`
          );
        }
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
    },

    async updateWebhookAddresses(args) {
      await request<unknown>("/update-webhook-addresses", {
        method: "PATCH",
        body: JSON.stringify({
          webhook_id: args.webhookId,
          addresses_to_add: args.addressesToAdd ?? [],
          addresses_to_remove: args.addressesToRemove ?? []
        })
      });
    }
  };
}
