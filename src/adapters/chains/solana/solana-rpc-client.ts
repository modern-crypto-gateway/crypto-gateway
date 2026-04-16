// Thin Solana JSON-RPC client. Only the methods the chain adapter uses:
//   - getLatestBlockhash
//   - getSignaturesForAddress
//   - getTransaction (parsed form)
//   - getSignatureStatuses
//   - sendTransaction
//   - getSlot
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
export interface SolanaTransactionResponse {
  slot: number;
  blockTime: number | null;
  meta: { err: unknown | null; fee: number; preBalances: number[]; postBalances: number[] } | null;
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

export interface SolanaRpcClient {
  getSlot(): Promise<number>;
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getSignaturesForAddress(address: string, opts?: { limit?: number; before?: string; until?: string }): Promise<readonly SolanaSignatureInfo[]>;
  getTransaction(signature: string): Promise<SolanaTransactionResponse | null>;
  getSignatureStatuses(signatures: readonly string[]): Promise<ReadonlyArray<SolanaSignatureStatus | null>>;
  sendTransaction(encodedTxBase58: string): Promise<string>;
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
    }
  };
}
