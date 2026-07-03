import type { AppDeps } from "../../core/app-deps.js";
import type { DetectionStrategy } from "../../core/ports/detection.port.js";
import type { ChainId } from "../../core/types/chain.js";
import type { DetectedTransfer } from "../../core/types/transaction.js";
import type { AmountRaw } from "../../core/types/money.js";

// BlockCypher webhook payload → DetectedTransfer projection.
//
// BlockCypher delivers a "TX object" body for `tx-confirmation` /
// `unconfirmed-tx` events. The shape is well-documented:
//
//   {
//     "hash": "...",
//     "block_height": 614625, // -1 if mempool
//     "confirmations": 0..6,
//     "addresses": [...],
//     "inputs": [{"addresses": [...], ...}],
//     "outputs": [{"value": 100000, "addresses": ["bc1q..."], ...}]
//   }
//
// We project each output that pays one of OUR addresses into a
// DetectedTransfer, mirroring what `scanIncoming` does on the poll path.
// The downstream `ingestDetectedTransfer` dedupes by (chainId, txHash, vout)
// regardless of which detection layer surfaced the tx — so a tx caught by
// BOTH the BlockCypher push and the Esplora poll never produces duplicate
// rows.
//
// chainId resolution: the route handler tells us which chain this hook fires
// for (extracted from URL params). We don't trust the payload to declare it.

interface BlockcypherTxOutput {
  readonly value: number;
  readonly addresses?: readonly string[];
  readonly script?: string;
  // BlockCypher includes more fields (script_type, spent_by, etc.); we only
  // need value + addresses for detection.
}

interface BlockcypherTxInput {
  readonly addresses?: readonly string[];
  // BlockCypher's "prev_hash" + "output_index" give us the spent UTXO id;
  // we don't use them here (the gateway tracks its own utxos).
}

interface BlockcypherTxPayload {
  readonly hash: string;
  // -1 when in mempool; positive integer when confirmed.
  readonly block_height: number;
  readonly confirmations: number;
  readonly addresses?: readonly string[];
  readonly inputs?: readonly BlockcypherTxInput[];
  readonly outputs?: readonly BlockcypherTxOutput[];
}

// `chainId` + `nativeSymbol` come from URL routing context (the HTTP
// handler knows which chain the hook was registered for). We don't inspect
// the payload's `coin` field — defense in depth against a misconfigured
// or spoofed callback.

export interface BlockcypherNotifyContext {
  readonly chainId: ChainId;
  readonly nativeSymbol: "BTC" | "LTC";
  // Lowercased addresses we own and want to credit. Caller supplies the set
  // (typically active invoice receive addresses); the adapter filters
  // outputs to only those the caller cares about.
  readonly ourAddresses: ReadonlySet<string>;
}

// Pure function: payload + context → projected transfers. Returns [] when
// no output pays an owned address (BlockCypher fires once per matching
// hook, but a tx can spend FROM one of our addresses without paying TO any
// of them; that's a payout self-detect and lands as 0 transfers here).
export function projectBlockcypherTx(
  payload: BlockcypherTxPayload,
  ctx: BlockcypherNotifyContext,
  seenAt: Date
): DetectedTransfer[] {
  if (!payload.outputs) return [];
  const transfers: DetectedTransfer[] = [];

  // Best-effort sender attribution: first input with a known address.
  // UTXO inputs can come from multiple addresses; we pick one for display.
  const fromAddress =
    (payload.inputs ?? [])
      .flatMap((i) => i.addresses ?? [])
      .filter((a) => a.length > 0)[0] ?? "";

  const blockNumber = payload.block_height >= 0 ? payload.block_height : null;
  const confirmations = Math.max(0, payload.confirmations);

  for (let vout = 0; vout < payload.outputs.length; vout += 1) {
    const out = payload.outputs[vout]!;
    const recipients = out.addresses ?? [];
    for (const addr of recipients) {
      const lc = addr.toLowerCase();
      if (!ctx.ourAddresses.has(lc)) continue;
      transfers.push({
        chainId: ctx.chainId,
        txHash: payload.hash as DetectedTransfer["txHash"],
        logIndex: vout,
        fromAddress: fromAddress as DetectedTransfer["fromAddress"],
        toAddress: lc as DetectedTransfer["toAddress"],
        token: ctx.nativeSymbol as DetectedTransfer["token"],
        amountRaw: out.value.toString() as AmountRaw,
        blockNumber,
        confirmations,
        seenAt,
        // Push payload — no reliable block timestamp on the typed shape. Live
        // detection uses the active-owner matcher (correct), so null is fine.
        onchainTime: null
      });
      // Same address might appear twice in the `addresses` array on legacy
      // multi-sig outputs; we only want one DetectedTransfer per (vout)
      // either way. Break once we matched.
      break;
    }
  }
  return transfers;
}

// DetectionStrategy `handlePush` shape — invoked by the route handler with
// the parsed body + chain context. Owned addresses are loaded fresh per
// call so the latest invoice set is reflected (a subscribe lifetime races
// the invoice's first detection in the worst case; the address is usually
// in our DB by the time this fires).
export function blockcypherNotifyDetection(
  resolveContext: (
    deps: AppDeps,
    chainId: ChainId
  ) => Promise<BlockcypherNotifyContext>
): DetectionStrategy {
  return {
    async handlePush(deps: AppDeps, raw: unknown): Promise<readonly DetectedTransfer[]> {
      const payload = raw as BlockcypherTxPayload & { chainId?: ChainId };
      if (typeof payload.hash !== "string" || !Array.isArray(payload.outputs)) return [];
      // The route handler injects `chainId` after URL routing. Without it
      // we can't know which chain this fires for; bail gracefully.
      if (payload.chainId === undefined) return [];
      const ctx = await resolveContext(deps, payload.chainId);
      return projectBlockcypherTx(payload, ctx, new Date());
    }
  };
}
