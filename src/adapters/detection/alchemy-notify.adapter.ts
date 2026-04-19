import type { AppDeps } from "../../core/app-deps.js";
import type { DetectionStrategy } from "../../core/ports/detection.port.ts";
import type { ChainId } from "../../core/types/chain.js";
import { findChainAdapter } from "../../core/domain/chain-lookup.js";
import type { DetectedTransfer } from "../../core/types/transaction.js";
import { TOKEN_REGISTRY } from "../../core/types/token-registry.js";
import type { AmountRaw } from "../../core/types/money.js";
import { CHAIN_ID_BY_ALCHEMY_NETWORK } from "./alchemy-network.js";

// Alchemy's ADDRESS_ACTIVITY payload shape. Pared down to the fields we read;
// ignored fields (webhookId, hash confirmations, contractMetadata, etc.) stay out
// of the typed surface so a version bump that adds fields doesn't break parsing.
interface AlchemyActivityEvent {
  fromAddress?: string;
  toAddress?: string;
  blockNum?: string; // hex "0x1234"
  hash?: string;
  asset?: string;
  category?: string; // "token" | "external" | "internal" | ...
  rawContract?: {
    rawValue?: string; // hex "0x..."
    address?: string;  // null for native transfers
    decimals?: number;
  };
  log?: { logIndex?: string };
}

interface AlchemyPayload {
  webhookId?: string;
  id?: string;
  createdAt?: string;
  type?: string;
  event?: {
    network?: string;
    // EVM payload shape.
    activity?: readonly AlchemyActivityEvent[];
    // Solana payload shape — each entry is one on-chain tx the watched
    // address appeared in. Alchemy's protobuf-to-JSON serializer wraps
    // single-occurrence fields as 1-element arrays (`transaction`, `meta`,
    // `message`), so every nested walk takes `[0]` defensively.
    transaction?: readonly SolanaWebhookTransaction[];
    slot?: number;
  };
}

// Solana-side payload shapes. Fields we don't read are left off so a future
// schema version that adds fields doesn't break parsing. Both snake_case
// (protobuf-default) and camelCase (raw-RPC) accessors are handled in
// `pickField` so the parser is resilient to either Alchemy variant.
interface SolanaWebhookTransaction {
  signature?: string;
  transaction?: ReadonlyArray<{
    signatures?: readonly string[];
    message?: ReadonlyArray<{
      account_keys?: readonly string[];
      accountKeys?: readonly string[];
    }>;
  }>;
  meta?: ReadonlyArray<{
    fee?: number;
    err?: unknown | null;
    pre_balances?: readonly number[];
    preBalances?: readonly number[];
    post_balances?: readonly number[];
    postBalances?: readonly number[];
    pre_token_balances?: readonly SolanaTokenBalance[];
    preTokenBalances?: readonly SolanaTokenBalance[];
    post_token_balances?: readonly SolanaTokenBalance[];
    postTokenBalances?: readonly SolanaTokenBalance[];
  }>;
  index?: number;
  is_vote?: boolean;
  isVote?: boolean;
  slot?: number;
}

interface SolanaTokenBalance {
  account_index?: number;
  accountIndex?: number;
  mint?: string;
  owner?: string;
  ui_token_amount?: { amount?: string; decimals?: number };
  uiTokenAmount?: { amount?: string; decimals?: number };
}

// DetectionStrategy.handlePush for Alchemy Notify webhooks. The route handler
// (http/routes/webhooks-ingest.ts) verifies the HMAC signature and parses the
// JSON body; this adapter turns the parsed payload into DetectedTransfer[].

export function alchemyNotifyDetection(): DetectionStrategy {
  return {
    async handlePush(deps: AppDeps, rawPayload: unknown): Promise<readonly DetectedTransfer[]> {
      const payload = rawPayload as AlchemyPayload;
      if (payload.type !== "ADDRESS_ACTIVITY") return [];

      const network = payload.event?.network;
      if (!network) return [];
      const chainIdNumber = CHAIN_ID_BY_ALCHEMY_NETWORK[network];
      if (chainIdNumber === undefined) {
        // Unknown network — the operator added a webhook for a chain we don't
        // serve. Silently drop so a misconfigured webhook never poisons the
        // ingest pipeline.
        return [];
      }
      const chainId = chainIdNumber as ChainId;

      const chainAdapter = findChainAdapter(deps, chainId);

      // Solana uses a different payload shape: event.transaction[] of full
      // Solana tx objects (with meta.pre_token_balances / post_token_balances
      // for SPL) vs EVM's flat event.activity[] (with rawContract.address +
      // rawValue). Branch on family so each parser stays single-purpose.
      if (chainAdapter.family === "solana") {
        return parseSolanaEvent(payload.event?.transaction ?? [], chainId, chainAdapter);
      }

      // Build a contract-address -> symbol map from the registry for this chain.
      // ERC-20 transfers arrive with rawContract.address; we need that to
      // resolve the token symbol (Alchemy's `asset` field is human-readable but
      // unreliable — empty for unknown contracts, and shadows our registry when
      // Alchemy disagrees on the ticker).
      const symbolByContract = new Map<string, string>();
      for (const t of TOKEN_REGISTRY) {
        if (t.chainId !== chainIdNumber) continue;
        if (t.contractAddress === null) continue;
        symbolByContract.set(t.contractAddress.toLowerCase(), t.symbol);
      }

      const activities = payload.event?.activity ?? [];
      const transfers: DetectedTransfer[] = [];
      for (const activity of activities) {
        const parsed = parseActivity(activity, chainId, chainAdapter, symbolByContract);
        if (parsed) transfers.push(parsed);
      }
      return transfers;
    }
  };
}

// ---- Solana parser ----
//
// A Solana webhook payload lists every transaction a watched address appeared
// in; for each we emit a DetectedTransfer per credited (owner, token) pair:
//   - Native SOL: account with positive pre/post balance delta → toAddress.
//   - SPL tokens: post_token_balance minus pre_token_balance per (owner, mint),
//     keyed against the registry's contractAddress to resolve the symbol.
//
// The handler is stateless: it returns every credit it finds, even for
// addresses we don't watch. The downstream ingest path
// (webhooks-ingest → ingestDetectedTransfer) filters by active-invoice
// receive_address, so a permissive parser is correct and cheap.
function parseSolanaEvent(
  transactions: readonly SolanaWebhookTransaction[],
  chainId: ChainId,
  chainAdapter: ReturnType<typeof findChainAdapter>
): readonly DetectedTransfer[] {
  const now = new Date();
  // Mint -> symbol map for SPL resolution.
  const symbolByMint = new Map<string, string>();
  for (const t of TOKEN_REGISTRY) {
    if (t.chainId !== chainId) continue;
    if (t.contractAddress === null) continue;
    symbolByMint.set(t.contractAddress, t.symbol);
  }
  const nativeSymbol = chainAdapter.nativeSymbol(chainId);

  const transfers: DetectedTransfer[] = [];
  for (const rawTx of transactions) {
    if (rawTx.signature === undefined) continue;
    const meta = (rawTx.meta ?? [])[0];
    if (!meta) continue;
    if (meta.err !== undefined && meta.err !== null) continue;

    const txInner = (rawTx.transaction ?? [])[0];
    const msg = (txInner?.message ?? [])[0];
    const accountKeys = msg?.account_keys ?? msg?.accountKeys ?? [];

    const preBalances = meta.pre_balances ?? meta.preBalances;
    const postBalances = meta.post_balances ?? meta.postBalances;
    const fee = meta.fee ?? 0;

    // Native SOL credits — account[i] where post-pre is strictly positive.
    // The account paying the fee (index 0 by Solana convention) is excluded
    // from being credited by adjusting for `fee` — otherwise a 0-lamport
    // transfer from account[0] would read as -fee and never match.
    if (preBalances && postBalances && accountKeys.length > 0) {
      for (let i = 0; i < accountKeys.length; i += 1) {
        const pre = preBalances[i];
        const post = postBalances[i];
        if (pre === undefined || post === undefined) continue;
        const delta = post - pre;
        if (delta <= 0) continue;
        const toAddress = accountKeys[i];
        if (toAddress === undefined) continue;
        // Best-effort sender: any account with the inverse delta (accounting
        // for fee burn on index 0). Falls back to account[0] (conventional
        // fee payer / signer).
        const fromAddress = guessSender(accountKeys, preBalances, postBalances, delta, fee, i) ?? accountKeys[0]!;
        transfers.push({
          chainId,
          txHash: rawTx.signature,
          logIndex: null,
          fromAddress,
          toAddress,
          token: nativeSymbol,
          amountRaw: delta.toString() as AmountRaw,
          blockNumber: rawTx.slot ?? null,
          confirmations: 1,
          seenAt: now
        });
      }
    }

    // SPL credits — per (owner, mint) pair, post - pre. We key by
    // `${owner}|${mint}` because the same owner can show up in multiple
    // token accounts if they hold more than one mint in the tx. The sender
    // for SPL is harder to recover without full instruction parsing; we
    // leave fromAddress as a placeholder and let the sweeper fill via
    // `getTransaction` if needed.
    const preTokens = meta.pre_token_balances ?? meta.preTokenBalances ?? [];
    const postTokens = meta.post_token_balances ?? meta.postTokenBalances ?? [];
    if (preTokens.length > 0 || postTokens.length > 0) {
      const preMap = indexTokenBalances(preTokens);
      const postMap = indexTokenBalances(postTokens);
      const keys = new Set<string>([...preMap.keys(), ...postMap.keys()]);
      for (const key of keys) {
        const pre = preMap.get(key) ?? { owner: "", mint: "", amount: 0n };
        const post = postMap.get(key) ?? { owner: "", mint: "", amount: 0n };
        const owner = post.owner || pre.owner;
        const mint = post.mint || pre.mint;
        if (!owner || !mint) continue;
        const symbol = symbolByMint.get(mint);
        if (symbol === undefined) continue;
        const delta = post.amount - pre.amount;
        if (delta <= 0n) continue;
        // Try to find the sender: the (other-owner, same-mint) pair whose
        // amount dropped by -delta. Best-effort; falls back to account[0].
        const fromAddress = guessSplSender(preMap, postMap, owner, mint, delta) ?? accountKeys[0] ?? "unknown";
        transfers.push({
          chainId,
          txHash: rawTx.signature,
          logIndex: null,
          fromAddress,
          toAddress: owner,
          token: symbol,
          amountRaw: delta.toString() as AmountRaw,
          blockNumber: rawTx.slot ?? null,
          confirmations: 1,
          seenAt: now
        });
      }
    }
  }
  return transfers;
}

interface IndexedTokenBalance {
  owner: string;
  mint: string;
  amount: bigint;
}

function indexTokenBalances(
  balances: readonly SolanaTokenBalance[]
): Map<string, IndexedTokenBalance> {
  const out = new Map<string, IndexedTokenBalance>();
  for (const b of balances) {
    const owner = b.owner ?? "";
    const mint = b.mint ?? "";
    if (!owner || !mint) continue;
    const amountStr = b.ui_token_amount?.amount ?? b.uiTokenAmount?.amount;
    if (amountStr === undefined) continue;
    let amount: bigint;
    try {
      amount = BigInt(amountStr);
    } catch {
      continue;
    }
    out.set(`${owner}|${mint}`, { owner, mint, amount });
  }
  return out;
}

function guessSender(
  accountKeys: readonly string[],
  preBalances: readonly number[],
  postBalances: readonly number[],
  creditedDelta: number,
  fee: number,
  creditedIndex: number
): string | null {
  for (let i = 0; i < accountKeys.length; i += 1) {
    if (i === creditedIndex) continue;
    const pre = preBalances[i];
    const post = postBalances[i];
    if (pre === undefined || post === undefined) continue;
    const d = post - pre;
    // Exact opposite, OR opposite adjusted for fee burn on index 0.
    if (d === -creditedDelta) return accountKeys[i] ?? null;
    if (i === 0 && d === -creditedDelta - fee) return accountKeys[i] ?? null;
  }
  return null;
}

function guessSplSender(
  preMap: Map<string, IndexedTokenBalance>,
  postMap: Map<string, IndexedTokenBalance>,
  creditedOwner: string,
  mint: string,
  creditedDelta: bigint
): string | null {
  const keys = new Set([...preMap.keys(), ...postMap.keys()]);
  for (const key of keys) {
    const pre = preMap.get(key);
    const post = postMap.get(key);
    const owner = post?.owner || pre?.owner;
    const m = post?.mint || pre?.mint;
    if (!owner || !m || m !== mint || owner === creditedOwner) continue;
    const delta = (post?.amount ?? 0n) - (pre?.amount ?? 0n);
    if (delta === -creditedDelta) return owner;
  }
  return null;
}

function parseActivity(
  activity: AlchemyActivityEvent,
  chainId: ChainId,
  chainAdapter: ReturnType<typeof findChainAdapter>,
  symbolByContract: Map<string, string>
): DetectedTransfer | null {
  const { fromAddress, toAddress, hash, blockNum, category } = activity;
  if (!fromAddress || !toAddress || !hash) return null;

  // Resolve the token symbol from the activity's category:
  //   - "token"    → ERC-20 transfer; symbol comes from rawContract.address
  //                  → registry lookup. Unknown contracts are skipped.
  //   - "external" → native gas-token transfer between EOAs (ETH/MATIC/BNB/...).
  //                  Symbol comes from the chain adapter's nativeSymbol map.
  //   - "internal" → native sent FROM a contract via internal CALL (forwarders,
  //                  multicalls, etc.). Same native-symbol resolution.
  // Anything else (e.g. "erc721", "erc1155") is ignored — we don't index NFTs.
  let symbol: string;
  if (category === "token") {
    const contractAddress = activity.rawContract?.address;
    if (!contractAddress) return null;
    const matched = symbolByContract.get(contractAddress.toLowerCase());
    if (!matched) return null;
    symbol = matched;
  } else if (category === "external" || category === "internal") {
    symbol = chainAdapter.nativeSymbol(chainId);
  } else {
    return null;
  }

  const rawValueHex = activity.rawContract?.rawValue;
  if (!rawValueHex) return null;
  let amountRaw: string;
  try {
    amountRaw = BigInt(rawValueHex).toString();
  } catch {
    return null;
  }

  let blockNumber: number | null = null;
  if (blockNum) {
    try {
      blockNumber = Number(BigInt(blockNum));
    } catch {
      blockNumber = null;
    }
  }

  let logIndex: number | null = null;
  if (activity.log?.logIndex) {
    try {
      logIndex = Number(BigInt(activity.log.logIndex));
    } catch {
      logIndex = null;
    }
  }

  // Canonicalize addresses so downstream matching against
  // invoice.receive_address works regardless of the casing Alchemy reports.
  let canonicalFrom: string;
  let canonicalTo: string;
  try {
    canonicalFrom = chainAdapter.canonicalizeAddress(fromAddress);
    canonicalTo = chainAdapter.canonicalizeAddress(toAddress);
  } catch {
    return null;
  }

  return {
    chainId,
    txHash: hash,
    logIndex,
    fromAddress: canonicalFrom,
    toAddress: canonicalTo,
    token: symbol,
    amountRaw: amountRaw as AmountRaw,
    blockNumber,
    // Alchemy Notify fires on the first confirmation. Treat as 1 confirmation;
    // the sweeper will re-query `getConfirmationStatus` for the authoritative depth.
    confirmations: 1,
    seenAt: new Date()
  };
}
