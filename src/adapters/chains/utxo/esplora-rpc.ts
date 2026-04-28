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

  // Broadcast a signed tx (hex). Returns the txid Esplora confirmed accepting
  // (which must equal the locally-computed txid; we cross-check upstream).
  // Throws EsploraBackendError on rejection so the caller can surface the
  // specific node error message — typical failures are "min relay fee not
  // met", "bad-txns-inputs-missingorspent" (UTXO already spent), or
  // "non-mandatory-script-verify-flag" (signature rejected).
  broadcastTx(rawHex: string): Promise<string>;

  // Recommended fee rates per confirmation target. Esplora returns an object
  // keyed by confirmation-target string ("1", "2", "3", ..., "144", "504",
  // "1008"); values are sat/vB. We project to low/medium/high tiers in the
  // chain adapter's quoteFeeTiers.
  getFeeEstimates(): Promise<Readonly<Record<string, number>>>;

  // Address summary: `chain_stats.funded_txo_sum - chain_stats.spent_txo_sum`
  // is the on-chain confirmed balance in satoshis. Mempool stats are kept
  // separately. Returns 0 for never-seen addresses.
  getAddressBalanceSats(address: string): Promise<bigint>;
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
    },

    async broadcastTx(rawHex: string): Promise<string> {
      return withFailover(async (backend) => {
        const url = `${backend.baseUrl.replace(/\/+$/, "")}/tx`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: rawHex,
            signal: controller.signal
          });
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new EsploraBackendError(backend.baseUrl, res.status, body);
          }
          // On success, Esplora returns the bare txid as a string.
          return (await res.text()).trim();
        } catch (err) {
          if (err instanceof EsploraBackendError) throw err;
          throw new EsploraBackendError(backend.baseUrl, null, err);
        } finally {
          clearTimeout(timer);
        }
      });
    },

    async getFeeEstimates(): Promise<Readonly<Record<string, number>>> {
      // Two compatible endpoints across mempool.space / litecoinspace /
      // blockstream.info:
      //   1. `/v1/fees/recommended` — mempool.space's modern API, named-
      //      priority shape. Served by mempool.space + litecoinspace.
      //   2. `/fee-estimates` — the older Esplora-native endpoint, keyed by
      //      block target. Served by all three (blockstream.info only
      //      supports this one).
      // Try the named-priority endpoint first (smaller response, more
      // reliable on mempool.space's CDN), then fall back to the Esplora-
      // native endpoint within the same backend before withFailover moves
      // on to the next backend.
      return withFailover(async (b) => {
        try {
          const recommended = await getJson<{
            fastestFee: number;
            halfHourFee: number;
            hourFee: number;
            economyFee: number;
            minimumFee: number;
          }>(b, "/v1/fees/recommended");
          // Convert to Esplora-compat shape so pickFeeTier (which keys on
          // confirmation-target strings) keeps working unchanged.
          // fastestFee → next-block (1), halfHourFee → 3-block,
          // hourFee → 6-block, economyFee → 144-block, minimumFee →
          // 1008-block. Floor at 1 sat/vB so a stale 0 doesn't break
          // downstream Math.ceil(141 × rate) producing 0 sats.
          const floor1 = (n: number): number => (typeof n === "number" && n > 0 ? n : 1);
          return {
            "1": floor1(recommended.fastestFee),
            "3": floor1(recommended.halfHourFee),
            "6": floor1(recommended.hourFee),
            "144": floor1(recommended.economyFee),
            "1008": floor1(recommended.minimumFee)
          };
        } catch (err) {
          if (err instanceof EsploraNotFoundError) {
            return getJson<Record<string, number>>(b, "/fee-estimates");
          }
          // For non-404 errors (5xx, network), the modern endpoint is
          // probably down on this backend — try the Esplora-native one
          // before letting withFailover move backends.
          return getJson<Record<string, number>>(b, "/fee-estimates");
        }
      });
    },

    async getAddressBalanceSats(address: string): Promise<bigint> {
      return withFailover(async (b) => {
        try {
          const info = await getJson<{
            chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
            mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
          }>(b, `/address/${address}`);
          // Confirmed balance only — mempool funds aren't spendable yet.
          return BigInt(info.chain_stats.funded_txo_sum - info.chain_stats.spent_txo_sum);
        } catch (err) {
          if (err instanceof EsploraNotFoundError) return 0n;
          throw err;
        }
      });
    }
  };
}
