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
// "fee-wallet"     : per-family gas provider. Resolves via the fee_wallets
//                    table: mode='hd-pool' redelegates to a pool-address
//                    lookup; mode='imported' returns the decrypted imported
//                    private key. Returns null-equivalent (throws) when no
//                    fee wallet is registered — callers check
//                    `chainAdapter.feeWalletCapability` and the store's
//                    `has()` before requesting the key.
//
// Individual private keys are derived on demand (HD) or decrypted on demand
// (imported) — nothing is stored at rest in plaintext.
export const SignerScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pool-address"),
    family: ChainFamilySchema,
    derivationIndex: z.number().int().nonnegative()
  }),
  z.object({ kind: z.literal("sweep-master"), family: ChainFamilySchema }),
  z.object({ kind: z.literal("receive-hd") }),
  z.object({ kind: z.literal("fee-wallet"), family: ChainFamilySchema })
]);
export type SignerScope = z.infer<typeof SignerScopeSchema>;
