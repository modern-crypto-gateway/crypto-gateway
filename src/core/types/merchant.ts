import { z } from "zod";
import type { Brand } from "./branded.js";

export const MerchantIdSchema = z.string().uuid();
export type MerchantId = Brand<z.infer<typeof MerchantIdSchema>, "MerchantId">;

export const MerchantSchema = z.object({
  id: MerchantIdSchema,
  name: z.string().min(1).max(128),
  // SHA-256 hex of the plaintext API key. Plaintext is shown once at creation and never stored.
  apiKeyHash: z.string().length(64).regex(/^[0-9a-f]+$/),
  webhookUrl: z.string().url().nullable(),
  // PLAINTEXT 32-byte HMAC signing secret (hex-encoded), used as-is to sign
  // outgoing webhook bodies. The column name `webhook_secret_hash` is a
  // misnomer kept for DDL stability; it is NOT a hash of anything.
  // TODO(phase-5): move to SignerStore for encryption-at-rest.
  webhookSecretHash: z.string().length(64).regex(/^[0-9a-f]+$/).nullable(),
  // SQLite stores booleans as INTEGER (0/1). We expose the row value directly
  // rather than coercing, because every query site reads it as a number and
  // comparing against 1 is clearer than flipping to boolean midway.
  active: z.number().int().min(0).max(1),
  createdAt: z.date(),
  updatedAt: z.date()
});
export type Merchant = z.infer<typeof MerchantSchema> & { id: MerchantId };
