// Monero daemon RPC client. Talks to a `monerod` JSON-RPC endpoint over
// HTTP. Public Monero nodes (mempool.space-equivalents for XMR) speak this
// protocol unauthenticated — we round-robin / failover across a list, same
// pattern as the Esplora client for UTXO chains.
//
// We only call READ methods + nothing requiring authentication: tip height,
// block-by-height, transactions-by-hash. Tx broadcast (`send_raw_transaction`)
// is the one write but isn't used in v1 (inbound only).
//
// Default backends are reasonably-stable community nodes. Operators can
// override via `MONERO_RPC_URLS` env var (comma-separated).
//
// Trust model in v1: the failover list is best-effort liveness only —
// `withFailover` returns the FIRST backend that responds. View-key crypto
// guarantees a malicious node cannot FORGE credits to us (the recipient-
// side cryptographic match would fail), but a malicious primary node CAN
// silently OMIT transactions. Operators concerned about omission should
// set `MONERO_RPC_URLS` to a self-hosted monerod. v2 may add a
// consensus-of-N tip-and-block-hashes pre-flight to catch single-node
// omission against community-run nodes.

// Default public mainnet backends. Public Monero nodes come and go (operators
// retire them, domains lapse). The list is ordered by recent reliability and
// failover walks it in order — first responder wins. Operators should set
// `MONERO_RPC_URLS` (comma-separated) for production; the defaults exist so a
// dev/local boot Just Works without env wiring.
//
// **Cloudflare Workers + TLS constraint.** Workers `fetch` enforces full TLS
// chain validation and offers no opt-out. The Monero community has many fast
// public nodes (hashvault, monerodevs, stormycloud, ...) but most use
// self-signed certs because the daemon's built-in HTTPS doesn't read CA
// certs — those are unreachable from a Worker even though they work fine
// from `curl -k` or a Node deployment. The defaults below are the subset
// known to terminate TLS through a real CA-signed cert (typically by
// fronting the daemon with nginx/Cloudflare on a `.com`/`.org` domain).
//
// If you discover one is dead, drop it from the list. Fresh candidates can
// be sourced from https://monero.fail/ — when picking, verify with
// `curl https://<node>/json_rpc` (without `-k`) that the cert validates.
export const DEFAULT_MAINNET_BACKENDS: readonly string[] = [
  "https://xmr-node.cakewallet.com:18081",
  "https://xmr-node-uk.cakewallet.com:18081",
  "https://xmr-node-eu.cakewallet.com:18081",
  "https://xmr-node-usa-east.cakewallet.com:18081",
  "https://node.sethforprivacy.com"
];

// Stagenet/testnet defaults are best-effort — these networks have far fewer
// public nodes, and self-signed certs are the norm. Operators running on
// Workers will likely need to point `MONERO_RPC_URLS` at a self-hosted node.
export const DEFAULT_STAGENET_BACKENDS: readonly string[] = [
  "https://stagenet.xmr-tw.org",
  "https://stagenet.community.rino.io",
  "https://stagenet.melo.tools:38081"
];

export const DEFAULT_TESTNET_BACKENDS: readonly string[] = [
  "https://testnet.xmr-tw.org",
  "https://testnet.community.rino.io"
];

export interface MoneroBackend {
  readonly baseUrl: string;
  // Optional per-backend HTTP headers. Required by commercial RPC providers
  // that authenticate via a header (NOWNodes uses `api-key`, Tatum uses
  // `x-api-key`, Alchemy / GetBlock embed the key in the URL and need
  // nothing here). Applied to every request made to this specific backend.
  // Treat the contents as secret material — never log full headers, only
  // header names.
  readonly headers?: Readonly<Record<string, string>>;
}

export class MoneroBackendError extends Error {
  constructor(
    public readonly backend: string,
    public readonly status: number | null,
    public override readonly cause: unknown
  ) {
    super(`monero rpc ${backend} failed (status=${status ?? "network"}): ${String(cause)}`);
    this.name = "MoneroBackendError";
  }
}

// Minimal subset of the daemon RPC tx response (jsonParsed style). We project
// only what we need: tx pubkey, output public keys, encrypted amounts,
// commitments, and the block this tx landed in.
export interface MoneroTxOutput {
  readonly publicKey: string; // hex 32 bytes — `output_public_keys[i]` AKA "K"
  // Encrypted amount (hex 8 bytes) for RingCT v2/v3. Null on coinbase.
  readonly encryptedAmount: string | null;
  // Pedersen commitment (hex 32 bytes) from `rct_signatures.outPk[i]`.
  // Monero stores outPk as the ACTUAL commitment point C = mask·G + amount·H.
  // Null on coinbase / pre-RingCT txs (plaintext amounts, no commitments).
  // SECURITY: `encryptedAmount` (ecdhInfo) is NOT consensus-validated — the
  // scanner must verify any decoded amount against this commitment before
  // crediting, otherwise a malicious payer can fake deposit amounts.
  readonly commitment: string | null;
}

export interface MoneroParsedTx {
  readonly txHash: string;
  readonly blockHeight: number | null; // null = mempool
  // Primary tx pubkey from `tx_extra` tag 0x01 (hex 32 bytes). Used for
  // outputs paid to a *primary* address. May be a decoy when every output
  // goes to a subaddress; in that case `additionalPubkeys[i]` is the per-
  // output key the receiver must use to derive the shared secret.
  readonly txPubkey: string;
  // Per-output tx pubkeys from `tx_extra` tag 0x04. Present whenever the
  // sender's wallet treats any recipient as a subaddress (which modern
  // wallets do by default, including for change). Index i corresponds to
  // output index i in `outputs`. Empty array when the sender used the
  // legacy single-pubkey form for all outputs.
  readonly additionalPubkeys: readonly string[];
  readonly outputs: readonly MoneroTxOutput[];
  // Coinbase txs never credit an external view-key holder; we still surface
  // them so callers can skip cleanly.
  readonly isCoinbase: boolean;
  // `unlock_time` from the tx prefix. 0 for virtually every real payment.
  // Non-zero means ALL outputs of the tx are time-locked: a value below
  // 500_000_000 is a block height, anything above is a unix timestamp.
  // The scanner skips any tx with a non-zero value (fail closed) — see the
  // policy comment in monero-chain.adapter.ts.
  readonly unlockTime: number;
}

export interface MoneroDaemonRpcClient {
  // Current tip (chain length). One block beyond the highest mined block.
  getTipHeight(): Promise<number>;
  // Block at the given height: returns the list of tx hashes (incl. miner tx).
  getBlockTxHashesByHeight(height: number): Promise<readonly string[]>;
  // Batch fetch parsed txs by hash. Tx hashes that the daemon doesn't know
  // about are silently dropped from the response (no per-hash error).
  getTransactions(txHashes: readonly string[]): Promise<readonly MoneroParsedTx[]>;
}

export interface MoneroDaemonRpcConfig {
  readonly backends: readonly MoneroBackend[];
  readonly fetch?: typeof globalThis.fetch;
  // Per-request timeout. Default 15s — Monero blocks are larger and
  // public nodes are slower than Esplora's mempool.space.
  readonly timeoutMs?: number;
  // Optional logger so the parser can warn when a backend returns a tx
  // without `as_json` populated, or with unparseable extra. Otherwise
  // these are silent drops that show up as "tx mysteriously not detected".
  readonly logger?: { warn: (msg: string, fields?: Record<string, unknown>) => void };
}

export function moneroDaemonRpcClient(config: MoneroDaemonRpcConfig): MoneroDaemonRpcClient {
  const backends = config.backends;
  if (backends.length === 0) {
    throw new Error("moneroDaemonRpcClient: at least one backend required");
  }
  const fetchImpl = config.fetch ?? globalThis.fetch;
  // 8s per backend keeps total cron-tick spend bounded when public nodes go
  // flaky. Worst-case full-failover budget is ~40s for the 5 default mainnet
  // backends — still inside a 1-minute cron interval. A real Monero node
  // responds to `get_block_count` in < 200ms; if it doesn't, it's not healthy
  // enough to keep waiting on.
  const timeoutMs = config.timeoutMs ?? 8_000;

  // Try each backend in order on failure. Same shape as Esplora's withFailover.
  // BEST-EFFORT LIVENESS ONLY — returns the first backend that responds.
  // Does NOT cross-check responses across backends; a malicious primary
  // node can omit txs without us noticing. See the file header for the
  // v1 trust model + v2 consensus-of-N follow-up note.
  async function withFailover<T>(op: (b: MoneroBackend) => Promise<T>): Promise<T> {
    const errors: MoneroBackendError[] = [];
    for (const backend of backends) {
      try {
        return await op(backend);
      } catch (err) {
        if (err instanceof MoneroBackendError) {
          errors.push(err);
          continue;
        }
        throw err;
      }
    }
    throw new Error(
      `monero: all ${backends.length} backends failed: ${errors.map((e) => e.message).join("; ")}`
    );
  }

  // POST /json_rpc — Monero's JSON-RPC envelope.
  async function jsonRpc<T>(backend: MoneroBackend, method: string, params: unknown): Promise<T> {
    const url = `${backend.baseUrl.replace(/\/+$/, "")}/json_rpc`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(backend.headers ?? {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: "0", method, params }),
        signal: controller.signal
      });
      if (!res.ok) {
        throw new MoneroBackendError(backend.baseUrl, res.status, await res.text().catch(() => ""));
      }
      const body = (await res.json()) as { result?: T; error?: { message: string } };
      if (body.error) {
        throw new MoneroBackendError(backend.baseUrl, res.status, body.error.message);
      }
      if (body.result === undefined) {
        throw new MoneroBackendError(backend.baseUrl, res.status, "missing 'result' in response");
      }
      return body.result;
    } catch (err) {
      if (err instanceof MoneroBackendError) throw err;
      throw new MoneroBackendError(backend.baseUrl, null, err);
    } finally {
      clearTimeout(timer);
    }
  }

  // Some daemon endpoints are mounted at /<endpoint> (raw JSON, not JSON-RPC):
  // /get_transactions, /get_outs, etc. Same shape as jsonRpc minus the wrapper.
  async function rawPost<T>(backend: MoneroBackend, path: string, body: unknown): Promise<T> {
    const url = `${backend.baseUrl.replace(/\/+$/, "")}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(backend.headers ?? {}) },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) {
        throw new MoneroBackendError(backend.baseUrl, res.status, await res.text().catch(() => ""));
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof MoneroBackendError) throw err;
      throw new MoneroBackendError(backend.baseUrl, null, err);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getTipHeight() {
      const result = await withFailover((b) =>
        jsonRpc<{ count: number }>(b, "get_block_count", {})
      );
      // get_block_count returns the chain length (tip + 1). Subtract 1 to
      // give the highest mined-block height.
      return Math.max(0, result.count - 1);
    },

    async getBlockTxHashesByHeight(height: number) {
      const result = await withFailover((b) =>
        jsonRpc<{ tx_hashes?: string[]; miner_tx_hash?: string }>(b, "get_block", { height })
      );
      const hashes: string[] = [];
      if (result.miner_tx_hash) hashes.push(result.miner_tx_hash);
      if (Array.isArray(result.tx_hashes)) hashes.push(...result.tx_hashes);
      return hashes;
    },

    async getTransactions(txHashes: readonly string[]) {
      if (txHashes.length === 0) return [];
      const result = await withFailover((b) =>
        rawPost<{
          txs?: Array<{
            tx_hash: string;
            block_height?: number;
            in_pool?: boolean;
            as_json?: string;
          }>;
        }>(b, "/get_transactions", {
          txs_hashes: [...txHashes],
          decode_as_json: true
        })
      );
      const out: MoneroParsedTx[] = [];
      for (const t of result.txs ?? []) {
        if (!t.as_json) {
          // Some restricted/proxy nodes return a tx record without a
          // decoded JSON payload, even when we asked for decode_as_json.
          // Without this log, every such tx is silently invisible — and
          // the same tx fetched via a different backend would decode
          // fine. Surface it so operators can swap backends or notice
          // a regression in their RPC provider.
          config.logger?.warn("monero rpc: tx has no as_json (cannot decode); skipping", {
            txHash: t.tx_hash,
            inPool: t.in_pool,
            blockHeight: t.block_height,
            backend: undefined
          });
          continue;
        }
        let parsed: ParsedTxJson;
        try {
          parsed = JSON.parse(t.as_json) as ParsedTxJson;
        } catch (err) {
          config.logger?.warn("monero rpc: tx as_json failed to parse; skipping", {
            txHash: t.tx_hash,
            error: err instanceof Error ? err.message : String(err)
          });
          continue;
        }
        const extraKeys = extractExtraPubkeys(parsed.extra);
        if (!extraKeys.primary && extraKeys.additional.length === 0) {
          // This drops every tx whose tx_extra parser bailed out on an
          // unknown tag before reaching tag 0x01 / 0x04. Real Monero txs
          // virtually always have a primary tx pubkey; missing it means
          // either the daemon stripped extra (very rare) or our parser
          // hit a tag layout we don't handle. Surface either way.
          config.logger?.warn("monero rpc: tx has no extractable tx pubkeys; skipping", {
            txHash: t.tx_hash,
            extraLength: Array.isArray(parsed.extra) ? parsed.extra.length : "non-array"
          });
          continue;
        }
        const outputs: MoneroTxOutput[] = (parsed.vout ?? []).map((vout, i) => ({
          publicKey: vout.target?.key ?? vout.target?.tagged_key?.key ?? "",
          encryptedAmount: parsed.rct_signatures?.ecdhInfo?.[i]?.amount ?? null,
          // outPk[i] is the output's Pedersen commitment for all RingCT
          // types; absent on coinbase / pre-RingCT (type 0) txs where the
          // amount is plaintext instead.
          commitment: parsed.rct_signatures?.outPk?.[i] ?? null
        }));
        const blockHeight = t.in_pool ? null : (typeof t.block_height === "number" ? t.block_height : null);
        out.push({
          txHash: t.tx_hash,
          blockHeight,
          // Empty string for primary when only additional pubkeys exist —
          // the adapter handles that case by skipping the primary path.
          txPubkey: extraKeys.primary ?? "",
          additionalPubkeys: extraKeys.additional,
          outputs,
          isCoinbase: parsed.vin?.[0]?.gen !== undefined,
          unlockTime: typeof parsed.unlock_time === "number" ? parsed.unlock_time : 0
        });
      }
      return out;
    }
  };
}

// Parses the comma-separated MONERO_RPC_URLS env var. Empty / missing →
// returns null so the caller can fall back to defaults.
export function parseMoneroRpcUrlsEnv(value: string | undefined): readonly string[] | null {
  if (value === undefined || value.length === 0) return null;
  const urls = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return urls.length === 0 ? null : urls;
}

// Parses MONERO_RPC_HEADERS_JSON. Optional. When present, must be a JSON
// object whose values are strings — applied as HTTP headers to every
// MONERO_RPC_URLS request. Used by commercial Monero RPC providers that
// authenticate via headers (NOWNodes: api-key; Tatum: x-api-key).
//
// Example operator config (Wrangler secret):
//   MONERO_RPC_URLS = "https://xmr.nownodes.io"
//   MONERO_RPC_HEADERS_JSON = "{\"api-key\":\"abcd1234\"}"
//
// Returns undefined on missing/empty/malformed input — caller treats as
// "no auth headers". Throws nothing; misconfigured headers just mean
// requests go out without them and the provider returns 401.
export function parseMoneroRpcHeadersEnv(value: string | undefined): Readonly<Record<string, string>> | undefined {
  if (value === undefined || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && k.length > 0) out[k] = v;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  } catch {
    return undefined;
  }
}

// ---- Internal helpers ----

// Shape of a tx's `as_json` decoded payload — only the fields we touch.
interface ParsedTxJson {
  readonly extra?: readonly number[]; // bytes (uint8 array as JSON numbers)
  // uint64 in the tx prefix; 0 = unlocked. Heights < 500_000_000, unix
  // timestamps above. (Extremely large timestamps can lose precision
  // through JSON.parse, but any non-zero value is skipped anyway.)
  readonly unlock_time?: number;
  readonly vin?: ReadonlyArray<{ readonly gen?: unknown; readonly key?: unknown }>;
  readonly vout?: ReadonlyArray<{
    readonly target?: {
      readonly key?: string;
      readonly tagged_key?: { readonly key: string };
    };
  }>;
  readonly rct_signatures?: {
    readonly ecdhInfo?: ReadonlyArray<{ readonly amount?: string }>;
    // Per-output Pedersen commitments (hex 32 bytes each) for RingCT txs.
    readonly outPk?: ReadonlyArray<string>;
  };
}

// `extra` is a TLV-style byte array carrying tx-level metadata.
// Tags we care about for receive-side detection:
//   0x00  padding (skip)
//   0x01  TX_PUBKEY (32 bytes follow) — the primary tx pubkey R = r·G
//   0x02  extra nonce (1-byte length, then payload — payment IDs etc.)
//   0x04  ADDITIONAL_PUBKEYS (1-byte count, then count*32 bytes) — per-output
//         tx pubkeys R_i = r_i·D_i, used by senders that pay any subaddress.
//         When present, output i's shared secret is derived from
//         additional[i], NOT from the primary R. Modern wallets (Cake,
//         Monero GUI, Feather) emit this for *every* tx with a subaddress
//         recipient, including change-to-self when the wallet's own change
//         output lives on a subaddress.
function extractExtraPubkeys(extraBytes: readonly number[] | undefined): {
  primary: string | null;
  additional: readonly string[];
} {
  const empty = { primary: null, additional: [] as readonly string[] };
  if (!extraBytes || extraBytes.length === 0) return empty;
  let primary: string | null = null;
  let additional: string[] = [];
  let i = 0;
  while (i < extraBytes.length) {
    const tag = extraBytes[i]!;
    if (tag === 0x00) {
      i += 1;
      continue;
    }
    if (tag === 0x01) {
      if (i + 33 > extraBytes.length) break;
      // Capture the FIRST 0x01 we encounter, not the last — matches the
      // reference Monero `wallet2.cpp::parse_extra_pub_key` behavior.
      // Standard wallets emit exactly one 0x01 tag per tx; multiple tags
      // would be malformed, but if a custom/older wallet does emit them
      // we want to use the canonical first one rather than an auxiliary
      // pubkey that might be tacked on later in the buffer.
      if (primary === null) {
        const slice = extraBytes.slice(i + 1, i + 33);
        primary = slice.map((b) => b.toString(16).padStart(2, "0")).join("");
      }
      i += 33;
      continue;
    }
    if (tag === 0x02) {
      if (i + 1 >= extraBytes.length) break;
      const len = extraBytes[i + 1]!;
      i += 2 + len;
      continue;
    }
    if (tag === 0x04) {
      if (i + 1 >= extraBytes.length) break;
      const n = extraBytes[i + 1]!;
      const startsAt = i + 2;
      const endsAt = startsAt + n * 32;
      if (endsAt > extraBytes.length) break;
      for (let k = 0; k < n; k += 1) {
        const off = startsAt + k * 32;
        const slice = extraBytes.slice(off, off + 32);
        additional.push(slice.map((b) => b.toString(16).padStart(2, "0")).join(""));
      }
      i = endsAt;
      continue;
    }
    // Unknown tag — can't safely advance past unknown TLV without a length
    // byte we don't know how to parse. Bail; whatever we have so far is
    // surfaced. Worst case the receiver tries fewer keys than possible and
    // misses an output, which the next reorg-resistant tick won't fix —
    // but in practice tag 0x04 (if present) appears before any unknown tag.
    break;
  }
  return { primary, additional };
}
