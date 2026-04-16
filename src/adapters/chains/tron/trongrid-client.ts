// Thin TronGrid REST client. TronGrid exposes two surfaces:
//   1. /v1/... — Tron's "v1" REST/paginated endpoints (TRC-20 transfers, account info)
//   2. /wallet/... — the native Tron node JSON POST API (triggersmartcontract, broadcast, etc.)
//
// Only a handful of methods are used by the chain adapter. The client is
// explicitly fetch-based with an injectable `fetch` so tests can supply
// deterministic fixtures without mocking globals.

export type TronFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface TronGridClientConfig {
  // Base URL, e.g. https://api.trongrid.io (mainnet) or https://nile.trongrid.io (Nile testnet).
  baseUrl: string;
  // Optional API key (TronGrid requires one for higher rate limits).
  apiKey?: string;
  // Injectable fetch for tests. Defaults to globalThis.fetch.
  fetch?: TronFetch;
  // Request timeout in ms. Defaults to 15s.
  timeoutMs?: number;
}

export interface TrongridTrc20Transfer {
  transaction_id: string;
  block_timestamp: number;
  block: number;
  from: string; // base58
  to: string;   // base58
  value: string; // decimal string of raw amount
  token_info: { address: string; decimals: number; name: string; symbol: string };
  type: string; // "Transfer"
}

export interface TrongridTxInfo {
  // Present when the tx is confirmed. Absent while pending.
  blockNumber?: number;
  // "SUCCESS" for normal confirmed; any other value (FAILED, REVERT) means reverted.
  receipt?: { result?: string };
  // Raw TronGrid also returns contractResult / fee etc. We only need the bits above.
}

export interface TrongridBlock {
  block_header: { raw_data: { number: number } };
}

export interface TrongridTriggerSmartContractResponse {
  transaction: {
    raw_data: unknown;
    raw_data_hex: string;
    txID: string;
  };
  energy_used?: number;
  result: { result?: boolean; message?: string };
}

export interface TrongridBroadcastResponse {
  result?: boolean;
  txid?: string;
  message?: string;
  code?: string;
}

// ---- Client factory ----

export interface TronGridClient {
  listTrc20Transfers(address: string, opts?: { minTimestamp?: number; contractAddress?: string; limit?: number }): Promise<readonly TrongridTrc20Transfer[]>;
  getTransactionInfo(txId: string): Promise<TrongridTxInfo | null>;
  getNowBlock(): Promise<TrongridBlock>;
  triggerSmartContract(params: TriggerSmartContractParams): Promise<TrongridTriggerSmartContractResponse>;
  // `raw_data_hex` is the hex payload; `signature` is 65-byte hex. Both come from the adapter's signer.
  broadcastTransaction(params: { raw_data_hex: string; signature: readonly string[]; txID: string; raw_data: unknown }): Promise<TrongridBroadcastResponse>;
}

export interface TriggerSmartContractParams {
  owner_address: string;        // hex form ("41..." 42 chars)
  contract_address: string;     // hex form
  function_selector: string;    // e.g. "transfer(address,uint256)"
  parameter: string;            // ABI-encoded args, hex
  fee_limit: number;            // max TRX to burn for energy, in sun
  call_value: number;           // native TRX to send, usually 0
}

export function tronGridClient(config: TronGridClientConfig): TronGridClient {
  const doFetch: TronFetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = config.timeoutMs ?? 15_000;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(config.apiKey !== undefined ? { "TRON-PRO-API-KEY": config.apiKey } : {}),
          ...(init?.headers ?? {})
        }
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`TronGrid ${path} returned ${res.status}: ${text.slice(0, 256)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async listTrc20Transfers(address, opts = {}) {
      const params = new URLSearchParams({ only_to: "true" });
      if (opts.limit !== undefined) params.set("limit", String(opts.limit));
      if (opts.minTimestamp !== undefined) params.set("min_timestamp", String(opts.minTimestamp));
      if (opts.contractAddress !== undefined) params.set("contract_address", opts.contractAddress);
      const response = await request<{ data?: readonly TrongridTrc20Transfer[] }>(
        `/v1/accounts/${address}/transactions/trc20?${params.toString()}`
      );
      return response.data ?? [];
    },

    async getTransactionInfo(txId) {
      // Tron returns `{}` (not 404) for unknown tx ids; treat empty object as null.
      const body = await request<TrongridTxInfo & Record<string, unknown>>(
        "/wallet/gettransactioninfobyid",
        { method: "POST", body: JSON.stringify({ value: txId }) }
      );
      return Object.keys(body).length === 0 ? null : body;
    },

    async getNowBlock() {
      return request<TrongridBlock>("/wallet/getnowblock", { method: "POST" });
    },

    async triggerSmartContract(params) {
      return request<TrongridTriggerSmartContractResponse>("/wallet/triggersmartcontract", {
        method: "POST",
        body: JSON.stringify(params)
      });
    },

    async broadcastTransaction(params) {
      return request<TrongridBroadcastResponse>("/wallet/broadcasttransaction", {
        method: "POST",
        body: JSON.stringify(params)
      });
    }
  };
}
