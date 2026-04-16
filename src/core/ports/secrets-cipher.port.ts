// Symmetric encryption-at-rest for stored application secrets (merchant
// webhook HMAC secrets, Alchemy per-chain signing keys). The concrete
// implementation lives in `adapters/crypto/secrets-cipher.ts` (AES-GCM-256);
// the domain only depends on this port so the algorithm can evolve without
// touching call sites.

export interface SecretsCipher {
  // Encrypts `plaintext` with the configured master key. The returned string
  // is a self-describing wire format (currently `v1:<base64>`), so future
  // versions can add rotation or algorithm changes without migration.
  encrypt(plaintext: string): Promise<string>;

  // Decrypts a previously-encrypted value. Throws if the input is not a
  // recognised wire format, or if the ciphertext fails authentication.
  // Legacy plaintext is NOT accepted silently — if you read a row that
  // predates encryption, migrate it explicitly.
  decrypt(ciphertext: string): Promise<string>;
}
