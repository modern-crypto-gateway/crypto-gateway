import { describe, expect, it, vi } from "vitest";
import {
  readAlchemyNotifyToken,
  readAlchemyNotifyTokenFromEnv
} from "../../adapters/detection/alchemy-token.js";
import type { Logger } from "../../core/ports/logger.port.ts";
import type { SecretsProvider } from "../../core/ports/secrets.port.ts";

function stubSecrets(values: Record<string, string | undefined>): SecretsProvider {
  return {
    getOptional: (k) => values[k],
    getRequired: (k) => {
      const v = values[k];
      if (v === undefined) throw new Error(`missing ${k}`);
      return v;
    }
  };
}

function stubLogger(): Logger & { entries: Array<{ level: string; msg: string }> } {
  const entries: Array<{ level: string; msg: string }> = [];
  return {
    entries,
    debug: (msg: string) => entries.push({ level: "debug", msg }),
    info: (msg: string) => entries.push({ level: "info", msg }),
    warn: (msg: string) => entries.push({ level: "warn", msg }),
    error: (msg: string) => entries.push({ level: "error", msg })
  } as never;
}

describe("readAlchemyNotifyToken", () => {
  it("returns the new ALCHEMY_NOTIFY_TOKEN when set", () => {
    const log = stubLogger();
    const token = readAlchemyNotifyToken(
      stubSecrets({ ALCHEMY_NOTIFY_TOKEN: "new_tok" }),
      log
    );
    expect(token).toBe("new_tok");
    expect(log.entries.filter((e) => e.level === "warn")).toHaveLength(0);
  });

  it("falls back to ALCHEMY_AUTH_TOKEN (legacy) with a deprecation warning", () => {
    const log = stubLogger();
    const token = readAlchemyNotifyToken(
      stubSecrets({ ALCHEMY_AUTH_TOKEN: "legacy_tok" }),
      log
    );
    expect(token).toBe("legacy_tok");
    const warning = log.entries.find((e) => e.level === "warn");
    expect(warning?.msg).toMatch(/ALCHEMY_AUTH_TOKEN is deprecated/);
  });

  it("prefers the new name when BOTH are set (no fallback warning fires)", () => {
    const log = stubLogger();
    const token = readAlchemyNotifyToken(
      stubSecrets({ ALCHEMY_NOTIFY_TOKEN: "new_tok", ALCHEMY_AUTH_TOKEN: "legacy_tok" }),
      log
    );
    expect(token).toBe("new_tok");
    expect(log.entries.filter((e) => e.level === "warn")).toHaveLength(0);
  });

  it("returns undefined when neither is set", () => {
    const token = readAlchemyNotifyToken(stubSecrets({}));
    expect(token).toBeUndefined();
  });

  it("logger argument is optional", () => {
    expect(() => readAlchemyNotifyToken(stubSecrets({ ALCHEMY_AUTH_TOKEN: "x" }))).not.toThrow();
  });
});

describe("readAlchemyNotifyTokenFromEnv (Workers path)", () => {
  it("returns the new name when set", () => {
    const token = readAlchemyNotifyTokenFromEnv({ ALCHEMY_NOTIFY_TOKEN: "new_tok" });
    expect(token).toBe("new_tok");
  });

  it("falls back to the legacy name with a warning", () => {
    const warn = vi.fn();
    const logger = { warn, info: () => {}, debug: () => {}, error: () => {} } as unknown as Logger;
    const token = readAlchemyNotifyTokenFromEnv({ ALCHEMY_AUTH_TOKEN: "legacy_tok" }, logger);
    expect(token).toBe("legacy_tok");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("ignores empty-string values so unset CF secrets don't masquerade as set", () => {
    const token = readAlchemyNotifyTokenFromEnv({
      ALCHEMY_NOTIFY_TOKEN: "",
      ALCHEMY_AUTH_TOKEN: ""
    });
    expect(token).toBeUndefined();
  });
});
