// Alchemy-backed EsploraClient for the UTXO family (Bitcoin / Litecoin).
//
// Why this exists: detection, confirmation tracking, and broadcast all ride on
// the `EsploraClient` port (see esplora-rpc.ts). The default implementation
// talks the Esplora REST shape to public indexers (litecoinspace.org for LTC).
// That host is a single point of failure with no public failover — when its
// address index degraded (HTTP 520) every Litecoin payment went undetected.
// Alchemy serves the same chains far more reliably, but NOT via Esplora: its
// UTXO data is the Blockbook v2 REST API, and chain-level reads are Bitcoin-
// Core JSON-RPC. This module adapts BOTH onto the `EsploraClient` interface so
// the rest of the UTXO stack (scanIncoming, getConfirmationStatus, payouts)
// works unchanged — just inject this client instead of (or ahead of) the
// Esplora one.
//
// Two sub-APIs on the same host `https://{subdomain}.g.alchemy.com/v2/{key}`:
//   - Blockbook REST  `…/api/v2/address/{addr}`, `…/api/v2/tx/{txid}`,
//                     `…/api/v2/sendtx`  — address history, tx, balance,
//                     broadcast. Monetary values are integer strings in the
//                     base unit (litoshis/satoshis); vin/vout carry an
//                     `addresses[]` array.
//   - JSON-RPC        `getblockcount` (tip height), `estimatesmartfee` (fees).
//                     Alchemy does not expose Blockbook's own `/api/v2` status
//                     or `/estimatefee` routes (they 404), so these two reads
//                     go through JSON-RPC.

import {
  esploraClient,
  failoverEsploraClient,
  EsploraBackendError,
  EsploraBadRequestError,
  EsploraNotFoundError,
  type EsploraClient,
  type EsploraTx,
  type EsploraVin,
  type EsploraVout
} from "./esplora-rpc.js";
import type { UtxoChainConfig } from "./utxo-config.js";

// ---- Blockbook response shapes (only the fields we consume) ----

interface BlockbookVin {
  readonly txid?: string;
  readonly vout?: number;
  readonly sequence?: number;
  readonly addresses?: readonly string[];
  readonly isAddress?: boolean;
  readonly value?: string; // base-unit integer string
}

interface BlockbookVout {
  readonly value?: string; // base-unit integer string
  readonly n?: number;
  readonly hex?: string; // scriptPubKey hex
  readonly addresses?: readonly string[];
  readonly isAddress?: boolean;
}

interface BlockbookTx {
  readonly txid: string;
  readonly vin?: readonly BlockbookVin[];
  readonly vout?: readonly BlockbookVout[];
  readonly blockHash?: string;
  readonly blockHeight?: number; // >0 confirmed; -1 (or absent) when in mempool
  readonly confirmations?: number; // 0 when in mempool
  readonly blockTime?: number; // unix seconds (confirmed only)
  readonly fees?: string; // base-unit integer string
}

interface BlockbookAddress {
  readonly address?: string;
  readonly balance?: string; // confirmed balance, base-unit integer string
  readonly transactions?: readonly BlockbookTx[];
}

interface JsonRpcResponse<T> {
  readonly result: T | null;
  readonly error: { readonly code?: number; readonly message?: string } | null;
}

export interface AlchemyUtxoClientConfig {
  // Alchemy subdomain for this chain, e.g. "litecoin-mainnet" / "bitcoin-mainnet".
  readonly subdomain: string;
  readonly apiKey: string;
  // Inject fetch (Workers + tests). Defaults to globalThis.fetch.
  readonly fetch?: typeof globalThis.fetch;
  // Per-request timeout in ms. Defaults to 10s.
  readonly timeoutMs?: number;
  // How many of the newest address transactions to pull per query. Esplora's
  // first page is 25; Blockbook supports up to 1000. 50 comfortably covers a
  // receive address's activity inside one poll window without bloating the
  // response. Older txs (beyond this many in a single window) are still caught
  // by subsequent polls.
  readonly addressPageSize?: number;
}

// Map "bitcoin"/"litecoin" mainnet configs to their Alchemy UTXO subdomain.
// Testnets are intentionally unmapped: Alchemy's UTXO product is mainnet-only
// for these chains today, so testnet callers fall back to the default Esplora
// backends. Returns null when Alchemy can't serve the chain.
export function alchemyUtxoSubdomain(chain: UtxoChainConfig): string | null {
  switch (chain.slug) {
    case "bitcoin":
      return "bitcoin-mainnet";
    case "litecoin":
      return "litecoin-mainnet";
    default:
      return null;
  }
}

// Build the detection/broadcast backend for a UTXO chain, preferring Alchemy
// when it can serve the chain and an API key is present, and ALWAYS keeping the
// chain's public Esplora endpoints as a fallback behind it. The result is a
// single EsploraClient the chain adapter consumes unchanged.
//
//   - Alchemy key set + chain supported → failover([alchemy, esplora(public)])
//   - otherwise                          → esplora(public)  (prior behavior)
//
// Keeping Esplora as a fallback (rather than replacing it) means an Alchemy
// outage degrades to the old path instead of going dark — defense in depth for
// exactly the single-backend failure that motivated this.
export function utxoEsploraClientFor(
  chain: UtxoChainConfig,
  opts: { readonly alchemyApiKey?: string; readonly fetch?: typeof globalThis.fetch }
): EsploraClient {
  const publicEsplora = esploraClient({
    backends: chain.defaultEsploraUrls.map((url) => ({ baseUrl: url })),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {})
  });
  const subdomain = alchemyUtxoSubdomain(chain);
  if (opts.alchemyApiKey !== undefined && opts.alchemyApiKey.length > 0 && subdomain !== null) {
    const alchemy = alchemyUtxoClient({
      subdomain,
      apiKey: opts.alchemyApiKey,
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {})
    });
    return failoverEsploraClient([alchemy, publicEsplora]);
  }
  return publicEsplora;
}

export function alchemyUtxoClient(config: AlchemyUtxoClientConfig): EsploraClient {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const pageSize = config.addressPageSize ?? 50;
  const host = `https://${config.subdomain}.g.alchemy.com/v2/${config.apiKey}`;
  const restBase = `${host}/api/v2`;

  async function getJson<T>(path: string): Promise<T> {
    const url = `${restBase}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      // Blockbook answers a missing/invalid tx with 400, not 404; treat both
      // as "not found" at the call sites that care (getTx). A 400 on an
      // address query means the address isn't valid for this chain.
      if (res.status === 404) throw new EsploraNotFoundError(path);
      if (res.status === 400) throw new EsploraBadRequestError(path);
      if (!res.ok) {
        throw new EsploraBackendError(host, res.status, await res.text().catch(() => ""));
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof EsploraNotFoundError) throw err;
      if (err instanceof EsploraBadRequestError) throw err;
      if (err instanceof EsploraBackendError) throw err;
      throw new EsploraBackendError(host, null, err);
    } finally {
      clearTimeout(timer);
    }
  }

  async function rpcCall<T>(method: string, params: readonly unknown[]): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(host, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal
      });
      if (!res.ok) {
        throw new EsploraBackendError(host, res.status, await res.text().catch(() => ""));
      }
      const body = (await res.json()) as JsonRpcResponse<T>;
      if (body.error !== null && body.error !== undefined) {
        throw new EsploraBackendError(host, res.status, body.error.message ?? "json-rpc error");
      }
      if (body.result === null || body.result === undefined) {
        throw new EsploraBackendError(host, res.status, `json-rpc ${method}: null result`);
      }
      return body.result;
    } catch (err) {
      if (err instanceof EsploraBackendError) throw err;
      throw new EsploraBackendError(host, null, err);
    } finally {
      clearTimeout(timer);
    }
  }

  async function addressTxs(address: string): Promise<readonly BlockbookTx[]> {
    const body = await getJson<BlockbookAddress>(
      `/address/${address}?details=txs&pageSize=${pageSize}`
    );
    return body.transactions ?? [];
  }

  return {
    // Confirmed history. Blockbook returns newest-first and includes mempool
    // txs at the top; we filter to confirmed here and surface the mempool
    // subset via getAddressMempoolTxs, matching the Esplora client's split so
    // the failover composite and scanIncoming behave identically across both.
    async getAddressTxs(address: string): Promise<readonly EsploraTx[]> {
      const txs = await addressTxs(address);
      return txs.filter((t) => isConfirmed(t)).map(blockbookTxToEsplora);
    },

    async getAddressMempoolTxs(address: string): Promise<readonly EsploraTx[]> {
      const txs = await addressTxs(address);
      return txs.filter((t) => !isConfirmed(t)).map(blockbookTxToEsplora);
    },

    async getTx(txid: string): Promise<EsploraTx> {
      // Blockbook returns 400 for an unknown/invalid txid; getJson maps that to
      // EsploraBadRequestError. The port contract is "throw EsploraNotFoundError
      // when the tx isn't there", so normalize both 400 and 404 to NotFound.
      try {
        const tx = await getJson<BlockbookTx>(`/tx/${txid}`);
        return blockbookTxToEsplora(tx);
      } catch (err) {
        if (err instanceof EsploraBadRequestError) throw new EsploraNotFoundError(`/tx/${txid}`);
        throw err;
      }
    },

    async getTipHeight(): Promise<number> {
      const n = await rpcCall<number>("getblockcount", []);
      if (typeof n !== "number" || !Number.isFinite(n)) {
        throw new EsploraBackendError(host, 200, `non-numeric block count: ${String(n)}`);
      }
      return n;
    },

    async broadcastTx(rawHex: string): Promise<string> {
      // Blockbook POST /sendtx accepts the raw hex as a text/plain body and
      // returns { result: "<txid>" } on success or { error: { message } } on
      // rejection (min-relay-fee, missing-inputs, bad-signature, …).
      const url = `${restBase}/sendtx`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: rawHex,
          signal: controller.signal
        });
        const body = (await res.json().catch(() => null)) as
          | { result?: string; error?: { message?: string } | string }
          | null;
        if (!res.ok || body === null || body.error !== undefined) {
          const msg =
            body !== null && body.error !== undefined
              ? typeof body.error === "string"
                ? body.error
                : (body.error.message ?? "sendtx error")
              : await res.text().catch(() => "");
          throw new EsploraBackendError(host, res.ok ? 200 : res.status, msg);
        }
        if (typeof body.result !== "string" || body.result.length === 0) {
          throw new EsploraBackendError(host, res.status, "sendtx: missing result txid");
        }
        return body.result;
      } catch (err) {
        if (err instanceof EsploraBackendError) throw err;
        throw new EsploraBackendError(host, null, err);
      } finally {
        clearTimeout(timer);
      }
    },

    async getFeeEstimates(): Promise<Readonly<Record<string, number>>> {
      // estimatesmartfee returns { feerate: <coin>/kB, blocks }. Convert to
      // sat/vB (× 1e8 sat/coin ÷ 1000 vB/kB = × 1e5), matching the units the
      // Esplora client's getFeeEstimates returns. Floor at 1 sat/vB so a chain
      // with no fee data doesn't produce a 0 that zeroes out downstream
      // Math.ceil(vsize × rate). Keys mirror the Esplora projection.
      const targets: Record<string, number> = { "1": 1, "3": 3, "6": 6, "144": 144, "1008": 1008 };
      const out: Record<string, number> = {};
      await Promise.all(
        Object.entries(targets).map(async ([key, blocks]) => {
          try {
            const r = await rpcCall<{ feerate?: number }>("estimatesmartfee", [blocks]);
            const satPerVb = typeof r.feerate === "number" && r.feerate > 0 ? r.feerate * 1e5 : 0;
            out[key] = Math.max(1, Math.ceil(satPerVb));
          } catch {
            // A single target failing (insufficient data) shouldn't sink the
            // whole estimate; floor it and let the others stand.
            out[key] = 1;
          }
        })
      );
      return out;
    },

    async getAddressBalanceSats(address: string): Promise<bigint> {
      try {
        const body = await getJson<BlockbookAddress>(`/address/${address}?details=basic`);
        return body.balance !== undefined ? BigInt(body.balance) : 0n;
      } catch (err) {
        if (err instanceof EsploraNotFoundError) return 0n;
        if (err instanceof EsploraBadRequestError) return 0n;
        throw err;
      }
    }
  };
}

// ---- Mapping ----

function isConfirmed(t: BlockbookTx): boolean {
  // Mempool txs report confirmations: 0 and blockHeight -1/absent. A tx is
  // confirmed once it has at least one confirmation AND a real block height.
  return (t.confirmations ?? 0) > 0 && typeof t.blockHeight === "number" && t.blockHeight > 0;
}

function satFromString(s: string | undefined): number {
  // Blockbook amounts are integer strings in the base unit (litoshis/satoshis),
  // uint53-safe well past either chain's max supply. Number() is exact here.
  if (s === undefined || s === "") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function blockbookTxToEsplora(t: BlockbookTx): EsploraTx {
  const confirmed = isConfirmed(t);
  const vin: EsploraVin[] = (t.vin ?? []).map((v) => {
    const addr = v.addresses && v.addresses.length > 0 ? v.addresses[0] : undefined;
    return {
      txid: v.txid ?? "",
      vout: v.vout ?? 0,
      // Esplora denormalizes the spent output into `prevout`; Blockbook gives
      // us the address + value directly on the input. scanIncoming only reads
      // prevout.scriptpubkey_address (for best-effort sender attribution), so
      // the empty scriptpubkey is fine. Coinbase inputs have no address →
      // prevout null, which the sender-attribution find() skips.
      prevout:
        addr !== undefined
          ? { scriptpubkey: "", scriptpubkey_address: addr, value: satFromString(v.value) }
          : null,
      ...(v.sequence !== undefined ? { sequence: v.sequence } : {})
    };
  });
  const vout: EsploraVout[] = (t.vout ?? []).map((o) => {
    const addr = o.addresses && o.addresses.length > 0 ? o.addresses[0] : undefined;
    return {
      scriptpubkey: o.hex ?? "",
      ...(addr !== undefined ? { scriptpubkey_address: addr } : {}),
      value: satFromString(o.value)
    };
  });
  return {
    txid: t.txid,
    status: confirmed
      ? {
          confirmed: true,
          block_height: t.blockHeight!,
          ...(t.blockHash !== undefined ? { block_hash: t.blockHash } : {}),
          ...(t.blockTime !== undefined ? { block_time: t.blockTime } : {})
        }
      : { confirmed: false },
    vin,
    vout,
    fee: satFromString(t.fees)
  };
}
