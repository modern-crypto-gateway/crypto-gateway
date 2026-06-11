import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadConfig } from "../../config/config.schema.js";

describe("loadConfig", () => {
  it("returns a typed AppConfig with defaults applied", () => {
    const config = loadConfig({});
    expect(config.environment).toBe("development");
    expect(config.port).toBe(8787);
  });

  it("parses env vars by their documented names (NODE_ENV, PORT, MASTER_SEED, ...)", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PORT: "9000",
      MASTER_SEED: "cat ".repeat(11) + "ranch",
      ADMIN_KEY: "x".repeat(32),
      SECRETS_ENCRYPTION_KEY: "a".repeat(64),
      DB_ADAPTER: "libsql",
      DATABASE_URL: "file:./foo.db"
    });
    expect(config.environment).toBe("production");
    expect(config.port).toBe(9000);
    expect(config.masterSeed).toContain("ranch");
    expect(config.adminKey).toHaveLength(32);
    expect(config.secretsEncryptionKey).toHaveLength(64);
    expect(config.dbAdapter).toBe("libsql");
    expect(config.databaseUrl).toBe("file:./foo.db");
  });

  it("coerces PORT from string and validates the range", () => {
    expect(loadConfig({ PORT: "3000" }).port).toBe(3000);
    expect(() => loadConfig({ PORT: "0" })).toThrow(ConfigValidationError);
    expect(() => loadConfig({ PORT: "70000" })).toThrow(ConfigValidationError);
    expect(() => loadConfig({ PORT: "not-a-number" })).toThrow(ConfigValidationError);
  });

  it("rejects unknown DB_ADAPTER / CACHE_ADAPTER / JOBS_ADAPTER values", () => {
    expect(() => loadConfig({ DB_ADAPTER: "mysql" })).toThrow(ConfigValidationError);
    expect(() => loadConfig({ CACHE_ADAPTER: "memcached" })).toThrow(ConfigValidationError);
    expect(() => loadConfig({ JOBS_ADAPTER: "bull" })).toThrow(ConfigValidationError);
  });

  it("treats empty strings as absent (so dotenv's '' does not masquerade as a real value)", () => {
    const config = loadConfig({ MASTER_SEED: "", DATABASE_URL: "" });
    expect(config.masterSeed).toBeUndefined();
    expect(config.databaseUrl).toBeUndefined();
  });

  describe("production refinements", () => {
    it("requires MASTER_SEED in production", () => {
      expect(() =>
        loadConfig({ NODE_ENV: "production", ADMIN_KEY: "x".repeat(32) })
      ).toThrow(/MASTER_SEED/);
    });

    it("rejects the 'dev-seed' placeholder in production", () => {
      expect(() =>
        loadConfig({ NODE_ENV: "production", MASTER_SEED: "dev-seed", ADMIN_KEY: "x".repeat(32) })
      ).toThrow(/MASTER_SEED/);
    });

    it("requires ADMIN_KEY of at least 32 chars in production", () => {
      expect(() =>
        loadConfig({ NODE_ENV: "production", MASTER_SEED: "real mnemonic", ADMIN_KEY: "short" })
      ).toThrow(/ADMIN_KEY/);
    });

    it("allows dev with no MASTER_SEED (the node entrypoint fills in a placeholder)", () => {
      const config = loadConfig({ NODE_ENV: "development" });
      expect(config.masterSeed).toBeUndefined();
    });

    it("allows the 'test' environment to skip MASTER_SEED + ADMIN_KEY refinements", () => {
      expect(() => loadConfig({ NODE_ENV: "test" })).not.toThrow();
    });

    it("requires SECRETS_ENCRYPTION_KEY as 64 hex chars in production", () => {
      const baseline = {
        NODE_ENV: "production",
        MASTER_SEED: "cat ".repeat(11) + "ranch",
        ADMIN_KEY: "x".repeat(32)
      };
      expect(() => loadConfig(baseline)).toThrow(/SECRETS_ENCRYPTION_KEY/);
      expect(() => loadConfig({ ...baseline, SECRETS_ENCRYPTION_KEY: "short" })).toThrow(/SECRETS_ENCRYPTION_KEY/);
      expect(() =>
        loadConfig({ ...baseline, SECRETS_ENCRYPTION_KEY: "zzzz".repeat(16) })
      ).toThrow(/SECRETS_ENCRYPTION_KEY/);
      expect(() =>
        loadConfig({ ...baseline, SECRETS_ENCRYPTION_KEY: "a".repeat(64) })
      ).not.toThrow();
    });

    it("requires BLOCKCYPHER_INGEST_TOKEN in production when BlockCypher push detection is enabled", () => {
      const baseline = {
        NODE_ENV: "production",
        MASTER_SEED: "cat ".repeat(11) + "ranch",
        ADMIN_KEY: "x".repeat(32),
        SECRETS_ENCRYPTION_KEY: "a".repeat(64)
      };
      // BlockCypher enabled (per-chain token var set) but no ingest token → boot error.
      expect(() =>
        loadConfig({ ...baseline, BLOCKCYPHER_TOKEN_BITCOIN: "bc-account-token" })
      ).toThrow(/BLOCKCYPHER_INGEST_TOKEN/);
      // Half-pair detection: a callback URL alone also signals intent.
      expect(() =>
        loadConfig({ ...baseline, BLOCKCYPHER_CALLBACK_URL_BITCOIN: "https://gw/webhooks/blockcypher/800" })
      ).toThrow(/BLOCKCYPHER_INGEST_TOKEN/);
      // Token present → passes.
      expect(() =>
        loadConfig({
          ...baseline,
          BLOCKCYPHER_TOKEN_BITCOIN: "bc-account-token",
          BLOCKCYPHER_INGEST_TOKEN: "ingest-token"
        })
      ).not.toThrow();
    });

    it("does not require BLOCKCYPHER_INGEST_TOKEN when BlockCypher is not enabled", () => {
      const baseline = {
        NODE_ENV: "production",
        MASTER_SEED: "cat ".repeat(11) + "ranch",
        ADMIN_KEY: "x".repeat(32),
        SECRETS_ENCRYPTION_KEY: "a".repeat(64)
      };
      // No BLOCKCYPHER_* vars at all → no ingest-token requirement.
      expect(() => loadConfig(baseline)).not.toThrow();
      // Legacy single-form vars are no longer recognized and don't count as "enabled".
      expect(() =>
        loadConfig({ ...baseline, BLOCKCYPHER_TOKEN: "legacy-ignored" })
      ).not.toThrow();
    });

    it("allows BlockCypher without an ingest token in development/test (relaxed envs)", () => {
      expect(() =>
        loadConfig({ NODE_ENV: "development", BLOCKCYPHER_TOKEN_BITCOIN: "bc-account-token" })
      ).not.toThrow();
      expect(() =>
        loadConfig({ NODE_ENV: "test", BLOCKCYPHER_TOKEN_BITCOIN: "bc-account-token" })
      ).not.toThrow();
    });

    it("applies production guards to NODE_ENV=staging (prevents pre-prod with placeholder secrets)", () => {
      expect(() =>
        loadConfig({ NODE_ENV: "staging", ADMIN_KEY: "x".repeat(32) })
      ).toThrow(/MASTER_SEED/);
      expect(() =>
        loadConfig({ NODE_ENV: "staging", MASTER_SEED: "dev-seed", ADMIN_KEY: "x".repeat(32) })
      ).toThrow(/MASTER_SEED/);
      expect(() =>
        loadConfig({ NODE_ENV: "staging", MASTER_SEED: "real mnemonic", ADMIN_KEY: "short" })
      ).toThrow(/ADMIN_KEY/);
    });
  });

  describe("adapter-coupled refinements", () => {
    it("requires DATABASE_URL when DB_ADAPTER=libsql", () => {
      expect(() => loadConfig({ DB_ADAPTER: "libsql" })).toThrow(/DATABASE_URL/);
    });

    it("requires REDIS_URL when CACHE_ADAPTER=redis", () => {
      expect(() => loadConfig({ CACHE_ADAPTER: "redis" })).toThrow(/REDIS_URL/);
    });

    it("accepts DB_ADAPTER=turso (alias for libsql) and still enforces DATABASE_URL", () => {
      expect(() => loadConfig({ DB_ADAPTER: "turso" })).not.toThrow();
    });
  });

  it("aggregates multiple issues into a single ConfigValidationError", () => {
    try {
      loadConfig({
        NODE_ENV: "production"
        // Missing MASTER_SEED and ADMIN_KEY
      });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const e = err as ConfigValidationError;
      expect(e.issues.length).toBeGreaterThanOrEqual(2);
      expect(e.message).toMatch(/Config validation failed/);
    }
  });
});
