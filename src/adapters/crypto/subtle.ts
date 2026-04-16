// Thin re-export of WebCrypto. Node 20+, Cloudflare Workers, Deno, Bun, and
// Vercel Edge all expose the same `globalThis.crypto` surface (SubtleCrypto +
// getRandomValues + randomUUID), so this file is almost a no-op. It exists so
// core/domain can import from one stable location rather than touching
// `globalThis` directly.
//
// Note on BufferSource casts: @types/node and lib.dom.d.ts disagree slightly
// about whether `new TextEncoder().encode(...)` produces a Uint8Array backed by
// ArrayBuffer or ArrayBufferLike. Every runtime we target accepts either at
// runtime, so we cast at the WebCrypto boundary rather than allocate copies.

export const subtle: SubtleCrypto = globalThis.crypto.subtle;

export function getRandomValues(array: Uint8Array): Uint8Array {
  return globalThis.crypto.getRandomValues(array);
}

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

const encoder = new TextEncoder();

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? encoder.encode(input) : input;
  const digest = await subtle.digest("SHA-256", data as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha256(key: string | Uint8Array, message: string | Uint8Array): Promise<Uint8Array> {
  const keyBytes = typeof key === "string" ? encoder.encode(key) : key;
  const msgBytes = typeof message === "string" ? encoder.encode(message) : message;
  const cryptoKey = await subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await subtle.sign("HMAC", cryptoKey, msgBytes as BufferSource);
  return new Uint8Array(sig);
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}
