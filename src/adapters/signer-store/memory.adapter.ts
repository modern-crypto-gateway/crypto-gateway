import type { SignerStore } from "../../core/ports/signer-store.port.ts";
import type { SignerScope } from "../../core/types/signer.js";

// Plaintext in-memory SignerStore. Correct for Node/Deno (single long-lived
// process) and tests. NOT safe on Cloudflare Workers or Vercel Edge: each
// isolate instantiates a fresh Map, so any key put() via the admin API is
// lost the moment the isolate terminates — the next fee-wallet payout will
// fail with "no key for scope". Deferred (Stage B.2): replace with a
// persistent, encrypted-at-rest signer store (options: D1-backed via
// secretsCipher; KV-backed; or HD-derived from MASTER_SEED so no private
// keys are stored at all). Until then, real-money payouts must run on the
// Node entrypoint only.

export interface MemorySignerStoreOptions {
  // Where this store is being constructed. The factory refuses to construct
  // on ephemeral runtimes when paired with a non-relaxed environment, since
  // that combination silently loses fee-wallet keys between isolate spawns
  // and no payout can ever succeed.
  runtime?: "node" | "deno" | "workers" | "vercel-edge" | "test";
  environment?: string;
  logger?: { warn: (msg: string, ctx?: Record<string, unknown>) => void };
}

const EPHEMERAL_RUNTIMES = new Set(["workers", "vercel-edge"]);
const RELAXED_ENVS = new Set(["development", "test"]);

export class UnsafeSignerStoreError extends Error {
  constructor(runtime: string, environment: string) {
    super(
      `memorySignerStore is unsafe on '${runtime}' with environment='${environment}': ` +
        "private keys live only for the current isolate and are lost between requests. " +
        "Wire a persistent, encrypted-at-rest SignerStore (D1-backed, KV-backed, " +
        "or HD-derived from MASTER_SEED) before running real-money payouts."
    );
    this.name = "UnsafeSignerStoreError";
  }
}

export function memorySignerStore(opts: MemorySignerStoreOptions = {}): SignerStore {
  const runtime = opts.runtime;
  const environment = opts.environment ?? "production";

  // Hard-fail boot on the only combination that cannot work correctly:
  // ephemeral isolate runtime + a non-relaxed environment (i.e. prod/staging).
  // The constructor throw makes misconfiguration obvious at startup instead
  // of erupting as a cryptic "no key for scope" at the first payout attempt.
  if (runtime !== undefined && EPHEMERAL_RUNTIMES.has(runtime) && !RELAXED_ENVS.has(environment)) {
    throw new UnsafeSignerStoreError(runtime, environment);
  }

  // Soft warning for the long-lived-process case (Node/Deno) when running
  // outside dev/test: the keys survive within the process but are lost on
  // restart, so the operator still needs to re-register every fee wallet
  // after a redeploy.
  if (runtime !== undefined && !EPHEMERAL_RUNTIMES.has(runtime) && !RELAXED_ENVS.has(environment)) {
    opts.logger?.warn(
      "memorySignerStore: running in production without a persistent signer store; fee-wallet keys must be re-registered after every restart",
      { runtime, environment }
    );
  }

  const store = new Map<string, string>();
  const key = (scope: SignerScope): string => JSON.stringify(scope);

  return {
    async put(scope, plaintextPrivateKey) {
      store.set(key(scope), plaintextPrivateKey);
    },
    async get(scope) {
      const value = store.get(key(scope));
      if (value === undefined) {
        throw new Error(`SignerStore: no key for scope ${key(scope)}`);
      }
      return value;
    },
    async delete(scope) {
      store.delete(key(scope));
    },
    async has(scope) {
      return store.has(key(scope));
    }
  };
}
