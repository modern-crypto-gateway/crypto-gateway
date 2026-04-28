import { z } from "zod";
import { scaleDecimalToRaw } from "../types/money.js";

// How many block confirmations before a transaction is considered final on
// each chain. Promotions (tx.detected -> tx.confirmed, and order.detected ->
// order.confirmed when all contributing txs are confirmed) wait for these
// thresholds. Tuned for each chain's reorg depth + finality guarantees.

export const DEFAULT_CONFIRMATION_THRESHOLDS: Readonly<Record<number, number>> = {
  1: 12,       // Ethereum mainnet
  10: 12,      // Optimism
  56: 15,      // BSC
  137: 256,    // Polygon PoS (deep reorgs historically)
  42161: 12,   // Arbitrum One
  8453: 12,    // Base
  11155111: 3, // Sepolia testnet
  800: 6,      // Bitcoin mainnet (~60 min at 10-min blocks)
  801: 12,     // Litecoin mainnet (~30 min at 2.5-min blocks)
  802: 1,      // Bitcoin testnet3 — 1 confirmation (test environment)
  803: 1,      // Litecoin testnet — 1 confirmation
  999: 1       // dev chain
};

// Fallback when a chainId is not in the table above. A conservative 12 is
// safe for any EVM chain, and non-EVM adapters should set their own.
export const FALLBACK_CONFIRMATION_THRESHOLD = 12;

// `overrides` takes precedence over the shipped defaults so operators can
// tune per-chain finality without a code change — e.g. raise chain 1 to 20
// after a governance-risk event, or drop chain 137 to 64 once the Polygon
// hard fork that eliminated deep reorgs is live. Wired through AppDeps
// from an env var (`FINALITY_OVERRIDES=1:20,137:64`) in the entrypoints.
export function confirmationThreshold(
  chainId: number,
  overrides?: Readonly<Record<number, number>>
): number {
  return overrides?.[chainId] ?? DEFAULT_CONFIRMATION_THRESHOLDS[chainId] ?? FALLBACK_CONFIRMATION_THRESHOLD;
}

// Per-merchant override map shape. Keyed by chainId-as-string (JSON keys
// must be strings) → positive integer confirmation count. Validated at the
// admin API boundary; stored as a JSON string in the merchant row.
//
//   { "1": 24, "800": 12, "137": 8 }
//
// Out-of-range entries (zero, negative, non-integer, > 10_000) are rejected
// at the API. Unknown chainIds are accepted (we don't gate on
// CHAIN_REGISTRY here — operators may add a chain in code without breaking
// existing merchant configs).
export const ConfirmationThresholdsSchema = z.record(
  z.string().regex(/^\d+$/, "chainId keys must be positive integers as strings"),
  z.number().int().positive().max(10_000)
);
export type ConfirmationThresholdsMap = z.infer<typeof ConfirmationThresholdsSchema>;

// Resolve the confirmation threshold to snapshot onto an invoice or payout
// at create time. Precedence (highest → lowest):
//   1. merchant override JSON (per-chain entry for `chainId`)
//   2. env-var FINALITY_OVERRIDES (per-chain)
//   3. DEFAULT_CONFIRMATION_THRESHOLDS (per-chain hardcoded)
//   4. FALLBACK_CONFIRMATION_THRESHOLD (12)
//
// Malformed merchant JSON is tolerated (parse errors → fall through to env
// override / default). The merchant config column is operator-managed and
// shouldn't be malformed in practice; defending here keeps create-paths
// resilient if someone hand-edits the DB.
export function resolveMerchantConfirmationThreshold(
  chainId: number,
  merchantOverridesJson: string | null,
  envOverrides?: Readonly<Record<number, number>>
): number {
  if (merchantOverridesJson !== null && merchantOverridesJson.length > 0) {
    try {
      const parsed = JSON.parse(merchantOverridesJson) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const map = parsed as Record<string, unknown>;
        const v = map[String(chainId)];
        if (typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 10_000) {
          return v;
        }
      }
    } catch {
      // Malformed JSON — silently fall through. The admin API validated
      // the shape at write time; reaching this path means someone bypassed
      // validation (manual DB edit or schema migration footgun).
    }
  }
  return confirmationThreshold(chainId, envOverrides);
}

// ---- Per-(chain, token) confirmation-tier rules ---------------------------
//
// Tiers extend the flat per-chain confirmation override with amount-based
// finality: small transfers confirm fast, large ones wait deeper. Used by
// merchants who want different reorg policies for different transaction
// sizes (e.g. "1 LTC = 1 conf, 100 LTC = 12 conf"). Stored on the merchant
// row as a JSON map keyed by `${chainId}:${token}`; snapshotted onto each
// new invoice/payout at create time and frozen for the resource's lifetime.
//
// Rule shape: `{ amount, op, confirmations }` evaluated top-to-bottom,
// first-match-wins. The trailing rule may omit `amount`/`op` to act as a
// catch-all (otherwise a non-matching transfer falls back to the flat
// confirmation_threshold). Operators: `<`, `<=`, `>`, `>=`, `=`, `<>`.
//
// Amount comparison uses BigInt math at the token's smallest-unit scale —
// the rule's decimal `amount` is scaled by the token's `decimals` and
// compared against the transfer's raw `amount_raw`. No float drift.

export const ConfirmationTierOpSchema = z.enum(["<", "<=", ">", ">=", "=", "<>"]);
export type ConfirmationTierOp = z.infer<typeof ConfirmationTierOpSchema>;

export const ConfirmationTierRuleSchema = z
  .object({
    amount: z.string().regex(/^\d+(\.\d+)?$/, "amount must be a non-negative decimal").optional(),
    op: ConfirmationTierOpSchema.optional(),
    confirmations: z.number().int().positive().max(10_000)
  })
  .refine(
    (v) => (v.amount === undefined) === (v.op === undefined),
    { message: "`amount` and `op` must be provided together — only the trailing catch-all rule may omit both" }
  );
export type ConfirmationTierRule = z.infer<typeof ConfirmationTierRuleSchema>;

// Per-(chainId, token) tier list. Key format: `"${chainId}:${TOKEN}"` —
// chainId as a positive integer string, token as a registered TokenSymbol
// (uppercase). Same shape as merchant.confirmation_tiers_json in the DB.
export const ConfirmationTiersSchema = z.record(
  z.string().regex(/^\d+:[A-Z][A-Z0-9]*$/, "key must be 'chainId:TOKEN' (e.g. '801:LTC')"),
  z.array(ConfirmationTierRuleSchema).min(1).max(20)
);
export type ConfirmationTiersMap = z.infer<typeof ConfirmationTiersSchema>;

// Evaluate a tier list against a transfer's raw amount + the token's decimals.
// Returns the matched confirmation count, or null when no rule matches AND
// the list has no catch-all — caller falls back to the flat threshold.
//
// Comparison is exact via BigInt at smallest-unit scale; no rounding. A rule
// with malformed `amount` (shouldn't happen — Zod validates at write time)
// is skipped so a single bad rule doesn't poison the whole evaluation.
export function evaluateConfirmationTier(
  amountRaw: string,
  decimals: number,
  rules: readonly ConfirmationTierRule[]
): number | null {
  let txValue: bigint;
  try {
    txValue = BigInt(amountRaw);
  } catch {
    return null;
  }
  for (const rule of rules) {
    if (rule.amount === undefined || rule.op === undefined) {
      // Catch-all (must be the last entry; we don't enforce ordering at
      // eval time — the schema does at write time). First catch-all wins.
      return rule.confirmations;
    }
    let ruleValue: bigint;
    try {
      ruleValue = scaleDecimalToRaw(rule.amount, decimals);
    } catch {
      continue; // malformed rule — skip
    }
    if (compareWithOp(txValue, ruleValue, rule.op)) {
      return rule.confirmations;
    }
  }
  return null;
}

function compareWithOp(left: bigint, right: bigint, op: ConfirmationTierOp): boolean {
  switch (op) {
    case "<":  return left < right;
    case "<=": return left <= right;
    case ">":  return left > right;
    case ">=": return left >= right;
    case "=":  return left === right;
    case "<>": return left !== right;
  }
}

// Look up the (chainId, token) entry in a merchant/invoice/payout's tier map
// (parsed from JSON column). Returns null when:
//   - merchantTiersJson is null / empty / malformed
//   - the (chainId, token) key isn't in the map
// In all those cases the caller falls back to the flat confirmation_threshold.
export function lookupTierRules(
  tiersJson: string | null,
  chainId: number,
  token: string
): readonly ConfirmationTierRule[] | null {
  if (tiersJson === null || tiersJson.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(tiersJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const map = parsed as Record<string, unknown>;
  const key = `${chainId}:${token.toUpperCase()}`;
  const entry = map[key];
  if (!Array.isArray(entry)) return null;
  // Caller treats validation failures as "no tier" — fall through to flat.
  // We don't re-Zod-parse here because the admin API validates at write time
  // and runtime parse cost matters on the confirmation hot path.
  return entry as ConfirmationTierRule[];
}

// Parse the `FINALITY_OVERRIDES` env format: `chainId:threshold,chainId:threshold`.
// Invalid entries are silently skipped and logged by the caller — a typo in
// one entry should not crash boot; the default threshold applies instead.
export function parseFinalityOverridesEnv(
  raw: string | undefined
): Readonly<Record<number, number>> {
  if (raw === undefined || raw.length === 0) return {};
  const out: Record<number, number> = {};
  for (const part of raw.split(",")) {
    const [chainIdStr, thresholdStr] = part.split(":").map((s) => s.trim());
    if (chainIdStr === undefined || thresholdStr === undefined) continue;
    const chainId = Number.parseInt(chainIdStr, 10);
    const threshold = Number.parseInt(thresholdStr, 10);
    if (!Number.isFinite(chainId) || chainId <= 0) continue;
    if (!Number.isFinite(threshold) || threshold < 0) continue;
    out[chainId] = threshold;
  }
  return out;
}
