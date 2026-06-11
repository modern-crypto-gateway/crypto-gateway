// Energy-rental provider port (Tron resource markets).
//
// Tron lets a third party delegate staked energy to any address for a fee
// that undercuts the chain's burn rate (energy × getEnergyFee SUN). Markets
// like TronSave / Feee.io / iTRX sell that delegation through an HTTP API.
// This port abstracts one such market so the Tron chain adapter can rent
// energy right before a TRC-20 broadcast instead of burning TRX.
//
// The port lives under adapters/ (not core/ports) deliberately: the domain
// layer never sees it. Only the Tron chain adapter consumes a provider, via
// `TronChainConfig.energyRental` — core stays free of Tron-market concepts.
//
// Contract notes for implementers:
//   - All amounts are SUN (1 TRX = 1_000_000 SUN) or raw energy units.
//   - `receiver` is the address that gets the delegation (OUR source pool
//     address) — never the payout's destination.
//   - Methods THROW on transport / API errors. The caller (Tron adapter)
//     treats any throw as "rental unavailable" and falls back to burning,
//     so a flaky provider can never block a payout.
//   - `createEnergyOrder` MUST be all-or-nothing: either the full amount is
//     matched (order created) or the call throws. Partially-filled orders
//     would leave the broadcast undersized and burn TRX for the gap.

export interface EnergyRentalEstimate {
  // SUN per energy unit the market would currently fill at.
  readonly unitPriceSun: number;
  // Total cost in SUN for the requested amount + duration.
  readonly totalCostSun: bigint;
  // Energy units available on the market right now. When below the
  // requested amount, an all-or-nothing order would be rejected — callers
  // should skip rental instead of trying.
  readonly availableEnergy: number;
}

export interface EnergyRentalOrderStatus {
  // 0..100. 100 = the delegation tx(s) are broadcast and the energy is
  // (or is about to be) usable by the receiver.
  readonly fulfilledPercent: number;
  // Actual SUN debited from the provider account for this order, when the
  // provider reports it. Null until known — callers fall back to the
  // estimate for bookkeeping.
  readonly paidSun: bigint | null;
}

export interface EnergyRentalProvider {
  // Stable identifier for logs + payout audit columns ("tronsave", ...).
  readonly name: string;

  estimateEnergyOrder(args: {
    readonly receiver: string;
    readonly energyAmount: number;
    readonly durationSec: number;
  }): Promise<EnergyRentalEstimate>;

  createEnergyOrder(args: {
    readonly receiver: string;
    readonly energyAmount: number;
    readonly durationSec: number;
    // Hard ceiling in SUN per energy unit. The provider must reject the
    // order rather than fill above this — it's the caller's mathematical
    // guarantee that renting never costs more than burning.
    readonly maxUnitPriceSun: number;
  }): Promise<{ readonly orderId: string }>;

  getOrderStatus(orderId: string): Promise<EnergyRentalOrderStatus>;

  // OPTIONAL — cancel a not-yet-filled order, refunding the committed
  // payment (possibly minus a provider cancellation fee). Implemented by
  // providers whose orders can sit unfilled in an order book (TEM); the
  // caller uses it on fill-timeout to convert "money committed, no energy"
  // into a clean burn-path fallback instead of deferring the payout.
  // Resolves true when the cancellation was accepted. MUST NOT cancel a
  // filled order (providers reject this server-side).
  cancelOrder?(orderId: string): Promise<boolean>;

  // Prepaid SUN balance held at the provider. Surfaced for admin/ops
  // visibility (low-balance alerts) — not consulted on the payout hot path.
  getAccountBalanceSun(): Promise<bigint>;
}
