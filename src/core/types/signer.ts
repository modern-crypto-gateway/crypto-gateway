import { z } from "zod";
import { ChainFamilySchema } from "./chain.js";

// Scope keys for the SignerStore (encrypted-at-rest private-key store).
//
// "fee-wallet"     : a gateway-owned hot wallet funding payouts on a given family.
// "sweep-master"   : master key used to derive sweep destination addresses.
// "receive-hd"     : HD seed used to derive per-order receive addresses.
//
// Each scope key is deliberately coarse — individual receive-address private
// keys are derived on demand from the HD seed, never stored.
export const SignerScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fee-wallet"), family: ChainFamilySchema, label: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("sweep-master"), family: ChainFamilySchema }),
  z.object({ kind: z.literal("receive-hd") })
]);
export type SignerScope = z.infer<typeof SignerScopeSchema>;
