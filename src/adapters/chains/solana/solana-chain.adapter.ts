import { ed25519 } from "@noble/curves/ed25519.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import { base58 } from "@scure/base";
import type { ChainAdapter, FeeTierQuote } from "../../../core/ports/chain.port.ts";
import type { Address, ChainId, TxHash } from "../../../core/types/chain.js";
import type { AmountRaw } from "../../../core/types/money.js";
import type { TokenSymbol } from "../../../core/types/token.js";
import { findToken, TOKEN_REGISTRY } from "../../../core/types/token-registry.js";
import type { DetectedTransfer } from "../../../core/types/transaction.js";
import type { BuildTransferArgs, EstimateArgs, UnsignedTx } from "../../../core/types/unsigned-tx.js";
import { bytesToHex } from "../../crypto/subtle.js";
import { derivePath } from "./slip10.js";
import {
  addressToPublicKeyBytes,
  isValidSolanaAddress,
  publicKeyBytesToAddress,
  publicKeyFromPrivateKey
} from "./solana-address.js";
import {
  buildNativeTransferMessage,
  encodeSignedTransaction
} from "./solana-message.js";
import {
  buildSplTransferMessage,
  deriveAssociatedTokenAccount
} from "./solana-spl.js";
import {
  solanaRpcClient,
  type SolanaRpcClient,
  type SolanaRpcConfig
} from "./solana-rpc-client.js";

// Synthetic chainIds for Solana (Solana doesn't have an EVM-style chain id).
// 900 = mainnet-beta, 901 = devnet — arbitrary but stable.
export const SOLANA_MAINNET_CHAIN_ID = 900;
export const SOLANA_DEVNET_CHAIN_ID = 901;

// Solana native fee: 5000 lamports per signature. For a single-signer transfer
// that's the whole fee. We don't query getFeeForMessage for such a hot-path op.
const SIGNATURE_FEE_LAMPORTS = 5_000n;

// Fixed CU allocation we bind on every payout when priority fees are in use.
// Generous upper bound: native transfer uses ~200 CU, SPL CreateIdempotent +
// TransferChecked combined uses ~20k CU. 200k leaves comfortable headroom
// for future SPL variants without making the operator overpay — the chain
// charges for CU * price, not for the allocation ceiling.
const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;

// Fallback per-CU priority fee samples when `getRecentPrioritizationFees`
// returns an empty array (validator doesn't support the method, or no recent
// slots touched the writable accounts). These values are conservative low /
// medium / high for late-2024 mainnet conditions: a quiet network needs zero,
// a busy one needs 50k+ microLamports/CU to land in 1-2 slots.
const FALLBACK_PRIORITY_MICROLAMPORTS = {
  low: 10_000n,
  medium: 50_000n,
  high: 200_000n
} as const;

// Phantom-compatible derivation path: m/44'/501'/{account}'/0'.
const DEFAULT_ACCOUNT_INDEX = 0;

// TTL for the per-chain getSlot() cache used inside getConfirmationStatus.
// One cron tick fans out one signature-status + slot query per active
// confirming tx; the slot is identical across all txs in the same tick, so
// coalesce. Solana slots are ~400ms, so 10s is at most 25 slots stale —
// well within the finalized vs current-slot bookkeeping we actually need.
const SLOT_CACHE_TTL_MS = 10_000;

export interface SolanaChainConfig {
  chainIds?: readonly number[];
  // Per-chain RPC configuration. Required unless `clients` is provided (tests).
  rpc?: Readonly<Record<number, SolanaRpcConfig>>;
  // Pre-built clients (for tests).
  clients?: Readonly<Record<number, SolanaRpcClient>>;
  // Bound on how far back scanIncoming looks; Solana RPCs vary in what they keep.
  scanSignatureLimit?: number;
}

export function solanaChainAdapter(config: SolanaChainConfig = {}): ChainAdapter {
  const chainIds = (config.chainIds ?? [SOLANA_MAINNET_CHAIN_ID]) as readonly ChainId[];
  const scanLimit = config.scanSignatureLimit ?? 100;

  const clientCache = new Map<number, SolanaRpcClient>();
  function getClient(chainId: number): SolanaRpcClient {
    const cached = clientCache.get(chainId);
    if (cached) return cached;
    const injected = config.clients?.[chainId];
    if (injected) {
      clientCache.set(chainId, injected);
      return injected;
    }
    const rpcCfg = config.rpc?.[chainId];
    if (!rpcCfg) {
      throw new Error(`solanaChainAdapter: no RPC config for chainId ${chainId}`);
    }
    const client = solanaRpcClient(rpcCfg);
    clientCache.set(chainId, client);
    return client;
  }

  const slotCache = new Map<number, { value: number; fetchedAt: number }>();
  async function getCachedSlot(chainId: number, client: SolanaRpcClient): Promise<number> {
    const now = Date.now();
    const entry = slotCache.get(chainId);
    if (entry && now - entry.fetchedAt < SLOT_CACHE_TTL_MS) return entry.value;
    const slot = await client.getSlot().catch(() => 0);
    slotCache.set(chainId, { value: slot, fetchedAt: now });
    return slot;
  }

  return {
    family: "solana",
    supportedChainIds: chainIds,

    // ---- Addresses ----

    deriveAddress(seed: string, index: number) {
      // SLIP-0010 ed25519 path: m/44'/501'/{index}'/0' (Phantom convention).
      // We bind the addressIndex to the account segment so each invoice gets
      // a distinct keypair — matches what Phantom / Solflare users are used
      // to.
      const seedBytes = mnemonicToSeedSync(seed);
      const node = derivePath(seedBytes, `m/44'/501'/${DEFAULT_ACCOUNT_INDEX}'/${index}'`);
      const publicKey = publicKeyFromPrivateKey(node.privateKey);
      const address = publicKeyBytesToAddress(publicKey) as Address;
      // We store the 32-byte seed as hex, NOT the 64-byte "expanded" form —
      // the expanded form can be reconstructed at signing time from the pubkey.
      const privateKey = `0x${bytesToHex(node.privateKey)}`;
      return { address, privateKey };
    },

    validateAddress(address: string): boolean {
      return isValidSolanaAddress(address);
    },

    canonicalizeAddress(address: string): Address {
      if (!isValidSolanaAddress(address)) {
        throw new Error(`Invalid Solana address: ${address}`);
      }
      // base58 of a 32-byte pubkey is already canonical — no case folding.
      return address as Address;
    },

    // ---- Detection ----

    async scanIncoming({ chainId, addresses, tokens, sinceMs }) {
      if (addresses.length === 0) return [];
      const client = getClient(chainId);

      const nativeSymbol = "SOL" as TokenSymbol;

      // Build a mint -> symbol lookup for every registered SPL token on this
      // chain, filtered to the symbols the caller asked for. Token balances
      // in the jsonParsed tx response carry `mint`; we need the symbol to
      // label the DetectedTransfer consistently with the registry.
      const wantedSymbols = new Set<TokenSymbol>(tokens);
      const symbolByMint = new Map<string, TokenSymbol>();
      for (const t of TOKEN_REGISTRY) {
        if (t.chainId !== chainId) continue;
        if (t.contractAddress === null) continue;
        if (!wantedSymbols.has(t.symbol)) continue;
        symbolByMint.set(t.contractAddress, t.symbol);
      }
      const wantsNative = wantedSymbols.has(nativeSymbol);
      const wantsAnySpl = symbolByMint.size > 0;
      if (!wantsNative && !wantsAnySpl) return [];

      // Per address: list recent signatures, fetch each tx, extract native +
      // SPL transfer amounts from pre/post balance deltas.
      const cutoffMs = sinceMs;
      const transfers: DetectedTransfer[] = [];
      const confirmationsFor = (sig: { confirmationStatus?: string }): number =>
        sig.confirmationStatus === "finalized" ? 32 : sig.confirmationStatus === "confirmed" ? 1 : 0;

      for (const address of addresses) {
        const signatures = await client.getSignaturesForAddress(address, { limit: scanLimit });
        for (const sig of signatures) {
          if (sig.err !== null) continue;
          if (sig.blockTime !== null && sig.blockTime * 1000 < cutoffMs) continue;
          const tx = await client.getTransaction(sig.signature);
          if (!tx || !tx.meta || tx.meta.err !== null) continue;

          const accountKeys = tx.transaction.message.accountKeys.map((k) =>
            typeof k === "string" ? k : k.pubkey
          );

          // ---- Native SOL credit to `address` ----
          if (wantsNative) {
            const idx = accountKeys.indexOf(address);
            if (idx !== -1) {
              const pre = tx.meta.preBalances[idx];
              const post = tx.meta.postBalances[idx];
              if (pre !== undefined && post !== undefined) {
                const delta = post - pre;
                if (delta > 0) {
                  // Identify sender by whichever account saw the opposite delta.
                  // Fallback to index 0 (conventional payer) when multiple
                  // accounts moved — heuristic, not a proof.
                  let fromAddress = accountKeys[0] ?? "unknown";
                  for (let i = 0; i < accountKeys.length; i += 1) {
                    if (i === idx) continue;
                    const dPre = tx.meta.preBalances[i];
                    const dPost = tx.meta.postBalances[i];
                    if (dPre === undefined || dPost === undefined) continue;
                    if (dPost - dPre === -delta - tx.meta.fee || dPost - dPre === -delta) {
                      fromAddress = accountKeys[i] ?? fromAddress;
                      break;
                    }
                  }
                  transfers.push({
                    chainId: chainId as ChainId,
                    txHash: sig.signature,
                    logIndex: null,
                    fromAddress,
                    toAddress: address,
                    token: nativeSymbol,
                    amountRaw: delta.toString() as AmountRaw,
                    blockNumber: sig.slot,
                    confirmations: confirmationsFor(sig),
                    seenAt: new Date()
                  });
                }
              }
            }
          }

          // ---- SPL credits to `address` (owner) ----
          // Audit path: the user watches the owner address (wallet), not the
          // ATA. Token balances under jsonParsed encoding include `owner`, so
          // we match (owner === address, mint ∈ wantedSymbols) and diff the
          // amount across pre/post to derive the credit.
          if (wantsAnySpl) {
            const preTokens = tx.meta.preTokenBalances ?? [];
            const postTokens = tx.meta.postTokenBalances ?? [];
            if (preTokens.length > 0 || postTokens.length > 0) {
              const preAmounts = new Map<string, bigint>();
              const postAmounts = new Map<string, bigint>();
              for (const b of preTokens) {
                if (!b.owner || b.owner !== address) continue;
                if (!symbolByMint.has(b.mint)) continue;
                try {
                  preAmounts.set(b.mint, BigInt(b.uiTokenAmount.amount));
                } catch { /* unparseable amount — treat as absent */ }
              }
              for (const b of postTokens) {
                if (!b.owner || b.owner !== address) continue;
                if (!symbolByMint.has(b.mint)) continue;
                try {
                  postAmounts.set(b.mint, BigInt(b.uiTokenAmount.amount));
                } catch { /* unparseable amount — treat as absent */ }
              }
              const mints = new Set<string>([...preAmounts.keys(), ...postAmounts.keys()]);
              for (const mint of mints) {
                const pre = preAmounts.get(mint) ?? 0n;
                const post = postAmounts.get(mint) ?? 0n;
                const delta = post - pre;
                if (delta <= 0n) continue;
                // Sender-side: any (other-owner, same-mint) whose amount
                // dropped by -delta. Best-effort; falls back to accountKeys[0].
                let fromAddress = accountKeys[0] ?? "unknown";
                for (const b of postTokens) {
                  if (!b.owner || b.owner === address || b.mint !== mint) continue;
                  let postOther: bigint;
                  try { postOther = BigInt(b.uiTokenAmount.amount); } catch { continue; }
                  // Match to pre entry for the same owner+mint.
                  let preOther = 0n;
                  for (const p of preTokens) {
                    if (p.owner === b.owner && p.mint === mint) {
                      try { preOther = BigInt(p.uiTokenAmount.amount); } catch { /* ignore */ }
                      break;
                    }
                  }
                  if (postOther - preOther === -delta) {
                    fromAddress = b.owner;
                    break;
                  }
                }
                transfers.push({
                  chainId: chainId as ChainId,
                  txHash: sig.signature,
                  logIndex: null,
                  fromAddress,
                  toAddress: address,
                  token: symbolByMint.get(mint)!,
                  amountRaw: delta.toString() as AmountRaw,
                  blockNumber: sig.slot,
                  confirmations: confirmationsFor(sig),
                  seenAt: new Date()
                });
              }
            }
          }
        }
      }
      return transfers;
    },

    async getConfirmationStatus(chainId: ChainId, txHash: TxHash) {
      const client = getClient(chainId);
      const [statuses, currentSlot] = await Promise.all([
        client.getSignatureStatuses([txHash]),
        getCachedSlot(chainId, client)
      ]);
      const status = statuses[0];
      if (!status) {
        return { blockNumber: null, confirmations: 0, reverted: false };
      }
      // `confirmations` is null on "finalized" — use slot distance as a
      // conservative lower bound. Solana finalizes at ~32 slots; reporting
      // 32 past that is correct for our threshold-based sweeper.
      let confirmations = status.confirmations ?? 0;
      if (status.confirmationStatus === "finalized") {
        confirmations = Math.max(32, currentSlot - status.slot);
      }
      return {
        blockNumber: status.slot,
        confirmations,
        reverted: status.err !== null
      };
    },

    // ---- Payouts ----

    async buildTransfer(args: BuildTransferArgs): Promise<UnsignedTx> {
      const token = findToken(args.chainId as ChainId, args.token);
      if (!token) {
        throw new Error(`Solana buildTransfer: unknown token ${args.token} on chain ${args.chainId}`);
      }

      const client = getClient(args.chainId);
      const { blockhash } = await client.getLatestBlockhash();

      // Translate the caller's fee tier into a ComputeBudget config. We only
      // bind ComputeBudget when a tier is requested — without it, the tx
      // uses Solana's default (200k CU limit, no priority fee) and pays
      // only the base 5k-lamport signature fee. Safe on quiet networks,
      // insufficient under congestion.
      const computeBudget =
        args.feeTier === undefined
          ? undefined
          : {
              computeUnitLimit: DEFAULT_COMPUTE_UNIT_LIMIT,
              computeUnitPriceMicroLamports: await resolveSolanaPriorityMicroLamports(
                client,
                args.feeTier,
                token.contractAddress !== null
                  ? [args.fromAddress, args.toAddress] // SPL: writable are sender+recipient owners
                  : [args.fromAddress, args.toAddress]
              )
            };

      if (token.contractAddress !== null) {
        // SPL path. Derive both ATAs client-side and build a single tx that
        // idempotently creates the destination ATA (no-op if it already
        // exists) then does a TransferChecked from sender → recipient. We
        // don't getAccountInfo the destination because CreateIdempotent is
        // the whole point of that instruction — one fewer RPC round trip.
        const senderAta = deriveAssociatedTokenAccount(args.fromAddress, token.contractAddress);
        const recipientAta = deriveAssociatedTokenAccount(args.toAddress, token.contractAddress);
        const message = buildSplTransferMessage({
          senderOwner: args.fromAddress,
          senderAssociatedTokenAccount: senderAta,
          recipientOwner: args.toAddress,
          recipientAssociatedTokenAccount: recipientAta,
          mintAddress: token.contractAddress,
          amount: BigInt(args.amountRaw),
          decimals: token.decimals,
          recentBlockhash: blockhash,
          ...(computeBudget !== undefined ? { computeBudget } : {})
        });
        return {
          chainId: args.chainId as ChainId,
          raw: { message, recentBlockhash: blockhash, fromAddress: args.fromAddress },
          summary: `SOL: SPL ${args.token} transfer ${args.amountRaw} from ${args.fromAddress} to ${args.toAddress} (ATA=${recipientAta})`
        };
      }

      const message = buildNativeTransferMessage({
        sourceAddress: args.fromAddress,
        destinationAddress: args.toAddress,
        lamports: BigInt(args.amountRaw),
        recentBlockhash: blockhash,
        ...(computeBudget !== undefined ? { computeBudget } : {})
      });

      return {
        chainId: args.chainId as ChainId,
        raw: { message, recentBlockhash: blockhash, fromAddress: args.fromAddress },
        summary: `SOL: native transfer ${args.amountRaw} lamports from ${args.fromAddress} to ${args.toAddress}`
      };
    },

    async signAndBroadcast(unsignedTx: UnsignedTx, privateKeyHex: string): Promise<TxHash> {
      const raw = unsignedTx.raw as { message: Uint8Array; fromAddress: string };
      const privateKey = hexToBytes(privateKeyHex);
      if (privateKey.length !== 32) {
        throw new Error(`Solana signing key must be 32 bytes, got ${privateKey.length}`);
      }
      // Cross-check: the declared `fromAddress` must match the public key
      // derived from this private key. Prevents signing with the wrong wallet
      // (which would broadcast a tx whose signer isn't listed in accountKeys).
      const publicKey = publicKeyFromPrivateKey(privateKey);
      const expectedPubkeyBytes = addressToPublicKeyBytes(raw.fromAddress);
      if (!bytesEqual(publicKey, expectedPubkeyBytes)) {
        throw new Error("Solana signAndBroadcast: fromAddress does not match the derived public key");
      }

      const signature = ed25519.sign(raw.message, privateKey);
      const encoded = encodeSignedTransaction(raw.message, [signature]);
      const client = getClient(unsignedTx.chainId);
      const txHash = await client.sendTransaction(encoded);
      return txHash as TxHash;
    },

    // ---- Fees ----

    nativeSymbol(_chainId: ChainId): TokenSymbol {
      return "SOL" as TokenSymbol;
    },

    async estimateGasForTransfer(_args: EstimateArgs): Promise<AmountRaw> {
      // Solana fees are per-signature. A native transfer has one signer, so
      // the fee is a fixed 5000 lamports. For SPL transfers the signer count
      // is still 1 (the fee payer) so the base fee is the same.
      return SIGNATURE_FEE_LAMPORTS.toString() as AmountRaw;
    },

    async quoteFeeTiers(args: EstimateArgs): Promise<FeeTierQuote> {
      // Real fee tiers for Solana.
      //
      //   total = base_signature_fee + (compute_unit_limit * microLamportsPerCu / 1e6)
      //
      // Priority per-CU prices come from `getRecentPrioritizationFees` —
      // bucketed to 25th/50th/75th percentile for low/medium/high. Empty
      // samples fall back to hard-coded defaults (see constants above).
      // CU limit is fixed at DEFAULT_COMPUTE_UNIT_LIMIT — plenty of headroom
      // for any transfer we actually build today, and operators only pay for
      // units consumed, not units allocated.
      const client = getClient(args.chainId);
      const tierPrices = await solanaTierPrices(client, [
        args.fromAddress,
        args.toAddress
      ]);
      const cuLimit = BigInt(DEFAULT_COMPUTE_UNIT_LIMIT);
      const totalFor = (microLamports: bigint): AmountRaw => {
        const priorityLamports = (cuLimit * microLamports) / 1_000_000n;
        return (SIGNATURE_FEE_LAMPORTS + priorityLamports).toString() as AmountRaw;
      };
      return {
        low: { tier: "low", nativeAmountRaw: totalFor(tierPrices.low) },
        medium: { tier: "medium", nativeAmountRaw: totalFor(tierPrices.medium) },
        high: { tier: "high", nativeAmountRaw: totalFor(tierPrices.high) },
        tieringSupported: true,
        nativeSymbol: "SOL" as TokenSymbol
      };
    },

    async getBalance(args): Promise<AmountRaw> {
      const client = getClient(args.chainId);
      const token = findToken(args.chainId as ChainId, args.token);
      if (!token) {
        throw new Error(`Solana getBalance: unknown token ${args.token} on chain ${args.chainId}`);
      }
      if (token.contractAddress === null) {
        const lamports = await client.getBalance(args.address);
        return lamports.toString() as AmountRaw;
      }
      // SPL: walk every token account the owner holds and sum balances for
      // the requested mint. Owners can hold multiple ATAs for the same mint
      // (e.g. Token-2022 vs SPL-Token); this collapses them.
      const accounts = await client.getTokenAccountsByOwner(args.address);
      let total = 0n;
      for (const acct of accounts) {
        if (acct.mint !== token.contractAddress) continue;
        try {
          total += BigInt(acct.amount);
        } catch {
          // Skip malformed entries; treat as 0.
        }
      }
      return total.toString() as AmountRaw;
    },

    async getAccountBalances(args): Promise<readonly { token: TokenSymbol; amountRaw: AmountRaw }[]> {
      const client = getClient(args.chainId);
      const chainId = args.chainId as ChainId;
      const tokensOnChain = TOKEN_REGISTRY.filter((t) => t.chainId === chainId);
      const splTokens = tokensOnChain.filter((t) => t.contractAddress !== null);
      const nativeSym = "SOL" as TokenSymbol;

      // One getBalance + one getTokenAccountsByOwner — total of 2 RPC calls
      // for the whole address regardless of how many SPL mints we know about.
      const [lamports, splAccounts] = await Promise.all([
        client.getBalance(args.address),
        splTokens.length > 0
          ? client.getTokenAccountsByOwner(args.address).catch(() => [])
          : Promise.resolve([])
      ]);

      // Sum balances per mint (an owner can hold multiple ATAs for the same
      // mint; merge before mapping back to the registry symbol).
      const balanceByMint = new Map<string, bigint>();
      for (const acct of splAccounts) {
        try {
          const prev = balanceByMint.get(acct.mint) ?? 0n;
          balanceByMint.set(acct.mint, prev + BigInt(acct.amount));
        } catch {
          // Skip malformed entries.
        }
      }

      const out: { token: TokenSymbol; amountRaw: AmountRaw }[] = [
        { token: nativeSym, amountRaw: lamports.toString() as AmountRaw }
      ];
      for (const t of splTokens) {
        const balance = balanceByMint.get(t.contractAddress as string) ?? 0n;
        out.push({ token: t.symbol, amountRaw: balance.toString() as AmountRaw });
      }
      return out;
    }
  };
}

// ---- Local byte helpers ----

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error(`hex string must have even length: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Silence "unused import" for the base58 re-export.
void base58;

// ---- Priority-fee helpers ----

// Fetch recent priority-fee samples and bucket them into low/medium/high
// (25th/50th/75th percentiles). On an empty sample set (validator without
// the extension, or no recent slots touching these accounts), fall back to
// the conservative baseline defined above.
async function solanaTierPrices(
  client: SolanaRpcClient,
  writableAccounts: readonly string[]
): Promise<{ low: bigint; medium: bigint; high: bigint }> {
  const samples = await client.getRecentPrioritizationFees(writableAccounts);
  if (samples.length === 0) {
    return {
      low: FALLBACK_PRIORITY_MICROLAMPORTS.low,
      medium: FALLBACK_PRIORITY_MICROLAMPORTS.medium,
      high: FALLBACK_PRIORITY_MICROLAMPORTS.high
    };
  }
  const sorted = [...samples]
    .map((s) => s.prioritizationFee)
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return {
      low: FALLBACK_PRIORITY_MICROLAMPORTS.low,
      medium: FALLBACK_PRIORITY_MICROLAMPORTS.medium,
      high: FALLBACK_PRIORITY_MICROLAMPORTS.high
    };
  }
  const percentile = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx] ?? 0;
  };
  return {
    low: BigInt(percentile(0.25)),
    medium: BigInt(percentile(0.5)),
    high: BigInt(percentile(0.75))
  };
}

// Resolve the microLamports-per-CU price to bind when a specific feeTier was
// requested at build time. Same source as `quoteFeeTiers` so the broadcast
// fee matches the quote the operator saw (within drift of the recent-slot
// window rolling between the two calls).
async function resolveSolanaPriorityMicroLamports(
  client: SolanaRpcClient,
  feeTier: "low" | "medium" | "high",
  writableAccounts: readonly string[]
): Promise<bigint> {
  const tiers = await solanaTierPrices(client, writableAccounts);
  return tiers[feeTier];
}
