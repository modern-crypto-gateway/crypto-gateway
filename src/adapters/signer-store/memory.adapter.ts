import type { SignerStore } from "../../core/ports/signer-store.port.ts";
import type { SignerScope } from "../../core/types/signer.js";

// Plaintext in-memory SignerStore for Phase 2 dev / tests. Phase 3 introduces
// an AES-GCM encrypted-at-rest variant keyed off SWEEP_MASTER_KEY.

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
