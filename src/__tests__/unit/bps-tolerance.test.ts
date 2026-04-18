import { describe, expect, it } from "vitest";
import { applyBps } from "../../core/domain/rate-window.js";

describe("applyBps", () => {
  it("returns the input unchanged when bps=0 (strict, default)", () => {
    expect(applyBps("100.00", 0, "down")).toBe("100.00");
    expect(applyBps("100.00", 0, "up")).toBe("100.00");
    expect(applyBps("0.01", 0, "down")).toBe("0.01");
  });

  it("subtracts bps from amount with direction=down (under-tolerance threshold)", () => {
    // 1% off 100.00 = 99.00
    expect(applyBps("100.00", 100, "down")).toBe("99.00");
    // 0.5% off 200.00 = 199.00
    expect(applyBps("200.00", 50, "down")).toBe("199.00");
    // 50 bps off 2.00 = 1.99
    expect(applyBps("2.00", 50, "down")).toBe("1.99");
  });

  it("adds bps to amount with direction=up (overpaid threshold)", () => {
    // +1% on 100.00 = 101.00
    expect(applyBps("100.00", 100, "up")).toBe("101.00");
    // +50 bps on 200.00 = 201.00
    expect(applyBps("200.00", 50, "up")).toBe("201.00");
  });

  it("clamps to 0.00 if a down-direction subtraction would go negative", () => {
    // 200% under 1.00 — 1.00 - 2.00 = -1.00 → 0.00
    expect(applyBps("1.00", 20_000, "down")).toBe("0.00");
  });

  it("floors when fractional cents arise from bps math (USD always rounds down at one cent)", () => {
    // 33 bps off 1.00 = 0.0033 → 0.99 (1 cent off, rest dropped)
    expect(applyBps("1.00", 33, "down")).toBe("0.99");
    // +33 bps on 1.00 = +0.0033 → 1.00 (no extra cent yet)
    expect(applyBps("1.00", 33, "up")).toBe("1.00");
  });

  it("survives the user's real-world case: $2.00 - 50 bps = $1.99 threshold", () => {
    // The actual scenario from prod: invoice for $2.00, paid $1.99, merchant
    // wants 0.5% under-tolerance to close as confirmed.
    const threshold = applyBps("2.00", 50, "down");
    expect(threshold).toBe("1.99");
  });
});
