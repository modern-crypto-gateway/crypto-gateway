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
// configure Alchemy as the `/wallet/*` primary while TronGrid carries indexed
// detection alone, preserving the constrained TronGrid quota.

export type TronFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface TrongridTrc20Transfer {
  transaction_id: string;
  block_timestamp: number;
  // Undefined for unconfirmed txs — the /trc20 endpoint has no
  // `only_confirmed` filter (unlike /transactions), so in-flight txs show up
  // without a block assignment. Callers must tolerate the missing field.
  block?: number;
  from: string;
  to: string;
  value: string;
  token_info: { address: string; decimals: number; name: string; symbol: string };
  type: string;
}

// Native TRX transfer surfaced by GET /v1/accounts/{addr}/transactions.
// The endpoint returns full Tron transactions; we project only what we need.
// `txID` is the Tron canonical id; `blockNumber` may be undefined for
// unconfirmed txs; `value` is in sun (1 TRX = 10^6 sun).
export interface TrongridTrxTransfer {
  txID: string;
  blockNumber?: number;
  blockTimestamp: number;
  from: string;
  to: string;
  // Sun (TRX's smallest unit). String to stay consistent with TRC-20 amounts.
  value: string;
}

export interface TrongridTxInfo {
  blockNumber?: number;
  receipt?: {
    result?: string;
    // Actual resource consumption, in sun. Present on any tx that touched
    // the VM (TRC-20 transfers, contract calls). Sum these with top-level
    // `fee` to get the total native cost — Tron charges for energy + net
    // even when the tx reverted, so fail-path debiting needs all three.
    net_fee?: number;
    energy_fee?: number;
    net_usage?: number;
    energy_usage?: number;
    energy_usage_total?: number;
  };
  // Fee paid for account activation / smart contract deployment / TX
  // underpricing. Zero on a typical TRC-20 transfer where the cost is
  // fully captured in `receipt.{net_fee, energy_fee}`.
  fee?: number;
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

// Read-only simulation params. Same shape as TriggerSmartContractParams
// minus fee_limit (no fee burned on constant calls) — but we keep both
// fields optional so callers that share a single params builder don't
// need a second code path.
export interface TriggerConstantContractParams {
  owner_address: string;
  contract_address: string;
  function_selector: string;
  parameter: string;
}

// Response from /wallet/triggerconstantcontract. `constant_result` is an
// array of hex strings, each being the raw return data of one invocation
// (for balanceOf, a single 64-char uint256 hex string).
export interface TrongridTriggerConstantContractResponse {
  result: { result?: boolean; message?: string };
  constant_result?: readonly string[];
  energy_used?: number;
}

// Flat key/value of the chain-parameter set returned by
// /wallet/getchainparameters. Keys are Tron's own camelCase names
// (`getEnergyFee`, `getTransactionFee`, etc.). Values are integers
// expressed in SUN or seconds depending on the parameter. We only read
// `getEnergyFee` today; the wider shape is typed as Record<string, number>
// so adding another param later (e.g. `getTransactionFee` for bandwidth)
// doesn't need a port change.
export interface TrongridChainParameters {
  readonly params: Readonly<Record<string, number>>;
}

// Account-resource state for a Tron address. Covers the effective energy /
// bandwidth budgets (own stake + delegated in) as read from a single
// /wallet/getaccountresource call. From these, the planner can decide
// whether a source has enough energy to skip a TRX burn.
//
// Tron meters two resources separately:
//   - ENERGY: consumed by TRC-20 / smart-contract calls (our primary payout)
//   - BANDWIDTH: consumed by every tx's raw bytes (~345 for a transfer);
//                every account gets 600 free/day on top of whatever staking
//                provides.
// Both accumulate daily; anything over the allowance burns TRX at fixed
// rates (see `getChainParameters.getEnergyFee` for the energy rate).
//
// Per-delegation direction accounting (out to X pool addresses, in from
// this fee wallet) requires a separate /wallet/getaccount call — not
// surfaced here to keep the fast-path read small. The admin status
// endpoint composes it separately when the operator explicitly asks.
export interface TronAccountResources {
  // Current free energy this account can still consume today (own stake +
  // delegated in, minus what's already used this day).
  readonly energyAvailable: number;
  // Total energy this account can consume per day from all sources.
  readonly energyLimit: number;
  // Free bandwidth this account can still consume today, INCLUDING the
  // ~600/day free allowance Tron grants every account.
  readonly bandwidthAvailable: number;
  readonly bandwidthLimit: number;
}

// Resource kind for freeze / delegate operations. Tron's on-the-wire enum
// uses 0 for BANDWIDTH and 1 for ENERGY; we expose string labels at the
// port and translate internally.
export type TronResourceKind = "ENERGY" | "BANDWIDTH";

export interface FreezeBalanceV2Params {
  owner_address: string;       // hex 0x41... form
  frozen_balance: number;      // sun to freeze
  resource: TronResourceKind;
}

export interface UnfreezeBalanceV2Params {
  owner_address: string;
  unfreeze_balance: number;
  resource: TronResourceKind;
}

export interface DelegateResourceParams {
  owner_address: string;       // fee wallet (delegator)
  receiver_address: string;    // pool address (delegatee)
  balance: number;             // TRX-stake-equivalent in sun
  resource: TronResourceKind;
  // When true, the delegation is "locked" for 3 days (cannot be undelegated
  // earlier than 3d from now). Reduces churn when delegations are long-lived.
  lock?: boolean;
  // Optional lock period in seconds; defaults to 3 days when `lock: true`.
  lock_period?: number;
}

export interface UndelegateResourceParams {
  owner_address: string;
  receiver_address: string;
  balance: number;
  resource: TronResourceKind;
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
    opts?: { minTimestamp?: number; maxTimestamp?: number; contractAddress?: string; limit?: number }
  ): Promise<readonly TrongridTrc20Transfer[]>;
  // Address-indexed list of native TRX transfers crediting `address`. Backed
  // by TronGrid's `/v1/accounts/{addr}/transactions` endpoint, filtered to
  // `TransferContract` records (native TRX moves; TRC-20 lives at the
  // `/trc20` sibling endpoint). Alchemy's Tron RPC has no equivalent yet —
  // alchemyTronBackend throws TronProviderNotSupportedError so the composite
  // client falls through to a TronGrid backend when paired.
  listTrxTransfers(
    address: string,
    opts?: { minTimestamp?: number; maxTimestamp?: number; limit?: number }
  ): Promise<readonly TrongridTrxTransfer[]>;
  getTransactionInfo(txId: string): Promise<TrongridTxInfo | null>;
  getNowBlock(): Promise<TrongridBlock>;
  triggerSmartContract(params: TriggerSmartContractParams): Promise<TrongridTriggerSmartContractResponse>;
  // Read-only contract call (view/pure methods like balanceOf). Unlike
  // triggerSmartContract this doesn't build an unsigned tx; it just returns
  // the EVM-style hex-encoded return data in `constant_result[0]`. Used by
  // getAccountBalances for authoritative TRC-20 balance reads (TronGrid's
  // `/v1/accounts/{addr}` indexed TRC-20 list is known to lag or omit
  // balances for addresses without recent outbound activity).
  triggerConstantContract(params: TriggerConstantContractParams): Promise<TrongridTriggerConstantContractResponse>;
  // Current network chain parameters (/wallet/getchainparameters). The only
  // field we consume today is `getEnergyFee` — the SUN-per-energy-unit rate
  // validators charge when an account burns TRX for energy. Hardcoding this
  // is a bug risk: Tron halved the rate from 420 to 210 SUN/unit during the
  // 2024 network vote, silently doubling the fee quotes of any tool that
  // didn't track the change. Reading it live means our quotes always match
  // the chain's actual cost.
  getChainParameters(): Promise<TrongridChainParameters>;
  // Account-resource state (energy / bandwidth budgets + delegation
  // accounting). Underpins both the admin "fee wallet status" view and the
  // planner's decision to skip a TRX-burn reservation when the source has
  // enough delegated energy.
  getAccountResources(address: string): Promise<TronAccountResources>;
  // Build-only endpoints for Stake 2.0 resource operations. Each returns
  // an unsigned tx that the caller signs + broadcasts via signAndBroadcast
  // (same flow as createTransaction for native TRX transfers). The fee-
  // wallet admin endpoints compose these into operator actions (stake,
  // unstake, delegate-to-pool, reclaim-from-pool).
  freezeBalanceV2(params: FreezeBalanceV2Params): Promise<TrongridCreateTransactionResponse>;
  unfreezeBalanceV2(params: UnfreezeBalanceV2Params): Promise<TrongridCreateTransactionResponse>;
  delegateResource(params: DelegateResourceParams): Promise<TrongridCreateTransactionResponse>;
  undelegateResource(params: UndelegateResourceParams): Promise<TrongridCreateTransactionResponse>;
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

// Structured HTTP failure surfaced by every Tron backend. Keeping the status
// and provider-requested cooldown separate from the message lets the TronGrid
// scheduler distinguish a quota response from a permanent 4xx without brittle
// string matching at every call site.
export class TronHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(args: { path: string; status: number; body: string; retryAfterMs: number | null }) {
    super(`Tron RPC ${args.path} returned ${args.status}: ${args.body.slice(0, 256)}`);
    this.name = "TronHttpError";
    this.status = args.status;
    this.retryAfterMs = args.retryAfterMs;
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
  // TronGrid's keyed public tier allows 15 QPS. Default to 10 request starts
  // per second so confirmation/payout traffic has headroom alongside scans.
  requestsPerSecond?: number;
  // Number of retries after the first attempt for 429 / 5xx responses.
  // Identical broadcast bodies are safe to retry because the txID is stable.
  maxRetries?: number;
  // Test hooks. Production callers should leave these undefined.
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  // Production defaults to a module-shared queue per base URL + API key so
  // separately-created app dependency graphs in one process/isolate cooperate.
  // Tests with injected transports default to isolated queues.
  sharedRateLimit?: boolean;
}

const DEFAULT_TRONGRID_REQUESTS_PER_SECOND = 10;
const DEFAULT_TRONGRID_MAX_RETRIES = 2;
const DEFAULT_TRONGRID_429_COOLDOWN_MS = 30_000;
const TRONGRID_429_COOLDOWN_PADDING_MS = 250;
const TRONGRID_RETRY_BASE_MS = 500;

interface TronGridSchedulerConfig {
  readonly intervalMs: number;
  readonly maxRetries: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

class TronGridRequestScheduler {
  private tail: Promise<void> = Promise.resolve();
  private nextStartAt = 0;
  private cooldownUntil = 0;

  constructor(private readonly config: TronGridSchedulerConfig) {}

  schedule<T>(operation: () => Promise<T>): Promise<T> {
    // Serialize the complete retry lifecycle. A 429 therefore pauses the
    // whole per-key queue instead of allowing already-enqueued siblings to
    // hammer a provider that explicitly suspended the key.
    const run = this.tail.then(
      () => this.runWithRetry(operation),
      () => this.runWithRetry(operation)
    );
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async runWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      await this.waitForStartSlot();
      try {
        return await operation();
      } catch (err) {
        if (!isRetryableTronHttpError(err)) throw err;

        const retryDelayMs = retryDelayFor(err, attempt, this.config.random);
        this.cooldownUntil = Math.max(this.cooldownUntil, this.config.now() + retryDelayMs);
        // Even an exhausted request must publish its cooldown before it
        // rejects; otherwise the next queued sibling would start ~100ms later
        // while TronGrid still has the API key suspended.
        if (attempt >= this.config.maxRetries) throw err;
      }
    }
  }

  private async waitForStartSlot(): Promise<void> {
    const target = Math.max(this.nextStartAt, this.cooldownUntil);
    const waitMs = Math.max(0, target - this.config.now());
    if (waitMs > 0) await this.config.sleep(waitMs);

    // Use the target as a floor as well as the post-sleep clock. This keeps
    // deterministic injected clocks honest even when their sleep hook only
    // records delays instead of advancing real wall time.
    const startedAt = Math.max(target, this.config.now());
    this.nextStartAt = startedAt + this.config.intervalMs;
  }
}

const sharedTronGridSchedulers = new Map<string, TronGridRequestScheduler>();

function tronGridScheduler(config: TronGridBackendConfig): TronGridRequestScheduler {
  const requestsPerSecond = config.requestsPerSecond ?? DEFAULT_TRONGRID_REQUESTS_PER_SECOND;
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) {
    throw new Error("TronGrid requestsPerSecond must be a positive finite number");
  }
  const maxRetries = config.maxRetries ?? DEFAULT_TRONGRID_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("TronGrid maxRetries must be a non-negative integer");
  }

  const schedulerConfig: TronGridSchedulerConfig = {
    intervalMs: Math.ceil(1000 / requestsPerSecond),
    maxRetries,
    now: config.now ?? (() => Date.now()),
    sleep: config.sleep ?? sleep,
    random: config.random ?? (() => Math.random())
  };

  const hasTestHooks =
    config.fetch !== undefined ||
    config.now !== undefined ||
    config.sleep !== undefined ||
    config.random !== undefined;
  const shouldShare = config.sharedRateLimit ?? !hasTestHooks;
  if (!shouldShare) return new TronGridRequestScheduler(schedulerConfig);

  // The key never leaves process memory or appears in logs. Including it is
  // necessary: two independent TronGrid keys have independent provider quotas.
  const schedulerKey = `${config.baseUrl.replace(/\/+$/, "")}\u0000${config.apiKey ?? "<keyless>"}`;
  const existing = sharedTronGridSchedulers.get(schedulerKey);
  if (existing !== undefined) return existing;
  const created = new TronGridRequestScheduler(schedulerConfig);
  sharedTronGridSchedulers.set(schedulerKey, created);
  return created;
}

function isRetryableTronHttpError(err: unknown): err is TronHttpError {
  return err instanceof TronHttpError && (err.status === 429 || err.status >= 500);
}

function retryDelayFor(err: TronHttpError, attempt: number, random: () => number): number {
  const exponentialWithFullJitter = Math.floor(TRONGRID_RETRY_BASE_MS * (2 ** attempt) * random());
  if (err.status !== 429) return exponentialWithFullJitter;
  const providerCooldown = (err.retryAfterMs ?? DEFAULT_TRONGRID_429_COOLDOWN_MS) +
    TRONGRID_429_COOLDOWN_PADDING_MS;
  return providerCooldown + exponentialWithFullJitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function tronGridBackend(config: TronGridBackendConfig): TronRpcBackend {
  const rawHttp = makeHttp({
    baseUrl: config.baseUrl,
    fetch: config.fetch,
    timeoutMs: config.timeoutMs,
    headers: config.apiKey !== undefined ? { "TRON-PRO-API-KEY": config.apiKey } : {},
    now: config.now
  });
  const scheduler = tronGridScheduler(config);
  const base = {
    request<T>(path: string, init?: RequestInit): Promise<T> {
      return scheduler.schedule(() => rawHttp.request<T>(path, init));
    }
  };

  type V1Page<T> = {
    data?: readonly T[];
    meta?: { fingerprint?: string };
  };

  async function listAllPages<T>(path: string, baseParams: URLSearchParams): Promise<readonly T[]> {
    const out: T[] = [];
    const seenFingerprints = new Set<string>();
    let fingerprint: string | undefined;

    for (;;) {
      const params = new URLSearchParams(baseParams);
      if (fingerprint !== undefined) params.set("fingerprint", fingerprint);
      const response = await base.request<V1Page<T>>(`${path}?${params.toString()}`);
      out.push(...(response.data ?? []));

      const next = response.meta?.fingerprint;
      if (next === undefined || next.length === 0) return out;
      if (seenFingerprints.has(next)) {
        throw new Error(`Tron RPC ${path} returned a repeated pagination fingerprint`);
      }
      seenFingerprints.add(next);
      fingerprint = next;
    }
  }

  return {
    name: "trongrid",
    supportsDetection: true,
    async listTrc20Transfers(address, opts = {}) {
      const params = new URLSearchParams({ only_to: "true" });
      if (opts.limit !== undefined) params.set("limit", String(opts.limit));
      if (opts.minTimestamp !== undefined) params.set("min_timestamp", String(opts.minTimestamp));
      if (opts.maxTimestamp !== undefined) params.set("max_timestamp", String(opts.maxTimestamp));
      if (opts.contractAddress !== undefined) params.set("contract_address", opts.contractAddress);
      return listAllPages<TrongridTrc20Transfer>(
        `/v1/accounts/${address}/transactions/trc20`,
        params
      );
    },
    async listTrxTransfers(address, opts = {}) {
      // `/v1/accounts/{addr}/transactions` returns full Tron txs (any type:
      // native transfer, smart-contract trigger, freeze, vote, …). We filter
      // to `TransferContract` (native TRX) and `to === address` to drop
      // outbound + cross-account txs the operator isn't watching for here.
      // `searchInternal=false` keeps internal contract-call TRX moves out;
      // those should surface through TRC-20 / contract-event paths instead.
      const params = new URLSearchParams({
        only_to: "true",
        only_confirmed: "true",
        search_internal: "false"
      });
      if (opts.limit !== undefined) params.set("limit", String(opts.limit));
      if (opts.minTimestamp !== undefined) params.set("min_timestamp", String(opts.minTimestamp));
      if (opts.maxTimestamp !== undefined) params.set("max_timestamp", String(opts.maxTimestamp));
      type RawTx = {
        txID?: string;
        blockNumber?: number;
        block_timestamp?: number;
        raw_data?: {
          contract?: ReadonlyArray<{
            type?: string;
            parameter?: { value?: { amount?: number | string; owner_address?: string; to_address?: string } };
          }>;
        };
      };
      const rows = await listAllPages<RawTx>(`/v1/accounts/${address}/transactions`, params);
      const out: TrongridTrxTransfer[] = [];
      for (const tx of rows) {
        const contract = tx.raw_data?.contract?.[0];
        if (contract?.type !== "TransferContract") continue;
        const v = contract.parameter?.value;
        if (!v?.owner_address || !v?.to_address || v.amount === undefined) continue;
        if (!tx.txID || tx.blockNumber === undefined || tx.block_timestamp === undefined) continue;
        // TronGrid returns hex-prefixed addresses (41-prefix). Caller
        // (tron-chain.adapter scanIncoming) re-canonicalizes to base58 via
        // `chainAdapter.canonicalizeAddress` before matching against
        // invoice receive addresses.
        out.push({
          txID: tx.txID,
          blockNumber: tx.blockNumber,
          blockTimestamp: tx.block_timestamp,
          from: v.owner_address,
          to: v.to_address,
          value: String(v.amount)
        });
      }
      return out;
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
    async triggerConstantContract(params) {
      return base.request<TrongridTriggerConstantContractResponse>("/wallet/triggerconstantcontract", {
        method: "POST",
        body: JSON.stringify(params)
      });
    },
    async getChainParameters() {
      const resp = await base.request<{ chainParameter?: ReadonlyArray<{ key: string; value?: number }> }>(
        "/wallet/getchainparameters",
        { method: "POST" }
      );
      const params: Record<string, number> = {};
      for (const entry of resp.chainParameter ?? []) {
        if (typeof entry.value === "number") params[entry.key] = entry.value;
      }
      return { params };
    },
    async getAccountResources(address) {
      // /wallet/getaccountresource — `visible: true` keeps addresses in
      // base58 on the wire. Uninitialized accounts come back as `{}` with
      // every field absent; treat as uniformly zero.
      const resp = await base.request<{
        EnergyLimit?: number;
        EnergyUsed?: number;
        NetLimit?: number;
        NetUsed?: number;
        freeNetLimit?: number;
        freeNetUsed?: number;
      }>("/wallet/getaccountresource", {
        method: "POST",
        body: JSON.stringify({ address, visible: true })
      });
      const energyLimit = resp.EnergyLimit ?? 0;
      const energyUsed = resp.EnergyUsed ?? 0;
      const stakedBandwidthLimit = resp.NetLimit ?? 0;
      const stakedBandwidthUsed = resp.NetUsed ?? 0;
      const freeBandwidthLimit = resp.freeNetLimit ?? 0;
      const freeBandwidthUsed = resp.freeNetUsed ?? 0;
      return {
        energyAvailable: Math.max(0, energyLimit - energyUsed),
        energyLimit,
        bandwidthAvailable:
          Math.max(0, stakedBandwidthLimit - stakedBandwidthUsed) +
          Math.max(0, freeBandwidthLimit - freeBandwidthUsed),
        bandwidthLimit: stakedBandwidthLimit + freeBandwidthLimit
      };
    },
    async freezeBalanceV2(params) {
      return base.request<TrongridCreateTransactionResponse>("/wallet/freezebalancev2", {
        method: "POST",
        body: JSON.stringify({
          owner_address: params.owner_address,
          frozen_balance: params.frozen_balance,
          resource: params.resource,
          visible: true
        })
      });
    },
    async unfreezeBalanceV2(params) {
      return base.request<TrongridCreateTransactionResponse>("/wallet/unfreezebalancev2", {
        method: "POST",
        body: JSON.stringify({
          owner_address: params.owner_address,
          unfreeze_balance: params.unfreeze_balance,
          resource: params.resource,
          visible: true
        })
      });
    },
    async delegateResource(params) {
      return base.request<TrongridCreateTransactionResponse>("/wallet/delegateresource", {
        method: "POST",
        body: JSON.stringify({
          owner_address: params.owner_address,
          receiver_address: params.receiver_address,
          balance: params.balance,
          resource: params.resource,
          ...(params.lock === true ? { lock: true } : {}),
          ...(params.lock_period !== undefined ? { lock_period: params.lock_period } : {}),
          visible: true
        })
      });
    },
    async undelegateResource(params) {
      return base.request<TrongridCreateTransactionResponse>("/wallet/undelegateresource", {
        method: "POST",
        body: JSON.stringify({
          owner_address: params.owner_address,
          receiver_address: params.receiver_address,
          balance: params.balance,
          resource: params.resource,
          visible: true
        })
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
    headers: {},
    now: undefined
  });

  return {
    name: "alchemy-tron",
    supportsDetection: false,
    async listTrc20Transfers() {
      throw new TronProviderNotSupportedError("alchemy-tron", "listTrc20Transfers");
    },
    async listTrxTransfers() {
      throw new TronProviderNotSupportedError("alchemy-tron", "listTrxTransfers");
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
    async triggerConstantContract(params) {
      return base.request<TrongridTriggerConstantContractResponse>("/wallet/triggerconstantcontract", {
        method: "POST",
        body: JSON.stringify(params)
      });
    },
    async getChainParameters() {
      const resp = await base.request<{ chainParameter?: ReadonlyArray<{ key: string; value?: number }> }>(
        "/wallet/getchainparameters",
        { method: "POST" }
      );
      const params: Record<string, number> = {};
      for (const entry of resp.chainParameter ?? []) {
        if (typeof entry.value === "number") params[entry.key] = entry.value;
      }
      return { params };
    },
    async getAccountResources(address) {
      // /wallet/getaccountresource — `visible: true` keeps addresses in
      // base58 on the wire. Uninitialized accounts come back as `{}` with
      // every field absent; treat as uniformly zero.
      const resp = await base.request<{
        EnergyLimit?: number;
        EnergyUsed?: number;
        NetLimit?: number;
        NetUsed?: number;
        freeNetLimit?: number;
        freeNetUsed?: number;
      }>("/wallet/getaccountresource", {
        method: "POST",
        body: JSON.stringify({ address, visible: true })
      });
      const energyLimit = resp.EnergyLimit ?? 0;
      const energyUsed = resp.EnergyUsed ?? 0;
      const stakedBandwidthLimit = resp.NetLimit ?? 0;
      const stakedBandwidthUsed = resp.NetUsed ?? 0;
      const freeBandwidthLimit = resp.freeNetLimit ?? 0;
      const freeBandwidthUsed = resp.freeNetUsed ?? 0;
      return {
        energyAvailable: Math.max(0, energyLimit - energyUsed),
        energyLimit,
        bandwidthAvailable:
          Math.max(0, stakedBandwidthLimit - stakedBandwidthUsed) +
          Math.max(0, freeBandwidthLimit - freeBandwidthUsed),
        bandwidthLimit: stakedBandwidthLimit + freeBandwidthLimit
      };
    },
    async freezeBalanceV2(params) {
      return base.request<TrongridCreateTransactionResponse>("/wallet/freezebalancev2", {
        method: "POST",
        body: JSON.stringify({
          owner_address: params.owner_address,
          frozen_balance: params.frozen_balance,
          resource: params.resource,
          visible: true
        })
      });
    },
    async unfreezeBalanceV2(params) {
      return base.request<TrongridCreateTransactionResponse>("/wallet/unfreezebalancev2", {
        method: "POST",
        body: JSON.stringify({
          owner_address: params.owner_address,
          unfreeze_balance: params.unfreeze_balance,
          resource: params.resource,
          visible: true
        })
      });
    },
    async delegateResource(params) {
      return base.request<TrongridCreateTransactionResponse>("/wallet/delegateresource", {
        method: "POST",
        body: JSON.stringify({
          owner_address: params.owner_address,
          receiver_address: params.receiver_address,
          balance: params.balance,
          resource: params.resource,
          ...(params.lock === true ? { lock: true } : {}),
          ...(params.lock_period !== undefined ? { lock_period: params.lock_period } : {}),
          visible: true
        })
      });
    },
    async undelegateResource(params) {
      return base.request<TrongridCreateTransactionResponse>("/wallet/undelegateresource", {
        method: "POST",
        body: JSON.stringify({
          owner_address: params.owner_address,
          receiver_address: params.receiver_address,
          balance: params.balance,
          resource: params.resource,
          visible: true
        })
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
      // Alchemy exposes Tron's native `/wallet/getaccount`, so the composite
      // client can now genuinely failover for balance reads. This endpoint
      // returns TRX balance (in sun) at full-node resolution — it does NOT
      // populate a TRC-20 balance map the way TronGrid's indexed
      // `/v1/accounts/{addr}` does. That's fine: getAccountBalances now
      // reads every TRC-20 via balanceOf (triggerConstantContract) anyway,
      // precisely so it can't be fooled by TronGrid's lagging TRC-20 index.
      // `visible: true` keeps address encoding as base58 on both sides.
      const response = await base.request<{
        address?: string;
        balance?: number | string;
      }>("/wallet/getaccount", {
        method: "POST",
        body: JSON.stringify({ address, visible: true })
      });
      return { balanceSun: String(response.balance ?? "0"), trc20: {} };
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
    listTrxTransfers: (address, opts2) =>
      tryEach("listTrxTransfers", (b) => b.listTrxTransfers(address, opts2)),
    getTransactionInfo: (txId) => tryEach("getTransactionInfo", (b) => b.getTransactionInfo(txId)),
    getNowBlock: () => tryEach("getNowBlock", (b) => b.getNowBlock()),
    triggerSmartContract: (params) =>
      tryEach("triggerSmartContract", (b) => b.triggerSmartContract(params)),
    triggerConstantContract: (params) =>
      tryEach("triggerConstantContract", (b) => b.triggerConstantContract(params)),
    getChainParameters: () => tryEach("getChainParameters", (b) => b.getChainParameters()),
    getAccountResources: (address) =>
      tryEach("getAccountResources", (b) => b.getAccountResources(address)),
    freezeBalanceV2: (params) =>
      tryEach("freezeBalanceV2", (b) => b.freezeBalanceV2(params)),
    unfreezeBalanceV2: (params) =>
      tryEach("unfreezeBalanceV2", (b) => b.unfreezeBalanceV2(params)),
    delegateResource: (params) =>
      tryEach("delegateResource", (b) => b.delegateResource(params)),
    undelegateResource: (params) =>
      tryEach("undelegateResource", (b) => b.undelegateResource(params)),
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
  now: (() => number) | undefined;
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
          const body = await res.text().catch(() => "");
          throw new TronHttpError({
            path,
            status: res.status,
            body,
            retryAfterMs: parseRetryAfterMs(
              res.headers.get("retry-after"),
              body,
              config.now?.() ?? Date.now()
            )
          });
        }
        return (await res.json()) as T;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

function parseRetryAfterMs(header: string | null, body: string, nowMs: number): number | null {
  let headerDelayMs: number | null = null;
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      headerDelayMs = Math.ceil(seconds * 1000);
    }

    if (headerDelayMs === null) {
      const dateMs = Date.parse(header);
      if (Number.isFinite(dateMs)) headerDelayMs = Math.max(0, dateMs - nowMs);
    }
  }

  // Current TronGrid bodies use wording such as "suspended for 12 s" or
  // "suspended for 30s". Match only a suspension duration so unrelated
  // numbers (status codes, QPS limit, account ids) cannot become a cooldown.
  const suspended = /suspended\s+for\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\b/i.exec(body);
  let bodyDelayMs: number | null = null;
  if (suspended?.[1] !== undefined) {
    const seconds = Number(suspended[1]);
    if (Number.isFinite(seconds) && seconds >= 0) bodyDelayMs = Math.ceil(seconds * 1000);
  }
  if (headerDelayMs === null) return bodyDelayMs;
  if (bodyDelayMs === null) return headerDelayMs;
  return Math.max(headerDelayMs, bodyDelayMs);
}
