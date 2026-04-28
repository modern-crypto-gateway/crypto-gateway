import { describe, it, expect } from "vitest";
import {
  evaluateConfirmationTier,
  lookupTierRules,
  ConfirmationTiersSchema,
  ConfirmationTierRuleSchema,
  type ConfirmationTierRule
} from "../../core/domain/payment-config.js";

// LTC has 8 decimals — same as BTC. ETH has 18. USDC has 6.
const LTC_DECIMALS = 8;
const ETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// Convenience: pack a tier rule (string amount + op + confirmations).
function rule(amount: string | undefined, op: ConfirmationTierRule["op"], confs: number): ConfirmationTierRule {
  return amount === undefined || op === undefined
    ? { confirmations: confs }
    : { amount, op, confirmations: confs };
}

// Convert "X LTC" to raw litoshis as a BigInt string. 1 LTC = 1e8 litoshis.
function ltc(amount: number): string {
  return BigInt(Math.round(amount * 1e8)).toString();
}

describe("evaluateConfirmationTier", () => {
  describe("operator semantics", () => {
    const rules: ConfirmationTierRule[] = [
      rule("0.5", "<", 1),
      rule("5", "<", 6),
      rule(undefined, undefined, 12) // catch-all
    ];

    it("amount=0.1 LTC → matches `<0.5` → 1 conf", () => {
      expect(evaluateConfirmationTier(ltc(0.1), LTC_DECIMALS, rules)).toBe(1);
    });

    it("amount=0.4999... LTC → matches `<0.5` → 1 conf", () => {
      // 0.49999999 LTC = 49999999 litoshis (just below 50000000 = 0.5 LTC)
      expect(evaluateConfirmationTier("49999999", LTC_DECIMALS, rules)).toBe(1);
    });

    it("amount=0.5 LTC exactly → falls through `<0.5`, matches `<5` → 6 conf", () => {
      expect(evaluateConfirmationTier(ltc(0.5), LTC_DECIMALS, rules)).toBe(6);
    });

    it("amount=4 LTC → matches `<5` → 6 conf", () => {
      expect(evaluateConfirmationTier(ltc(4), LTC_DECIMALS, rules)).toBe(6);
    });

    it("amount=5 LTC exactly → falls through `<5`, hits catch-all → 12", () => {
      expect(evaluateConfirmationTier(ltc(5), LTC_DECIMALS, rules)).toBe(12);
    });

    it("amount=100 LTC → catch-all → 12", () => {
      expect(evaluateConfirmationTier(ltc(100), LTC_DECIMALS, rules)).toBe(12);
    });
  });

  describe("each operator", () => {
    it("`<=` is inclusive at the boundary", () => {
      const r = [rule("1", "<=", 3), rule(undefined, undefined, 12)];
      expect(evaluateConfirmationTier(ltc(1), LTC_DECIMALS, r)).toBe(3);
      expect(evaluateConfirmationTier(ltc(0.999), LTC_DECIMALS, r)).toBe(3);
      expect(evaluateConfirmationTier(ltc(1.001), LTC_DECIMALS, r)).toBe(12);
    });

    it("`>` is strict-greater", () => {
      const r = [rule("10", ">", 24), rule(undefined, undefined, 6)];
      expect(evaluateConfirmationTier(ltc(10), LTC_DECIMALS, r)).toBe(6);    // not greater
      expect(evaluateConfirmationTier(ltc(10.01), LTC_DECIMALS, r)).toBe(24);
    });

    it("`>=` is inclusive at the boundary", () => {
      const r = [rule("10", ">=", 24), rule(undefined, undefined, 6)];
      expect(evaluateConfirmationTier(ltc(10), LTC_DECIMALS, r)).toBe(24);
      expect(evaluateConfirmationTier(ltc(9.999), LTC_DECIMALS, r)).toBe(6);
    });

    it("`=` exact match", () => {
      const r = [rule("0.125", "=", 99), rule(undefined, undefined, 6)];
      expect(evaluateConfirmationTier(ltc(0.125), LTC_DECIMALS, r)).toBe(99);
      expect(evaluateConfirmationTier(ltc(0.126), LTC_DECIMALS, r)).toBe(6);
    });

    it("`<>` not-equal", () => {
      const r = [rule("0.125", "<>", 6), rule(undefined, undefined, 12)];
      expect(evaluateConfirmationTier(ltc(0.125), LTC_DECIMALS, r)).toBe(12); // <> false → fall through
      expect(evaluateConfirmationTier(ltc(0.126), LTC_DECIMALS, r)).toBe(6);
    });
  });

  describe("ordering + first-match-wins", () => {
    it("evaluates top-to-bottom; first match wins", () => {
      // Rules ordered ASCENDING (correct for risk policy: smaller→fewer confs).
      const r = [
        rule("1",   "<", 1),
        rule("10",  "<", 6),
        rule("100", "<", 12),
        rule(undefined, undefined, 24)
      ];
      expect(evaluateConfirmationTier(ltc(0.5), LTC_DECIMALS, r)).toBe(1);
      expect(evaluateConfirmationTier(ltc(5), LTC_DECIMALS, r)).toBe(6);
      expect(evaluateConfirmationTier(ltc(50), LTC_DECIMALS, r)).toBe(12);
      expect(evaluateConfirmationTier(ltc(500), LTC_DECIMALS, r)).toBe(24);
    });

    it("badly-ordered rules: first match still wins (operator-rules give merchants the rope)", () => {
      // If an author writes `< 100` BEFORE `< 10`, every amount under 100
      // matches the first rule. This is the documented hazard of operator
      // mode — the schema doesn't enforce ordering, the author owns it.
      const r = [
        rule("100", "<", 99),  // catches almost everything
        rule("10",  "<", 1),   // never reached for amounts < 100
        rule(undefined, undefined, 24)
      ];
      expect(evaluateConfirmationTier(ltc(5), LTC_DECIMALS, r)).toBe(99);   // not 1
      expect(evaluateConfirmationTier(ltc(50), LTC_DECIMALS, r)).toBe(99);
      expect(evaluateConfirmationTier(ltc(150), LTC_DECIMALS, r)).toBe(24); // catch-all
    });
  });

  describe("no match + no catch-all", () => {
    it("returns null when no rule matches and there's no catch-all", () => {
      const r = [rule("1", "<", 1), rule("2", "<", 2)];
      // amount=10 — neither rule matches, no catch-all
      expect(evaluateConfirmationTier(ltc(10), LTC_DECIMALS, r)).toBeNull();
    });
  });

  describe("decimal handling", () => {
    it("ETH at 18 decimals is compared correctly", () => {
      const r = [rule("0.5", "<", 6), rule(undefined, undefined, 24)];
      // 0.4 ETH in raw wei = 0.4 * 1e18 = 400000000000000000
      expect(evaluateConfirmationTier("400000000000000000", ETH_DECIMALS, r)).toBe(6);
      // 0.5 ETH exactly → not strict-less, falls to catch-all
      expect(evaluateConfirmationTier("500000000000000000", ETH_DECIMALS, r)).toBe(24);
    });

    it("USDC at 6 decimals is compared correctly", () => {
      const r = [rule("100", "<", 3), rule("1000", "<", 12), rule(undefined, undefined, 24)];
      expect(evaluateConfirmationTier("99999999", USDC_DECIMALS, r)).toBe(3); // 99.99 USDC
      expect(evaluateConfirmationTier("100000000", USDC_DECIMALS, r)).toBe(12); // 100 USDC exactly
      expect(evaluateConfirmationTier("999999999", USDC_DECIMALS, r)).toBe(12); // 999.99 USDC
      expect(evaluateConfirmationTier("1000000000", USDC_DECIMALS, r)).toBe(24); // 1000 USDC
    });

    it("rule amount with more fraction digits than token decimals truncates (no rounding)", () => {
      // rule "0.000005" against LTC (8 decimals) = 500 litoshis.
      // We compare raw amounts; "0.000005" → 500 litoshis exactly.
      const r = [rule("0.000005", "<", 1), rule(undefined, undefined, 12)];
      expect(evaluateConfirmationTier("499", LTC_DECIMALS, r)).toBe(1);  // 499 < 500
      expect(evaluateConfirmationTier("500", LTC_DECIMALS, r)).toBe(12); // 500 not < 500
    });
  });

  describe("malformed input tolerance", () => {
    it("returns null when amount_raw isn't a valid BigInt string", () => {
      const r = [rule("1", "<", 1), rule(undefined, undefined, 12)];
      expect(evaluateConfirmationTier("not-a-number", LTC_DECIMALS, r)).toBeNull();
    });

    it("skips a single malformed rule and continues to the next", () => {
      // Mid-list rule with an unparseable amount. Eval skips it, evaluates
      // the rest. The Zod schema should prevent this at write time anyway.
      const r: ConfirmationTierRule[] = [
        { amount: "abc", op: "<", confirmations: 99 } as ConfirmationTierRule,
        rule("10", "<", 6),
        rule(undefined, undefined, 12)
      ];
      expect(evaluateConfirmationTier(ltc(5), LTC_DECIMALS, r)).toBe(6);
    });
  });
});

describe("lookupTierRules", () => {
  const tiersJson = JSON.stringify({
    "801:LTC": [{ amount: "0.5", op: "<", confirmations: 1 }, { confirmations: 12 }],
    "1:USDT":  [{ amount: "100", op: ">", confirmations: 24 }, { confirmations: 6 }]
  });

  it("returns the matching tier list for a (chainId, token) pair", () => {
    const rules = lookupTierRules(tiersJson, 801, "LTC");
    expect(rules).toHaveLength(2);
    expect(rules?.[0]).toEqual({ amount: "0.5", op: "<", confirmations: 1 });
  });

  it("token comparison is case-insensitive (uppercased to match key shape)", () => {
    expect(lookupTierRules(tiersJson, 801, "ltc")).toHaveLength(2);
    expect(lookupTierRules(tiersJson, 801, "Ltc")).toHaveLength(2);
  });

  it("returns null when no matching key", () => {
    expect(lookupTierRules(tiersJson, 999, "LTC")).toBeNull();
    expect(lookupTierRules(tiersJson, 801, "BTC")).toBeNull();
  });

  it("returns null on null/empty/malformed input", () => {
    expect(lookupTierRules(null, 801, "LTC")).toBeNull();
    expect(lookupTierRules("", 801, "LTC")).toBeNull();
    expect(lookupTierRules("{not json", 801, "LTC")).toBeNull();
    expect(lookupTierRules("[1, 2, 3]", 801, "LTC")).toBeNull(); // array, not object
  });
});

describe("ConfirmationTiersSchema (Zod)", () => {
  it("accepts a valid map", () => {
    const parsed = ConfirmationTiersSchema.parse({
      "801:LTC": [{ amount: "0.5", op: "<", confirmations: 1 }, { confirmations: 12 }],
      "1:ETH":   [{ confirmations: 24 }]
    });
    expect(parsed).toBeDefined();
  });

  it("rejects keys that don't match `chainId:TOKEN`", () => {
    expect(() => ConfirmationTiersSchema.parse({ "ltc": [{ confirmations: 1 }] })).toThrow();
    expect(() => ConfirmationTiersSchema.parse({ "801": [{ confirmations: 1 }] })).toThrow();
    expect(() => ConfirmationTiersSchema.parse({ "801:ltc": [{ confirmations: 1 }] })).toThrow();
  });

  it("rejects an empty rule list", () => {
    expect(() => ConfirmationTiersSchema.parse({ "1:ETH": [] })).toThrow();
  });

  it("rule schema rejects partial amount/op (must be paired or both omitted)", () => {
    expect(() =>
      ConfirmationTierRuleSchema.parse({ amount: "1", confirmations: 12 })
    ).toThrow(/`amount` and `op` must be provided together/);
    expect(() =>
      ConfirmationTierRuleSchema.parse({ op: "<", confirmations: 12 })
    ).toThrow(/`amount` and `op` must be provided together/);
  });

  it("rule schema accepts a catch-all (no amount/op) and a regular rule", () => {
    expect(ConfirmationTierRuleSchema.parse({ confirmations: 12 })).toBeDefined();
    expect(
      ConfirmationTierRuleSchema.parse({ amount: "0.5", op: "<", confirmations: 1 })
    ).toBeDefined();
  });

  it("rule schema rejects invalid operator", () => {
    expect(() =>
      ConfirmationTierRuleSchema.parse({ amount: "1", op: "==", confirmations: 1 })
    ).toThrow();
  });
});
