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
      DB_ADAPTER: "libsql",
      DATABASE_URL: "file:./foo.db"
    });
    expect(config.environment).toBe("production");
    expect(config.port).toBe(9000);
    expect(config.masterSeed).toContain("ranch");
    expect(config.adminKey).toHaveLength(32);
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
  });

  describe("adapter-coupled refinements", () => {
    it("requires DATABASE_URL when DB_ADAPTER=libsql", () => {
      expect(() => loadConfig({ DB_ADAPTER: "libsql" })).toThrow(/DATABASE_URL/);
    });

    it("requires REDIS_URL when CACHE_ADAPTER=redis", () => {
      expect(() => loadConfig({ CACHE_ADAPTER: "redis" })).toThrow(/REDIS_URL/);
    });

    it("is fine with DB_ADAPTER=d1 and no DATABASE_URL (D1 is a binding, not a URL)", () => {
      expect(() => loadConfig({ DB_ADAPTER: "d1" })).not.toThrow();
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
