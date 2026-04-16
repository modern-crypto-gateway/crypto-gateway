import type { AppDeps } from "../../core/app-deps.js";
import type { DetectionStrategy } from "../../core/ports/detection.port.ts";
import type { ChainId } from "../../core/types/chain.js";
import { findChainAdapter } from "../../core/domain/chain-lookup.js";
import type { DetectedTransfer } from "../../core/types/transaction.js";
import { TOKEN_REGISTRY } from "../../core/types/token-registry.js";
import type { AmountRaw } from "../../core/types/money.js";
import { CHAIN_ID_BY_ALCHEMY_NETWORK } from "./alchemy-network.js";

// Alchemy's ADDRESS_ACTIVITY payload shape. Pared down to the fields we read;
// ignored fields (webhookId, hash confirmations, contractMetadata, etc.) stay out
// of the typed surface so a version bump that adds fields doesn't break parsing.
interface AlchemyActivityEvent {
  fromAddress?: string;
  toAddress?: string;
  blockNum?: string; // hex "0x1234"
  hash?: string;
  asset?: string;
  category?: string; // "token" | "external" | "internal" | ...
  rawContract?: {
    rawValue?: string; // hex "0x..."
    address?: string;  // null for native transfers
    decimals?: number;
  };
  log?: { logIndex?: string };
}

interface AlchemyPayload {
  webhookId?: string;
  id?: string;
  createdAt?: string;
  type?: string;
  event?: {
    network?: string;
    activity?: readonly AlchemyActivityEvent[];
  };
}

// DetectionStrategy.handlePush for Alchemy Notify webhooks. The route handler
// (http/routes/webhooks-ingest.ts) verifies the HMAC signature and parses the
// JSON body; this adapter turns the parsed payload into DetectedTransfer[].

export function alchemyNotifyDetection(): DetectionStrategy {
  return {
    async handlePush(deps: AppDeps, rawPayload: unknown): Promise<readonly DetectedTransfer[]> {
      const payload = rawPayload as AlchemyPayload;
      if (payload.type !== "ADDRESS_ACTIVITY") return [];

      const network = payload.event?.network;
      if (!network) return [];
      const chainIdNumber = CHAIN_ID_BY_ALCHEMY_NETWORK[network];
      if (chainIdNumber === undefined) {
        // Unknown network — the operator added a webhook for a chain we don't
        // serve. Silently drop so a misconfigured webhook never poisons the
        // ingest pipeline.
        return [];
      }
      const chainId = chainIdNumber as ChainId;

      const chainAdapter = findChainAdapter(deps, chainId);

      // Build a contract-address -> symbol map from the registry for this chain.
      // ERC-20 transfers arrive with rawContract.address; we need that to
      // resolve the token symbol (Alchemy's `asset` field is human-readable but
      // unreliable — empty for unknown contracts, and shadows our registry when
      // Alchemy disagrees on the ticker).
      const symbolByContract = new Map<string, string>();
      for (const t of TOKEN_REGISTRY) {
        if (t.chainId !== chainIdNumber) continue;
        if (t.contractAddress === null) continue;
        symbolByContract.set(t.contractAddress.toLowerCase(), t.symbol);
      }

      const activities = payload.event?.activity ?? [];
      const transfers: DetectedTransfer[] = [];
      for (const activity of activities) {
        const parsed = parseActivity(activity, chainId, chainAdapter, symbolByContract);
        if (parsed) transfers.push(parsed);
      }
      return transfers;
    }
  };
}

function parseActivity(
  activity: AlchemyActivityEvent,
  chainId: ChainId,
  chainAdapter: ReturnType<typeof findChainAdapter>,
  symbolByContract: Map<string, string>
): DetectedTransfer | null {
  const { fromAddress, toAddress, hash, blockNum, category } = activity;
  if (!fromAddress || !toAddress || !hash) return null;

  // Only token transfers are supported in Phase 4b. Native (category "external")
  // can be added when the EVM adapter grows a native-scan path.
  if (category !== "token") return null;

  const contractAddress = activity.rawContract?.address;
  if (!contractAddress) return null;
  const symbol = symbolByContract.get(contractAddress.toLowerCase());
  if (!symbol) return null;

  const rawValueHex = activity.rawContract?.rawValue;
  if (!rawValueHex) return null;
  let amountRaw: string;
  try {
    amountRaw = BigInt(rawValueHex).toString();
  } catch {
    return null;
  }

  let blockNumber: number | null = null;
  if (blockNum) {
    try {
      blockNumber = Number(BigInt(blockNum));
    } catch {
      blockNumber = null;
    }
  }

  let logIndex: number | null = null;
  if (activity.log?.logIndex) {
    try {
      logIndex = Number(BigInt(activity.log.logIndex));
    } catch {
      logIndex = null;
    }
  }

  // Canonicalize addresses so downstream matching against order.receive_address
  // works regardless of the casing Alchemy reports.
  let canonicalFrom: string;
  let canonicalTo: string;
  try {
    canonicalFrom = chainAdapter.canonicalizeAddress(fromAddress);
    canonicalTo = chainAdapter.canonicalizeAddress(toAddress);
  } catch {
    return null;
  }

  return {
    chainId,
    txHash: hash,
    logIndex,
    fromAddress: canonicalFrom,
    toAddress: canonicalTo,
    token: symbol,
    amountRaw: amountRaw as AmountRaw,
    blockNumber,
    // Alchemy Notify fires on the first confirmation. Treat as 1 confirmation;
    // the sweeper will re-query `getConfirmationStatus` for the authoritative depth.
    confirmations: 1,
    seenAt: new Date()
  };
}
