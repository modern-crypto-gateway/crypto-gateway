// Tron RPC client with pluggable backends.
//
// There are two providers we support:
//   - TronGrid: the reference REST surface. Exposes BOTH the native node
//     endpoints (`/wallet/*`) AND the paginated REST endpoints (`/v1/*`).
//     The `/v1/accounts/{addr}/transactions/trc20` path is how we cheaply
//     discover incoming TRC-20 transfers for a set of watched addresses.
//   - Alchemy Tron: a drop-in for `/wallet/*` (build, broadcast, confirmations).
//     DOES NOT expose the `/v1/*` REST endpoints — there is no paginated
//     transfer-history API on Alchemy. Any detection call made against
//     this backend throws `TronProviderNotSupportedError`.
//
// The composite client routes per-method: every backend is tried in the
// supplied order, and a backend that cannot service a given method is
// silently skipped (not a failure). This lets an operator with BOTH keys
// configure Alchemy as a /wallet failover while TronGrid carries detection
// alone — which is a 3-5x capacity win under the 100k/day TronGrid free tier.

export type TronFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface TrongridTrc20Transfer {
  transaction_id: string;
  block_timestamp: number;
  block: number;
  from: string;
  to: string;
  value: string;
  token_info: { address: string; decimals: number; name: string; symbol: string };
  type: string;
}

export interface TrongridTxInfo {
  blockNumber?: number;
  receipt?: { result?: string };
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

export interface TriggerSmartContractParams {
  owner_address: string;
  contract_address: string;
  function_selector: string;
  parameter: string;
  fee_limit: number;
  call_value: number;
}

// Native TRX transfer build response. TronGrid returns the fully-formed
// unsigned transaction; shape matches triggerSmartContract's `transaction`
// field so downstream sign+broadcast handles both identically.
export interface TrongridCreateTransactionResponse {
  raw_data: unknown;
  raw_data_hex: string;
  txID: string;
  // Surfaced when the build itself rejects (e.g. bad hex inputs).
  Error?: string;
}

export interface CreateTransactionParams {
  // All three addresses are hex (21 bytes, 0x41-prefixed) per /wallet/* convention.
  owner_address: string;
  to_address: string;
  // Amount in sun (1 TRX = 1_000_000 sun).
  amount: number;
}

// Native TRX + TRC-20 balance snapshot for a single address. Returned by
// TronGrid's `/v1/accounts/{addr}` endpoint. We normalize it into a flat
// shape: native sun amount + a (contract → raw atomic balance) map for
// TRC-20s. Both are absent when the account hasn't been activated on chain.
export interface TrongridAccount {
  // Sun (1 TRX = 1_000_000 sun). 0 when the account is unknown.
  balanceSun: string;
  // contract address (base58, T-prefixed) → raw atomic balance string.
  trc20: Readonly<Record<string, string>>;
}

export interface TronRpcBackend {
  // Stable identifier for logs + metrics. "trongrid" | "alchemy-tron" | ...
  readonly name: string;
  // True when this backend implements `listTrc20Transfers`. Exposed so the
  // entrypoint can decide whether Tron detection should be enabled at all.
  readonly supportsDetection: boolean;

  listTrc20Transfers(
    address: string,
    opts?: { minTimestamp?: number; contractAddress?: string; limit?: number }
  ): Promise<readonly TrongridTrc20Transfer[]>;
  getTransactionInfo(txId: string): Promise<TrongridTxInfo | null>;
  getNowBlock(): Promise<TrongridBlock>;
  triggerSmartContract(params: TriggerSmartContractParams): Promise<TrongridTriggerSmartContractResponse>;
  createTransaction(params: CreateTransactionParams): Promise<TrongridCreateTransactionResponse>;
  broadcastTransaction(params: {
    raw_data_hex: string;
    signature: readonly string[];
    txID: string;
    raw_data: unknown;
  }): Promise<TrongridBroadcastResponse>;
  // One-shot balance snapshot (TRX + every TRC-20 the address holds). Backed
  // by TronGrid's `/v1/accounts/{addr}` endpoint, which Alchemy Tron does not
  // expose — alchemy-tron throws TronProviderNotSupportedError so the
  // composite client can fall through to a TronGrid backend when paired.
  getAccount(address: string): Promise<TrongridAccount>;
}

// Thrown when a call targets a method the backend can't service. The
// composite client treats this as "skip, try the next backend" rather than
// a failure. If every backend declines, the composite rethrows so the
// detection scheduler can surface the config gap.
export class TronProviderNotSupportedError extends Error {
  constructor(backend: string, method: string) {
    super(`Tron backend '${backend}' does not support ${method}`);
    this.name = "TronProviderNotSupportedError";
  }
}

// ---- Backends ----

export interface TronGridBackendConfig {
  // e.g. `https://api.trongrid.io` or `https://nile.trongrid.io`.
  baseUrl: string;
  // Optional. Free tier works without one but with much tighter per-IP limits.
  apiKey?: string;
  fetch?: TronFetch;
  timeoutMs?: number;
}

export function tronGridBackend(config: TronGridBackendConfig): TronRpcBackend {
  const base = makeHttp({
    baseUrl: config.baseUrl,
    fetch: config.fetch,
    timeoutMs: config.timeoutMs,
    headers: config.apiKey !== undefined ? { "TRON-PRO-API-KEY": config.apiKey } : {}
  });

  return {
    name: "trongrid",
    supportsDetection: true,
    async listTrc20Transfers(address, opts = {}) {
      const params = new URLSearchParams({ only_to: "true" });
      if (opts.limit !== undefined) params.set("limit", String(opts.limit));
      if (opts.minTimestamp !== undefined) params.set("min_timestamp", String(opts.minTimestamp));
      if (opts.contractAddress !== undefined) params.set("contract_address", opts.contractAddress);
      const response = await base.request<{ data?: readonly TrongridTrc20Transfer[] }>(
        `/v1/accounts/${address}/transactions/trc20?${params.toString()}`
      );
      return response.data ?? [];
    },
    async getTransactionInfo(txId) {
      const body = await base.request<TrongridTxInfo & Record<string, unknown>>(
        "/wallet/gettransactioninfobyid",
        { method: "POST", body: JSON.stringify({ value: txId }) }
      );
      return Object.keys(body).length === 0 ? null : body;
    },
    async getNowBlock() {
      return base.request<TrongridBlock>("/wallet/getnowblock", { method: "POST" });
    },
    async triggerSmartContract(params) {
      return base.request<TrongridTriggerSmartContractResponse>("/wallet/triggersmartcontract", {
        method: "POST",
        body: JSON.stringify(params)
      });
    },
    async createTransaction(params) {
      return base.request<TrongridCreateTransactionResponse>("/wallet/createtransaction", {
        method: "POST",
        body: JSON.stringify(params)
      });
    },
    async broadcastTransaction(params) {
      return base.request<TrongridBroadcastResponse>("/wallet/broadcasttransaction", {
        method: "POST",
        body: JSON.stringify(params)
      });
    },
    async getAccount(address) {
      // /v1/accounts/{addr} returns an array (single-element when the account
      // exists, empty when it doesn't). Inactive Tron accounts have no on-chain
      // record at all — treat as zero balance rather than throwing.
      const response = await base.request<{
        data?: ReadonlyArray<{
          balance?: number | string;
          trc20?: ReadonlyArray<Readonly<Record<string, string>>>;
        }>;
      }>(`/v1/accounts/${address}`);
      const acct = response.data?.[0];
      if (!acct) return { balanceSun: "0", trc20: {} };
      const trc20: Record<string, string> = {};
      for (const entry of acct.trc20 ?? []) {
        for (const [contract, amount] of Object.entries(entry)) {
          // TronGrid sometimes returns multiple entries per contract on
          // re-issued tokens; sum them rather than overwrite.
          try {
            const prev = BigInt(trc20[contract] ?? "0");
            trc20[contract] = (prev + BigInt(amount)).toString();
          } catch {
            // Skip malformed entries.
          }
        }
      }
      return { balanceSun: String(acct.balance ?? "0"), trc20 };
    }
  };
}

export interface AlchemyTronBackendConfig {
  // Alchemy API key. Placed in the URL per Alchemy's conventions.
  apiKey: string;
  // Subdomain override. Defaults to "tron-mainnet"; Shasta testnet = "tron-shasta".
  // Nile testnet is NOT served by Alchemy — operators on Nile must use TronGrid.
  subdomain?: string;
  fetch?: TronFetch;
  timeoutMs?: number;
}

// Builds a backend against Alchemy's Tron API. Serves `/wallet/*` only;
// detection methods throw TronProviderNotSupportedError so the composite
// client falls through to the next backend (or surfaces the gap if none
// remains). Alchemy's Tron URL pattern embeds the key in the path, not a
// header, so no extra auth is applied on top of the usual fetch.
export function alchemyTronBackend(config: AlchemyTronBackendConfig): TronRpcBackend {
  const subdomain = config.subdomain ?? "tron-mainnet";
  const base = makeHttp({
    baseUrl: `https://${subdomain}.g.alchemy.com/v2/${config.apiKey}`,
    fetch: config.fetch,
    timeoutMs: config.timeoutMs,
    headers: {}
  });

  return {
    name: "alchemy-tron",
    supportsDetection: false,
    async listTrc20Transfers() {
      throw new TronProviderNotSupportedError("alchemy-tron", "listTrc20Transfers");
    },
    async getTransactionInfo(txId) {
      const body = await base.request<TrongridTxInfo & Record<string, unknown>>(
        "/wallet/gettransactioninfobyid",
        { method: "POST", body: JSON.stringify({ value: txId }) }
      );
      return Object.keys(body).length === 0 ? null : body;
    },
    async getNowBlock() {
      return base.request<TrongridBlock>("/wallet/getnowblock", { method: "POST" });
    },
    async triggerSmartContract(params) {
      return base.request<TrongridTriggerSmartContractResponse>("/wallet/triggersmartcontract", {
        method: "POST",
        body: JSON.stringify(params)
      });
    },
    async createTransaction(params) {
      return base.request<TrongridCreateTransactionResponse>("/wallet/createtransaction", {
        method: "POST",
        body: JSON.stringify(params)
      });
    },
    async broadcastTransaction(params) {
      return base.request<TrongridBroadcastResponse>("/wallet/broadcasttransaction", {
        method: "POST",
        body: JSON.stringify(params)
      });
    },
    async getAccount() {
      throw new TronProviderNotSupportedError("alchemy-tron", "getAccount");
    }
  };
}

// ---- Composite client ----

export interface TronCompositeClientOptions {
  // Called when a backend is skipped (not-supported) or retried (transient).
  // Keep lightweight — this runs inside the hot path for every RPC call.
  onBackendSkipped?: (info: { backend: string; method: string; reason: string }) => void;
}

// Wraps a list of backends so every RPC call tries them in order. A backend
// that throws TronProviderNotSupportedError is skipped silently; a backend
// that throws any other error (including HTTP 429 / 5xx surfaced as an
// Error from makeHttp) fails over to the next. The first successful result
// wins. If every backend errors, the LAST error is rethrown — usually the
// most informative, and the only one the caller can act on.
export function tronCompositeClient(
  backends: readonly TronRpcBackend[],
  opts: TronCompositeClientOptions = {}
): TronRpcBackend {
  if (backends.length === 0) {
    throw new Error("tronCompositeClient: at least one backend is required");
  }
  const onSkip = opts.onBackendSkipped ?? (() => undefined);

  async function tryEach<T>(method: string, fn: (b: TronRpcBackend) => Promise<T>): Promise<T> {
    let lastError: unknown;
    let attempted = 0;
    for (const backend of backends) {
      try {
        return await fn(backend);
      } catch (err) {
        if (err instanceof TronProviderNotSupportedError) {
          onSkip({ backend: backend.name, method, reason: "not-supported" });
          continue;
        }
        attempted += 1;
        lastError = err;
        onSkip({
          backend: backend.name,
          method,
          reason: err instanceof Error ? err.message : String(err)
        });
      }
    }
    if (attempted === 0 && lastError === undefined) {
      // Every backend declined the method. Surface that specifically so
      // the scheduler can emit a "detection not configured" warning
      // instead of looking like a transient provider outage.
      throw new TronProviderNotSupportedError("composite", method);
    }
    throw lastError ?? new Error(`Tron ${method}: all backends failed`);
  }

  // Report `supportsDetection = true` when at least one backend can do it.
  // Gives entrypoints a single place to check before enabling poll detection.
  const anySupportsDetection = backends.some((b) => b.supportsDetection);

  return {
    name: `composite(${backends.map((b) => b.name).join(",")})`,
    supportsDetection: anySupportsDetection,
    listTrc20Transfers: (address, opts2) =>
      tryEach("listTrc20Transfers", (b) => b.listTrc20Transfers(address, opts2)),
    getTransactionInfo: (txId) => tryEach("getTransactionInfo", (b) => b.getTransactionInfo(txId)),
    getNowBlock: () => tryEach("getNowBlock", (b) => b.getNowBlock()),
    triggerSmartContract: (params) =>
      tryEach("triggerSmartContract", (b) => b.triggerSmartContract(params)),
    createTransaction: (params) =>
      tryEach("createTransaction", (b) => b.createTransaction(params)),
    broadcastTransaction: (params) =>
      tryEach("broadcastTransaction", (b) => b.broadcastTransaction(params)),
    getAccount: (address) => tryEach("getAccount", (b) => b.getAccount(address))
  };
}

// ---- Shared HTTP core ----

interface HttpConfig {
  baseUrl: string;
  fetch: TronFetch | undefined;
  timeoutMs: number | undefined;
  headers: Readonly<Record<string, string>>;
}

function makeHttp(config: HttpConfig): {
  request<T>(path: string, init?: RequestInit): Promise<T>;
} {
  const doFetch: TronFetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = config.timeoutMs ?? 15_000;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  return {
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            ...config.headers,
            ...(init?.headers ?? {})
          }
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Tron RPC ${path} returned ${res.status}: ${text.slice(0, 256)}`);
        }
        return (await res.json()) as T;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
