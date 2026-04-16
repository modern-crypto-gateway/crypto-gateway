import type { SignerScope } from "../types/signer.js";

// Encrypted-at-rest store for long-lived private keys (fee wallets, sweep master,
// HD seed). Keys are decrypted only on the signing path and held only for the
// duration of a single signAndBroadcast call. Implementations wrap AES-GCM
// (via WebCrypto) with a master key sourced from SecretsProvider.

export interface SignerStore {
  put(scope: SignerScope, plaintextPrivateKey: string): Promise<void>;

  // Returns the decrypted plaintext. Callers should not cache the result.
  get(scope: SignerScope): Promise<string>;

  delete(scope: SignerScope): Promise<void>;

  // Returns true when a key exists for the given scope.
  has(scope: SignerScope): Promise<boolean>;
}
