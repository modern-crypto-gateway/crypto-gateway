import { ed25519 } from "@noble/curves/ed25519.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import { base58 } from "@scure/base";
import type { ChainAdapter } from "../../../core/ports/chain.port.ts";
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
      // Pull-based SPL detection (scanning `getTransaction` + pre/post token
      // balances per signature) is DEFERRED. The Alchemy Notify webhook path
      // carries SPL today — see alchemy-notify.adapter.ts `parseSolanaEvent`.
      // Until the pull path catches up, `scanIncoming` stays native-SOL-only:
      // SPL support here needs jsonParsed token-balance extraction plus an
      // ATA-owner cross-check per signature, which is a separate piece of work.
      const wantsNative = tokens.some((t) => t === nativeSymbol);
      if (!wantsNative) return [];
      void tokens;

      // Per address: list recent signatures, fetch each tx, extract the native
      // transfer amount from balance deltas.
      const cutoffMs = sinceMs;
      const transfers: DetectedTransfer[] = [];
      for (const address of addresses) {
        const signatures = await client.getSignaturesForAddress(address, { limit: scanLimit });
        for (const sig of signatures) {
          if (sig.err !== null) continue;
          if (sig.blockTime !== null && sig.blockTime * 1000 < cutoffMs) continue;
          const tx = await client.getTransaction(sig.signature);
          if (!tx || !tx.meta || tx.meta.err !== null) continue;

          // Find `address` in the account list and compute the balance delta.
          const accountKeys = tx.transaction.message.accountKeys.map((k) =>
            typeof k === "string" ? k : k.pubkey
          );
          const idx = accountKeys.indexOf(address);
          if (idx === -1) continue;
          const pre = tx.meta.preBalances[idx];
          const post = tx.meta.postBalances[idx];
          if (pre === undefined || post === undefined) continue;
          const delta = post - pre;
          // Credit-only: ignore outflows, ignore self-pay with delta=0.
          if (delta <= 0) continue;

          // Identify sender by whichever account saw the opposite delta.
          // Fallback to index 0 (conventional payer) when multiple accounts
          // moved — this is a heuristic, not a proof.
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
            confirmations: sig.confirmationStatus === "finalized" ? 32 : sig.confirmationStatus === "confirmed" ? 1 : 0,
            seenAt: new Date()
          });
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
          recentBlockhash: blockhash
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
        recentBlockhash: blockhash
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
