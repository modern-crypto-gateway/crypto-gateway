import { describe, expect, it } from "vitest";
import { wireTron } from "../../../../adapters/chains/tron/wire.js";
import type { Logger, LogFields } from "../../../../core/ports/logger.port.js";

// Captures log calls so tests can assert which rental providers got wired —
// wireTron doesn't expose the adapter's internal config any other way.
function captureLogger() {
  const entries: Array<{ level: string; message: string; fields?: LogFields }> = [];
  const logger: Logger = {
    debug: (message, fields) => void entries.push({ level: "debug", message, ...(fields ? { fields } : {}) }),
    info: (message, fields) => void entries.push({ level: "info", message, ...(fields ? { fields } : {}) }),
    warn: (message, fields) => void entries.push({ level: "warn", message, ...(fields ? { fields } : {}) }),
    error: (message, fields) => void entries.push({ level: "error", message, ...(fields ? { fields } : {}) }),
    child: () => logger
  };
  return { logger, entries };
}

function rentalWiredEntry(entries: ReturnType<typeof captureLogger>["entries"]) {
  return entries.find((e) => e.message === "tron energy rental wired");
}

describe("wireTron — energy rental provider selection", () => {
  it("wires both markets for cheapest-wins when both credentials are present", () => {
    const { logger, entries } = captureLogger();
    wireTron({
      network: "mainnet",
      trongridApiKey: "tg-key",
      tronsaveApiKey: "ts-key",
      tronEnergyMarketApiKey: "tem-key",
      tronEnergyMarketAddress: "TGMvWrWVqQXUdfNeYRrnNCkbZkKkpRZJAA",
      logger
    });
    expect(rentalWiredEntry(entries)?.fields?.["providers"]).toEqual(["tronenergy.market", "tronsave"]);
  });

  it("pins rental to a single provider when requested", () => {
    const { logger, entries } = captureLogger();
    wireTron({
      network: "mainnet",
      trongridApiKey: "tg-key",
      tronsaveApiKey: "ts-key",
      tronEnergyMarketApiKey: "tem-key",
      tronEnergyMarketAddress: "TGMvWrWVqQXUdfNeYRrnNCkbZkKkpRZJAA",
      energyRentalPinnedProvider: "tronsave",
      logger
    });
    const wired = rentalWiredEntry(entries);
    expect(wired?.fields?.["providers"]).toEqual(["tronsave"]);
    expect(wired?.fields?.["pinned"]).toBe("tronsave");
  });

  it("disables rental (with a warning) when the pinned provider isn't configured", () => {
    const { logger, entries } = captureLogger();
    wireTron({
      network: "mainnet",
      trongridApiKey: "tg-key",
      tronsaveApiKey: "ts-key",
      energyRentalPinnedProvider: "tronenergy.market",
      logger
    });
    expect(rentalWiredEntry(entries)).toBeUndefined();
    expect(entries.some((e) => e.level === "warn" && e.message.includes("pinned provider"))).toBe(true);
  });

  it("skips tronenergy.market on nile (no testnet environment) but keeps tronsave", () => {
    const { logger, entries } = captureLogger();
    wireTron({
      network: "nile",
      trongridApiKey: "tg-key",
      tronsaveApiKey: "ts-key",
      tronEnergyMarketApiKey: "tem-key",
      tronEnergyMarketAddress: "TGMvWrWVqQXUdfNeYRrnNCkbZkKkpRZJAA",
      logger
    });
    expect(rentalWiredEntry(entries)?.fields?.["providers"]).toEqual(["tronsave"]);
  });

  it("skips tronenergy.market when the account address is missing (orders need it)", () => {
    const { logger, entries } = captureLogger();
    wireTron({
      network: "mainnet",
      trongridApiKey: "tg-key",
      tronEnergyMarketApiKey: "tem-key",
      logger
    });
    expect(rentalWiredEntry(entries)).toBeUndefined();
    expect(entries.some((e) => e.level === "warn" && e.message.includes("TRONENERGY_MARKET_ADDRESS"))).toBe(true);
  });
});
