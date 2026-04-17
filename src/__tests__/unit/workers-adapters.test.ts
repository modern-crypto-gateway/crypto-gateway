import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext, KVNamespace } from "@cloudflare/workers-types";
import { cfKvAdapter } from "../../adapters/cache/cf-kv.adapter.js";
import { waitUntilJobs } from "../../adapters/jobs/wait-until.adapter.js";
import { workersEnvSecrets } from "../../adapters/secrets/workers-env.js";

// These tests exercise the translation layer between Cloudflare's native
// binding interfaces and our port interfaces. They don't boot a full Worker —
// just assert that each port method delegates correctly to the underlying
// binding and normalizes the response shape.

// ---- CF KV ----

function makeFakeKv(): KVNamespace & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    _store: store,
    async get(key: string, _mode?: unknown) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, _opts?: unknown) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const prefix = opts.prefix ?? "";
      const allKeys = Array.from(store.keys()).filter((k) => k.startsWith(prefix)).sort();
      const cursorIdx = opts.cursor === undefined ? 0 : allKeys.findIndex((k) => k > opts.cursor!);
      const startIdx = cursorIdx === -1 ? allKeys.length : cursorIdx;
      const limit = opts.limit ?? 1000;
      const page = allKeys.slice(startIdx, startIdx + limit);
      const list_complete = startIdx + limit >= allKeys.length;
      const keys = page.map((name) => ({ name }));
      return list_complete
        ? { keys, list_complete: true }
        : { keys, list_complete: false, cursor: page[page.length - 1] };
    }
  };
  return kv as unknown as KVNamespace & { _store: Map<string, string> };
}

describe("cfKvAdapter", () => {
  it("get/put/delete round-trip through the binding", async () => {
    const kv = makeFakeKv();
    const cache = cfKvAdapter(kv);

    expect(await cache.get("missing")).toBeNull();
    await cache.put("k", "v");
    expect(await cache.get("k")).toBe("v");
    await cache.delete("k");
    expect(await cache.get("k")).toBeNull();
  });

  it("getJSON / putJSON round-trip through JSON.stringify", async () => {
    const kv = makeFakeKv();
    // kv.get("json" mode) normally returns the parsed object; our fake just
    // returns the raw string, so for this test we use a narrower path: our
    // adapter's getJSON calls `kv.get(key, "json")` directly, which our fake
    // returns as a plain string. Override to simulate real KV behavior.
    const originalGet = kv.get.bind(kv);
    (kv as unknown as { get: (k: string, m?: unknown) => unknown }).get = async (k: string, m?: unknown) => {
      const raw = await originalGet(k);
      if (m === "json" && typeof raw === "string") return JSON.parse(raw);
      return raw;
    };
    const cache = cfKvAdapter(kv);

    await cache.putJSON("obj", { a: 1, b: "two" });
    expect(await cache.getJSON<{ a: number; b: string }>("obj")).toEqual({ a: 1, b: "two" });
  });

  it("clamps ttlSeconds to the Workers KV minimum of 60s", async () => {
    const kv = makeFakeKv();
    const putSpy = vi.spyOn(kv, "put");
    const cache = cfKvAdapter(kv);
    await cache.put("k", "v", { ttlSeconds: 5 });
    expect(putSpy).toHaveBeenCalledWith("k", "v", { expirationTtl: 60 });
    await cache.put("k2", "v2", { ttlSeconds: 3600 });
    expect(putSpy).toHaveBeenLastCalledWith("k2", "v2", { expirationTtl: 3600 });
  });

  it("list returns keys and surfaces cursor only on incomplete pages", async () => {
    const kv = makeFakeKv();
    const cache = cfKvAdapter(kv);
    for (const k of ["p:a", "p:b", "p:c", "other"]) {
      await cache.put(k, "v");
    }
    const full = await cache.list("p:");
    expect([...full.keys].sort()).toEqual(["p:a", "p:b", "p:c"]);
    expect(full.cursor).toBeUndefined();

    const firstPage = await cache.list("p:", { limit: 2 });
    expect(firstPage.keys).toHaveLength(2);
    expect(firstPage.cursor).toBeDefined();
  });
});

// ---- waitUntil ----

describe("waitUntilJobs", () => {
  it("forwards deferred tasks to ctx.waitUntil", async () => {
    const waited: Array<Promise<unknown>> = [];
    const ctx: Partial<ExecutionContext> = {
      waitUntil: (p: Promise<unknown>) => {
        waited.push(p);
      },
      passThroughOnException: () => {}
    };
    const runner = waitUntilJobs(ctx as ExecutionContext);
    let ran = false;
    runner.defer(async () => {
      ran = true;
    });
    expect(waited).toHaveLength(1);
    await waited[0];
    expect(ran).toBe(true);
  });

  it("catches errors from a deferred task so the Worker response is unaffected", async () => {
    const waited: Array<Promise<unknown>> = [];
    const ctx: Partial<ExecutionContext> = {
      waitUntil: (p: Promise<unknown>) => void waited.push(p),
      passThroughOnException: () => {}
    };
    const runner = waitUntilJobs(ctx as ExecutionContext);
    runner.defer(async () => {
      throw new Error("boom");
    });
    // Must not throw when the task is awaited — the adapter swallows + logs.
    await expect(waited[0]).resolves.toBeUndefined();
  });

  it("drain is a no-op on Workers (the runtime owns lifetime)", async () => {
    const ctx: Partial<ExecutionContext> = {
      waitUntil: () => {},
      passThroughOnException: () => {}
    };
    const runner = waitUntilJobs(ctx as ExecutionContext);
    await expect(runner.drain(1_000)).resolves.toBeUndefined();
    expect(runner.inFlight()).toBe(0);
  });
});

// ---- workers-env secrets ----

describe("workersEnvSecrets", () => {
  it("returns string values from the env object", () => {
    const secrets = workersEnvSecrets({ FOO: "bar", EMPTY: "" });
    expect(secrets.getRequired("FOO")).toBe("bar");
    expect(secrets.getOptional("FOO")).toBe("bar");
  });

  it("throws from getRequired on missing or empty values", () => {
    const secrets = workersEnvSecrets({ EMPTY: "" });
    expect(() => secrets.getRequired("EMPTY")).toThrow(/not set/i);
    expect(() => secrets.getRequired("ABSENT")).toThrow(/not set/i);
  });

  it("getOptional returns undefined for missing / empty / non-string values", () => {
    const secrets = workersEnvSecrets({ EMPTY: "", BINDING: { not: "a string" } });
    expect(secrets.getOptional("EMPTY")).toBeUndefined();
    expect(secrets.getOptional("ABSENT")).toBeUndefined();
    expect(secrets.getOptional("BINDING")).toBeUndefined();
  });
});
