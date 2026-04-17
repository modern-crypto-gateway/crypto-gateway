import type { Logger } from "../../core/ports/logger.port.js";
import type { SecretsCipher } from "../../core/ports/secrets-cipher.port.js";
import {
  ALCHEMY_FAMILY_BY_CHAIN_ID,
  ALCHEMY_NETWORK_BY_CHAIN_ID,
  ALCHEMY_PLACEHOLDER_ADDRESS_BY_FAMILY
} from "./alchemy-network.js";
import type { AlchemyAdminClient, AlchemyWebhookSummary } from "./alchemy-admin-client.js";
import type { AlchemyRegistryStore } from "./alchemy-registry-store.js";

// Idempotent bootstrap: for each desired chain, ensure Alchemy has an
// ADDRESS_ACTIVITY webhook pointed at our URL. Webhooks that already match
// (same URL + same network) are reported as "existing"; missing ones are
// created and their signing_key is persisted (encrypted) into
// `alchemy_webhook_registry`. Dashboard-created webhooks can be back-filled
// via `POST /admin/alchemy-webhooks/signing-keys`.
//
// Design notes:
//   - Alchemy's `/create-webhook` requires ≥1 address at creation. We seed
//     with a chain-family-correct placeholder (EVM: 0x0…0, Solana: base58
//     all-zeros "11111…"), then IMMEDIATELY remove that placeholder from
//     the watch list. Real HD-derived receive addresses are added later via
//     the subscription-sync sweep as invoices are placed.
//   - WHY the placeholder is removed straight away: the EVM zero address
//     is the source/sink of every ERC-20 mint/burn — watching it floods
//     the gateway with thousands of irrelevant events per minute. The
//     Solana System Program address is inert as an SPL transfer recipient
//     but we remove it too for symmetry.
//   - Self-healing on re-run: existing webhooks also get their placeholder
//     removed, so an operator who hit an earlier version of this code can
//     recover simply by re-running bootstrap.
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
  // True when the placeholder address was successfully removed from the
  // watch list post-create. False means the remove call failed (non-fatal;
  // operator can call /update-webhook-addresses manually) or the webhook
  // was created by an earlier code path that didn't use a placeholder.
  placeholderRemoved?: boolean;
  error?: string;
}

export interface BootstrapAlchemyWebhooksArgs {
  client: AlchemyAdminClient;
  // Our publicly reachable URL that Alchemy will POST to, e.g.
  // "https://gateway.example.com/webhooks/alchemy".
  webhookUrl: string;
  // ChainIds to bootstrap. Typical: same list as the Alchemy RPC set.
  chainIds: readonly number[];
  // Override the per-family placeholder seed. If supplied for a chainId,
  // bootstrap uses this address AS-IS and does NOT remove it post-create
  // (caller wanted something specific, so keep it watched).
  seedAddressByChainId?: Readonly<Record<number, string>>;
  // When present, freshly created webhooks get their { webhookId, signingKey }
  // persisted so the inbound ingest route can resolve HMAC keys from the
  // payload's `webhookId`. Existing webhooks are NOT upserted (Alchemy
  // doesn't return signing_key on list — we only have it at create time).
  registryStore?: AlchemyRegistryStore;
  // Required when `registryStore` is set: the signingKey is encrypted before
  // writing so the row is useless to anyone with DB-read-only access. Without
  // this, bootstrap refuses to persist (would be silently storing plaintext).
  secretsCipher?: SecretsCipher;
  // Optional logger for placeholder-removal errors (non-fatal path).
  logger?: Logger;
  // Clock injection so tests can assert persisted timestamps deterministically.
  now?: () => number;
}

export async function bootstrapAlchemyWebhooks(
  args: BootstrapAlchemyWebhooksArgs
): Promise<readonly BootstrapPerChainResult[]> {
  const results: BootstrapPerChainResult[] = [];
  const existingWebhooks = await args.client.listWebhooks();

  for (const chainId of args.chainIds) {
    const network = ALCHEMY_NETWORK_BY_CHAIN_ID[chainId];
    const family = ALCHEMY_FAMILY_BY_CHAIN_ID[chainId];
    if (network === undefined || family === undefined) {
      results.push({ chainId, status: "unsupported" });
      continue;
    }

    const operatorSeed = args.seedAddressByChainId?.[chainId];
    const usingPlaceholder = operatorSeed === undefined;
    const seed = operatorSeed ?? ALCHEMY_PLACEHOLDER_ADDRESS_BY_FAMILY[family];

    const match = findMatchingWebhook(existingWebhooks, network, args.webhookUrl);
    if (match !== null) {
      const result: BootstrapPerChainResult = { chainId, status: "existing", webhookId: match.id };
      // Self-heal: clean the placeholder off the existing webhook's watch list
      // in case an earlier bootstrap run (pre-fix) left it there. Idempotent
      // — Alchemy treats removes of addresses not on the list as no-ops.
      if (usingPlaceholder) {
        result.placeholderRemoved = await removeSeedAddress(args, match.id, seed);
      }
      results.push(result);
      continue;
    }

    try {
      const created = await args.client.createWebhook({
        chainId,
        webhookUrl: args.webhookUrl,
        addresses: [seed],
        name: nameForWebhook(chainId, family)
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
        if (args.secretsCipher === undefined) {
          result.persisted = false;
          result.error =
            "webhook created in Alchemy but registry upsert skipped: missing secretsCipher (refusing to store signingKey plaintext)";
        } else {
          try {
            const ciphertext = await args.secretsCipher.encrypt(created.signing_key);
            await args.registryStore.upsert({
              chainId,
              webhookId: created.id,
              signingKeyCiphertext: ciphertext,
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
      }

      // Immediately drop the placeholder off the watch list so the gateway
      // isn't flooded with mint/burn events on the zero address. Only when
      // we used the default placeholder — operator-supplied seeds stay.
      if (usingPlaceholder) {
        result.placeholderRemoved = await removeSeedAddress(args, created.id, seed);
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

// Best-effort: remove the seed address from a webhook's watch list so we
// don't receive events for it. Returns true on success, false on failure.
// Failures are logged but NEVER fail the bootstrap — the webhook exists
// either way; an operator can clean up via /update-webhook-addresses.
async function removeSeedAddress(
  args: BootstrapAlchemyWebhooksArgs,
  webhookId: string,
  seed: string
): Promise<boolean> {
  try {
    await args.client.updateWebhookAddresses({
      webhookId,
      addressesToRemove: [seed]
    });
    return true;
  } catch (err) {
    args.logger?.warn(
      "bootstrap: could not remove placeholder seed address from webhook; remove it manually via Alchemy's /update-webhook-addresses or the dashboard",
      {
        webhookId,
        seed,
        error: err instanceof Error ? err.message : String(err)
      }
    );
    return false;
  }
}

function nameForWebhook(chainId: number, family: string): string {
  return `crypto-gateway ${family}-${chainId}`;
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
