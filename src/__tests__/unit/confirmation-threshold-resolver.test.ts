import { describe, it, expect } from "vitest";
import {
  resolveMerchantConfirmationThreshold,
  ConfirmationThresholdsSchema,
  DEFAULT_CONFIRMATION_THRESHOLDS,
  FALLBACK_CONFIRMATION_THRESHOLD
} from "../../core/domain/payment-config.js";

// Resolver precedence: merchant override > env override > chain default >
// fallback. This module is the single source of truth for snapshotting at
// invoice/payout create time, so the precedence order matters more than
// any individual call site's behavior.

describe("resolveMerchantConfirmationThreshold", () => {
  describe("precedence", () => {
    it("merchant override wins over env override", () => {
      const merchantJson = JSON.stringify({ "1": 50 });
      const envOverrides = { 1: 25 };
      expect(resolveMerchantConfirmationThreshold(1, merchantJson, envOverrides)).toBe(50);
    });

    it("env override wins over chain default when merchant has no entry", () => {
      const merchantJson = JSON.stringify({ "137": 100 }); // entry for a different chain
      const envOverrides = { 1: 25 };
      // chainId 1 not in merchant map → fall to env → 25 (vs default 12)
      expect(resolveMerchantConfirmationThreshold(1, merchantJson, envOverrides)).toBe(25);
    });

    it("chain default applies when merchant + env both miss", () => {
      // BTC default is 6 per DEFAULT_CONFIRMATION_THRESHOLDS
      expect(resolveMerchantConfirmationThreshold(800, null, undefined)).toBe(
        DEFAULT_CONFIRMATION_THRESHOLDS[800]
      );
    });

    it("fallback applies when chain isn't in defaults table", () => {
      // chainId 999_999 isn't in DEFAULT_CONFIRMATION_THRESHOLDS
      expect(resolveMerchantConfirmationThreshold(999_999, null, undefined)).toBe(
        FALLBACK_CONFIRMATION_THRESHOLD
      );
    });
  });

  describe("merchant JSON tolerance", () => {
    it("treats null merchantJson as no override (passes through)", () => {
      expect(resolveMerchantConfirmationThreshold(1, null, undefined)).toBe(
        DEFAULT_CONFIRMATION_THRESHOLDS[1]
      );
    });

    it("treats empty-string merchantJson as no override", () => {
      expect(resolveMerchantConfirmationThreshold(1, "", undefined)).toBe(
        DEFAULT_CONFIRMATION_THRESHOLDS[1]
      );
    });

    it("silently falls through on malformed JSON (doesn't throw)", () => {
      expect(resolveMerchantConfirmationThreshold(1, "{not json", undefined)).toBe(
        DEFAULT_CONFIRMATION_THRESHOLDS[1]
      );
    });

    it("silently falls through on JSON that isn't an object (array)", () => {
      expect(resolveMerchantConfirmationThreshold(1, "[1, 2, 3]", undefined)).toBe(
        DEFAULT_CONFIRMATION_THRESHOLDS[1]
      );
    });

    it("ignores entries with negative or zero values, falls through", () => {
      const json = JSON.stringify({ "1": 0, "800": -5 });
      expect(resolveMerchantConfirmationThreshold(1, json, undefined)).toBe(
        DEFAULT_CONFIRMATION_THRESHOLDS[1]
      );
      expect(resolveMerchantConfirmationThreshold(800, json, undefined)).toBe(
        DEFAULT_CONFIRMATION_THRESHOLDS[800]
      );
    });

    it("ignores non-integer values (string, float), falls through", () => {
      const json = JSON.stringify({ "1": "20", "800": 6.5 });
      expect(resolveMerchantConfirmationThreshold(1, json, undefined)).toBe(
        DEFAULT_CONFIRMATION_THRESHOLDS[1]
      );
      expect(resolveMerchantConfirmationThreshold(800, json, undefined)).toBe(
        DEFAULT_CONFIRMATION_THRESHOLDS[800]
      );
    });

    it("ignores out-of-range values (> 10_000), falls through", () => {
      const json = JSON.stringify({ "1": 100_000 });
      expect(resolveMerchantConfirmationThreshold(1, json, undefined)).toBe(
        DEFAULT_CONFIRMATION_THRESHOLDS[1]
      );
    });

    it("uses the merchant override when valid", () => {
      const json = JSON.stringify({ "1": 24, "800": 12 });
      expect(resolveMerchantConfirmationThreshold(1, json, undefined)).toBe(24);
      expect(resolveMerchantConfirmationThreshold(800, json, undefined)).toBe(12);
    });
  });

  describe("real-world scenarios", () => {
    it("low-risk merchant with 1 conf everywhere", () => {
      const json = JSON.stringify({ "1": 1, "137": 1, "800": 1, "801": 1 });
      expect(resolveMerchantConfirmationThreshold(1, json, undefined)).toBe(1);
      expect(resolveMerchantConfirmationThreshold(137, json, undefined)).toBe(1); // vs default 256
      expect(resolveMerchantConfirmationThreshold(800, json, undefined)).toBe(1); // vs default 6
    });

    it("high-risk B2B merchant with 100 confs on EVM, default elsewhere", () => {
      const json = JSON.stringify({ "1": 100, "137": 500 });
      expect(resolveMerchantConfirmationThreshold(1, json, undefined)).toBe(100);
      expect(resolveMerchantConfirmationThreshold(137, json, undefined)).toBe(500);
      // BTC not in their map — falls to default 6
      expect(resolveMerchantConfirmationThreshold(800, json, undefined)).toBe(
        DEFAULT_CONFIRMATION_THRESHOLDS[800]
      );
    });
  });
});

describe("ConfirmationThresholdsSchema", () => {
  it("accepts valid per-chain map", () => {
    const result = ConfirmationThresholdsSchema.parse({ "1": 24, "800": 12, "137": 8 });
    expect(result).toEqual({ "1": 24, "800": 12, "137": 8 });
  });

  it("accepts an empty object", () => {
    expect(ConfirmationThresholdsSchema.parse({})).toEqual({});
  });

  it("rejects non-numeric chainId keys", () => {
    expect(() => ConfirmationThresholdsSchema.parse({ "ethereum": 24 })).toThrow();
  });

  it("rejects zero or negative values", () => {
    expect(() => ConfirmationThresholdsSchema.parse({ "1": 0 })).toThrow();
    expect(() => ConfirmationThresholdsSchema.parse({ "1": -5 })).toThrow();
  });

  it("rejects non-integer values", () => {
    expect(() => ConfirmationThresholdsSchema.parse({ "1": 1.5 })).toThrow();
  });

  it("rejects values above the 10_000 ceiling", () => {
    expect(() => ConfirmationThresholdsSchema.parse({ "1": 100_000 })).toThrow();
  });
});
