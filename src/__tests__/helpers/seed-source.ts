import type { BootedTestApp } from "./boot.js";
import { addressPool, transactions } from "../../db/schema.js";
import type { ChainFamily } from "../../core/types/chain.js";

// Seed an HD-derivable pool address with confirmed inbound balances so the
// payout source picker (`computeSpendable` ledger-based) considers it a
// funded candidate. Replacement for the old `seedFeeWallet` helper.
//
// Inserts:
//   - one `address_pool` row at the supplied derivationIndex (so the signer
//     can derive the matching private key at exec time);
//   - one `transactions` row per (chainId, token) bucket recording a
//     confirmed inbound credit at `tokenBalanceRaw`. The native rail is
//     identified by `nativeSymbol` (the chain adapter's nativeSymbol() value).
//
// The picker reads `addressPool` to enumerate candidates and `transactions`
// to compute spendable. Reservation rows are written by the picker itself —
// nothing to seed there.
export async function seedFundedPoolAddress(
  booted: BootedTestApp,
  args: {
    chainId: number;
    family: ChainFamily;
    address: string;
    derivationIndex: number;
    // Token symbol → confirmed balance (smallest unit). Use the chain
    // adapter's native symbol for the native rail.
    balances: Record<string, string>;
  }
): Promise<{ address: string }> {
  const now = booted.deps.clock.now().getTime();
  await booted.deps.db
    .insert(addressPool)
    .values({
      id: globalThis.crypto.randomUUID(),
      family: args.family,
      addressIndex: args.derivationIndex,
      address: args.address,
      status: "available",
      allocatedToInvoiceId: null,
      allocatedAt: null,
      totalAllocations: 0,
      lastReleasedAt: null,
      cooldownUntil: null,
      lastReleasedByMerchantId: null,
      createdAt: now
    })
    .onConflictDoNothing();

  for (const [token, amountRaw] of Object.entries(args.balances)) {
    if (amountRaw === "0") continue;
    await booted.deps.db.insert(transactions).values({
      id: globalThis.crypto.randomUUID(),
      invoiceId: null,
      chainId: args.chainId,
      txHash: `0x${globalThis.crypto.randomUUID().replace(/-/g, "")}`,
      logIndex: token === "NATIVE" ? null : 0,
      fromAddress: "0x0000000000000000000000000000000000000000",
      toAddress: args.address,
      token,
      amountRaw,
      blockNumber: 1,
      confirmations: 30,
      status: "confirmed",
      detectedAt: now,
      confirmedAt: now,
      amountUsd: null,
      usdRate: null,
      dismissedAt: null,
      dismissReason: null
    });
  }
  return { address: args.address };
}
