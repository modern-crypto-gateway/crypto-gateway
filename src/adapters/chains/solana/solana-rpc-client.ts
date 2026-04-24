// Thin Solana JSON-RPC client. Only the methods the chain adapter uses:
//   - getLatestBlockhash
//   - getSignaturesForAddress
//   - getTransaction (parsed form)
//   - getSignatureStatuses
//   - sendTransaction
//   - getSlot
//   - getBalance
//   - getTokenAccountsByOwner
//
// Solana RPC uses JSON-RPC 2.0. Fetch is injectable for tests.

export type SolanaFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface SolanaRpcConfig {
  // e.g. https://api.mainnet-beta.solana.com or a Helius / QuickNode URL.
  url: string;
  // Optional Authorization header value (providers like Helius use query-string keys;
  // others use bearer tokens).
  authHeader?: string;
  fetch?: SolanaFetch;
  timeoutMs?: number;
}

// Minimal subset of the Solana signature-for-address response.
export interface SolanaSignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown | null;
  confirmationStatus?: "processed" | "confirmed" | "finalized";
}

// Solana's parsed getTransaction response is nested and polymorphic. We only
// consume a few top-level fields; callers pick what they need from `raw`.
export interface SolanaTokenBalance {
  accountIndex?: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface SolanaTransactionResponse {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown | null;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    // Present when the tx touched any SPL token account. `owner` is populated
    // under jsonParsed encoding, which is what getTransaction requests.
    preTokenBalances?: SolanaTokenBalance[];
    postTokenBalances?: SolanaTokenBalance[];
  } | null;
  transaction: {
    message: {
      accountKeys: Array<string | { pubkey: string; signer: boolean; writable: boolean }>;
      instructions: Array<Record<string, unknown>>;
    };
    signatures: string[];
  };
}

export interface SolanaSignatureStatus {
  slot: number;
  confirmations: number | null;
  err: unknown | null;
  confirmationStatus?: "processed" | "confirmed" | "finalized";
}

// Subset of the SPL `getTokenAccountsByOwner` (jsonParsed) response used by
// the admin balance snapshot. We pull the parsed `mint` and the `tokenAmount`
// pair so the caller can decide whether to include zero-balance accounts.
export interface SolanaParsedTokenAccount {
  mint: string;
  // uiAmountString is decimal; amount is the raw atomic count (string in JSON
  // because it can exceed JS number precision).
  amount: string;
  decimals: number;
}

// Per-slot prioritization-fee sample from `getRecentPrioritizationFees`.
// One entry per recent slot that included a tx touching any of the queried
// writable accounts (empty `accountKeys` asks for global samples).
export interface SolanaPrioritizationFeeSample {
  slot: number;
  // Price the lander paid — micro-lamports per compute unit.
  prioritizationFee: number;
}

export interface SolanaRpcClient {
  getSlot(): Promise<number>;
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getSignaturesForAddress(address: string, opts?: { limit?: number; before?: string; until?: string }): Promise<readonly SolanaSignatureInfo[]>;
  getTransaction(signature: string): Promise<SolanaTransactionResponse | null>;
  getSignatureStatuses(signatures: readonly string[]): Promise<ReadonlyArray<SolanaSignatureStatus | null>>;
  sendTransaction(encodedTxBase58: string): Promise<string>;
  // Native SOL balance in lamports for `address`. Returns 0 for unknown accounts.
  getBalance(address: string): Promise<number>;
  // SPL token accounts owned by `address`. One call returns every mint the
  // owner holds (including zero-balance ATAs). Caller filters by mint to map
  // back to registry tokens.
  getTokenAccountsByOwner(address: string): Promise<readonly SolanaParsedTokenAccount[]>;
  // True iff there's a system-level account at `address` right now. Used at
  // SPL-transfer build time to detect when the destination ATA doesn't yet
  // exist — in that case the payout tx includes a CreateIdempotent step
  // which needs the source to cover the token-account rent-exempt minimum
  // (~2 039 280 lamports) on top of the signature fee. Without this check
  // the planner under-reserves SOL and the chain reverts at CPI-allocation
  // time with System error 0x1 (ResultWithNegativeLamports), which surfaces
  // as a cryptic "custom program error: 0x1" at instruction 2.
  accountExists(address: string): Promise<boolean>;
  // Recent per-slot prioritization-fee samples. `accountKeys` narrows to slots
  // that included a tx touching any of the given writable accounts; an empty
  // array returns a global network-wide sample. Validators return up to ~150
  // recent slots. Used by the fee-tier quote path to bucket 25th/50th/75th
  // percentiles into low/medium/high tiers.
  getRecentPrioritizationFees(
    accountKeys: readonly string[]
  ): Promise<readonly SolanaPrioritizationFeeSample[]>;
}

export function solanaRpcClient(config: SolanaRpcConfig): SolanaRpcClient {
  const doFetch: SolanaFetch = config.fetch ?? ((u, i) => globalThis.fetch(u, i));
  const timeoutMs = config.timeoutMs ?? 15_000;

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(config.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(config.authHeader !== undefined ? { authorization: config.authHeader } : {})
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Solana RPC ${method} returned ${res.status}: ${text.slice(0, 256)}`);
      }
      const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
      if (body.error) {
        throw new Error(`Solana RPC ${method} error ${body.error.code}: ${body.error.message}`);
      }
      return body.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getSlot() {
      return rpc<number>("getSlot", []);
    },

    async getLatestBlockhash() {
      const result = await rpc<{ context: unknown; value: { blockhash: string; lastValidBlockHeight: number } }>(
        "getLatestBlockhash",
        []
      );
      return result.value;
    },

    async getSignaturesForAddress(address, opts = {}) {
      const cfg: Record<string, unknown> = {};
      if (opts.limit !== undefined) cfg["limit"] = opts.limit;
      if (opts.before !== undefined) cfg["before"] = opts.before;
      if (opts.until !== undefined) cfg["until"] = opts.until;
      return rpc<readonly SolanaSignatureInfo[]>("getSignaturesForAddress", [address, cfg]);
    },

    async getTransaction(signature) {
      return rpc<SolanaTransactionResponse | null>("getTransaction", [
        signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }
      ]);
    },

    async getSignatureStatuses(signatures) {
      const result = await rpc<{ context: unknown; value: ReadonlyArray<SolanaSignatureStatus | null> }>(
        "getSignatureStatuses",
        [signatures, { searchTransactionHistory: true }]
      );
      return result.value;
    },

    async sendTransaction(encodedTxBase58) {
      return rpc<string>("sendTransaction", [encodedTxBase58, { encoding: "base58", preflightCommitment: "confirmed" }]);
    },

    async getBalance(address) {
      const result = await rpc<{ context: unknown; value: number }>("getBalance", [address]);
      return result.value;
    },

    async getRecentPrioritizationFees(accountKeys) {
      // Solana RPC returns an array of { slot, prioritizationFee } — no
      // context wrapper. Some validators reject the call entirely (e.g. when
      // the RPC is configured without the extension); we catch and return an
      // empty array so the caller falls back to a sensible default.
      try {
        return await rpc<readonly SolanaPrioritizationFeeSample[]>(
          "getRecentPrioritizationFees",
          [accountKeys as string[]]
        );
      } catch {
        return [];
      }
    },

    async accountExists(address) {
      // getAccountInfo returns { context, value: null } for a non-existent
      // account (no system-level record — never allocated, never received
      // SOL). For an existing account, `value` is a shape with executable,
      // lamports, owner, etc. We only need the existence signal.
      try {
        const result = await rpc<{
          context: unknown;
          value: unknown | null;
        }>("getAccountInfo", [address, { encoding: "base64" }]);
        return result.value !== null;
      } catch {
        // Treat transient failures as "unknown, assume exists" — the
        // downstream tx will still run CreateIdempotent which handles the
        // both-exist and neither-exist cases, and the chain's own checks
        // are authoritative. Better to under-reserve rent on a flap than
        // block valid payouts.
        return true;
      }
    },

    async getTokenAccountsByOwner(address) {
      // Canonical SPL Token program id. Token-2022 accounts
      // (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb) are NOT included here —
      // when/if we register Token-2022 mints in the registry we'll need a
      // second call with that program id.
      const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
      const result = await rpc<{
        context: unknown;
        value: ReadonlyArray<{
          pubkey: string;
          account: {
            data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } };
          };
        }>;
      }>("getTokenAccountsByOwner", [
        address,
        { programId: SPL_TOKEN_PROGRAM },
        { encoding: "jsonParsed" }
      ]);
      const out: SolanaParsedTokenAccount[] = [];
      for (const entry of result.value) {
        const info = entry.account?.data?.parsed?.info;
        if (!info) continue;
        out.push({
          mint: info.mint,
          amount: info.tokenAmount.amount,
          decimals: info.tokenAmount.decimals
        });
      }
      return out;
    }
  };
}
