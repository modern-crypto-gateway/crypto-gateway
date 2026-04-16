import { z } from "zod";
import type { Brand } from "./branded.js";

export const MerchantIdSchema = z.string().uuid();
export type MerchantId = Brand<z.infer<typeof MerchantIdSchema>, "MerchantId">;

export const MerchantSchema = z.object({
  id: MerchantIdSchema,
  name: z.string().min(1).max(128),
  // SHA-256 hex of the plaintext API key. Plaintext is shown once at creation and never stored.
  apiKeyHash: z.string().length(64).regex(/^[0-9a-f]+$/),
  // HMAC secret for signing webhook payloads, stored hashed at rest. null if webhooks disabled.
  webhookUrl: z.string().url().nullable(),
  webhookSecretHash: z.string().length(64).regex(/^[0-9a-f]+$/).nullable(),
  active: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date()
});
export type Merchant = z.infer<typeof MerchantSchema> & { id: MerchantId };
