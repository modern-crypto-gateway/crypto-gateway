import { describe, expect, it } from "vitest";
import {
  devCipher,
  makeSecretsCipher,
  SecretsCipherError
} from "../../adapters/crypto/secrets-cipher.js";

const TEST_KEY = "11".repeat(32); // 32 bytes hex

describe("makeSecretsCipher", () => {
  it("encrypts and decrypts round-trip", async () => {
    const cipher = await makeSecretsCipher(TEST_KEY);
    const ciphertext = await cipher.encrypt("my-secret");
    expect(ciphertext).toMatch(/^v1:/);
    expect(await cipher.decrypt(ciphertext)).toBe("my-secret");
  });

  it("produces different ciphertexts for the same plaintext (random IV)", async () => {
    const cipher = await makeSecretsCipher(TEST_KEY);
    const a = await cipher.encrypt("same-input");
    const b = await cipher.encrypt("same-input");
    expect(a).not.toEqual(b);
    expect(await cipher.decrypt(a)).toBe("same-input");
    expect(await cipher.decrypt(b)).toBe("same-input");
  });

  it("rejects a key that is not 64 hex chars", async () => {
    await expect(makeSecretsCipher("short")).rejects.toBeInstanceOf(SecretsCipherError);
    await expect(makeSecretsCipher("00".repeat(16))).rejects.toBeInstanceOf(SecretsCipherError);
  });

  it("rejects ciphertext without the v1: prefix (legacy plaintext guard)", async () => {
    const cipher = await makeSecretsCipher(TEST_KEY);
    await expect(cipher.decrypt("raw-plaintext-no-prefix")).rejects.toBeInstanceOf(SecretsCipherError);
  });

  it("rejects tampered ciphertext (GCM auth tag catches it)", async () => {
    const cipher = await makeSecretsCipher(TEST_KEY);
    const ciphertext = await cipher.encrypt("hello");
    // Flip a byte in the base64 body — decryption must fail.
    const body = ciphertext.slice(3);
    const tampered = "v1:" + (body[0] === "A" ? "B" : "A") + body.slice(1);
    await expect(cipher.decrypt(tampered)).rejects.toBeDefined();
  });

  it("a ciphertext encrypted with one key does NOT decrypt under another", async () => {
    const a = await makeSecretsCipher("aa".repeat(32));
    const b = await makeSecretsCipher("bb".repeat(32));
    const ct = await a.encrypt("secret");
    await expect(b.decrypt(ct)).rejects.toBeDefined();
  });
});

describe("devCipher", () => {
  it("is deterministic across calls — same dev key, cross-cipher decrypt works", async () => {
    const a = await devCipher();
    const b = await devCipher();
    const ct = await a.encrypt("dev-secret");
    expect(await b.decrypt(ct)).toBe("dev-secret");
  });
});
