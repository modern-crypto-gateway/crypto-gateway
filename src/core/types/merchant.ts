import { z } from "zod";
import type { Brand } from "./branded.js";

export const MerchantIdSchema = z.string().uuid();
export type MerchantId = Brand<z.infer<typeof MerchantIdSchema>, "MerchantId">;

// Basis points for payment tolerance. 1 bp = 0.01%; 100 bps = 1%; 10_000 = 100%.
// Hard-capped at 2000 bps (20%) — see PaymentToleranceBpsSchema callers.
export const PaymentToleranceBpsSchema = z.number().int().min(0).max(2000);

export const MerchantSchema = z.object({
  id: MerchantIdSchema,
  name: z.string().min(1).max(128),
  // SHA-256 hex of the plaintext API key. Plaintext is shown once at creation and never stored.
  apiKeyHash: z.string().length(64).regex(/^[0-9a-f]+$/),
  webhookUrl: z.string().url().nullable(),
  // AES-GCM ciphertext of the 32-byte HMAC signing secret, in the wire format
  // produced by `SecretsCipher.encrypt` (`v1:<base64>`). Decrypted on demand
  // in webhook-subscriber.ts; plaintext never lands in the DB.
  webhookSecretCiphertext: z.string().nullable(),
  // SQLite stores booleans as INTEGER (0/1). We expose the row value directly
  // rather than coercing, because every query site reads it as a number and
  // comparing against 1 is clearer than flipping to boolean midway.
  active: z.number().int().min(0).max(1),
  // Default invoice payment tolerance, basis points. 0 = strict (legacy).
  // Hard-capped at 2000 bps (20%) — any larger value almost certainly
  // indicates a misconfigured merchant rather than a real business need,
  // and an overly loose tolerance closes invoices that effectively went
  // unpaid.
  paymentToleranceUnderBps: PaymentToleranceBpsSchema,
  paymentToleranceOverBps: PaymentToleranceBpsSchema,
  createdAt: z.date(),
  updatedAt: z.date()
});
export type Merchant = z.infer<typeof MerchantSchema> & { id: MerchantId };
