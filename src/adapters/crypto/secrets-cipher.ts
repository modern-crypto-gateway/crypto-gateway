import type { SecretsCipher } from "../../core/ports/secrets-cipher.port.ts";
import { getRandomValues, subtle } from "./subtle.js";
export type { SecretsCipher };

// Symmetric encryption-at-rest for application secrets stored in the DB
// (merchant webhook HMAC secrets, Alchemy signing keys). The wire format is
// deliberately tagged so we can rotate keys or change algorithms later
// without ambiguity:
//
//   v1:<base64(iv || ciphertext_with_gcm_tag)>
//
// - v1 = AES-GCM-256 with a 96-bit random IV, 128-bit tag.
// - iv is 12 bytes (GCM's recommended size).
// - ciphertext_with_gcm_tag is the output of SubtleCrypto's `encrypt`, which
//   already appends the auth tag.
//
// The master key is 32 bytes (AES-256), hex-encoded in the env var
// SECRETS_ENCRYPTION_KEY. Generating one:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// Dev convenience: callers may construct a cipher from a fixed well-known
// key ("dev-secrets-cipher-key" padded to 32 bytes) via `devCipher()`. Tests
// and local Node use this so the boot path doesn't require generating a key
// just to run `npm run dev:node`.

const VERSION_PREFIX = "v1:";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class SecretsCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsCipherError";
  }
}

export async function makeSecretsCipher(keyHex: string): Promise<SecretsCipher> {
  const keyBytes = hexToBytes(keyHex);
  if (keyBytes.length !== KEY_BYTES) {
    throw new SecretsCipherError(
      `SECRETS_ENCRYPTION_KEY must be ${KEY_BYTES * 2} hex chars (${KEY_BYTES} bytes); got ${keyBytes.length}`
    );
  }
  const cryptoKey = await subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
  return {
    async encrypt(plaintext) {
      const iv = getRandomValues(new Uint8Array(IV_BYTES));
      const encoded = new TextEncoder().encode(plaintext);
      const cipherBuf = await subtle.encrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        cryptoKey,
        encoded as BufferSource
      );
      const cipherBytes = new Uint8Array(cipherBuf);
      const combined = new Uint8Array(iv.length + cipherBytes.length);
      combined.set(iv, 0);
      combined.set(cipherBytes, iv.length);
      return VERSION_PREFIX + bytesToBase64(combined);
    },

    async decrypt(wireFormat) {
      if (!wireFormat.startsWith(VERSION_PREFIX)) {
        throw new SecretsCipherError(
          `ciphertext is missing the '${VERSION_PREFIX}' prefix — either corrupted or stored as legacy plaintext`
        );
      }
      const combined = base64ToBytes(wireFormat.slice(VERSION_PREFIX.length));
      if (combined.length <= IV_BYTES) {
        throw new SecretsCipherError("ciphertext too short to contain IV + payload");
      }
      const iv = combined.slice(0, IV_BYTES);
      const body = combined.slice(IV_BYTES);
      const plainBuf = await subtle.decrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        cryptoKey,
        body as BufferSource
      );
      return new TextDecoder().decode(plainBuf);
    }
  };
}

// Fixed well-known key for development. Same bytes every boot so rows written
// in one dev run decrypt in the next. DO NOT use in production — the key is
// public (in this file), so anyone with DB access can decrypt everything.
const DEV_KEY_HEX = "00".repeat(KEY_BYTES);

export function devCipher(): Promise<SecretsCipher> {
  return makeSecretsCipher(DEV_KEY_HEX);
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new SecretsCipherError("hex key must have even length");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) {
      throw new SecretsCipherError(`non-hex character in key at position ${i * 2}`);
    }
    out[i] = b;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Workers + Node + Deno all expose `btoa` via globalThis; we avoid Buffer
  // which isn't available on Workers without nodejs_compat.
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return globalThis.btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = globalThis.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
