import type { ChainAdapter } from "../../../core/ports/chain.port.js";
import type { DetectionStrategy } from "../../../core/ports/detection.port.js";
import type { Logger } from "../../../core/ports/logger.port.js";
import { rpcPollDetection } from "../../detection/rpc-poll.adapter.js";
import {
  alchemyTronBackend,
  tronCompositeClient,
  tronGridBackend,
  type TronRpcBackend
} from "./tron-rpc.js";
import {
  tronChainAdapter,
  TRON_MAINNET_CHAIN_ID,
  TRON_NILE_CHAIN_ID
} from "./tron-chain.adapter.js";

export interface TronWiringInput {
  // Absent or empty => no Tron wiring at all.
  trongridApiKey?: string;
  // Alchemy API key (the same one used for EVM). When combined with
  // trongridApiKey, `/wallet/*` requests fail over to Alchemy on provider
  // error, keeping TronGrid budget reserved for detection. When passed
  // WITHOUT trongridApiKey, Tron payouts still work but detection is
  // silently disabled (Alchemy's Tron API has no paginated transfer-history
  // endpoint).
  alchemyApiKey?: string;
  // "mainnet" or "nile". Only TronGrid serves Nile — picking Nile together
  // with an Alchemy-only config will log a warning and return no wiring.
  network: "mainnet" | "nile";
  // Minimum wall-clock ms between detection polls. Undefined = every cron tick.
  pollIntervalMs?: number;
  logger: Logger;
}

export interface TronWiringResult {
  chainAdapter?: ChainAdapter;
  chainId?: number;
  detectionStrategy?: DetectionStrategy;
}

// Builds the Tron RPC backend list based on which API keys are configured,
// composes them behind a composite client, returns the chain adapter +
// detection strategy for the entrypoint to plug into its deps graph.
//
// Returns an empty object when no backend is configured, letting the caller
// trivially `...spread` the result into the `chains` array and
// `detectionStrategies` map.
export function wireTron(input: TronWiringInput): TronWiringResult {
  const backends: TronRpcBackend[] = [];
  const baseUrl = input.network === "nile" ? "https://nile.trongrid.io" : "https://api.trongrid.io";
  const chainId = input.network === "nile" ? TRON_NILE_CHAIN_ID : TRON_MAINNET_CHAIN_ID;

  if (input.trongridApiKey !== undefined && input.trongridApiKey.length > 0) {
    backends.push(tronGridBackend({ baseUrl, apiKey: input.trongridApiKey }));
  }

  // Alchemy only wires for mainnet — their Nile subdomain doesn't exist.
  // An operator targeting Nile without TronGrid ends up with an empty backend
  // list; the caller treats that as "Tron not wired".
  if (
    input.alchemyApiKey !== undefined &&
    input.alchemyApiKey.length > 0 &&
    input.network === "mainnet"
  ) {
    backends.push(alchemyTronBackend({ apiKey: input.alchemyApiKey }));
  }

  if (backends.length === 0) return {};

  const client = backends.length === 1
    ? backends[0]!
    : tronCompositeClient(backends, {
        onBackendSkipped: (ev) => input.logger.warn("tron backend failover", ev)
      });

  const chainAdapter = tronChainAdapter({
    chainIds: [chainId],
    clients: { [chainId]: client }
  });

  const result: TronWiringResult = { chainAdapter, chainId };
  if (client.supportsDetection) {
    const pollConfig: Parameters<typeof rpcPollDetection>[0] = {};
    if (input.pollIntervalMs !== undefined) pollConfig.minIntervalMs = input.pollIntervalMs;
    result.detectionStrategy = rpcPollDetection(pollConfig);
  } else {
    input.logger.warn(
      "tron detection disabled: no backend supports the paginated TRC-20 transfer endpoint. Set TRONGRID_API_KEY to enable detection.",
      { backends: backends.map((b) => b.name) }
    );
  }
  return result;
}
