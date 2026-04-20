import type { Address, ChainFamily, ChainId, TxHash } from "../types/chain.js";
import type { AmountRaw } from "../types/money.js";
import type { TokenSymbol } from "../types/token.js";
import type { DetectedTransfer } from "../types/transaction.js";
import type { BuildTransferArgs, EstimateArgs, UnsignedTx } from "../types/unsigned-tx.js";

export type FeeTier = "low" | "medium" | "high";

// One tier's worth of the fee quote. `nativeAmountRaw` is the total fee in
// the chain's native units (wei / sun / lamports). Callers convert to USD
// via the price oracle and display alongside the payout amount.
export interface FeeQuote {
  readonly tier: FeeTier;
  readonly nativeAmountRaw: AmountRaw;
}

export interface FeeTierQuote {
  readonly low: FeeQuote;
  readonly medium: FeeQuote;
  readonly high: FeeQuote;
  // False when the chain has no real tier concept (Tron today); the three
  // tiers carry identical values. The frontend renders a single option when
  // this is false.
  readonly tieringSupported: boolean;
  // Chain's native gas symbol (same as `nativeSymbol(chainId)` for the same
  // chainId) — returned alongside so the frontend doesn't need a second call
  // just to label the tier amounts.
  readonly nativeSymbol: TokenSymbol;
}

// The one contract every chain family implements. Adding a new family
// (Solana, Aptos, Bitcoin, ...) is one file that implements this interface;
// core/domain never switches on `family` for control flow.
export interface ChainAdapter {
  readonly family: ChainFamily;
  readonly supportedChainIds: readonly ChainId[];

  // ---- Addresses ----

  // Deterministically derive a (address, privateKey) pair from the HD seed at
  // the given index. Same seed + index MUST yield the same pair every time.
  deriveAddress(seed: string, index: number): { address: Address; privateKey: string };

  validateAddress(address: string): boolean;
  // Return the family's canonical textual form (e.g. EIP-55 checksummed for EVM).
  // Used as the DB storage key so lookups are case-consistent.
  canonicalizeAddress(address: string): Address;

  // ---- Detection ----

  // Pull path. Returns transfers to any of `addresses` in `tokens` since `sinceMs`.
  // Push-based adapters (Alchemy Notify, Helius) may still implement this for
  // gap-filling after webhook outages.
  scanIncoming(args: {
    chainId: ChainId;
    addresses: readonly Address[];
    tokens: readonly TokenSymbol[];
    sinceMs: number;
  }): Promise<readonly DetectedTransfer[]>;

  getConfirmationStatus(
    chainId: ChainId,
    txHash: TxHash
  ): Promise<{
    blockNumber: number | null;
    confirmations: number;
    reverted: boolean;
  }>;

  // ---- Payouts ----

  buildTransfer(args: BuildTransferArgs): Promise<UnsignedTx>;

  // Returns the broadcast tx hash. Private key is passed per-call so keys stay
  // in memory only for the duration of signing.
  signAndBroadcast(unsignedTx: UnsignedTx, privateKey: string): Promise<TxHash>;

  // ---- Fees ----

  // "ETH" on EVM, "TRX" on Tron, "SOL" on Solana. Used for fee-wallet balance checks.
  nativeSymbol(chainId: ChainId): TokenSymbol;

  // Raw native units (wei / sun / lamports). Used by source-selection to verify
  // the chosen fee wallet has enough native gas before reserving it.
  estimateGasForTransfer(args: EstimateArgs): Promise<AmountRaw>;

  // Quote the fee for a hypothetical transfer at three priority tiers. Used
  // by `POST /api/v1/payouts/estimate` before planning a real payout.
  //
  // Tier semantics vary by family:
  //   - EVM: priority-fee multipliers off of viem's `estimateFeesPerGas()` —
  //     low 0.8×, medium 1.0×, high 1.5×. `tieringSupported=true`.
  //   - Tron: energy + bandwidth simulation converted to SUN. No priority
  //     concept; all three tiers return the same amount. `tieringSupported=false`.
  //   - Solana: `getRecentPrioritizationFees` percentiles on the writable
  //     account set. `tieringSupported=true` when the RPC responds; `false`
  //     on fallback.
  //
  // The returned amount is the full native-token cost at each tier. The
  // caller adds this to the payout amount (when paying out the native token)
  // for the total native outflow.
  quoteFeeTiers(args: EstimateArgs): Promise<FeeTierQuote>;

  // Returns the on-chain balance of `token` held by `address` on `chainId`,
  // in raw units (wei / sun / lamports / token-atomic). Used by the payout
  // executor for a pre-flight check before broadcasting — spares us burning
  // gas on transfers that will revert for insufficient balance.
  //
  // Implementations SHOULD NOT throw on a missing account: return "0" so the
  // caller can decide whether that's a hard failure. They MAY throw on
  // network errors; the caller treats that as "can't verify, broadcast anyway
  // and let the chain decide" to avoid trading correctness for liveness.
  getBalance(args: {
    chainId: ChainId;
    address: Address;
    token: TokenSymbol;
  }): Promise<AmountRaw>;

  // Returns balances for ALL known tokens (native + every registered token on
  // the chain) held by `address`, in a single best-effort call. Used by the
  // admin balance-snapshot surface to walk pool + invoice + fee-wallet
  // addresses without paying one RPC per (address × token).
  //
  // Implementations are expected to coalesce the work into the cheapest
  // provider call available (alchemy_getTokenBalances, TronGrid /v1/accounts,
  // Solana getTokenAccountsByOwner) and fall back to per-token loops only when
  // the bulk endpoint is unavailable for the configured backend.
  //
  // Tokens not held by the address SHOULD be omitted (or returned with "0").
  // A network error MAY throw — callers treat that as "couldn't snapshot
  // this address" and continue with the rest.
  getAccountBalances(args: {
    chainId: ChainId;
    address: Address;
  }): Promise<readonly { token: TokenSymbol; amountRaw: AmountRaw }[]>;
}
