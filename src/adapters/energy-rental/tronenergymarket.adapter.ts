// tronenergy.market (TEM) energy-rental provider.
//
// Order-book marketplace, materially cheaper than TronSave for short
// rentals (observed 2026-06: 35 SUN/day-unit at the 5min-1h tier vs
// TronSave's ~65 flat). Prepaid-credit + API-key model: the operator
// deposits TRX to TEM's address once (min 10 TRX, 1 credit = 1 TRX,
// withdrawals locked 48h after deposit) and each order draws from credit —
// no on-chain signing per purchase. The `api_key` travels in the JSON BODY
// (TEM convention), not a header, alongside the TEM account address it was
// issued for.
//
// Endpoint surface (base https://api.tronenergy.market; no testnet exists —
// wire mainnet only):
//   GET  /info                  → market prices/depth/minimums (public)
//   POST /order/new             → create order, returns { order: <id> }
//   GET  /order/info/?id={id}   → fill status (public)
//   POST /order/cancel          → cancel unfilled order (1 TRX fee)
//   GET  /credit?address={a}    → prepaid balance in SUN (public)
//
// Pricing quirk to get right: the order `price` is SUN per energy unit PER
// DAY, and sub-day orders are billed as (duration + 1 day) — verbatim from
// TEM's official examples:
//   PAYMENT = PRICE * AMOUNT * (DURATION + (DURATION < 86400 ? 86400 : 0)) / 86400
// So a 600s order at the 35-SUN tier costs ~35.24 SUN per unit effective.
// Estimates computed here apply that padding so the caller's rent-vs-burn
// comparison stays honest.
//
// Orders are created with `partfill: false` (all-or-nothing — the port
// contract) and `instant: true` (fill from pool supply immediately instead
// of waiting for a filling round; TEM: "speeds up minutes order to get
// completed in seconds").

import type {
  EnergyRentalEstimate,
  EnergyRentalOrderStatus,
  EnergyRentalProvider
} from "./energy-rental.port.js";

export const TRONENERGY_MARKET_URL = "https://api.tronenergy.market";

// Floor on the order size TEM accepts (live /info `order.minEnergy`; this
// constant is the fallback when the live read omits it). Orders below it
// are clamped UP — the estimate prices the clamped amount so the caller
// compares true cost, and extra delegated energy is simply unused.
const TEM_FALLBACK_MIN_ORDER_ENERGY = 20_000;

// Sub-day billing pad (see header). Numerator/denominator kept as integers
// so cost math stays exact until the final division.
const SECONDS_PER_DAY = 86_400;

// /info is public and changes slowly (pool floors move on the order of
// hours); cache briefly so estimate + create within one payout share a read.
const INFO_CACHE_TTL_MS = 60_000;

export type TemFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface TronEnergyMarketConfig {
  // API key issued for `accountAddress` (Account → API on tronenergy.market,
  // or POST /apikey/new). Anyone holding it can spend the prepaid credit.
  apiKey: string;
  // The TEM account address the key belongs to ("origin" in their API).
  // Orders are paid from this account's credit.
  accountAddress: string;
  baseUrl?: string;
  fetch?: TemFetch;
  timeoutMs?: number;
}

interface TemInfo {
  readonly minOrderEnergy: number;
  // Price tiers: pick the highest minDuration <= requested duration.
  readonly openEnergyTiers: ReadonlyArray<{ minDuration: number; suggestedPrice: number }>;
  // Order-book depth by price (ascending) — supply at or below a price.
  readonly energyByPrice: ReadonlyArray<{ price: number; value: number }>;
}

export function tronEnergyMarketProvider(config: TronEnergyMarketConfig): EnergyRentalProvider {
  const baseUrl = (config.baseUrl ?? TRONENERGY_MARKET_URL).replace(/\/+$/, "");
  const doFetch: TemFetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = config.timeoutMs ?? 15_000;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`TEM ${path} returned ${res.status}: ${text.slice(0, 256)}`);
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`TEM ${path} returned non-JSON body: ${text.slice(0, 256)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  let infoCache: { value: TemInfo; fetchedAt: number } | null = null;
  async function getInfo(): Promise<TemInfo> {
    const now = Date.now();
    if (infoCache !== null && now - infoCache.fetchedAt < INFO_CACHE_TTL_MS) return infoCache.value;
    const raw = await request<{
      order?: { minEnergy?: number };
      price?: { openEnergy?: ReadonlyArray<{ minDuration?: number; suggestedPrice?: number }> };
      market?: { availableEnergyByPrice?: ReadonlyArray<{ price?: number; value?: number }> };
    }>("/info");
    const tiers = (raw.price?.openEnergy ?? [])
      .filter((t): t is { minDuration: number; suggestedPrice: number } =>
        typeof t.minDuration === "number" && typeof t.suggestedPrice === "number" && t.suggestedPrice > 0
      )
      .sort((a, b) => a.minDuration - b.minDuration);
    if (tiers.length === 0) {
      throw new Error("TEM /info returned no usable openEnergy price tiers");
    }
    const value: TemInfo = {
      minOrderEnergy: raw.order?.minEnergy ?? TEM_FALLBACK_MIN_ORDER_ENERGY,
      openEnergyTiers: tiers,
      energyByPrice: (raw.market?.availableEnergyByPrice ?? []).filter(
        (e): e is { price: number; value: number } =>
          typeof e.price === "number" && typeof e.value === "number"
      )
    };
    infoCache = { value, fetchedAt: now };
    return value;
  }

  // Tier price for a duration = the highest tier whose minDuration fits.
  function tierPriceFor(info: TemInfo, durationSec: number): number {
    let price = info.openEnergyTiers[0]!.suggestedPrice;
    for (const tier of info.openEnergyTiers) {
      if (tier.minDuration <= durationSec) price = tier.suggestedPrice;
      else break;
    }
    return price;
  }

  function paddedDuration(durationSec: number): number {
    return durationSec + (durationSec < SECONDS_PER_DAY ? SECONDS_PER_DAY : 0);
  }

  function orderCostSun(pricePerDay: number, energyAmount: number, durationSec: number): bigint {
    // ceil(price × amount × paddedDuration / 86400) without float drift.
    const numerator = BigInt(pricePerDay) * BigInt(energyAmount) * BigInt(paddedDuration(durationSec));
    return (numerator + BigInt(SECONDS_PER_DAY) - 1n) / BigInt(SECONDS_PER_DAY);
  }

  return {
    name: "tronenergy.market",

    async estimateEnergyOrder(args): Promise<EnergyRentalEstimate> {
      const info = await getInfo();
      const amount = Math.max(args.energyAmount, info.minOrderEnergy);
      const pricePerDay = tierPriceFor(info, args.durationSec);
      const totalCostSun = orderCostSun(pricePerDay, amount, args.durationSec);
      // Supply our order can draw from = pool depth at or below our bid
      // (pools fill any order priced at/above their floor).
      const availableEnergy = info.energyByPrice
        .filter((e) => e.price <= pricePerDay)
        .reduce((sum, e) => sum + e.value, 0);
      // Effective SUN per unit INCLUDING the sub-day billing pad, so the
      // caller's price-ceiling check compares like with like.
      const unitPriceSun = (pricePerDay * paddedDuration(args.durationSec)) / SECONDS_PER_DAY;
      return { unitPriceSun, totalCostSun, availableEnergy: Math.floor(availableEnergy) };
    },

    async createEnergyOrder(args): Promise<{ orderId: string }> {
      const info = await getInfo();
      const amount = Math.max(args.energyAmount, info.minOrderEnergy);
      const pricePerDay = tierPriceFor(info, args.durationSec);
      const effectiveUnitSun = (pricePerDay * paddedDuration(args.durationSec)) / SECONDS_PER_DAY;
      // TEM has no server-side price ceiling — the buyer names the price.
      // Enforce the caller's ceiling here so the port contract ("never fill
      // above maxUnitPriceSun") holds on this provider too.
      if (effectiveUnitSun > args.maxUnitPriceSun) {
        throw new Error(
          `TEM tier price ${effectiveUnitSun.toFixed(2)} SUN/unit (incl. sub-day pad) exceeds ceiling ${args.maxUnitPriceSun}`
        );
      }
      const resp = await request<{ order?: number | string }>("/order/new", {
        method: "POST",
        body: JSON.stringify({
          market: "Open",
          address: config.accountAddress,
          target: args.receiver,
          amount,
          resource: 0, // 0 = energy
          duration: args.durationSec,
          price: pricePerDay,
          // All-or-nothing per the port contract: "the order won't be
          // filled unless there is 1 address which can complete the order
          // in 1 transaction" (TEM docs verbatim).
          partfill: false,
          // Fill from pool supply immediately instead of waiting for the
          // next filling round — minutes-orders complete in seconds.
          instant: true,
          api_key: config.apiKey
        })
      });
      if (resp.order === undefined || resp.order === null || `${resp.order}`.length === 0) {
        throw new Error("TEM /order/new returned no order id");
      }
      return { orderId: String(resp.order) };
    },

    async getOrderStatus(orderId): Promise<EnergyRentalOrderStatus> {
      const data = await request<{
        status?: string;
        // TRX-stake terms: total requested vs delegated so far.
        freeze?: number;
        frozen?: number;
        payment?: number;
      }>(`/order/info/?id=${encodeURIComponent(orderId)}`);
      // Active = delegation in effect; Completed = order finished. Both mean
      // the energy was delivered. Pending tracks fill progress via
      // frozen/freeze; Cancelled never delivers.
      const delivered = data.status === "Active" || data.status === "Completed";
      const ratio =
        typeof data.freeze === "number" && data.freeze > 0 && typeof data.frozen === "number"
          ? Math.min(100, Math.floor((data.frozen / data.freeze) * 100))
          : 0;
      const fulfilledPercent = delivered ? 100 : data.status === "Cancelled" ? 0 : ratio;
      return {
        fulfilledPercent,
        paidSun:
          fulfilledPercent >= 100 && typeof data.payment === "number" && Number.isFinite(data.payment)
            ? BigInt(Math.ceil(data.payment))
            : null
      };
    },

    async cancelOrder(orderId): Promise<boolean> {
      // Refunds the committed payment to credit minus TEM's 1 TRX fee.
      // Only valid on unfilled orders; TEM rejects cancels on filled ones
      // (surfaced as a non-2xx → false).
      try {
        await request("/order/cancel", {
          method: "POST",
          body: JSON.stringify({
            order: Number(orderId),
            address: config.accountAddress,
            api_key: config.apiKey
          })
        });
        return true;
      } catch {
        return false;
      }
    },

    async getAccountBalanceSun(): Promise<bigint> {
      const data = await request<{ value?: number | string }>(
        `/credit?address=${encodeURIComponent(config.accountAddress)}`
      );
      try {
        return BigInt(data.value ?? 0);
      } catch {
        throw new Error(`TEM /credit returned unparseable balance: ${String(data.value)}`);
      }
    }
  };
}
