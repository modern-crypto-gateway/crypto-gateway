// TronSave energy-rental provider (https://docs.tronsave.io).
//
// API-key mode: orders draw from a prepaid TRX balance held in a TronSave
// internal account (deposited out-of-band by the operator; min 10 TRX per
// deposit). Every request carries the lowercase `apikey` header. Mainnet
// and Nile run as fully separate environments — separate base URLs, keys,
// balances and order books.
//
// Endpoint surface used (all v2):
//   GET  /v2/user-info               → prepaid balance (SUN)
//   POST /v2/estimate-buy-resource   → market price + available supply
//   POST /v2/buy-resource            → create order (all-or-nothing)
//   GET  /v2/order/{orderId}         → fill status + actual SUN paid
//
// Responses share the envelope { error: boolean, message: string, data: T }.
// TronSave has no webhooks — callers poll getOrderStatus (their own code
// examples poll at 3s). Rate limits are 15 req/s on these endpoints, far
// above anything the payout executor generates.

import type {
  EnergyRentalEstimate,
  EnergyRentalOrderStatus,
  EnergyRentalProvider
} from "./energy-rental.port.js";

export const TRONSAVE_MAINNET_URL = "https://api.tronsave.io";
export const TRONSAVE_NILE_URL = "https://api-dev.tronsave.io";

// Smallest energy order TronSave fills. Their API reference doesn't publish
// a hard validation floor, but 32k is the bottom of their own UI/examples
// and matches the market-wide minimum other aggregators advertise; smaller
// orders come back as INVALID_PARAMS rejections or sit unmatched. Requests
// below it are clamped UP (mirrors the TEM adapter's clamp to its
// advertised minOrderEnergy): the executor rents only its shortfall, and a
// source with leftover delegation can need e.g. 20k — without the clamp
// that order is rejected and the whole shortfall burns as TRX despite a
// healthy rental market. Extra energy above the shortfall is simply unused
// (or covers sizing drift); the estimate prices the clamped amount, so the
// rent-vs-burn comparison stays honest.
export const TRONSAVE_MIN_ORDER_ENERGY = 32_000;

export type TronSaveFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface TronSaveConfig {
  apiKey: string;
  // Defaults to mainnet. Pass TRONSAVE_NILE_URL when TRON_NETWORK=nile.
  baseUrl?: string;
  fetch?: TronSaveFetch;
  timeoutMs?: number;
}

interface TronSaveEnvelope<T> {
  error?: boolean;
  message?: string;
  data?: T;
}

export function tronSaveProvider(config: TronSaveConfig): EnergyRentalProvider {
  const baseUrl = (config.baseUrl ?? TRONSAVE_MAINNET_URL).replace(/\/+$/, "");
  const doFetch: TronSaveFetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
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
          // TronSave wants the header name lowercase, value verbatim.
          apikey: config.apiKey,
          ...(init?.headers ?? {})
        }
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`TronSave ${path} returned ${res.status}: ${text.slice(0, 256)}`);
      }
      let body: TronSaveEnvelope<T>;
      try {
        body = JSON.parse(text) as TronSaveEnvelope<T>;
      } catch {
        throw new Error(`TronSave ${path} returned non-JSON body: ${text.slice(0, 256)}`);
      }
      if (body.error === true || body.data === undefined) {
        throw new Error(`TronSave ${path} rejected: ${body.message ?? "unknown error"}`);
      }
      return body.data;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: "tronsave",

    async estimateEnergyOrder(args): Promise<EnergyRentalEstimate> {
      const effectiveEnergyAmount = Math.max(args.energyAmount, TRONSAVE_MIN_ORDER_ENERGY);
      // unitPrice "MEDIUM" = TronSave's "lowest price that maximizes fill".
      // SLOW risks a no-fill on an order we need within one executor tick;
      // FAST never prices below MEDIUM. The maxPriceAccepted cap at order
      // time (not here) is what bounds the worst case.
      const data = await request<{
        unitPrice?: number;
        estimateTrx?: number;
        availableResource?: number;
      }>("/v2/estimate-buy-resource", {
        method: "POST",
        body: JSON.stringify({
          resourceType: "ENERGY",
          receiver: args.receiver,
          durationSec: args.durationSec,
          resourceAmount: effectiveEnergyAmount,
          unitPrice: "MEDIUM"
        })
      });
      const unitPriceSun = data.unitPrice ?? 0;
      const totalCostSun = data.estimateTrx ?? 0;
      if (!Number.isFinite(unitPriceSun) || unitPriceSun <= 0 || !Number.isFinite(totalCostSun) || totalCostSun <= 0) {
        throw new Error(
          `TronSave estimate returned unusable pricing (unitPrice=${data.unitPrice}, estimateTrx=${data.estimateTrx})`
        );
      }
      return {
        unitPriceSun,
        totalCostSun: BigInt(Math.ceil(totalCostSun)),
        availableEnergy: data.availableResource ?? 0,
        effectiveEnergyAmount
      };
    },

    async createEnergyOrder(args): Promise<{ orderId: string }> {
      const data = await request<{ orderId?: string }>("/v2/buy-resource", {
        method: "POST",
        body: JSON.stringify({
          resourceType: "ENERGY",
          receiver: args.receiver,
          durationSec: args.durationSec,
          resourceAmount: Math.max(args.energyAmount, TRONSAVE_MIN_ORDER_ENERGY),
          unitPrice: "MEDIUM",
          options: {
            // All-or-nothing: reject (CANNOT_FULFILLED) instead of partially
            // delegating. A partial fill would leave the broadcast burning
            // TRX for the gap — worse than not renting at all.
            onlyCreateWhenFulfilled: true,
            allowPartialFill: false,
            // Idempotency guard: a re-submission while a previous identical
            // order is still pending errors (MUST_BE_WAIT_PREVIOUS_ORDER_FILLED)
            // instead of double-buying. The caller treats that error as
            // "rental unavailable this tick" and falls back to burn.
            preventDuplicateIncompleteOrders: true,
            // Caller-computed ceiling (SUN/energy-unit), strictly below the
            // chain's burn rate. TronSave rejects fills above it.
            maxPriceAccepted: args.maxUnitPriceSun
          }
        })
      });
      if (data.orderId === undefined || data.orderId.length === 0) {
        throw new Error("TronSave buy-resource returned no orderId");
      }
      return { orderId: data.orderId };
    },

    async getOrderStatus(orderId): Promise<EnergyRentalOrderStatus> {
      const data = await request<{
        fulfilledPercent?: number;
        payoutAmount?: number;
      }>(`/v2/order/${encodeURIComponent(orderId)}`);
      return {
        fulfilledPercent: data.fulfilledPercent ?? 0,
        paidSun:
          data.payoutAmount !== undefined && Number.isFinite(data.payoutAmount)
            ? BigInt(Math.ceil(data.payoutAmount))
            : null
      };
    },

    async getAccountBalanceSun(): Promise<bigint> {
      const data = await request<{ balance?: string | number }>("/v2/user-info");
      try {
        return BigInt(data.balance ?? 0);
      } catch {
        throw new Error(`TronSave user-info returned unparseable balance: ${String(data.balance)}`);
      }
    }
  };
}
