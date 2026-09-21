import { eq } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import { recentOracleFailures } from "../ports/oracle-diagnostics.js";
import type { ChainFamily } from "../types/chain.js";
import { chainEntry } from "../types/chain-registry.js";
import { findToken, TOKEN_REGISTRY } from "../types/token-registry.js";
import type { TokenSymbol } from "../types/token.js";
import { invoices } from "../../db/schema.js";

// 10-minute rolling rate window for USD-path invoices.
//
// On invoice creation we snapshot USD rates for every token the invoice can
// accept (every registered symbol in every accepted family, deduped) and
// pin them for 10 minutes. Subsequent payments within that window convert
// at the pinned rates. When detection happens past expiry, we refresh.
//
// This is the "simple with mix" stance from the product debate: merchant
// bears limited risk (locked-in rate for the current 10-minute slice),
// customer gets predictable pricing, volatility-induced short-paid invoices
// are caught in the NEXT window rather than silently.

export const RATE_WINDOW_DURATION_MS = 10 * 60 * 1000;

export interface RateSnapshot {
  // Decimal-string USD per 1 whole token: { "USDC": "1.00", "ETH": "2500.00" }.
  rates: Readonly<Record<string, string>>;
  // Unix-ms timestamp this window expires at (window created AT / closed AT).
  expiresAt: number;
}

// Enumerate every distinct token symbol registered on any chain in the
// supplied families. Input to oracle.getUsdRates — determines the set of
// tokens whose rates we pin for this invoice.
export function tokensForFamilies(families: readonly ChainFamily[]): readonly TokenSymbol[] {
  const set = new Set<string>();
  for (const entry of TOKEN_REGISTRY) {
    const family = familyForChainId(entry.chainId);
    if (family === null) continue;
    if (!families.includes(family)) continue;
    set.add(entry.symbol);
    // Also include the native symbol per family. Native tokens usually
    // aren't in the token registry (they have no contract address), so
    // we add them explicitly below.
  }
  // Add family native tokens the oracle should quote. Registry has these
  // for Solana + dev chain via `contractAddress: null`; other families'
  // natives (ETH, BNB, MATIC, AVAX, TRX) aren't currently in the registry
  // but may arrive as transfers, so the oracle needs to quote them.
  if (families.includes("evm")) {
    set.add("ETH");
    set.add("BNB");
    set.add("MATIC");
    set.add("AVAX");
  }
  if (families.includes("tron")) {
    set.add("TRX");
  }
  if (families.includes("solana")) {
    set.add("SOL");
  }
  if (families.includes("utxo")) {
    // BTC + LTC are already in the registry (chainIds 800/801/802/803) so the
    // loop above adds them, but stating them explicitly here matches the
    // EVM/Tron/Solana branches and prevents a future registry refactor from
    // silently dropping UTXO natives from the rate snapshot.
    set.add("BTC");
    set.add("LTC");
  }
  if (families.includes("monero")) {
    // XMR is registered in TOKEN_REGISTRY for chainIds 1000/1001/1002, so
    // the registry loop above already adds it. Stated explicitly here so a
    // USD-pegged universal invoice with `acceptedFamilies: [..., "monero"]`
    // always gets an XMR/USD rate snapshotted at create time even if a
    // future registry refactor drops the native row.
    set.add("XMR");
  }
  return Array.from(set) as TokenSymbol[];
}

// Single shared cache key holding the latest USD rate map across every
// token any wired family might price. The cron's warmRateCache writes
// this entry every tick; snapshotRates reads it.
//
// Freshness is enforced by the entry's own updatedAt, NOT by the cache
// TTL. The TTL is purely hygiene (a very long ceiling so an abandoned
// deployment doesn't keep a dead key forever). Before this split, the TTL
// doubled as the freshness bound: a cron outage longer than the TTL wiped
// the entry and invoice creation went down entirely with no way to recover
// until the cron came back. Now the request path can refresh inline and,
// failing that, serve a bounded-stale entry — see snapshotRates.
const WARMED_RATES_CACHE_KEY = "rates:usd:warmed";
const WARMED_RATES_TTL_SECONDS = 7 * 24 * 3600;

// Age within which a warmed entry is served straight from cache with no
// upstream call. The cron rewrites the entry every minute, so in steady
// state the entry is never older than ~60s; anything past this bound means
// the cron is dead or every oracle has been failing for an hour.
export const RATES_FRESH_MS = 60 * 60 * 1000;

// Absolute staleness ceiling. When the cache is past RATES_FRESH_MS AND an
// inline refresh fails (every live oracle down), we still serve the last
// good entry up to this age rather than refuse every invoice. Crypto can
// move a few percent in six hours — that is a bounded, visible risk the
// merchant's tolerance settings already absorb, whereas a hard outage of
// invoice creation is unbounded lost revenue. Past this age we refuse.
export const RATES_MAX_STALE_MS = 6 * 60 * 60 * 1000;

// Wall-clock budget for the inline (request-path) refresh. Each oracle link
// has its own 2.5s fetch timeout and the chain is four deep, so the worst
// case is ~10s; bound it so an invoice-create never hangs past that.
const INLINE_REFRESH_TIMEOUT_MS = 10_000;

// After an inline refresh fails, park a short marker so the next requests
// don't each pay the full oracle-chain timeout while providers are down.
// While the marker is set we go straight to the bounded-stale path (or
// the error). KV's minimum TTL is 60s, which is also the cron cadence, so
// the marker never outlives the next scheduled attempt.
const INLINE_REFRESH_BACKOFF_KEY = "rates:usd:inline-refresh-failed";
const INLINE_REFRESH_BACKOFF_SECONDS = 60;

// ---- Refresh health, retries and alerting ----
//
// Rate refresh must never fail silently. Every refresh outcome is tracked
// in a small cache-backed state record so that:
//   - the FIRST failure after a healthy period alerts immediately (error-
//     level log → ALERT_WEBHOOK_URL; Discord-formatted when that is a
//     Discord webhook) with everything the on-call needs: which path
//     failed (cron / inline), the error, per-provider failure reasons from
//     the oracle diagnostics buffer, how old the cache is, exactly when
//     invoices will start failing, and what auto-recovery is already doing;
//   - continued failure re-alerts every RATE_ALERT_REPEAT_MS with the
//     running outage duration instead of once a minute;
//   - the first success after an outage sends a recovery notice.
const REFRESH_STATE_KEY = "rates:usd:refresh-state";
const REFRESH_STATE_TTL_SECONDS = 7 * 24 * 3600;
export const RATE_ALERT_REPEAT_MS = 10 * 60 * 1000;

// The cron rewrites the entry every minute. If the request path ever sees
// an entry older than this while the refresh state shows no recent failed
// attempt either, the scheduled handler is simply not running (deploy
// misconfig, boot failure, cron trigger removed). Alert on that
// specifically: a dead cron also stalls detection, payouts and webhooks.
export const RATE_CRON_STALE_ALERT_MS = 5 * 60 * 1000;
const CRON_STALE_ALERT_MARKER_KEY = "rates:usd:cron-stale-alerted";
const CRON_STALE_ALERT_REPEAT_SECONDS = 10 * 60;

// Dedupe marker for the per-request RATES_UNAVAILABLE alert so a burst of
// failing invoice-creates produces one page, not thirty.
const UNAVAILABLE_ALERT_MARKER_KEY = "rates:usd:unavailable-alerted";
const UNAVAILABLE_ALERT_REPEAT_SECONDS = 120;

// In-tick retry policy for the cron warm. The chain already falls through
// four providers per attempt; retrying the whole chain covers transient
// edge-network blips (DNS, connection reset) that hit every provider at
// once. Mutable so tests can zero the backoff.
export const RATE_REFRESH_RETRY_POLICY: { attempts: number; backoffMs: readonly number[] } = {
  attempts: 3,
  backoffMs: [250, 750]
};

interface WarmedRatesEntry {
  rates: Record<string, string>;
  updatedAt: number;
}

interface RefreshState {
  consecutiveFailures: number;
  firstFailedAt: number | null;
  lastFailedAt: number | null;
  lastAlertAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
}

// Thrown by snapshotRates when no usable rates exist: the cache is empty
// or older than RATES_MAX_STALE_MS, AND an inline refresh through the live
// oracle chain failed. Surfaces as a 503 with a stable code so merchants
// retry rather than getting silently mis-priced invoices.
export class RateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateUnavailableError";
  }
}

// Snapshot the current rates for the given tokens. Three tiers, cheapest first:
//
//   1. Fresh cache (age ≤ RATES_FRESH_MS) — the steady-state path. The
//      cron is the only thing touching the network; the merchant's request
//      just reads the prebuilt map. Sub-millisecond.
//   2. Inline refresh — cache missing or aged (fresh deploy before the
//      first cron tick, cron dead, KV entry lost). Call the same oracle
//      fallback chain the cron uses, bounded by INLINE_REFRESH_TIMEOUT_MS
//      and single-flighted per deps instance, and write the result back so
//      the next request is tier 1 again. This is what used to be a hard
//      503 until the cron recovered.
//   3. Bounded-stale — inline refresh failed (every live provider down).
//      Serve the last good entry if it is younger than RATES_MAX_STALE_MS,
//      logging loudly. Beyond that, throw RateUnavailableError: pricing
//      against hours-old rates is worse than asking the merchant to retry.
//
// No static-peg substitution anywhere in this path — hardcoded numbers can
// be off by 30–50 % and cause real financial loss.
export async function snapshotRates(
  deps: AppDeps,
  tokens: readonly TokenSymbol[]
): Promise<RateSnapshot> {
  const now = deps.clock.now().getTime();
  let entry = await readWarmedRates(deps);
  const ageMs = entry === null ? Number.POSITIVE_INFINITY : now - entry.updatedAt;

  if (ageMs > RATE_CRON_STALE_ALERT_MS) {
    await watchCronStaleness(deps, entry, now);
  }

  if (ageMs > RATES_FRESH_MS) {
    const refreshed = await inlineRefresh(deps, tokens);
    if (refreshed !== null) {
      entry = refreshed;
    } else if (entry !== null && ageMs <= RATES_MAX_STALE_MS) {
      deps.logger.warn("snapshotRates: serving stale rates — cache aged and live refresh failed", {
        ageSeconds: Math.round(ageMs / 1000),
        maxStaleSeconds: RATES_MAX_STALE_MS / 1000
      });
    } else {
      await alertRatesUnavailable(deps, entry, ageMs, now);
      throw new RateUnavailableError(
        entry === null
          ? "Rate cache is empty and the live price oracles could not be reached. Retry shortly."
          : "Cached rates are too stale to price safely and the live price oracles could not be reached. Retry shortly."
      );
    }
  }

  const out: Record<string, string> = {};
  for (const t of tokens) {
    const rate = entry!.rates[t];
    if (rate !== undefined) out[t] = rate;
  }
  return { rates: out, expiresAt: now + RATE_WINDOW_DURATION_MS };
}

async function readWarmedRates(deps: AppDeps): Promise<WarmedRatesEntry | null> {
  const cached = await deps.cache.getJSON<WarmedRatesEntry>(WARMED_RATES_CACHE_KEY);
  if (cached === null || typeof cached !== "object") return null;
  if (typeof cached.updatedAt !== "number" || cached.rates === null || typeof cached.rates !== "object") {
    return null;
  }
  return cached;
}

async function readRefreshState(deps: AppDeps): Promise<RefreshState | null> {
  const cached = await deps.cache.getJSON<RefreshState>(REFRESH_STATE_KEY);
  if (cached === null || typeof cached !== "object") return null;
  if (typeof cached.consecutiveFailures !== "number") return null;
  return cached;
}

async function writeRefreshState(deps: AppDeps, state: RefreshState): Promise<void> {
  await deps.cache.putJSON(REFRESH_STATE_KEY, state, { ttlSeconds: REFRESH_STATE_TTL_SECONDS });
}

// Every token the cache entry should cover: the union of what every wired
// family can price and whatever the caller asked for. The cron and the
// inline refresh both use this so a request-path warm leaves the entry
// as complete as a cron warm would.
function tokensToWarm(deps: AppDeps, extra: readonly TokenSymbol[] = []): readonly TokenSymbol[] {
  const families = new Set<ChainFamily>();
  for (const adapter of deps.chains) families.add(adapter.family);
  const set = new Set<TokenSymbol>(tokensForFamilies([...families]));
  for (const t of extra) set.add(t);
  return [...set];
}

// Call the oracle fallback chain (with in-tick retries for the cron) and
// persist the result. Returns the new entry, or null when every attempt
// threw or returned nothing usable — in which case the previous entry is
// deliberately left untouched (never overwrite last-good with an empty
// map) and the failure is recorded + alerted via noteRefreshFailure.
async function fetchAndStoreLiveRates(
  deps: AppDeps,
  tokens: readonly TokenSymbol[],
  source: "cron" | "inline"
): Promise<WarmedRatesEntry | null> {
  if (tokens.length === 0) return null;
  const attempts = source === "cron" ? Math.max(1, RATE_REFRESH_RETRY_POLICY.attempts) : 1;
  let lastError = "unknown";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let live: Record<string, string> | null = null;
    try {
      live = { ...(await deps.priceOracle.getUsdRates(tokens)) };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      deps.logger.warn("warmRateCache(" + source + "): oracle chain threw (attempt " + attempt + "/" + attempts + ")", {
        error: lastError
      });
    }
    if (live !== null && Object.keys(live).length === 0) {
      lastError = "oracle chain returned no rates (every provider failed or every symbol unmapped)";
      deps.logger.warn("warmRateCache(" + source + "): " + lastError + " (attempt " + attempt + "/" + attempts + ")");
      live = null;
    }
    if (live !== null) {
      const entry: WarmedRatesEntry = { rates: live, updatedAt: deps.clock.now().getTime() };
      await deps.cache.putJSON(WARMED_RATES_CACHE_KEY, entry, { ttlSeconds: WARMED_RATES_TTL_SECONDS });
      await noteRefreshSuccess(deps, source);
      return entry;
    }
    if (attempt < attempts) await sleep(RATE_REFRESH_RETRY_POLICY.backoffMs[attempt - 1] ?? 0);
  }
  await noteRefreshFailure(deps, { source, tokens, error: lastError, attempts });
  return null;
}

async function noteRefreshSuccess(deps: AppDeps, source: "cron" | "inline"): Promise<void> {
  const now = deps.clock.now().getTime();
  const state = await readRefreshState(deps);
  if (state !== null && state.consecutiveFailures > 0) {
    deps.logger.error("[RATE_REFRESH_RECOVERED] USD rate refresh is succeeding again", {
      alertKind: "recovery",
      source,
      failedAttempts: state.consecutiveFailures,
      outageSeconds: state.firstFailedAt !== null ? Math.round((now - state.firstFailedAt) / 1000) : null,
      lastError: state.lastError,
      note: "Invoice pricing is back on live rates. No action needed unless this keeps recurring."
    });
  }
  await writeRefreshState(deps, {
    consecutiveFailures: 0,
    firstFailedAt: null,
    lastFailedAt: state?.lastFailedAt ?? null,
    lastAlertAt: null,
    lastSuccessAt: now,
    lastError: null
  });
}

async function noteRefreshFailure(
  deps: AppDeps,
  info: { source: "cron" | "inline"; tokens: readonly TokenSymbol[]; error: string; attempts: number }
): Promise<void> {
  const now = deps.clock.now().getTime();
  const state: RefreshState = (await readRefreshState(deps)) ?? {
    consecutiveFailures: 0,
    firstFailedAt: null,
    lastFailedAt: null,
    lastAlertAt: null,
    lastSuccessAt: null,
    lastError: null
  };
  const consecutiveFailures = state.consecutiveFailures + 1;
  const firstFailedAt = state.firstFailedAt ?? now;
  const shouldAlert = state.lastAlertAt === null || now - state.lastAlertAt >= RATE_ALERT_REPEAT_MS;
  let lastAlertAt = state.lastAlertAt;

  if (shouldAlert) {
    lastAlertAt = now;
    const entry = await readWarmedRates(deps);
    const cacheAgeMs = entry === null ? null : now - entry.updatedAt;
    const servableUntil = entry === null ? null : entry.updatedAt + RATES_MAX_STALE_MS;
    const impact =
      entry === null || servableUntil === null || servableUntil <= now
        ? "USD-pegged invoice creation is FAILING NOW with 503 RATES_UNAVAILABLE."
        : "Invoices are currently priced from cached rates (" +
          Math.round((cacheAgeMs ?? 0) / 60_000) +
          " min old). Creation starts failing with 503 RATES_UNAVAILABLE at " +
          new Date(servableUntil).toISOString() +
          " unless a refresh succeeds first.";
    deps.logger.error("[RATE_REFRESH_FAILED] USD rate refresh failed", {
      alertKind: "failure",
      source: info.source,
      attempts: info.attempts,
      error: info.error,
      consecutiveFailures,
      failingForSeconds: Math.round((now - firstFailedAt) / 1000),
      lastSuccessAt: state.lastSuccessAt !== null ? new Date(state.lastSuccessAt).toISOString() : null,
      impact,
      cache: {
        present: entry !== null,
        ageSeconds: cacheAgeMs === null ? null : Math.round(cacheAgeMs / 1000),
        tokenCount: entry === null ? 0 : Object.keys(entry.rates).length,
        servableUntil: servableUntil === null ? null : new Date(servableUntil).toISOString()
      },
      tokensRequested: [...info.tokens],
      providerFailures: recentOracleFailures(15 * 60 * 1000, now).map((f) => ({
        provider: f.provider,
        at: new Date(f.at).toISOString(),
        error: f.error,
        ...(f.tokens !== undefined ? { tokens: f.tokens } : {})
      })),
      autoRecovery:
        "The cron retries the full oracle chain every minute (" +
        RATE_REFRESH_RETRY_POLICY.attempts +
        " attempts per tick) and every USD invoice request also attempts an inline refresh. Nothing to restart; a recovery notice follows the first success.",
      investigate: [
        "providerFailures names each upstream that failed and why: 429 = rate limit / key quota, 5xx = provider outage, AbortError = timeout, 'fetch failed' = DNS / egress.",
        "If providerFailures is empty the chain never ran — check the scheduled handler is firing (wrangler tail) and whether a 'worker boot failed' alert preceded this.",
        "Config knobs: PRICE_ADAPTER, DISABLE_COINGECKO / DISABLE_COINCAP / DISABLE_BINANCE / DISABLE_ALCHEMY, COINGECKO_API_KEY, COINCAP_API_KEY, ALCHEMY_API_KEY."
      ]
    });
  }

  await writeRefreshState(deps, {
    consecutiveFailures,
    firstFailedAt,
    lastFailedAt: now,
    lastAlertAt,
    lastSuccessAt: state.lastSuccessAt,
    lastError: info.error
  });
}

// Request-path watchdog for a dead cron. Only reached when the cache entry
// is missing or older than RATE_CRON_STALE_ALERT_MS, so the steady-state
// request path never pays for it.
async function watchCronStaleness(deps: AppDeps, entry: WarmedRatesEntry | null, now: number): Promise<void> {
  const state = await readRefreshState(deps);
  const lastWrite = entry?.updatedAt ?? state?.lastSuccessAt ?? null;
  // No history at all: a brand-new deployment before its first tick. The
  // inline refresh handles that; nothing to alert on yet.
  if (lastWrite === null) return;
  if (now - lastWrite <= RATE_CRON_STALE_ALERT_MS) return;
  // The cron IS running but the oracles are failing — that is covered by the
  // RATE_REFRESH_FAILED alert with far better detail.
  if (state?.lastFailedAt !== null && state?.lastFailedAt !== undefined && now - state.lastFailedAt <= RATE_CRON_STALE_ALERT_MS) {
    return;
  }
  const acquired = await deps.cache.putIfAbsent(CRON_STALE_ALERT_MARKER_KEY, "1", {
    ttlSeconds: CRON_STALE_ALERT_REPEAT_SECONDS
  });
  if (!acquired) return;
  deps.logger.error("[RATE_CRON_STALE] scheduled rate warm has not run recently — the cron appears to be down", {
    alertKind: "failure",
    lastCacheWriteAt: new Date(lastWrite).toISOString(),
    minutesSinceLastWrite: Math.round((now - lastWrite) / 60_000),
    lastRefreshFailureAt: state?.lastFailedAt !== null && state?.lastFailedAt !== undefined ? new Date(state.lastFailedAt).toISOString() : null,
    impact:
      "Rates are being refreshed inline by invoice requests (self-healing), but a dead cron ALSO stalls payment detection, confirmations, payouts and webhook retries.",
    investigate: [
      "Workers: run wrangler tail and look for the scheduled handler firing or a 'worker boot failed' alert; confirm the crons trigger is still in wrangler.jsonc and the last deploy succeeded.",
      "Node / Vercel / Deno: confirm the external scheduler is POSTing /internal/cron/tick every minute with the CRON_SECRET."
    ]
  });
}

async function alertRatesUnavailable(
  deps: AppDeps,
  entry: WarmedRatesEntry | null,
  ageMs: number,
  now: number
): Promise<void> {
  const acquired = await deps.cache.putIfAbsent(UNAVAILABLE_ALERT_MARKER_KEY, "1", {
    ttlSeconds: UNAVAILABLE_ALERT_REPEAT_SECONDS
  });
  if (!acquired) return;
  const state = await readRefreshState(deps);
  deps.logger.error("[RATES_UNAVAILABLE] invoice creation is failing — no usable USD rates", {
    alertKind: "failure",
    cachePresent: entry !== null,
    cacheAgeSeconds: entry === null ? null : Math.round(ageMs / 1000),
    maxStaleSeconds: RATES_MAX_STALE_MS / 1000,
    lastSuccessAt: state?.lastSuccessAt !== null && state?.lastSuccessAt !== undefined ? new Date(state.lastSuccessAt).toISOString() : null,
    consecutiveRefreshFailures: state?.consecutiveFailures ?? null,
    lastRefreshError: state?.lastError ?? null,
    providerFailures: recentOracleFailures(15 * 60 * 1000, now).map((f) => ({
      provider: f.provider,
      at: new Date(f.at).toISOString(),
      error: f.error
    })),
    impact: "Every USD-pegged invoice create is returning 503 RATES_UNAVAILABLE until a refresh succeeds. Raw-amount invoices are unaffected.",
    autoRecovery: "Each request retries an inline refresh (60s backoff between attempts) and the cron retries every minute."
  });
}

// Request-path refresh. Single-flight per deps instance so a burst of
// invoice-creates against an empty cache makes one oracle round-trip, not
// N. Honors the failure backoff marker and sets it on failure.
const inlineRefreshInFlight = new WeakMap<AppDeps, Promise<WarmedRatesEntry | null>>();

async function inlineRefresh(
  deps: AppDeps,
  tokens: readonly TokenSymbol[]
): Promise<WarmedRatesEntry | null> {
  const inFlight = inlineRefreshInFlight.get(deps);
  if (inFlight !== undefined) return inFlight;
  const run = inlineRefreshOnce(deps, tokens).finally(() => {
    inlineRefreshInFlight.delete(deps);
  });
  inlineRefreshInFlight.set(deps, run);
  return run;
}

async function inlineRefreshOnce(
  deps: AppDeps,
  tokens: readonly TokenSymbol[]
): Promise<WarmedRatesEntry | null> {
  if ((await deps.cache.get(INLINE_REFRESH_BACKOFF_KEY)) !== null) {
    deps.logger.warn("snapshotRates: inline refresh skipped — recent attempt failed, in backoff");
    return null;
  }
  deps.logger.warn("snapshotRates: rate cache missing or aged; refreshing inline from the oracle chain");
  const result = await withTimeout(
    fetchAndStoreLiveRates(deps, tokensToWarm(deps, tokens), "inline"),
    INLINE_REFRESH_TIMEOUT_MS
  );
  if (result === null) {
    await deps.cache.put(INLINE_REFRESH_BACKOFF_KEY, "1", { ttlSeconds: INLINE_REFRESH_BACKOFF_SECONDS });
  }
  return result;
}

// Resolve to null if the promise hasn't settled within ms. The underlying
// oracle call keeps running to completion in the background (its own fetch
// timeouts bound it) and will still write the cache if it eventually
// succeeds — which is exactly what we want for the next request.
function withTimeout<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cron-driven cache warmer. In steady state the ONLY thing that touches
// upstream oracles — runs once per cron tick, calls the full fallback
// chain (CoinGecko → Alchemy → CoinCap → Binance per select-oracle.ts)
// with in-tick retries, and writes whatever the chain returned to the
// shared cache slot.
//
// If every live oracle is down, the existing (last good) entry is left in
// place, the failure is alerted (see noteRefreshFailure), and
// snapshotRates decides at read time whether that entry is still young
// enough to serve (see RATES_MAX_STALE_MS).
//
// Family enumeration: read straight off deps.chains so a deployment
// with only EVM wired doesn't waste calls warming BTC/LTC, and a
// deployment that later adds UTXO automatically picks up the new
// symbols on the next tick.
export async function warmRateCache(deps: AppDeps): Promise<void> {
  const tokens = tokensToWarm(deps);
  if (tokens.length === 0) return;
  await fetchAndStoreLiveRates(deps, tokens, "cron");
}

// If the invoice's rate window has expired, re-query the oracle and persist a
// fresh snapshot on the invoice row. Returns the rates that SHOULD be used
// for the current detection event. Safe to call on every ingest: when the
// window is still valid, this is a single in-memory check + DB read (no
// network).
//
// Concurrent detections for the same invoice race here; we accept a small
// chance of two simultaneous refreshes producing slightly different rates.
// The last write wins and both writes see consistent subsequent payments.
// For sub-second precision, callers would need a per-invoice lock — overkill
// for a 10-minute window where a 100ms race is invisible.
export async function refreshIfExpired(
  deps: AppDeps,
  invoiceId: string,
  currentRates: Readonly<Record<string, string>> | null,
  currentExpiresAt: number | null,
  acceptedFamilies: readonly ChainFamily[]
): Promise<Readonly<Record<string, string>>> {
  const now = deps.clock.now().getTime();
  if (currentRates !== null && currentExpiresAt !== null && now < currentExpiresAt) {
    return currentRates;
  }
  const snapshot = await snapshotRates(deps, tokensForFamilies(acceptedFamilies));
  await deps.db
    .update(invoices)
    .set({
      ratesJson: JSON.stringify(snapshot.rates),
      rateWindowExpiresAt: snapshot.expiresAt,
      updatedAt: now
    })
    .where(eq(invoices.id, invoiceId));
  return snapshot.rates;
}

// Decimals lookup for a (chainId, token) pair. Registry is the source of
// truth for contract-backed tokens (USDC / USDT); hardcoded natives fill
// the gap so ETH / BNB / AVAX / MATIC / SOL / TRX transfers can be USD-
// valued without per-chain adapter queries. Returns null for unknown tokens
// — detection skips the USD aggregation for those (the payment still lands
// in `transactions` for audit).
export function tokenDecimalsFor(chainId: number, token: string): number | null {
  const registered = findToken(chainId, token as TokenSymbol);
  if (registered) return registered.decimals;
  const family = familyForChainId(chainId);
  if (family === "evm") {
    if (token === "ETH" || token === "BNB" || token === "MATIC" || token === "AVAX" || token === "POL") {
      return 18;
    }
  }
  if (family === "solana" && token === "SOL") return 9;
  if (family === "tron" && token === "TRX") return 6;
  return null;
}

// Compute the USD value of a raw-unit transfer, using a pinned rate. Returns
// null when the token isn't priceable — caller writes amount_usd = NULL on
// the transaction row and the invoice's paid_usd total skips it (the payment
// still counts toward received_amount_raw for legacy invoices, just not USD).
//
// Math: usd = amount_raw / 10^decimals * rate. Done with BigInt to avoid
// floating-point drift; result is a string to two decimal places (standard
// USD precision; downstream totals use BigInt cents internally).
export function usdValueFor(
  amountRaw: string,
  token: string,
  chainId: number,
  rates: Readonly<Record<string, string>>
): string | null {
  const decimals = tokenDecimalsFor(chainId, token);
  if (decimals === null) return null;
  const rate = rates[token];
  if (rate === undefined) return null;

  // Work in "cents" (×100 USD) via BigInt so we never touch Number for an
  // amount that might dwarf MAX_SAFE_INTEGER. rate is decimal-string, so
  // scale it up by 10^8 for 8 decimals of rate precision, then back down.
  const RATE_SCALE = 8;
  const rateCents = scaleDecimal(rate, RATE_SCALE);
  // amountRaw is scaled by 10^decimals; multiply by rate (scaled by RATE_SCALE)
  // and divide by 10^(decimals + RATE_SCALE) to get whole dollars. Then ×100
  // for cents.
  const numerator = BigInt(amountRaw) * rateCents * 100n;
  const divisor = BigInt(10) ** BigInt(decimals + RATE_SCALE);
  const cents = numerator / divisor;
  const dollars = cents / 100n;
  const centRemainder = cents % 100n;
  return `${dollars}.${centRemainder.toString().padStart(2, "0")}`;
}

// Inverse of `usdValueFor`: given a USD target, rate, and token decimals,
// return the minimum raw-units amount a payer must send to cover the target.
// Uses CEIL division so floating-point truncation can't leave the payer one
// unit short; over-send by at most 1 raw unit (sub-cent for stables; dust
// for natives). The checkout UI calls this to render "send X USDC" values
// for every accepted token in the invoice's rate snapshot.
export function payableAmountRaw(
  amountUsd: string,
  rate: string,
  decimals: number
): string {
  const RATE_SCALE = 8;
  const usdCents = scaleDecimal(amountUsd, 2);
  const rateScaled = scaleDecimal(rate, RATE_SCALE);
  if (rateScaled === 0n) return "0";
  // amountRaw = amountUsd * 10^decimals / rate
  //           = (usdCents / 100) * 10^decimals / (rateScaled / 10^RATE_SCALE)
  //           = usdCents * 10^(RATE_SCALE + decimals) / (100 * rateScaled)
  const numerator = usdCents * BigInt(10) ** BigInt(RATE_SCALE + decimals);
  const denominator = 100n * rateScaled;
  // Ceil division: (a + b - 1) / b.
  const amountRaw = (numerator + denominator - 1n) / denominator;
  return amountRaw.toString();
}

function scaleDecimal(value: string, decimals: number): bigint {
  const [wholeStr, fracStr = ""] = value.split(".");
  const frac = (fracStr + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(wholeStr ?? "0") * BigInt(10) ** BigInt(decimals) + BigInt(frac || "0");
}

// Add two decimal-string USD amounts. Used by the invoice's paid_usd
// aggregate to avoid floating-point drift across many small partial
// payments. Returns "D.CC" (cents precision).
export function addUsd(a: string, b: string): string {
  const sum = scaleDecimal(a, 2) + scaleDecimal(b, 2);
  const dollars = sum / 100n;
  const cents = sum % 100n;
  return `${dollars}.${cents.toString().padStart(2, "0")}`;
}

// Compare two decimal-string USD amounts. Returns 1 when a > b, -1 when
// a < b, 0 otherwise. Used by status transitions (is paid_usd ≥ amount_usd?).
export function compareUsd(a: string, b: string): number {
  const av = scaleDecimal(a, 2);
  const bv = scaleDecimal(b, 2);
  if (av > bv) return 1;
  if (av < bv) return -1;
  return 0;
}

// Apply a basis-point delta to a USD decimal string. `bps` ≥ 0; sign chosen
// by `direction`. Example: `applyBps("100.00", 100, "down")` → "99.00";
// `applyBps("100.00", 100, "up")` → "101.00". We compute the delta at 4
// decimals of precision (so sub-cent bps math doesn't vanish on small
// invoices like $1.00 + 33 bps) and then floor the final amount to cents.
// USD always rounds down at the cent boundary, so `down` deductions round
// the threshold further from the invoice amount (more lenient under-tol)
// and `up` additions round the threshold closer to the amount (stricter
// over-tol). Both keep the merchant from chasing fractional-cent errors.
export function applyBps(amount: string, bps: number, direction: "up" | "down"): string {
  const TENTHS = 10_000n; // 4 decimals of precision
  const scaled = scaleDecimal(amount, 4);
  if (bps === 0) return scaleToCents(scaled / 100n);
  const delta = (scaled * BigInt(bps)) / TENTHS;
  const next = direction === "down" ? scaled - delta : scaled + delta;
  return scaleToCents((next < 0n ? 0n : next) / 100n);
}

function scaleToCents(cents: bigint): string {
  const dollars = cents / 100n;
  const c = cents % 100n;
  return `${dollars}.${c.toString().padStart(2, "0")}`;
}

// a - b in USD. Negative results clamp to "0.00" — caller uses this for
// overpaid deltas, where negative would be nonsense.
export function subUsd(a: string, b: string): string {
  const diff = scaleDecimal(a, 2) - scaleDecimal(b, 2);
  if (diff <= 0n) return "0.00";
  const dollars = diff / 100n;
  const cents = diff % 100n;
  return `${dollars}.${cents.toString().padStart(2, "0")}`;
}

// Authoritative chainId → family lookup via the chain registry. The previous
// local copy hardcoded family ranges and went stale: it had a `chainId > 0
// → "evm"` catch-all that incorrectly swallowed UTXO chainIds (800/801/802/803),
// so USD-path invoices for BTC/LTC produced an empty rate snapshot — payments
// arrived with `usd_rate=null` and never credited the invoice's USD target.
// chainEntry() pulls from CHAIN_REGISTRY, the same source-of-truth that
// validateAddress / nativeSymbol / etc. all use. No drift possible.
function familyForChainId(chainId: number): ChainFamily | null {
  return chainEntry(chainId)?.family ?? null;
}
