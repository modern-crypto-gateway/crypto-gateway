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
  // Optional: true when the adapter served conservative hardcoded rates
  // because its upstream fee oracle was unreachable. Tier numbers are
  // still safe to plan/broadcast against — operators can RBF-bump later
  // if real mempool conditions push the market above the fallback. Used
  // by the payout estimate to surface a `fee_quote_degraded` warning so
  // the merchant/dashboard can flag "rates aren't market-fresh".
  readonly degraded?: boolean;
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

  // Derive the on-chain address for a raw private key. Used by any code
  // path that imports an externally-generated key (fee-wallet /import,
  // future multisig-co-signer registration, etc.) to cross-check the
  // operator-supplied `address` matches the key before persisting the
  // ciphertext — a typo'd address would otherwise surface as a silent
  // signer-mismatch on the first payout attempt.
  //
  // Input format per family: hex string (with or without `0x` prefix) of
  // the raw private key bytes — 32 bytes for EVM secp256k1, Tron
  // secp256k1, and Solana ed25519.
  addressFromPrivateKey(privateKey: string): Address;

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

  // Query the actual native-fee consumed by a previously-broadcast tx.
  // Called on the fail path so the gateway can debit what the chain
  // actually spent even when the tx reverted — EVM charges the full
  // `gasUsed × effectiveGasPrice` on revert, Tron burns energy-fee +
  // net-fee regardless of execution outcome, Solana charges the signature
  // fee on any submitted tx. Without this, the DB-tracked spendable
  // drifts higher than on-chain reality with every failed payout, and
  // the planner keeps picking the same underfunded source.
  //
  // Returns the fee in native units (wei / sun / lamports), or `null`
  // when the tx can't be located yet (not-yet-mined, purged from mempool,
  // RPC flap). Callers treat null as "try again later" — debit is
  // deferred, not zeroed.
  getConsumedNativeFee(chainId: ChainId, txHash: TxHash): Promise<AmountRaw | null>;

  // ---- Payouts ----

  buildTransfer(args: BuildTransferArgs): Promise<UnsignedTx>;

  // Returns the broadcast tx hash. Private key is passed per-call so keys stay
  // in memory only for the duration of signing.
  //
  // `options.feePayerPrivateKey` is supplied ONLY when the caller built the
  // UnsignedTx with `BuildTransferArgs.feePayerAddress` — the adapter uses
  // it to produce the fee payer's signature (Solana) or ignores it
  // (EVM / Tron / Dev, whose topologies don't co-sign). Passing a fee-payer
  // key on a chain whose `feeWalletCapability === "none"` is a caller bug;
  // adapters MAY throw to surface it.
  //
  // `options.inputPrivateKeys` is meaningful ONLY on UTXO-family chains
  // (Bitcoin / Litecoin) where each input may be funded from a different
  // address with a different private key. Caller derives one key per input
  // (using the BIP44 index stored on the utxos row) and passes them in the
  // same order as `unsignedTx.raw.inputs`. The single `privateKey` argument
  // is unused for UTXO and the caller MAY pass any non-empty placeholder
  // (the existing positional shape is preserved for API stability).
  // Account-model adapters (EVM / Tron / Solana / Dev) ignore the field.
  signAndBroadcast(
    unsignedTx: UnsignedTx,
    privateKey: string,
    options?: {
      readonly feePayerPrivateKey?: string;
      readonly inputPrivateKeys?: ReadonlyArray<{
        readonly address: Address;
        readonly privateKey: string;
      }>;
    }
  ): Promise<TxHash>;

  // ---- Fees ----

  // "ETH" on EVM, "TRX" on Tron, "SOL" on Solana. Used for fee-wallet balance checks.
  nativeSymbol(chainId: ChainId): TokenSymbol;

  // Native-balance amount the source MUST retain after a payout completes.
  // Solana returns the rent-exempt minimum for a 0-byte SystemProgram account
  // (~890 880 lamports) — drain a Solana source below this and the tx fails
  // simulation with "insufficient funds for rent". EVM and Tron have no such
  // concept; both return 0n. Used by `selectSource` so the picker refuses
  // payouts that would violate the reserve, and by chain adapters' pre-
  // broadcast checks for defense in depth.
  minimumNativeReserve(chainId: ChainId): bigint;

  // Multiplier applied to `quoteFeeTiers` output when the picker decides
  // whether a candidate source has enough native for gas. A 1.5× margin on
  // EVM absorbs ~6 blocks of EIP-1559 baseFee growth (baseFee rises at most
  // 12.5%/block, so 2× baseFee > baseFee × 1.125^6); Tron's energyFee is an
  // SR-voted chain parameter that changes rarely so 1.1× is ample; Solana's
  // signature fee is a fixed 5000 lamports with no drift at all, 1.2× covers
  // tier variance from compute-unit pricing if we later add priority fees.
  // Returning `{num: 0n, den: 1n}` is not valid — den must be positive.
  gasSafetyFactor(chainId: ChainId): { readonly num: bigint; readonly den: bigint };

  // Describes whether (and how) this family can use an external fee wallet
  // to cover the gas for a payout, offloading native-balance requirements
  // from the source pool address:
  //   - "none":    no native fee-wallet concept on this chain today. The
  //                planner uses the self-pay / sponsor-topup flow as
  //                before. EVM lives here pending account abstraction.
  //   - "top-up":  the fee wallet holds native (e.g. TRX) and is offered
  //                to the planner as an additional sponsor candidate
  //                alongside pool addresses. The payout flow is otherwise
  //                unchanged: the fee wallet sends a top-up tx to the
  //                source, which then broadcasts the actual payout. Used
  //                for Tron when the operator has not staked into energy
  //                (or the source has no delegated resources). Cheaper
  //                than running the picker against ad-hoc pool sponsors
  //                and lets one funded wallet sponsor every Tron payout.
  //   - "delegate": the fee wallet provides resources out-of-band (Tron's
  //                DelegateResource). The payout tx is unchanged at sign
  //                time; the chain substitutes delegated resources for
  //                native burn. Planner can lower its native requirement
  //                for eligible sources when `canFeeWalletCover*` returns
  //                true for the candidate + resource amount.
  //   - "co-sign":  the fee wallet signs every payout as the tx's feePayer
  //                (Solana). The planner skips native-balance checks on
  //                the source entirely when a fee wallet is configured and
  //                funded; `withFeePayer` rewrites the unsigned tx to
  //                declare the fee wallet as the fee payer before sign.
  feeWalletCapability(chainId: ChainId): "none" | "top-up" | "delegate" | "co-sign";

  // (Fee-payer application is now expressed via `BuildTransferArgs.feePayerAddress`
  // set at build time + `options.feePayerPrivateKey` passed at broadcast. No
  // separate `withFeePayer` port method is needed — the adapter emits the
  // correct message layout directly when `feePayerAddress` is present.)

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
