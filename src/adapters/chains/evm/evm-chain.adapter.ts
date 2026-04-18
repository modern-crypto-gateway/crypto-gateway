import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  type Hex,
  type PublicClient,
  type Transport
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { bytesToHex } from "../../crypto/subtle.js";
import type { ChainAdapter } from "../../../core/ports/chain.port.ts";
import type { Address, ChainId, TxHash } from "../../../core/types/chain.js";
import type { AmountRaw } from "../../../core/types/money.js";
import type { TokenSymbol } from "../../../core/types/token.js";
import { findToken } from "../../../core/types/token-registry.js";
import type { DetectedTransfer } from "../../../core/types/transaction.js";
import type { BuildTransferArgs, EstimateArgs, UnsignedTx } from "../../../core/types/unsigned-tx.js";
import { ERC20_ABI } from "./erc20.js";

// Native token symbols per chainId. Anything not listed defaults to ETH —
// correct for Ethereum mainnet + most L2s (Optimism, Arbitrum, Base).
const NATIVE_SYMBOLS: Readonly<Record<number, string>> = {
  1: "ETH",
  10: "ETH",
  42161: "ETH",
  8453: "ETH",
  11155111: "ETH",
  56: "BNB",
  137: "POL"
};

// Default BIP44 derivation path prefix for EVM. addressIndex is appended.
// m/44'/60'/0'/0/{index}  — Ethereum coin type = 60.
const DEFAULT_ACCOUNT_INDEX = 0;
const DEFAULT_CHANGE_INDEX = 0;

// Bound on the block range for a single eth_getLogs call. Most providers cap
// at 1k–10k blocks; 2k is a safe middle that covers ~7 minutes on mainnet.
const DEFAULT_MAX_SCAN_BLOCKS = 2_000;
// Approximate mainnet block time. Used to translate `sinceMs` into a block window.
const APPROX_BLOCK_TIME_MS: Readonly<Record<number, number>> = {
  1: 12_000,
  10: 2_000,
  42161: 250,
  8453: 2_000,
  11155111: 12_000,
  56: 3_000,
  137: 2_000
};

export interface EvmChainConfig {
  // Which chainIds this adapter serves.
  chainIds: readonly number[];
  // Per-chain RPC URL. Required unless a custom `transports` entry is supplied.
  // Also use this for a private Alchemy / QuickNode endpoint.
  rpcUrls?: Readonly<Record<number, string>>;
  // Per-chain viem Transport override. Primarily for testing: inject a mock
  // transport that responds to JSON-RPC method calls with fixtures.
  transports?: Readonly<Record<number, Transport>>;
  // BIP44 accountIndex (default 0). Use separate accounts for separate envs
  // (prod vs staging) off the same mnemonic.
  accountIndex?: number;
  // Cap on the block window `scanIncoming` will sweep in a single call.
  maxScanBlocks?: number;
}

// TTL for the per-chain latest-block-number cache used inside
// getConfirmationStatus. A single cron tick fans out one receipt+block-height
// query per active confirming tx; the block height is identical for every tx
// on the same chain in that tick, so we only need to fetch it once. ~10s
// covers tick coalescing without going stale (mainnet block ~12s).
const BLOCK_HEIGHT_CACHE_TTL_MS = 10_000;

export function evmChainAdapter(config: EvmChainConfig): ChainAdapter {
  const accountIndex = config.accountIndex ?? DEFAULT_ACCOUNT_INDEX;
  const maxScanBlocks = config.maxScanBlocks ?? DEFAULT_MAX_SCAN_BLOCKS;

  // Clients are built lazily per chainId and cached. viem's PublicClient is
  // internally memoized, so constructing once per chainId is cheap.
  const clientCache = new Map<number, PublicClient>();
  function getClient(chainId: number): PublicClient {
    const cached = clientCache.get(chainId);
    if (cached) return cached;
    const transport = config.transports?.[chainId] ?? buildHttpTransport(config.rpcUrls, chainId);
    // viem requires a chain object for some helpers; a minimal stub is enough
    // when we already know the chain id via our own registry.
    const client = createPublicClient({ transport }) as PublicClient;
    clientCache.set(chainId, client);
    return client;
  }

  const blockHeightCache = new Map<number, { value: bigint; fetchedAt: number }>();
  async function getCachedBlockNumber(chainId: number, client: PublicClient): Promise<bigint> {
    const now = Date.now();
    const entry = blockHeightCache.get(chainId);
    if (entry && now - entry.fetchedAt < BLOCK_HEIGHT_CACHE_TTL_MS) return entry.value;
    const latest = await client.getBlockNumber();
    blockHeightCache.set(chainId, { value: latest, fetchedAt: now });
    return latest;
  }

  return {
    family: "evm",
    supportedChainIds: config.chainIds as readonly ChainId[],

    // ---- Addresses ----

    deriveAddress(seed: string, index: number) {
      // viem validates the mnemonic and throws a helpful message if malformed.
      const account = mnemonicToAccount(seed, {
        accountIndex,
        changeIndex: DEFAULT_CHANGE_INDEX,
        addressIndex: index
      });
      const hdKey = account.getHdKey();
      if (!hdKey.privateKey) {
        throw new Error(`EVM derivation produced an account without a private key (index=${index})`);
      }
      const privateKey = `0x${bytesToHex(hdKey.privateKey)}`;
      // Lowercased to match `canonicalizeAddress`. On-chain EVM addresses are
      // case-insensitive (EIP-55 is just a typo-detection checksum); storing
      // one canonical case makes joins between detected transfers and
      // invoice/pool rows reliable. Turso/SQLite TEXT compares are
      // case-sensitive — a single mismatched char silently drops the join.
      return { address: account.address.toLowerCase() as Address, privateKey };
    },

    validateAddress(addr: string): boolean {
      return isAddress(addr);
    },

    canonicalizeAddress(addr: string): Address {
      // Lowercased hex. `getAddress` throws on invalid hex/length first so we
      // still reject malformed input — we just discard the EIP-55 checksum
      // case afterwards for storage. See deriveAddress comment for rationale.
      return getAddress(addr).toLowerCase() as Address;
    },

    // ---- Detection ----

    async scanIncoming({ chainId, addresses, tokens, sinceMs }) {
      if (addresses.length === 0) return [];
      const client = getClient(chainId);

      // Translate `sinceMs` into a block number. A provider-reported `latest`
      // minus an estimated block count keeps us chain-agnostic without needing
      // a timestamp-to-block service.
      const latest = await client.getBlockNumber();
      const blockTimeMs = APPROX_BLOCK_TIME_MS[chainId] ?? 12_000;
      const nowMs = Date.now();
      const spanBlocks = Math.min(
        maxScanBlocks,
        Math.max(1, Math.ceil((nowMs - sinceMs) / blockTimeMs))
      );
      const fromBlock = latest - BigInt(spanBlocks) + 1n;

      // Match tokens (from our registry) on this chain. Unknown symbols silently skipped.
      const targetTokens = tokens
        .map((sym) => findToken(chainId as ChainId, sym))
        .filter((t): t is NonNullable<typeof t> => t !== null);

      const erc20Targets = targetTokens.filter((t) => t.contractAddress !== null);

      // One log query per token. We could do one call across all contracts,
      // but most providers return better results per-contract. The parallelism
      // is cheap on HTTP.
      const results: DetectedTransfer[] = [];
      await Promise.all(
        erc20Targets.map(async (token) => {
          const logs = await client.getLogs({
            address: token.contractAddress! as Hex,
            event: {
              type: "event",
              name: "Transfer",
              inputs: [
                { name: "from", type: "address", indexed: true },
                { name: "to", type: "address", indexed: true },
                { name: "value", type: "uint256", indexed: false }
              ]
            },
            args: { to: [...(addresses as readonly Hex[])] },
            fromBlock,
            toBlock: latest
          });
          for (const log of logs) {
            // viem-decoded args: { from, to, value }
            const args = log.args as { from: Hex; to: Hex; value: bigint };
            results.push({
              chainId: chainId as ChainId,
              txHash: log.transactionHash,
              logIndex: log.logIndex,
              fromAddress: getAddress(args.from),
              toAddress: getAddress(args.to),
              token: token.symbol,
              amountRaw: args.value.toString() as AmountRaw,
              blockNumber: Number(log.blockNumber),
              confirmations: Number(latest - log.blockNumber) + 1,
              seenAt: new Date()
            });
          }
        })
      );

      return results;
    },

    async getConfirmationStatus(chainId: ChainId, txHash: TxHash) {
      const client = getClient(chainId);
      const [receipt, latest] = await Promise.all([
        client.getTransactionReceipt({ hash: txHash as Hex }).catch(() => null),
        getCachedBlockNumber(chainId, client)
      ]);
      if (!receipt) {
        // Not yet mined or unknown — report zero confirmations, not reverted.
        return { blockNumber: null, confirmations: 0, reverted: false };
      }
      const blockNumber = Number(receipt.blockNumber);
      const confirmations = Number(latest - receipt.blockNumber) + 1;
      return {
        blockNumber,
        confirmations: Math.max(0, confirmations),
        reverted: receipt.status === "reverted"
      };
    },

    // ---- Payouts ----

    async buildTransfer(args: BuildTransferArgs): Promise<UnsignedTx> {
      const token = findToken(args.chainId as ChainId, args.token);
      if (!token) {
        throw new Error(`EVM buildTransfer: unknown token ${args.token} on chain ${args.chainId}`);
      }

      const isNative = token.contractAddress === null;
      let to: Hex;
      let data: Hex;
      let value: bigint;

      if (isNative) {
        to = args.toAddress as Hex;
        data = "0x";
        value = BigInt(args.amountRaw);
      } else {
        to = token.contractAddress as unknown as Hex;
        data = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [args.toAddress as Hex, BigInt(args.amountRaw)]
        });
        value = 0n;
      }

      // Gas is estimated in `estimateGasForTransfer`; don't pre-bind it here
      // so a caller can call either method independently.
      const raw: EvmUnsignedTxRaw = {
        to,
        data,
        value,
        from: args.fromAddress as Hex,
        chainId: args.chainId
      };

      return {
        chainId: args.chainId as ChainId,
        raw,
        summary: isNative
          ? `EVM: native transfer ${args.amountRaw} to ${args.toAddress}`
          : `EVM: ERC-20 ${args.token} transfer ${args.amountRaw} to ${args.toAddress}`
      };
    },

    async signAndBroadcast(unsignedTx: UnsignedTx, privateKey: string): Promise<TxHash> {
      const raw = unsignedTx.raw as EvmUnsignedTxRaw;
      const account = privateKeyToAccount(privateKey as Hex);
      const chainId = raw.chainId;
      const transport = config.transports?.[chainId] ?? buildHttpTransport(config.rpcUrls, chainId);
      const wallet = createWalletClient({ account, transport });
      const hash = await wallet.sendTransaction({
        to: raw.to,
        data: raw.data,
        value: raw.value,
        ...(raw.gas !== undefined ? { gas: raw.gas } : {}),
        // viem requires a chain; build a minimal stub since we only need the id.
        chain: { id: chainId, name: `evm-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } }
      });
      return hash as TxHash;
    },

    // ---- Fees ----

    nativeSymbol(chainId: ChainId): TokenSymbol {
      return (NATIVE_SYMBOLS[chainId] ?? "ETH") as TokenSymbol;
    },

    async estimateGasForTransfer(args: EstimateArgs): Promise<AmountRaw> {
      const client = getClient(args.chainId);
      const token = findToken(args.chainId as ChainId, args.token);
      if (!token) {
        throw new Error(`EVM estimateGas: unknown token ${args.token} on chain ${args.chainId}`);
      }
      if (token.contractAddress === null) {
        const gas = await client.estimateGas({
          account: args.fromAddress as Hex,
          to: args.toAddress as Hex,
          value: BigInt(args.amountRaw)
        });
        return gas.toString() as AmountRaw;
      }
      const data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [args.toAddress as Hex, BigInt(args.amountRaw)]
      });
      const gas = await client.estimateGas({
        account: args.fromAddress as Hex,
        to: token.contractAddress as unknown as Hex,
        data
      });
      return gas.toString() as AmountRaw;
    },

    async getBalance(args): Promise<AmountRaw> {
      const client = getClient(args.chainId);
      const token = findToken(args.chainId as ChainId, args.token);
      if (!token) {
        throw new Error(`EVM getBalance: unknown token ${args.token} on chain ${args.chainId}`);
      }
      if (token.contractAddress === null) {
        const balance = await client.getBalance({ address: args.address as Hex });
        return balance.toString() as AmountRaw;
      }
      const balance = (await client.readContract({
        address: token.contractAddress as unknown as Hex,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [args.address as Hex]
      })) as bigint;
      return balance.toString() as AmountRaw;
    }
  };
}

// ---- Shared internals ----

function buildHttpTransport(
  rpcUrls: EvmChainConfig["rpcUrls"],
  chainId: number
): Transport {
  const url = rpcUrls?.[chainId];
  if (!url) {
    throw new Error(`evmChainAdapter: no rpcUrl or transport configured for chainId ${chainId}`);
  }
  return http(url);
}

// The shape the EVM adapter stores inside UnsignedTx.raw. Only this adapter
// inspects it — core/domain treats `raw` as opaque.
interface EvmUnsignedTxRaw {
  to: Hex;
  data: Hex;
  value: bigint;
  from: Hex;
  chainId: number;
  gas?: bigint;
}
