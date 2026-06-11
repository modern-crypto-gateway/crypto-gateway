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
  TRON_NILE_CHAIN_ID,
  type TronEnergyRentalConfig
} from "./tron-chain.adapter.js";
import {
  tronSaveProvider,
  TRONSAVE_MAINNET_URL,
  TRONSAVE_NILE_URL
} from "../../energy-rental/tronsave.adapter.js";
import { tronEnergyMarketProvider } from "../../energy-rental/tronenergymarket.adapter.js";
import type { EnergyRentalProvider } from "../../energy-rental/energy-rental.port.js";

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
  // Energy-rental markets. Setting any provider's credentials enables
  // rent-vs-burn for TRC-20 payouts (see prepareGasForBroadcast): the
  // executor quotes every configured market per payout, the cheapest
  // viable estimate wins the order, and any failure falls back to the
  // next market and finally to burning TRX.
  //
  // tronenergy.market (TEM): cheapest observed for 10-min rentals
  // (~35 SUN/unit vs TronSave's ~65). Requires the API key AND the TEM
  // account address the key was issued for (orders are paid from that
  // account's prepaid credit). Mainnet only — TEM has no Nile environment,
  // so on Nile this provider is skipped with a warning.
  tronEnergyMarketApiKey?: string;
  tronEnergyMarketAddress?: string;
  // TronSave: pricier but battle-tested API with server-side price caps.
  // Orders draw from the operator's prepaid TronSave balance. Nile selects
  // TronSave's dev environment (api-dev.tronsave.io) automatically — the
  // key must be issued there.
  tronsaveApiKey?: string;
  // Pin rental to a single provider by name ("tronsave" |
  // "tronenergy.market"), bypassing cheapest-wins selection. Use when a
  // prepaid balance must be drained first (e.g. TronSave deposits can't be
  // self-withdrawn). Pinning a provider that isn't configured (or was
  // skipped) disables rental entirely with a warning — burning is honest;
  // silently substituting a different market is not.
  energyRentalPinnedProvider?: string;
  // Optional absolute cap (SUN per energy unit) on top of the built-in
  // dynamic ceiling of 90% of the live chain burn rate.
  tronsaveMaxUnitPriceSun?: number;
  // Rental duration in seconds (default 10min — the cheapest sub-day
  // bucket; the rented energy is consumed seconds after the fill).
  tronsaveDurationSec?: number;
  // How long the executor waits for an order to fill before deferring the
  // payout to the next tick (default 30s).
  tronsaveFillTimeoutMs?: number;
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

  // Energy rental markets. Wired only when the operator supplied
  // credentials; without any, the adapter keeps the pure burn-path
  // behavior. Selection between configured providers is by live price at
  // payout time, not by order here.
  const rentalProviders: EnergyRentalProvider[] = [];
  if (
    input.tronEnergyMarketApiKey !== undefined &&
    input.tronEnergyMarketApiKey.length > 0 &&
    input.tronEnergyMarketAddress !== undefined &&
    input.tronEnergyMarketAddress.length > 0
  ) {
    if (input.network === "nile") {
      input.logger.warn(
        "tronenergy.market has no Nile environment; provider skipped. Use TronSave (api-dev) for testnet rental."
      );
    } else {
      rentalProviders.push(
        tronEnergyMarketProvider({
          apiKey: input.tronEnergyMarketApiKey,
          accountAddress: input.tronEnergyMarketAddress
        })
      );
    }
  } else if (input.tronEnergyMarketApiKey !== undefined && input.tronEnergyMarketApiKey.length > 0) {
    input.logger.warn(
      "TRONENERGY_MARKET_API_KEY set without TRONENERGY_MARKET_ADDRESS; provider skipped (orders are paid from that account's credit)."
    );
  }
  if (input.tronsaveApiKey !== undefined && input.tronsaveApiKey.length > 0) {
    rentalProviders.push(
      tronSaveProvider({
        apiKey: input.tronsaveApiKey,
        baseUrl: input.network === "nile" ? TRONSAVE_NILE_URL : TRONSAVE_MAINNET_URL
      })
    );
  }
  let pinnedProviders = rentalProviders;
  if (input.energyRentalPinnedProvider !== undefined && input.energyRentalPinnedProvider.length > 0) {
    pinnedProviders = rentalProviders.filter((p) => p.name === input.energyRentalPinnedProvider);
    if (pinnedProviders.length === 0 && rentalProviders.length > 0) {
      input.logger.warn(
        "tron energy rental disabled: pinned provider is not configured/available; payouts will burn TRX",
        {
          pinned: input.energyRentalPinnedProvider,
          configured: rentalProviders.map((p) => p.name)
        }
      );
    }
  }
  let energyRental: TronEnergyRentalConfig | undefined;
  if (pinnedProviders.length > 0) {
    energyRental = { providers: pinnedProviders, logger: input.logger };
    if (input.tronsaveMaxUnitPriceSun !== undefined) energyRental.maxUnitPriceSun = input.tronsaveMaxUnitPriceSun;
    if (input.tronsaveDurationSec !== undefined) energyRental.durationSec = input.tronsaveDurationSec;
    if (input.tronsaveFillTimeoutMs !== undefined) energyRental.fillTimeoutMs = input.tronsaveFillTimeoutMs;
    input.logger.info("tron energy rental wired", {
      providers: pinnedProviders.map((p) => p.name),
      ...(input.energyRentalPinnedProvider !== undefined ? { pinned: input.energyRentalPinnedProvider } : {}),
      network: input.network
    });
  }

  const chainAdapter = tronChainAdapter({
    chainIds: [chainId],
    clients: { [chainId]: client },
    ...(energyRental !== undefined ? { energyRental } : {})
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
