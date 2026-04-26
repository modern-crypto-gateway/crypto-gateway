// Esplora REST client (mempool.space, Blockstream, litecoinspace).
//
// Esplora is the de-facto open-source UTXO indexer; both mempool.space and
// Blockstream serve compatible endpoints with no API key. We round-robin /
// failover across the configured backend list so a single 502 doesn't kill
// detection. Same shape as `tronCompositeClient` in src/adapters/chains/tron.

// Subset of Esplora's tx response. We only project the fields detection +
// confirmation tracking actually consume; ignored keys (`vsize`, `weight`,
// `version`, `locktime`, etc.) stay out of the typed surface so a future
// schema bump that adds keys doesn't break parsing.

export interface EsploraTxStatus {
  // Mempool txs return confirmed=false and no block_* fields. Confirmed txs
  // include the height + hash + time of the inclusion block.
  readonly confirmed: boolean;
  readonly block_height?: number;
  readonly block_hash?: string;
  readonly block_time?: number;
}

export interface EsploraVin {
  // tx that funded this input (the UTXO being spent)
  readonly txid: string;
  readonly vout: number;
  // The previous output's scriptPubkey + value, denormalized into the input
  // by Esplora so consumers don't have to fetch the funding tx separately.
  readonly prevout: {
    readonly scriptpubkey: string;
    readonly scriptpubkey_address?: string;
    readonly value: number;
  } | null;
  // Witness stack (segwit). Hex strings, one per stack item.
  readonly witness?: readonly string[];
  // Sequence number; we don't care for detection.
  readonly sequence?: number;
}

export interface EsploraVout {
  readonly scriptpubkey: string;
  readonly scriptpubkey_address?: string;
  readonly value: number; // satoshis
}

export interface EsploraTx {
  readonly txid: string;
  readonly status: EsploraTxStatus;
  readonly vin: readonly EsploraVin[];
  readonly vout: readonly EsploraVout[];
  // Fee = sum(inputs) - sum(outputs). Esplora computes it for us.
  readonly fee: number; // satoshis
}

export interface EsploraBackend {
  readonly baseUrl: string;
}

// Errors. We surface 4xx (bad request, not found) distinctly from 5xx /
// network failure so the failover logic can treat them differently — there's
// no point retrying a 404 on a different backend.
export class EsploraNotFoundError extends Error {
  constructor(public readonly path: string) {
    super(`esplora: not found ${path}`);
    this.name = "EsploraNotFoundError";
  }
}

export class EsploraBackendError extends Error {
  constructor(
    public readonly backend: string,
    public readonly status: number | null,
    public override readonly cause: unknown
  ) {
    super(`esplora backend ${backend} failed (status=${status ?? "network"}): ${String(cause)}`);
    this.name = "EsploraBackendError";
  }
}

export interface EsploraClient {
  // Recent confirmed txs touching `address`. Esplora returns up to 25 txs
  // per page; we pull just the first page (newest 25) — sufficient for
  // detection runs at our cadence. If a merchant pushes >25 txs to a
  // single address inside one poll window, the older ones will still be
  // picked up by subsequent polls (cursor support is `last_seen_txid`).
  getAddressTxs(address: string): Promise<readonly EsploraTx[]>;

  // Unconfirmed mempool txs touching `address`. Used to surface
  // "incoming, awaiting confirmations" UX before block inclusion.
  getAddressMempoolTxs(address: string): Promise<readonly EsploraTx[]>;

  // Single tx by id. Used by getConfirmationStatus + getConsumedNativeFee.
  // Throws EsploraNotFoundError on 404.
  getTx(txid: string): Promise<EsploraTx>;

  // Current tip height. Used to compute confirmations = tip - block_height + 1.
  getTipHeight(): Promise<number>;
}

export interface EsploraClientConfig {
  readonly backends: readonly EsploraBackend[];
  // Optional: inject fetch (tests). Defaults to globalThis.fetch.
  readonly fetch?: typeof globalThis.fetch;
  // Per-request timeout in ms. Defaults to 10s — mempool.space typically
  // responds in <500ms but a stuck connection shouldn't block the poll loop.
  readonly timeoutMs?: number;
}

export function esploraClient(config: EsploraClientConfig): EsploraClient {
  const backends = config.backends;
  if (backends.length === 0) {
    throw new Error("esploraClient: at least one backend required");
  }
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;

  // Run `op` against each backend in order. Return the first success;
  // collect the failures into a single error if all backends fail. 4xx
  // (NotFound) short-circuits — there's no point asking a different backend
  // for a tx that genuinely doesn't exist.
  async function withFailover<T>(op: (backend: EsploraBackend) => Promise<T>): Promise<T> {
    const errors: EsploraBackendError[] = [];
    for (const backend of backends) {
      try {
        return await op(backend);
      } catch (err) {
        if (err instanceof EsploraNotFoundError) throw err;
        if (err instanceof EsploraBackendError) {
          errors.push(err);
          continue;
        }
        throw err;
      }
    }
    throw new Error(
      `esplora: all ${backends.length} backends failed: ${errors.map((e) => e.message).join("; ")}`
    );
  }

  async function getJson<T>(backend: EsploraBackend, path: string): Promise<T> {
    const url = `${backend.baseUrl.replace(/\/+$/, "")}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (res.status === 404) throw new EsploraNotFoundError(path);
      if (!res.ok) throw new EsploraBackendError(backend.baseUrl, res.status, await res.text().catch(() => ""));
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof EsploraNotFoundError) throw err;
      if (err instanceof EsploraBackendError) throw err;
      throw new EsploraBackendError(backend.baseUrl, null, err);
    } finally {
      clearTimeout(timer);
    }
  }

  async function getText(backend: EsploraBackend, path: string): Promise<string> {
    const url = `${backend.baseUrl.replace(/\/+$/, "")}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (res.status === 404) throw new EsploraNotFoundError(path);
      if (!res.ok) throw new EsploraBackendError(backend.baseUrl, res.status, await res.text().catch(() => ""));
      return await res.text();
    } catch (err) {
      if (err instanceof EsploraNotFoundError) throw err;
      if (err instanceof EsploraBackendError) throw err;
      throw new EsploraBackendError(backend.baseUrl, null, err);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getAddressTxs(address: string): Promise<readonly EsploraTx[]> {
      return withFailover((b) => getJson<EsploraTx[]>(b, `/address/${address}/txs`));
    },

    async getAddressMempoolTxs(address: string): Promise<readonly EsploraTx[]> {
      return withFailover((b) => getJson<EsploraTx[]>(b, `/address/${address}/txs/mempool`));
    },

    async getTx(txid: string): Promise<EsploraTx> {
      return withFailover((b) => getJson<EsploraTx>(b, `/tx/${txid}`));
    },

    async getTipHeight(): Promise<number> {
      return withFailover(async (b) => {
        const text = await getText(b, "/blocks/tip/height");
        const n = Number(text.trim());
        if (!Number.isFinite(n)) {
          throw new EsploraBackendError(b.baseUrl, 200, `non-numeric tip height: ${text}`);
        }
        return n;
      });
    }
  };
}
