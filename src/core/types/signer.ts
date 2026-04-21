import { z } from "zod";
import { ChainFamilySchema } from "./chain.js";

// Scope keys for the SignerStore.
//
// "pool-address"   : gateway-controlled HD-derived address at a specific
//                    derivation index. Used as the payout source (both for
//                    invoice pool addresses and for gas top-up sponsors —
//                    the picker is blind to the distinction).
// "sweep-master"   : master key used to derive sweep destination addresses.
// "receive-hd"     : HD seed used to derive per-order receive addresses.
//
// Individual private keys are derived on demand from MASTER_SEED at the
// supplied `derivationIndex`; nothing is stored at rest.
export const SignerScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pool-address"),
    family: ChainFamilySchema,
    derivationIndex: z.number().int().nonnegative()
  }),
  z.object({ kind: z.literal("sweep-master"), family: ChainFamilySchema }),
  z.object({ kind: z.literal("receive-hd") })
]);
export type SignerScope = z.infer<typeof SignerScopeSchema>;
