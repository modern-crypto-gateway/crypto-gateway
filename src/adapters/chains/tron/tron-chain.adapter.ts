import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { ChainAdapter, FeeTierQuote } from "../../../core/ports/chain.port.ts";
import type { Address, ChainId, TxHash } from "../../../core/types/chain.js";
import type { AmountRaw } from "../../../core/types/money.js";
import type { TokenSymbol } from "../../../core/types/token.js";
import { findToken, TOKEN_REGISTRY } from "../../../core/types/token-registry.js";
import type { DetectedTransfer } from "../../../core/types/transaction.js";
import type { BuildTransferArgs, EstimateArgs, UnsignedTx } from "../../../core/types/unsigned-tx.js";
import { bytesToHex } from "../../crypto/subtle.js";
import {
  decodeTronAddress,
  hexAddressToTron,
  isValidTronAddress,
  privateKeyToTronAddress,
  tronToEvmCoreHex
} from "./tron-address.js";
import {
  tronGridBackend,
  type TronGridBackendConfig,
  type TronRpcBackend
} from "./tron-rpc.js";

// Known Tron chain ids. Values match what Tron's own tooling reports in the
// genesis block timestamp heuristic; we just use them as identifiers.
export const TRON_MAINNET_CHAIN_ID = 728126428;
export const TRON_NILE_CHAIN_ID = 3448148188;

const DEFAULT_FEE_LIMIT_SUN = 100_000_000; // 100 TRX cap per payout tx (generous, rarely consumed)
// Hard energy cap for TRC-20 `transfer(address,uint256)`. Standard SRC-20
// transfers use 14k-65k energy; 150k leaves headroom for cold-slot writes
// and first-time recipient state. If the simulation reports more than this,
// the target is almost certainly NOT a standard TRC-20 (proxy, fee-on-transfer,
// or worse — a loop contract that would burn the full fee_limit). Refusing
// to broadcast turns a silent fee burn into a loud build-time error.
const MAX_EXPECTED_TRANSFER_ENERGY = 150_000;
const DEFAULT_ACCOUNT_INDEX = 0;
const DEFAULT_CHANGE_INDEX = 0;

// TTL for the per-chain latest-block cache used inside getConfirmationStatus.
// One cron tick fans out one info+nowblock query per active confirming tx;
// nowblock is identical for every tx in that tick, so coalesce calls within
// ~10s. Tron block time is ~3s, so this is at most one stale-by-3-blocks read.
const NOW_BLOCK_CACHE_TTL_MS = 10_000;

// Dust threshold for address-poisoning spam on Tron. TRX sun and USDT/USDC
// base units (both 6 decimals on Tron) below this are dropped at scan time.
// Rationale: legitimate payment flows on Tron never send sub-milli-unit
// amounts — wallets don't expose that precision in their UIs. The spam wave
// we observe uses amountRaw="1" (1 sun / 0.000001 TRX) explicitly to defeat
// a naive "> 0" filter. 1000 base units = 0.001 token ≈ $0.0003 at current
// prices, comfortably below the smallest real checkout amount (typically
// $0.01+). Applies uniformly to TRX and all 6-decimal TRC-20 tokens.
const TRON_DUST_THRESHOLD = 1_000n;

export interface TronChainConfig {
  // Which chainIds this adapter serves. Defaults to Tron mainnet only.
  chainIds?: readonly number[];
  // Per-chain TronGrid configuration. Shortcut for the common single-backend
  // case — entries here build a `tronGridBackend` automatically. Ignored for
  // any chainId where `clients` already has an entry (which takes precedence
  // so operators can supply a composite with failover).
  trongrid?: Readonly<Record<number, TronGridBackendConfig>>;
  // Per-chain pre-built RPC clients. Use this (via `tronCompositeClient(...)`)
  // when you want TronGrid + Alchemy Tron failover, or to inject a fake
  // backend in tests and bypass HTTP entirely.
  clients?: Readonly<Record<number, TronRpcBackend>>;
  // BIP44 accountIndex (default 0).
  accountIndex?: number;
  // Cap on the lookback window for `scanIncoming`, ms. Defaults to 30 days
  // so /admin/audit-address (which passes a 30-day sinceMs by default) can
  // actually see its requested window. The cap exists as a runaway guard
  // against "rewind to epoch" calls; 30 days still prevents that while
  // accommodating realistic forensic use. Poll-path callers (rpc-poll) pass
  // a much shorter sinceMs via the cached checkpoint, so this cap only ever
  // matters for the audit path.
  maxScanWindowMs?: number;
  // Fee limit in sun for payout txs. Defaults to 100 TRX.
  feeLimitSun?: number;
}

export function tronChainAdapter(config: TronChainConfig = {}): ChainAdapter {
  const chainIds = (config.chainIds ?? [TRON_MAINNET_CHAIN_ID]) as readonly ChainId[];
  const accountIndex = config.accountIndex ?? DEFAULT_ACCOUNT_INDEX;
  const feeLimit = config.feeLimitSun ?? DEFAULT_FEE_LIMIT_SUN;
  const maxScanWindowMs = config.maxScanWindowMs ?? 30 * 24 * 60 * 60 * 1000;

  const clientCache = new Map<number, TronRpcBackend>();
  function getClient(chainId: number): TronRpcBackend {
    const cached = clientCache.get(chainId);
    if (cached) return cached;
    const injected = config.clients?.[chainId];
    if (injected) {
      clientCache.set(chainId, injected);
      return injected;
    }
    const cfg = config.trongrid?.[chainId];
    if (!cfg) {
      throw new Error(`tronChainAdapter: no Tron RPC configuration for chainId ${chainId}`);
    }
    const client = tronGridBackend(cfg);
    clientCache.set(chainId, client);
    return client;
  }

  const nowBlockCache = new Map<number, { value: number; fetchedAt: number }>();
  async function getCachedNowBlock(chainId: number, client: TronRpcBackend): Promise<number> {
    const now = Date.now();
    const entry = nowBlockCache.get(chainId);
    if (entry && now - entry.fetchedAt < NOW_BLOCK_CACHE_TTL_MS) return entry.value;
    const block = await client.getNowBlock();
    const number = block.block_header.raw_data.number;
    nowBlockCache.set(chainId, { value: number, fetchedAt: now });
    return number;
  }

  return {
    family: "tron",
    supportedChainIds: chainIds,

    // ---- Addresses ----

    deriveAddress(seed: string, index: number) {
      // BIP44 path for Tron = m/44'/195'/{account}'/{change}/{index}. Coin type 195.
      const seedBytes = mnemonicToSeedSync(seed);
      const master = HDKey.fromMasterSeed(seedBytes);
      const child = master.derive(`m/44'/195'/${accountIndex}'/${DEFAULT_CHANGE_INDEX}/${index}`);
      if (!child.privateKey) {
        throw new Error(`Tron derivation produced no private key at index ${index}`);
      }
      const privateKeyHex = `0x${bytesToHex(child.privateKey)}`;
      const address = privateKeyToTronAddress(privateKeyHex) as Address;
      return { address, privateKey: privateKeyHex };
    },

    validateAddress(addr: string): boolean {
      return isValidTronAddress(addr);
    },

    canonicalizeAddress(addr: string): Address {
      // Base58 is already case-sensitive and canonical — decoding validates
      // the checksum, and re-encoding is the identity for valid inputs.
      // We reject hex-form addresses here; callers should have base58 in hand.
      if (!isValidTronAddress(addr)) {
        throw new Error(`Invalid Tron address: ${addr}`);
      }
      return addr as Address;
    },

    // ---- Detection ----

    async scanIncoming({ chainId, addresses, tokens, sinceMs }) {
      if (addresses.length === 0) return [];
      const client = getClient(chainId);

      // Clamp sinceMs to within the max window — protects against "rewind to epoch"
      // style calls returning a mountain of data.
      const now = Date.now();
      const minTimestamp = Math.max(sinceMs, now - maxScanWindowMs);

      // Resolve requested token symbols against the registry, then split into
      // TRC-20 (contractAddress !== null) and native TRX (contractAddress === null).
      // Each takes a different TronGrid endpoint so we fan out separately.
      const targets = tokens
        .map((sym) => findToken(chainId as ChainId, sym))
        .filter((t): t is NonNullable<typeof t> => t !== null);
      const trc20Targets = targets.filter((t) => t.contractAddress !== null);
      const wantsNative = targets.some((t) => t.contractAddress === null);

      const allowedContracts = new Set(trc20Targets.map((t) => t.contractAddress!));
      const addressSet = new Set(addresses.map((a) => a));
      const symbolByContract = new Map(trc20Targets.map((t) => [t.contractAddress!, t.symbol]));

      // Fan out: one listTrc20Transfers call per (address x contract). TronGrid
      // doesn't offer a multi-contract filter, so this is the natural shape.
      const calls: Array<Promise<readonly DetectedTransfer[]>> = [];
      for (const addr of addresses) {
        for (const target of trc20Targets) {
          calls.push(
            client
              .listTrc20Transfers(addr, {
                minTimestamp,
                contractAddress: target.contractAddress!,
                limit: 200
              })
              .then((transfers) =>
                transfers
                  .filter((t) => t.token_info?.address !== undefined && allowedContracts.has(t.token_info.address))
                  .filter((t) => addressSet.has(t.to))
                  // Drop dust TRC-20 address-poisoning spam. Common on Tron:
                  // attackers blast 0- or 1-unit USDT/USDC transfers (1 unit
                  // = 0.000001 stablecoin) to pollute wallet tx histories.
                  // A naive "> 0" filter is defeated by amount=1; threshold
                  // at 0.001 token (TRON_DUST_THRESHOLD) blocks the pattern
                  // without touching any plausible payment amount.
                  .filter((t) => {
                    try { return BigInt(t.value) >= TRON_DUST_THRESHOLD; }
                    catch { return false; }
                  })
                  .map<DetectedTransfer>((t) => ({
                    chainId: chainId as ChainId,
                    txHash: t.transaction_id,
                    logIndex: null, // Tron TRC-20 transfers are 1 per tx in the v1 endpoint; no logIndex concept
                    fromAddress: t.from,
                    toAddress: t.to,
                    token: symbolByContract.get(t.token_info.address) ?? target.symbol,
                    amountRaw: t.value as AmountRaw,
                    // TronGrid's /trc20 endpoint returns `block` undefined for
                    // unconfirmed txs (it has no `only_confirmed` filter — that's
                    // only on /transactions). Coerce to null so DetectedTransfer's
                    // Zod schema (blockNumber: nullable number) accepts it; the
                    // sweeper's getConfirmationStatus will fill in the real block
                    // once the tx confirms. Without this, a single in-flight TRC-20
                    // tx fails Zod and aborts the entire scan batch.
                    blockNumber: t.block ?? null,
                    // `v1/.../transactions/trc20` doesn't expose a confirmation count directly.
                    // We record what we can see and let the sweeper call `getConfirmationStatus`
                    // for authoritative depth on each tx.
                    confirmations: 0,
                    seenAt: new Date(t.block_timestamp)
                  }))
              )
          );
        }
      }

      // Native TRX path: `/v1/accounts/{addr}/transactions` already returns
      // one row per native TransferContract crediting `addr` (the backend
      // does the filtering). TronGrid emits hex 41-prefix addresses; convert
      // back to base58check so they match invoice receive addresses.
      if (wantsNative) {
        for (const addr of addresses) {
          calls.push(
            client.listTrxTransfers(addr, { minTimestamp, limit: 200 }).then((transfers) =>
              transfers.flatMap<DetectedTransfer>((t) => {
                let toCanonical: string;
                let fromCanonical: string;
                try {
                  toCanonical = hexAddressToTron(t.to);
                  fromCanonical = hexAddressToTron(t.from);
                } catch {
                  return [];
                }
                if (!addressSet.has(toCanonical as Address)) return [];
                // Drop dust native TRX address-poisoning spam. The active
                // spam pattern sends amountRaw="1" (1 sun) specifically to
                // slip past a naive "> 0" filter. TRON_DUST_THRESHOLD pins
                // the floor at 0.001 TRX — well below the smallest real
                // checkout amount, well above the spam traffic.
                let amount: bigint;
                try { amount = BigInt(t.value); } catch { return []; }
                if (amount < TRON_DUST_THRESHOLD) return [];
                return [
                  {
                    chainId: chainId as ChainId,
                    txHash: t.txID,
                    logIndex: null,
                    fromAddress: fromCanonical,
                    toAddress: toCanonical,
                    token: "TRX" as TokenSymbol,
                    amountRaw: t.value as AmountRaw,
                    // Parallel to the TRC-20 branch: TronGrid's tx listing can
                    // return undefined blockNumber for unconfirmed txs. Coerce
                    // to null so Zod accepts it; sweeper fills later.
                    blockNumber: t.blockNumber ?? null,
                    confirmations: 0,
                    seenAt: new Date(t.blockTimestamp)
                  }
                ];
              })
            )
          );
        }
      }

      const arrays = await Promise.all(calls);
      return arrays.flat();
    },

    async getConfirmationStatus(chainId: ChainId, txHash: TxHash) {
      const client = getClient(chainId);
      const [info, latest] = await Promise.all([
        client.getTransactionInfo(txHash),
        getCachedNowBlock(chainId, client)
      ]);
      if (!info || info.blockNumber === undefined) {
        return { blockNumber: null, confirmations: 0, reverted: false };
      }
      const receiptResult = info.receipt?.result;
      // Tron's receipt.result is undefined for a typical successful transfer
      // (it's only populated when the VM executed a contract that returned a
      // status). So treat undefined as "not reverted".
      const reverted = receiptResult !== undefined && receiptResult !== "SUCCESS";
      return {
        blockNumber: info.blockNumber,
        confirmations: Math.max(0, latest - info.blockNumber + 1),
        reverted
      };
    },

    // ---- Payouts ----

    async buildTransfer(args: BuildTransferArgs): Promise<UnsignedTx> {
      const token = findToken(args.chainId as ChainId, args.token);
      if (!token) {
        throw new Error(`Tron buildTransfer: unknown token ${args.token} on chain ${args.chainId}`);
      }
      const client = getClient(args.chainId);

      if (token.contractAddress === null) {
        // Native TRX — /wallet/createtransaction builds the unsigned tx directly.
        // Amount is in sun; we pass the raw value as a number because TronGrid's
        // JSON rejects strings here. BigInt -> Number is safe up to 9e15 sun
        // (9 billion TRX), which is ~100x the total supply, so no overflow risk
        // for any realistic payout.
        const amountSun = Number(args.amountRaw);
        if (!Number.isFinite(amountSun) || amountSun <= 0) {
          throw new Error(`Tron buildTransfer: invalid TRX amount ${args.amountRaw}`);
        }
        const tx = await client.createTransaction({
          owner_address: base58ToHex(args.fromAddress),
          to_address: base58ToHex(args.toAddress),
          amount: amountSun
        });
        if (tx.Error !== undefined) {
          throw new Error(`Tron createtransaction failed: ${tx.Error}`);
        }
        return {
          chainId: args.chainId as ChainId,
          raw: {
            txID: tx.txID,
            raw_data_hex: tx.raw_data_hex,
            raw_data: tx.raw_data,
            fromAddress: args.fromAddress
          },
          summary: `TRON: native TRX transfer ${args.amountRaw} sun to ${args.toAddress}`
        };
      }

      // ABI-encoded parameter for `transfer(address,uint256)`:
      //   - 32 bytes: zero-padded core address (Tron addresses in calldata are
      //     the 20-byte EVM-equivalent, NOT the 21-byte prefixed form).
      //   - 32 bytes: amount (big-endian uint256)
      const toCoreHex = tronToEvmCoreHex(args.toAddress).slice(2).padStart(64, "0");
      const amountHex = BigInt(args.amountRaw).toString(16).padStart(64, "0");
      const parameter = `${toCoreHex}${amountHex}`;

      const resp = await client.triggerSmartContract({
        owner_address: base58ToHex(args.fromAddress),
        contract_address: base58ToHex(token.contractAddress),
        function_selector: "transfer(address,uint256)",
        parameter,
        fee_limit: feeLimit,
        call_value: 0
      });

      if (resp.result.result !== true) {
        throw new Error(`Tron triggersmartcontract failed: ${resp.result.message ?? "unknown"}`);
      }

      // Energy-consumption guard. The fee_limit is a CEILING, not a quote —
      // without this check, a non-standard transfer() implementation (proxy
      // that loops, fee-on-transfer, malicious contract) could silently burn
      // the full 100 TRX on each payout. Bail loudly at build time instead.
      if (resp.energy_used !== undefined && resp.energy_used > MAX_EXPECTED_TRANSFER_ENERGY) {
        throw new Error(
          `Tron transfer simulation reported ${resp.energy_used} energy (cap=${MAX_EXPECTED_TRANSFER_ENERGY}); ` +
            `refusing to broadcast. Token ${args.token} on chain ${args.chainId} may not be a standard TRC-20.`
        );
      }

      return {
        chainId: args.chainId as ChainId,
        raw: {
          txID: resp.transaction.txID,
          raw_data_hex: resp.transaction.raw_data_hex,
          raw_data: resp.transaction.raw_data,
          fromAddress: args.fromAddress
        },
        summary: `TRON: TRC-20 ${args.token} transfer ${args.amountRaw} to ${args.toAddress}`
      };
    },

    async signAndBroadcast(unsignedTx: UnsignedTx, privateKey: string): Promise<TxHash> {
      const raw = unsignedTx.raw as { txID: string; raw_data_hex: string; raw_data: unknown };
      // Tron signs the sha256 of the raw_data bytes with secp256k1 (canonical
      // `recoveryBit` appended). The txID is already sha256(raw_data_hex) per
      // TronGrid, so we sign that directly.
      const privBytes = hexToBytesLocal(privateKey);
      const txIdBytes = hexToBytesLocal(raw.txID);
      // Noble returns `r || s || recovery` (65 bytes) when format='recovered'.
      // `prehash: false` tells it the message is already a 32-byte digest (Tron's
      // txID IS sha256 of raw_data_hex, so re-hashing would corrupt the signature).
      const sig = secp256k1.sign(txIdBytes, privBytes, { format: "recovered", prehash: false, lowS: true });
      const signatureHex = bytesToHex(sig);

      const client = getClient(unsignedTx.chainId);
      const resp = await client.broadcastTransaction({
        txID: raw.txID,
        raw_data: raw.raw_data,
        raw_data_hex: raw.raw_data_hex,
        signature: [signatureHex]
      });
      if (resp.result !== true) {
        throw new Error(`Tron broadcast failed: ${resp.message ?? resp.code ?? "unknown"}`);
      }
      return (resp.txid ?? raw.txID) as TxHash;
    },

    // ---- Fees ----

    nativeSymbol(_chainId: ChainId): TokenSymbol {
      return "TRX" as TokenSymbol;
    },

    async getBalance(args): Promise<AmountRaw> {
      const client = getClient(args.chainId);
      // Native gas (TRX) isn't in TOKEN_REGISTRY (only USDC/USDT for Tron),
      // so route around findToken when fee-wallet checks ask for "TRX".
      if (args.token === "TRX") {
        const acct = await client.getAccount(args.address);
        return acct.balanceSun as AmountRaw;
      }
      const token = findToken(args.chainId as ChainId, args.token);
      if (!token) {
        throw new Error(`Tron getBalance: unknown token ${args.token} on chain ${args.chainId}`);
      }
      if (token.contractAddress === null) {
        // Non-TRX native case — only applies if a future registry entry
        // adds another native asset on a Tron-family chain. Fall back to
        // getAccount's sun balance for correctness.
        const acct = await client.getAccount(args.address);
        return acct.balanceSun as AmountRaw;
      }
      // TRC-20: read balanceOf(address) directly. Reading from
      // getAccount().trc20 would be wrong on both backends — Alchemy's
      // /wallet/getaccount returns no TRC-20 data at all, and TronGrid's
      // /v1/accounts trc20 list is a lagging secondary index.
      return (await readTrc20Balance(client, args.address, token.contractAddress)).toString() as AmountRaw;
    },

    async getAccountBalances(args): Promise<readonly { token: TokenSymbol; amountRaw: AmountRaw }[]> {
      const client = getClient(args.chainId);
      const chainId = args.chainId as ChainId;
      const tokensOnChain = TOKEN_REGISTRY.filter((t) => t.chainId === chainId);

      // Native TRX comes from /wallet/getaccount — that field is authoritative
      // (pulled straight from the node state, not a secondary index). TRC-20
      // balances are NOT reliable from that endpoint: TronGrid's /v1/accounts
      // trc20 list is a lagging index, and Alchemy's /wallet/getaccount
      // returns no TRC-20 data at all. For those we call balanceOf directly
      // via triggerConstantContract — same path wallets use, consistent with
      // what holders see on Tronscan. 1 call for TRX + 1 per registered
      // TRC-20 token; for the current registry that's 3 calls per address
      // on Tron mainnet (TRX + USDT + USDC).
      const acct = await client.getAccount(args.address);
      const out: { token: TokenSymbol; amountRaw: AmountRaw }[] = [];

      // Native TRX first, whether or not it's in the registry.
      out.push({ token: "TRX" as TokenSymbol, amountRaw: acct.balanceSun as AmountRaw });

      for (const t of tokensOnChain) {
        if (t.contractAddress === null) continue; // TRX handled above
        const amount = await readTrc20Balance(client, args.address, t.contractAddress);
        out.push({ token: t.symbol, amountRaw: amount.toString() as AmountRaw });
      }
      return out;
    },

    async estimateGasForTransfer(args: EstimateArgs): Promise<AmountRaw> {
      // TronGrid's triggersmartcontract returns `energy_used` for the simulated
      // call. We invoke a dry-run build and read that field. For a simple TRC-20
      // `transfer`, energy is roughly 14k-65k depending on cold/warm slots.
      const token = findToken(args.chainId as ChainId, args.token);
      if (!token || token.contractAddress === null) {
        return "0" as AmountRaw;
      }
      const client = getClient(args.chainId);
      const toCoreHex = tronToEvmCoreHex(args.toAddress).slice(2).padStart(64, "0");
      const amountHex = BigInt(args.amountRaw).toString(16).padStart(64, "0");
      const resp = await client.triggerSmartContract({
        owner_address: base58ToHex(args.fromAddress),
        contract_address: base58ToHex(token.contractAddress),
        function_selector: "transfer(address,uint256)",
        parameter: `${toCoreHex}${amountHex}`,
        fee_limit: feeLimit,
        call_value: 0
      });
      // Revert detection — TronGrid returns HTTP 200 even when the simulated
      // call reverts (insufficient balance, frozen/blacklisted account,
      // destination-contract reject). On revert `result.result` is false and
      // `result.message` carries the reason bytes; `energy_used` may be 0 or
      // partial. Without this check, a pre-flight `estimate` would quote $0
      // fees for a doomed tx — parity with `buildTransfer` at line 349-360
      // where the same check already exists.
      if (resp.result.result !== true) {
        const message = resp.result.message ?? "unknown";
        throw new Error(`Tron simulation failed: ${message}`);
      }
      const energy = resp.energy_used ?? 0;
      return energy.toString() as AmountRaw;
    },

    async quoteFeeTiers(args: EstimateArgs): Promise<FeeTierQuote> {
      // Tron has no concept of priority tiers — TRX txs either fit under the
      // account's staked bandwidth/energy allowance or burn SUN at a fixed
      // rate. We quote the burn-all-SUN worst case so the estimate never
      // undersells what the operator will pay if the account's stake is
      // insufficient. Energy burn rate is ~420 SUN/unit; bandwidth burn is
      // ~1000 SUN/byte — both are network parameters that rarely change.
      // Returning `fee_limit` (the max the operator will spend) as the
      // conservative upper bound keeps the estimate honest.
      const energy = BigInt(await this.estimateGasForTransfer(args));
      // 420 SUN per energy unit is the post-Stake 2.0 burn rate.
      const ENERGY_BURN_SUN = 420n;
      // Bandwidth for a TRC-20 transfer is ~345 bytes × 1000 SUN/byte.
      const BANDWIDTH_SUN = 345n * 1000n;
      const totalSun = (energy * ENERGY_BURN_SUN + BANDWIDTH_SUN).toString() as AmountRaw;
      return {
        low: { tier: "low", nativeAmountRaw: totalSun },
        medium: { tier: "medium", nativeAmountRaw: totalSun },
        high: { tier: "high", nativeAmountRaw: totalSun },
        tieringSupported: false,
        nativeSymbol: this.nativeSymbol(args.chainId as ChainId)
      };
    }
  };
}

// ---- Local helpers ----

// Read a TRC-20 balance via `balanceOf(address)` on the token contract. Used
// in place of reading getAccount().trc20[contract] because that secondary
// index is either lagging (TronGrid) or not populated at all (Alchemy's
// /wallet/getaccount returns only native TRX). A transient RPC failure, an
// empty/short hex result, or an unparseable value collapses to 0n — the
// snapshot-level error bookkeeping is the right place to surface per-address
// failures, not per-token-on-a-good-address failures.
async function readTrc20Balance(
  client: TronRpcBackend,
  ownerBase58: string,
  contractBase58: string
): Promise<bigint> {
  try {
    const resp = await client.triggerConstantContract({
      owner_address: base58ToHex(ownerBase58),
      contract_address: base58ToHex(contractBase58),
      function_selector: "balanceOf(address)",
      parameter: tronToEvmCoreHex(ownerBase58).slice(2).padStart(64, "0")
    });
    const hex = resp.constant_result?.[0];
    if (hex === undefined || hex.length === 0) return 0n;
    try {
      return BigInt(`0x${hex}`);
    } catch {
      return 0n;
    }
  } catch {
    return 0n;
  }
}

function base58ToHex(base58Address: string): string {
  const bytes = decodeTronAddress(base58Address);
  return bytesToHex(bytes);
}

function hexToBytesLocal(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

