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

export function memorySignerStore(): SignerStore {
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
