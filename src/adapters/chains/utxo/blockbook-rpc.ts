import {
  EsploraBackendError,
  EsploraNotFoundError,
  type EsploraClient,
  type EsploraTx,
  type EsploraVin,
  type EsploraVout
} from "./esplora-rpc.js";

// Blockbook (Trezor) REST v2 client, projected onto the EsploraClient
// interface so the chain adapter can fail over between the two API shapes
// transparently.
//
// Why a second API shape exists at all: public Esplora coverage for
// Litecoin is effectively ONE instance (litecoinspace.org), and history
// shows it goes through rough patches (HTTP 520s). The healthy free
// failovers found in provider research (GetBlock free tier, NOWNodes) all
// speak Blockbook v2, not Esplora — so redundancy for LTC means speaking
// both. Endpoints are ordinary valid-TLS HTTPS, so this leg works from
// Cloudflare Workers too (unlike public Electrum servers, whose self-signed
// certs and custom ports Workers cannot reach).
//
// API-key convention: embed the key as URL userinfo —
//   BLOCKBOOK_URLS_LITECOIN=https://MYKEY@ltcbook.nownodes.io
// The key is stripped from the request URL and sent as the `api-key`
// header (NOWNodes' scheme). GetBlock puts its token in the path
// (https://go.getblock.io/<token>) and needs no userinfo.

interface BlockbookVin {
  readonly txid?: string;
  readonly vout?: number;
  readonly n?: number;
  readonly addresses?: readonly string[];
  readonly isAddress?: boolean;
  readonly value?: string;
}

interface BlockbookVout {
  readonly value?: string;
  readonly n?: number;
  readonly hex?: string;
  readonly addresses?: readonly string[];
  readonly isAddress?: boolean;
}

interface BlockbookTx {
  readonly txid: string;
  readonly vin?: readonly BlockbookVin[];
  readonly vout?: readonly BlockbookVout[];
  readonly blockHash?: string;
  readonly blockHeight?: number; // -1 when unconfirmed
  readonly confirmations?: number;
  readonly blockTime?: number;
  readonly fees?: string; // satoshis, decimal string
}

export interface BlockbookClientConfig {
  // Base URL, optionally with an API key as userinfo (https://KEY@host).
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export function blockbookClient(config: BlockbookClientConfig): EsploraClient {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;

  // Split userinfo-style API key out of the base URL.
  const parsed = new URL(config.baseUrl);
  const apiKey = parsed.username.length > 0 ? decodeURIComponent(parsed.username) : undefined;
  parsed.username = "";
  parsed.password = "";
  const baseUrl = parsed.toString().replace(/\/+$/, "");

  async function getJson<T>(path: string): Promise<T> {
    const url = `${baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        headers: apiKey !== undefined ? { "api-key": apiKey } : {}
      });
      if (res.status === 404) throw new EsploraNotFoundError(path);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // Blockbook reports "tx not found" style errors as 400s with an
        // error message; treat those as not-found so the confirmation
        // sweep retries instead of counting a backend outage.
        if (res.status === 400 && /not found/i.test(body)) {
          throw new EsploraNotFoundError(path);
        }
        throw new EsploraBackendError(baseUrl, res.status, body);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof EsploraNotFoundError) throw err;
      if (err instanceof EsploraBackendError) throw err;
      throw new EsploraBackendError(baseUrl, null, err);
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchAddressTxs(address: string): Promise<readonly EsploraTx[]> {
    const info = await getJson<{ transactions?: readonly BlockbookTx[] }>(
      `/api/v2/address/${encodeURIComponent(address)}?details=txs&pageSize=50`
    );
    return (info.transactions ?? []).map(toEsploraTx);
  }

  return {
    async getAddressTxs(address) {
      // Blockbook's details=txs list mixes confirmed and mempool — same
      // consumers as Esplora's /address/:addr/txs, which also mixes.
      return fetchAddressTxs(address);
    },

    async getAddressMempoolTxs(address) {
      const txs = await fetchAddressTxs(address);
      return txs.filter((t) => !t.status.confirmed);
    },

    async getTx(txid) {
      const tx = await getJson<BlockbookTx>(`/api/v2/tx/${encodeURIComponent(txid)}`);
      return toEsploraTx(tx);
    },

    async getTipHeight() {
      const status = await getJson<{
        blockbook?: { bestHeight?: number };
        backend?: { blocks?: number };
      }>("/api/v2");
      const height = status.blockbook?.bestHeight ?? status.backend?.blocks;
      if (typeof height !== "number" || !Number.isFinite(height)) {
        throw new EsploraBackendError(baseUrl, 200, "blockbook status missing bestHeight");
      }
      return height;
    },

    async broadcastTx(rawHex) {
      const result = await getJson<{ result?: string; error?: { message?: string } }>(
        `/api/v2/sendtx/${rawHex}`
      );
      if (typeof result.result !== "string" || result.result.length === 0) {
        throw new EsploraBackendError(
          baseUrl,
          200,
          result.error?.message ?? "blockbook sendtx returned no txid"
        );
      }
      return result.result;
    },

    async getFeeEstimates() {
      // Blockbook's estimatefee returns coin/kvB as a decimal string; the
      // Esplora shape wants sat/vB keyed by confirmation target. Query the
      // three tiers the fee picker actually uses.
      const targets = [1, 3, 6] as const;
      const results = await Promise.all(
        targets.map((t) =>
          getJson<{ result?: string }>(`/api/v2/estimatefee/${t}`).catch(() => ({ result: undefined }))
        )
      );
      const out: Record<string, number> = {};
      for (let i = 0; i < targets.length; i += 1) {
        const coinPerKvb = Number(results[i]?.result);
        // coin/kvB → sat/vB: × 1e8 / 1000. Floor at 1 like the Esplora path.
        const satPerVb = Number.isFinite(coinPerKvb) && coinPerKvb > 0
          ? Math.max(1, (coinPerKvb * 1e8) / 1000)
          : 1;
        out[String(targets[i])] = satPerVb;
      }
      return out;
    },

    async getAddressBalanceSats(address) {
      try {
        const info = await getJson<{ balance?: string }>(
          `/api/v2/address/${encodeURIComponent(address)}?details=basic`
        );
        return BigInt(info.balance ?? "0");
      } catch (err) {
        if (err instanceof EsploraNotFoundError) return 0n;
        throw err;
      }
    }
  };
}

// Project a Blockbook tx onto the Esplora shape the detection/payout code
// consumes. Values are satoshi decimal strings in Blockbook — Number() is
// safe (UTXO amounts < 2^53).
function toEsploraTx(tx: BlockbookTx): EsploraTx {
  const confirmed = (tx.confirmations ?? 0) > 0 && (tx.blockHeight ?? -1) > 0;
  const vin: EsploraVin[] = (tx.vin ?? []).map((input) => ({
    txid: input.txid ?? "0".repeat(64),
    vout: input.vout ?? 0,
    prevout: {
      scriptpubkey: "",
      ...(input.isAddress !== false && input.addresses?.[0] !== undefined
        ? { scriptpubkey_address: input.addresses[0] }
        : {}),
      value: Number(input.value ?? "0")
    }
  }));
  const vout: EsploraVout[] = (tx.vout ?? []).map((output) => ({
    scriptpubkey: output.hex ?? "",
    ...(output.isAddress !== false && output.addresses?.[0] !== undefined
      ? { scriptpubkey_address: output.addresses[0] }
      : {}),
    value: Number(output.value ?? "0")
  }));
  return {
    txid: tx.txid,
    status: confirmed
      ? {
          confirmed: true,
          block_height: tx.blockHeight!,
          ...(tx.blockHash !== undefined ? { block_hash: tx.blockHash } : {}),
          ...(tx.blockTime !== undefined ? { block_time: tx.blockTime } : {})
        }
      : { confirmed: false },
    vin,
    vout,
    fee: Number(tx.fees ?? "0")
  };
}
