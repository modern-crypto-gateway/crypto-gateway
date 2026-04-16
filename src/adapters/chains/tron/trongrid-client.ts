// Legacy public surface. Historical callers imported `TronGridClient` +
// `tronGridClient` from this module; Phase 10 introduced a backend-based
// abstraction (`TronRpcBackend`) in `tron-rpc.ts` so operators can compose
// TronGrid + Alchemy Tron with failover. The types below are kept as
// aliases so downstream call sites and tests import the new names when
// they touch them but nothing existing breaks.

export type {
  TronFetch,
  TronRpcBackend as TronGridClient,
  TronGridBackendConfig as TronGridClientConfig,
  TrongridTrc20Transfer,
  TrongridTxInfo,
  TrongridBlock,
  TrongridTriggerSmartContractResponse,
  TrongridBroadcastResponse,
  TriggerSmartContractParams
} from "./tron-rpc.js";
export { tronGridBackend as tronGridClient } from "./tron-rpc.js";
