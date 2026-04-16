import type { Address, ChainFamily, ChainId, TxHash } from "../types/chain.js";
import type { AmountRaw } from "../types/money.js";
import type { TokenSymbol } from "../types/token.js";
import type { DetectedTransfer } from "../types/transaction.js";
import type { BuildTransferArgs, EstimateArgs, UnsignedTx } from "../types/unsigned-tx.js";

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
}
