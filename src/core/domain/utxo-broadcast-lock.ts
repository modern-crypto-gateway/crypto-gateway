// In-process, per-chain broadcast lock for the UTXO family.
//
// WHY: UTXO coin selection reads the shared `utxos` ledger, but chosen
// inputs are only marked spent (`spent_in_payout_id`) AFTER the network
// accepts the tx (broadcastUtxoMain step c — the mark can't precede the
// broadcast, because a definitive rejection must leave the inputs
// spendable). Two concurrent broadcasts on the same chain therefore
// coin-select from identical spendable sets, pick overlapping inputs, and
// every tx after the first is rejected by the node with
// `txn-mempool-conflict` (observed in production: 7 of 10 parallel LTC
// payouts failed this way). Serializing the select → broadcast → mark-spent
// window per chain removes the race; each waiter re-selects against a
// ledger that already excludes the previous winner's inputs. Cross-chain
// broadcasts stay parallel — their UTXO sets are disjoint.
//
// The lock is PROCESS-LOCAL. That is sufficient under the codebase-wide
// single-writer assumption (one executor instance per deployment) — the
// same assumption the EVM nonce cache documents in evm-chain.adapter.ts.
// Two gateway instances sharing one DB would still race each other; that
// topology is unsupported everywhere in this codebase.

// Tail of the per-chain queue. Tails are error-swallowed (never reject), so
// a failed broadcast can't poison the queue for later holders.
const tails = new Map<number, Promise<unknown>>();

export function withUtxoChainLock<T>(chainId: number, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(chainId) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  tails.set(chainId, tail);
  // Drop the map entry once the queue drains so an idle chain holds no
  // settled promise forever. A newer tail replaces ours before we settle
  // when another broadcast queued behind us — leave that one in place.
  void tail.then(() => {
    if (tails.get(chainId) === tail) tails.delete(chainId);
  });
  return run;
}
