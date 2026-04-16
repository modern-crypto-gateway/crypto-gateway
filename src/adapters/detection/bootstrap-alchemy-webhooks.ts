import { ALCHEMY_NETWORK_BY_CHAIN_ID } from "./alchemy-network.js";
import type { AlchemyAdminClient, AlchemyWebhookSummary } from "./alchemy-admin-client.js";
import type { AlchemyRegistryStore } from "./alchemy-registry-store.js";

// Idempotent bootstrap: for each desired chain, ensure Alchemy has an
// ADDRESS_ACTIVITY webhook pointed at our URL. Webhooks that already match
// (same URL + same network) are reported as "existing" and nothing is changed.
// Webhooks missing are created and their signing_key is returned ONCE for the
// operator to stash in env as `ALCHEMY_NOTIFY_SIGNING_KEY`.
//
// Design notes:
//   - Per Alchemy's API, `/create-webhook` requires at least one address at
//     creation time. We seed with a placeholder address (the zero address);
//     real HD-derived addresses get registered later via
//     `/update-webhook-addresses` — that's a separate follow-up sync job.
//   - Safe to call repeatedly: the list-first step prevents duplicate
//     webhooks from piling up if the operator re-runs the bootstrap.
//   - All chainIds that Alchemy doesn't serve are flagged as `unsupported`
//     rather than silently dropped — surfaces config mistakes clearly.

export interface BootstrapPerChainResult {
  chainId: number;
  // One of:
  //   - "created"     : we just created a new webhook. `signing_key` is set.
  //   - "existing"    : a webhook with the same URL+network already existed.
  //   - "unsupported" : Alchemy doesn't serve this chainId.
  //   - "failed"      : the API call threw. `error` is set.
  status: "created" | "existing" | "unsupported" | "failed";
  webhookId?: string;
  signingKey?: string;
  // True when the registry row was persisted to the DB. Only meaningful on
  // status=created with a registryStore provided. When false on a `created`
  // result, the operator still has `signingKey` in-response and must stash
  // it manually — the webhook exists in Alchemy but our DB doesn't know its key.
  persisted?: boolean;
  error?: string;
}

export interface BootstrapAlchemyWebhooksArgs {
  client: AlchemyAdminClient;
  // Our publicly reachable URL that Alchemy will POST to, e.g.
  // "https://gateway.example.com/webhooks/alchemy".
  webhookUrl: string;
  // ChainIds to bootstrap. Typical: same list as the Alchemy RPC set.
  chainIds: readonly number[];
  // Placeholder addresses seeded at webhook creation. Alchemy requires at
  // least one. The zero address is safe but must match the chain family's
  // canonical form — the caller supplies it.
  seedAddressByChainId?: Readonly<Record<number, string>>;
  // When present, freshly created webhooks get their { webhookId, signingKey }
  // persisted so the inbound ingest route can resolve HMAC keys from the
  // payload's `webhookId`. Existing webhooks are NOT upserted (Alchemy
  // doesn't return signing_key on list — we only have it at create time).
  registryStore?: AlchemyRegistryStore;
  // Clock injection so tests can assert persisted timestamps deterministically.
  now?: () => number;
}

const ZERO_EVM_ADDRESS = "0x0000000000000000000000000000000000000000";

export async function bootstrapAlchemyWebhooks(
  args: BootstrapAlchemyWebhooksArgs
): Promise<readonly BootstrapPerChainResult[]> {
  const results: BootstrapPerChainResult[] = [];
  const existingWebhooks = await args.client.listWebhooks();

  for (const chainId of args.chainIds) {
    const network = ALCHEMY_NETWORK_BY_CHAIN_ID[chainId];
    if (network === undefined) {
      results.push({ chainId, status: "unsupported" });
      continue;
    }

    const match = findMatchingWebhook(existingWebhooks, network, args.webhookUrl);
    if (match !== null) {
      results.push({ chainId, status: "existing", webhookId: match.id });
      continue;
    }

    try {
      const seed = args.seedAddressByChainId?.[chainId] ?? ZERO_EVM_ADDRESS;
      const created = await args.client.createWebhook({
        chainId,
        webhookUrl: args.webhookUrl,
        addresses: [seed]
      });
      const result: BootstrapPerChainResult = {
        chainId,
        status: "created",
        webhookId: created.id
      };
      if (created.signing_key !== undefined) result.signingKey = created.signing_key;

      // Persist the { chainId, webhookId, signingKey } row if the caller
      // supplied a registry store. If persistence fails after the webhook
      // was created in Alchemy, we do NOT compensate — the signingKey is
      // still in the response for the operator to stash manually, and
      // re-running bootstrap would find the webhook via `listWebhooks`
      // but wouldn't know the signing key (Alchemy doesn't return it on list).
      if (args.registryStore !== undefined && created.signing_key !== undefined) {
        try {
          await args.registryStore.upsert({
            chainId,
            webhookId: created.id,
            signingKey: created.signing_key,
            webhookUrl: args.webhookUrl,
            now: (args.now ?? Date.now)()
          });
          result.persisted = true;
        } catch (persistErr) {
          result.persisted = false;
          result.error =
            "webhook created in Alchemy but registry upsert failed: " +
            (persistErr instanceof Error ? persistErr.message : String(persistErr));
        }
      }

      results.push(result);
    } catch (err) {
      results.push({
        chainId,
        status: "failed",
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return results;
}

function findMatchingWebhook(
  webhooks: readonly AlchemyWebhookSummary[],
  network: string,
  webhookUrl: string
): AlchemyWebhookSummary | null {
  for (const wh of webhooks) {
    if (wh.network === network && wh.webhook_url === webhookUrl && wh.webhook_type === "ADDRESS_ACTIVITY") {
      return wh;
    }
  }
  return null;
}
