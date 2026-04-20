import { describe, expect, it } from "vitest";
import { mulDecimal } from "../../core/domain/payout.service.js";

// Audit regression guards. Prior version truncated to 2dp (systematic
// under-quoting) and produced leading-dot output when wholePart was empty.

describe("mulDecimal — USD display math", () => {
  it("handles integer × integer", () => {
    expect(mulDecimal("10", "5")).toBe("50.00");
    expect(mulDecimal("0", "2500")).toBe("0.00");
  });

  it("rounds half-up to 2 decimals (was truncating before)", () => {
    // 0.001 × 2500.999 = 2.502499 → rounds to 2.50.
    expect(mulDecimal("0.001", "2500.999")).toBe("2.50");
    // 0.001 × 2500.5 = 2.5005 → rounds up to 2.50 (2.5005 → .5 rule → 2.51).
    // NB: "2.5005" third fractional digit is "0", rounds to 2.50. The .5 case
    // happens at 0.002 × 2500.5 = 5.001 → third digit 1, stays 5.00.
    // Exercise a definitive half-up case:
    // 0.001 × 2501 = 2.501 → third digit 1 → stays 2.50.
    expect(mulDecimal("0.001", "2501")).toBe("2.50");
    // 0.0011 × 2500 = 2.75 exactly → 2.75.
    expect(mulDecimal("0.0011", "2500")).toBe("2.75");
    // 0.01 × 0.5 = 0.005 → third digit 5 → rounds to 0.01.
    expect(mulDecimal("0.01", "0.5")).toBe("0.01");
  });

  it("never returns a string starting with a bare dot when wholePart is empty", () => {
    // Old bug: mulDecimal("0.01", "0.5") produced ".01" when the whole part
    // collapsed to "". Now always "0.XX".
    expect(mulDecimal("0.01", "0.5")).toMatch(/^\d/);
    expect(mulDecimal("0.001", "0.5")).toMatch(/^\d/);
    expect(mulDecimal("0", "1")).toMatch(/^\d/);
  });

  it("handles the exact values used by the estimate flow (ETH quote scenario)", () => {
    // 21000 gas × 100 Gwei maxFeePerGas = 2100000 Gwei = 0.0021 ETH.
    // formatRawDecimal would give "0.0021". At $2500/ETH: 0.0021 × 2500 = $5.25.
    expect(mulDecimal("0.0021", "2500")).toBe("5.25");
    // Tiny values shouldn't lose precision on the way out.
    expect(mulDecimal("0.000000001", "2500")).toBe("0.00");
  });

  it("handles large BigInt products without overflow", () => {
    // 1B × 1B = 1e18, still fits in BigInt trivially.
    expect(mulDecimal("1000000000", "1000000000")).toBe("1000000000000000000.00");
  });
});
