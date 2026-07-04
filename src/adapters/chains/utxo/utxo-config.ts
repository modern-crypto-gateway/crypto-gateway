import type { ChainId } from "../../../core/types/chain.js";

// Per-chain UTXO configuration. The chain adapter is parameterized by these
// constants — single ChainAdapter implementation, two registered chains.
//
// `coinType` is the BIP44 coin_type (slip-0044). `bech32Hrp` is the
// human-readable prefix on segwit addresses. `nativeSymbol` matches the
// token-registry entry. `defaultEsploraUrls` are the public Esplora
// endpoints we'll round-robin / failover across in detection.
export interface UtxoChainConfig {
  readonly chainId: ChainId;
  readonly slug: "bitcoin" | "litecoin" | "bitcoin-testnet" | "litecoin-testnet";
  // BIP44 coin_type per slip-0044. Mainnet uses 0 (BTC) / 2 (LTC); testnets
  // share coin_type 1 ("All test-nets"), so a single MASTER_SEED produces
  // the same testnet addresses across BTC testnet3 and LTC testnet (they
  // can't collide on-chain because chains are independent).
  readonly coinType: number;
  readonly bech32Hrp: string;
  readonly nativeSymbol: "BTC" | "LTC";
  readonly defaultEsploraUrls: readonly string[];
  // mempool.space-style WebSocket endpoint for push detection
  // (`track-addresses` + `want blocks`). Served by mempool.space (BTC) and
  // litecoinspace.org (LTC — the Litecoin Foundation's mempool fork).
  // blockstream.info does NOT serve this API, so the WS URL is a separate
  // field rather than derived from `defaultEsploraUrls`.
  readonly defaultMempoolWsUrl: string;
  // Server-enforced cap on addresses per `track-addresses` subscription on
  // the public instance (probed live 2026-07: mempool.space = 10,
  // litecoinspace.org = 100). The watcher shards addresses across
  // connections in groups of this size.
  readonly wsMaxTrackedAddressesPerConnection: number;
  // When true, this chain is a testnet — used by callers that want to
  // suppress side-effects (alerting) for non-production chains.
  readonly testnet: boolean;
}

export const BITCOIN_CONFIG: UtxoChainConfig = {
  chainId: 800 as ChainId,
  slug: "bitcoin",
  coinType: 0,
  bech32Hrp: "bc",
  nativeSymbol: "BTC",
  defaultEsploraUrls: [
    "https://mempool.space/api",
    "https://blockstream.info/api"
  ],
  defaultMempoolWsUrl: "wss://mempool.space/api/v1/ws",
  wsMaxTrackedAddressesPerConnection: 10,
  testnet: false
};

export const LITECOIN_CONFIG: UtxoChainConfig = {
  chainId: 801 as ChainId,
  slug: "litecoin",
  coinType: 2,
  bech32Hrp: "ltc",
  nativeSymbol: "LTC",
  defaultEsploraUrls: [
    "https://litecoinspace.org/api"
  ],
  defaultMempoolWsUrl: "wss://litecoinspace.org/api/v1/ws",
  wsMaxTrackedAddressesPerConnection: 100,
  testnet: false
};

// Bitcoin testnet3 (chainId 802). HRP "tb" per BIP173. coin_type 1 per
// slip-0044 ("All test-nets share coin_type 1"). Esplora endpoints:
// mempool.space/testnet and blockstream.info/testnet.
export const BITCOIN_TESTNET_CONFIG: UtxoChainConfig = {
  chainId: 802 as ChainId,
  slug: "bitcoin-testnet",
  coinType: 1,
  bech32Hrp: "tb",
  nativeSymbol: "BTC",
  defaultEsploraUrls: [
    "https://mempool.space/testnet/api",
    "https://blockstream.info/testnet/api"
  ],
  defaultMempoolWsUrl: "wss://mempool.space/testnet/api/v1/ws",
  wsMaxTrackedAddressesPerConnection: 10,
  testnet: true
};

// Litecoin testnet (chainId 803). HRP "tltc" per the litecoin-project
// BIP173 reference. coin_type 1 (shared testnet). litecoinspace.org hosts a
// live Litecoin testnet4 instance under /testnet (REST + WebSocket) —
// verified 2026-07.
export const LITECOIN_TESTNET_CONFIG: UtxoChainConfig = {
  chainId: 803 as ChainId,
  slug: "litecoin-testnet",
  coinType: 1,
  bech32Hrp: "tltc",
  nativeSymbol: "LTC",
  defaultEsploraUrls: [
    "https://litecoinspace.org/testnet/api"
  ],
  defaultMempoolWsUrl: "wss://litecoinspace.org/testnet/api/v1/ws",
  wsMaxTrackedAddressesPerConnection: 100,
  testnet: true
};

export function utxoConfigForChainId(chainId: number): UtxoChainConfig | null {
  switch (chainId) {
    case BITCOIN_CONFIG.chainId: return BITCOIN_CONFIG;
    case LITECOIN_CONFIG.chainId: return LITECOIN_CONFIG;
    case BITCOIN_TESTNET_CONFIG.chainId: return BITCOIN_TESTNET_CONFIG;
    case LITECOIN_TESTNET_CONFIG.chainId: return LITECOIN_TESTNET_CONFIG;
    default: return null;
  }
}
