import { describe, expect, it } from "vitest";
import {
  tronChainAdapter,
  TRON_MAINNET_CHAIN_ID,
  type TronEnergyRentalConfig
} from "../../../../adapters/chains/tron/tron-chain.adapter.js";
import type {
  TriggerConstantContractParams,
  TronAccountResources,
  TronRpcBackend
} from "../../../../adapters/chains/tron/tron-rpc.js";
import type {
  EnergyRentalEstimate,
  EnergyRentalOrderStatus,
  EnergyRentalProvider
} from "../../../../adapters/energy-rental/energy-rental.port.js";

const SOURCE = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
const DEST = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";

// Sizing math under test (see RENTAL_ENERGY_* in the adapter):
//   warm receiver: max(sim=4k, 65_000) × 1.02 = 66_300 required energy
//   cold receiver: max(sim=4k, 131_000) × 1.02 = 133_620
//   burn cost at getEnergyFee=100: 66_300 × 100 = 6_630_000 SUN
const WARM_REQUIRED = 66_300;
const COLD_REQUIRED = 133_620;
const WARM_BURN_SUN = 6_630_000n;

function fakeClient(overrides: Partial<TronRpcBackend>): TronRpcBackend {
  const reject = (method: string) => async () => {
    throw new Error(`unexpected ${method} call`);
  };
  return {
    name: "fake",
    supportsDetection: true,
    listTrc20Transfers: reject("listTrc20Transfers"),
    listTrxTransfers: reject("listTrxTransfers"),
    getTransactionInfo: reject("getTransactionInfo"),
    getNowBlock: reject("getNowBlock"),
    triggerSmartContract: reject("triggerSmartContract"),
    triggerConstantContract: reject("triggerConstantContract"),
    getChainParameters: async () => ({ params: { getEnergyFee: 100 } }),
    getAccountResources: reject("getAccountResources"),
    freezeBalanceV2: reject("freezeBalanceV2"),
    unfreezeBalanceV2: reject("unfreezeBalanceV2"),
    delegateResource: reject("delegateResource"),
    undelegateResource: reject("undelegateResource"),
    createTransaction: reject("createTransaction"),
    broadcastTransaction: reject("broadcastTransaction"),
    getAccount: reject("getAccount"),
    ...overrides
  };
}

// Routes the two triggerConstantContract uses by selector: the transfer
// simulation and the receiver's balanceOf read.
function constantContract(opts: {
  simEnergy?: number;
  receiverHoldsToken?: boolean;
  simReverts?: boolean;
}) {
  return async (params: TriggerConstantContractParams) => {
    if (params.function_selector === "transfer(address,uint256)") {
      if (opts.simReverts === true) {
        return { result: { result: false, message: "REVERT opcode executed" } };
      }
      return { result: { result: true }, energy_used: opts.simEnergy ?? 4_000 };
    }
    if (params.function_selector === "balanceOf(address)") {
      const balance = opts.receiverHoldsToken === false ? 0n : 5_000_000n;
      return { result: { result: true }, constant_result: [balance.toString(16).padStart(64, "0")] };
    }
    throw new Error(`unexpected selector ${params.function_selector}`);
  };
}

// getAccountResources stub returning queued energyAvailable values; the last
// value repeats (sizing read first, then verify-loop reads).
function resourcesQueue(energyValues: readonly number[]): () => Promise<TronAccountResources> {
  let i = 0;
  return async () => {
    const energy = energyValues[Math.min(i, energyValues.length - 1)]!;
    i += 1;
    return { energyAvailable: energy, energyLimit: energy, bandwidthAvailable: 600, bandwidthLimit: 600 };
  };
}

function scriptedProvider(
  script: {
    estimate?: () => Promise<EnergyRentalEstimate>;
    create?: () => Promise<{ orderId: string }>;
    status?: () => Promise<EnergyRentalOrderStatus>;
    cancel?: () => Promise<boolean>;
  },
  name = "fake-market"
) {
  const calls = {
    estimate: [] as Array<{ receiver: string; energyAmount: number; durationSec: number }>,
    create: [] as Array<{ receiver: string; energyAmount: number; durationSec: number; maxUnitPriceSun: number }>,
    status: 0,
    cancel: 0
  };
  const provider: EnergyRentalProvider = {
    name,
    async estimateEnergyOrder(args) {
      calls.estimate.push(args);
      if (!script.estimate) throw new Error("unexpected estimateEnergyOrder call");
      return script.estimate();
    },
    async createEnergyOrder(args) {
      calls.create.push(args);
      if (!script.create) throw new Error("unexpected createEnergyOrder call");
      return script.create();
    },
    async getOrderStatus() {
      calls.status += 1;
      if (!script.status) throw new Error("unexpected getOrderStatus call");
      return script.status();
    },
    ...(script.cancel !== undefined
      ? {
          async cancelOrder() {
            calls.cancel += 1;
            return script.cancel!();
          }
        }
      : {}),
    async getAccountBalanceSun() {
      return 0n;
    }
  };
  return { provider, calls };
}

function prep(client: TronRpcBackend, rental?: TronEnergyRentalConfig) {
  const adapter = tronChainAdapter({
    chainIds: [TRON_MAINNET_CHAIN_ID],
    clients: { [TRON_MAINNET_CHAIN_ID]: client },
    ...(rental !== undefined ? { energyRental: rental } : {})
  });
  return adapter.prepareGasForBroadcast!({
    chainId: TRON_MAINNET_CHAIN_ID,
    fromAddress: SOURCE,
    toAddress: DEST,
    token: "USDT",
    amountRaw: "25000000"
  });
}

// Fast-poll rental config so timeout paths complete in tens of ms.
function rentalConfig(
  providers: EnergyRentalProvider | readonly EnergyRentalProvider[],
  extra: Partial<TronEnergyRentalConfig> = {}
): TronEnergyRentalConfig {
  return {
    providers: Array.isArray(providers) ? providers : [providers as EnergyRentalProvider],
    pollIntervalMs: 1,
    fillTimeoutMs: 40,
    verifyTimeoutMs: 40,
    ...extra
  };
}

describe("tronChainAdapter.prepareGasForBroadcast", () => {
  it("is a no-op when no rental market is configured", async () => {
    // fakeClient throws on every method — reaching any RPC would fail the test.
    const result = await prep(fakeClient({}));
    expect(result).toEqual({ kind: "none" });
  });

  it("is a no-op for native TRX payouts (gas IS the asset)", async () => {
    const { provider } = scriptedProvider({});
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: fakeClient({}) },
      energyRental: rentalConfig(provider)
    });
    const result = await adapter.prepareGasForBroadcast!({
      chainId: TRON_MAINNET_CHAIN_ID,
      fromAddress: SOURCE,
      toAddress: DEST,
      token: "TRX",
      amountRaw: "1000000"
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("reports covered when existing delegated energy already spans the transfer", async () => {
    const { provider, calls } = scriptedProvider({});
    const client = fakeClient({
      triggerConstantContract: constantContract({}),
      getAccountResources: resourcesQueue([200_000])
    });
    const result = await prep(client, rentalConfig(provider));
    expect(result).toEqual({ kind: "covered" });
    expect(calls.estimate).toHaveLength(0);
  });

  it("rents the warm-receiver shortfall when strictly cheaper than burning", async () => {
    const { provider, calls } = scriptedProvider({
      estimate: async () => ({ unitPriceSun: 64, totalCostSun: 4_492_800n, availableEnergy: 900_000 }),
      create: async () => ({ orderId: "ord-1" }),
      status: async () => ({ fulfilledPercent: 100, paidSun: 4_492_800n })
    });
    const client = fakeClient({
      triggerConstantContract: constantContract({ receiverHoldsToken: true }),
      // 0 at sizing → shortfall = full required; 200k at verify → delegation landed.
      getAccountResources: resourcesQueue([0, 200_000])
    });

    const result = await prep(client, rentalConfig(provider));

    expect(result).toEqual({
      kind: "rented",
      provider: "fake-market",
      orderId: "ord-1",
      costNativeRaw: "4492800"
    });
    // Energy is delegated to OUR source, never the payout destination.
    expect(calls.estimate[0]).toMatchObject({ receiver: SOURCE, energyAmount: WARM_REQUIRED, durationSec: 600 });
    // Unit-price ceiling = 90% of the live burn rate (getEnergyFee=100).
    expect(calls.create[0]).toMatchObject({ receiver: SOURCE, energyAmount: WARM_REQUIRED, maxUnitPriceSun: 90 });
  });

  it("sizes a cold receiver (no token balance) at the doubled energy class", async () => {
    const { provider, calls } = scriptedProvider({
      estimate: async () => ({ unitPriceSun: 64, totalCostSun: 9_054_720n, availableEnergy: 900_000 }),
      create: async () => ({ orderId: "ord-cold" }),
      status: async () => ({ fulfilledPercent: 100, paidSun: null })
    });
    const client = fakeClient({
      triggerConstantContract: constantContract({ receiverHoldsToken: false }),
      getAccountResources: resourcesQueue([0, 200_000])
    });

    const result = await prep(client, rentalConfig(provider));

    expect(result).toMatchObject({ kind: "rented", orderId: "ord-cold" });
    expect(calls.estimate[0]!.energyAmount).toBe(COLD_REQUIRED);
    // paidSun unknown → falls back to the estimate for the audit cost.
    expect((result as { costNativeRaw: string }).costNativeRaw).toBe("9054720");
  });

  it("subtracts already-delegated energy and only rents the gap", async () => {
    // Gap = 66_300 - 50_000 = 16_300 energy; burn = 1_630_000 SUN; rental at
    // 64 SUN = 1_043_200 → clears the 500_000 min-savings bar.
    const { provider, calls } = scriptedProvider({
      estimate: async () => ({ unitPriceSun: 64, totalCostSun: 1_043_200n, availableEnergy: 900_000 }),
      create: async () => ({ orderId: "ord-gap" }),
      status: async () => ({ fulfilledPercent: 100, paidSun: 1_043_200n })
    });
    const client = fakeClient({
      triggerConstantContract: constantContract({ receiverHoldsToken: true }),
      getAccountResources: resourcesQueue([50_000, 200_000])
    });

    const result = await prep(client, rentalConfig(provider));

    expect(result).toMatchObject({ kind: "rented" });
    expect(calls.estimate[0]!.energyAmount).toBe(WARM_REQUIRED - 50_000);
  });

  it("honors a tighter operator unit-price cap over the dynamic ceiling", async () => {
    const { provider, calls } = scriptedProvider({
      estimate: async () => ({ unitPriceSun: 60, totalCostSun: 4_212_000n, availableEnergy: 900_000 }),
      create: async () => ({ orderId: "ord-cap" }),
      status: async () => ({ fulfilledPercent: 100, paidSun: null })
    });
    const client = fakeClient({
      triggerConstantContract: constantContract({ receiverHoldsToken: true }),
      getAccountResources: resourcesQueue([0, 200_000])
    });

    await prep(client, rentalConfig(provider, { maxUnitPriceSun: 80 }));

    expect(calls.create[0]!.maxUnitPriceSun).toBe(80);
  });

  it("falls back to burn when the market can't supply the shortfall", async () => {
    const { provider, calls } = scriptedProvider({
      estimate: async () => ({ unitPriceSun: 64, totalCostSun: 4_492_800n, availableEnergy: 10_000 })
    });
    const client = fakeClient({
      triggerConstantContract: constantContract({ receiverHoldsToken: true }),
      getAccountResources: resourcesQueue([0])
    });

    const result = await prep(client, rentalConfig(provider));

    expect(result).toEqual({ kind: "none" });
    expect(calls.create).toHaveLength(0);
  });

  it("falls back to burn when the rental doesn't beat burning by the minimum savings", async () => {
    // Burn = 7_020_000 SUN; rental at 6_900_000 + 500_000 min savings > burn → skip.
    const { provider, calls } = scriptedProvider({
      estimate: async () => ({ unitPriceSun: 98, totalCostSun: WARM_BURN_SUN - 120_000n, availableEnergy: 900_000 })
    });
    const client = fakeClient({
      triggerConstantContract: constantContract({ receiverHoldsToken: true }),
      getAccountResources: resourcesQueue([0])
    });

    const result = await prep(client, rentalConfig(provider));

    expect(result).toEqual({ kind: "none" });
    expect(calls.create).toHaveLength(0);
  });

  it("falls back to burn when the provider estimate errors", async () => {
    const { provider } = scriptedProvider({
      estimate: async () => {
        throw new Error("provider down");
      }
    });
    const client = fakeClient({
      triggerConstantContract: constantContract({ receiverHoldsToken: true }),
      getAccountResources: resourcesQueue([0])
    });

    const result = await prep(client, rentalConfig(provider));
    expect(result).toEqual({ kind: "none" });
  });

  it("never spends on a transfer whose simulation reverts", async () => {
    const { provider, calls } = scriptedProvider({});
    const client = fakeClient({
      triggerConstantContract: constantContract({ simReverts: true }),
      getAccountResources: resourcesQueue([0])
    });

    const result = await prep(client, rentalConfig(provider));

    expect(result).toEqual({ kind: "none" });
    expect(calls.estimate).toHaveLength(0);
  });

  it("refuses to rent past the non-standard-TRC-20 ceiling", async () => {
    const { provider, calls } = scriptedProvider({});
    const client = fakeClient({
      // 260k simulated × 1.02 buffer > 250k refusal ceiling → buildTransfer
      // is going to reject this tx; don't spend rental money first.
      triggerConstantContract: constantContract({ simEnergy: 260_000, receiverHoldsToken: true }),
      getAccountResources: resourcesQueue([0])
    });

    const result = await prep(client, rentalConfig(provider));

    expect(result).toEqual({ kind: "none" });
    expect(calls.estimate).toHaveLength(0);
  });

  it("burns after an ambiguous order failure only once on-chain state confirms no fill", async () => {
    const { provider } = scriptedProvider({
      estimate: async () => ({ unitPriceSun: 64, totalCostSun: 4_492_800n, availableEnergy: 900_000 }),
      create: async () => {
        throw new Error("socket hang up");
      }
    });
    const client = fakeClient({
      triggerConstantContract: constantContract({ receiverHoldsToken: true }),
      getAccountResources: resourcesQueue([0, 0])
    });

    const result = await prep(client, rentalConfig(provider));
    expect(result).toEqual({ kind: "none" });
  });

  it("uses the delegation when an ambiguous order failure actually landed", async () => {
    const { provider } = scriptedProvider({
      estimate: async () => ({ unitPriceSun: 64, totalCostSun: 4_492_800n, availableEnergy: 900_000 }),
      create: async () => {
        throw new Error("fetch timeout after response was processed");
      }
    });
    const client = fakeClient({
      triggerConstantContract: constantContract({ receiverHoldsToken: true }),
      getAccountResources: resourcesQueue([0, 200_000])
    });

    const result = await prep(client, rentalConfig(provider));
    expect(result).toEqual({ kind: "covered" });
  });

  it("defers (never burns) when a created order doesn't confirm filled in time", async () => {
    const { provider } = scriptedProvider({
      estimate: async () => ({ unitPriceSun: 64, totalCostSun: 4_492_800n, availableEnergy: 900_000 }),
      create: async () => ({ orderId: "ord-slow" }),
      status: async () => ({ fulfilledPercent: 0, paidSun: null })
    });
    const client = fakeClient({
      triggerConstantContract: constantContract({ receiverHoldsToken: true }),
      getAccountResources: resourcesQueue([0])
    });

    const result = await prep(client, rentalConfig(provider));

    expect(result).toMatchObject({ kind: "deferred" });
    expect((result as { reason: string }).reason).toContain("ord-slow");
  });

  it("quotes every provider and the cheapest viable estimate wins the order", async () => {
    const expensive = scriptedProvider(
      { estimate: async () => ({ unitPriceSun: 67, totalCostSun: 4_700_000n, availableEnergy: 900_000 }) },
      "pricey-market"
    );
    const cheap = scriptedProvider(
      {
        estimate: async () => ({ unitPriceSun: 35, totalCostSun: 2_400_000n, availableEnergy: 900_000 }),
        create: async () => ({ orderId: "ord-cheap" }),
        status: async () => ({ fulfilledPercent: 100, paidSun: 2_400_000n })
      },
      "cheap-market"
    );
    const client = fakeClient({
      triggerConstantContract: constantContract({ receiverHoldsToken: true }),
      getAccountResources: resourcesQueue([0, 200_000])
    });

    const result = await prep(client, rentalConfig([expensive.provider, cheap.provider]));

    expect(result).toEqual({
      kind: "rented",
      provider: "cheap-market",
      orderId: "ord-cheap",
      costNativeRaw: "2400000"
    });
    // Both quoted, only the winner bought.
    expect(expensive.calls.estimate).toHaveLength(1);
    expect(expensive.calls.create).toHaveLength(0);
    expect(cheap.calls.create).toHaveLength(1);
  });

  it("falls past a cheaper market that can't supply the shortfall", async () => {
    const thin = scriptedProvider(
      { estimate: async () => ({ unitPriceSun: 35, totalCostSun: 2_400_000n, availableEnergy: 1_000 }) },
      "thin-market"
    );
    const deep = scriptedProvider(
      {
        estimate: async () => ({ unitPriceSun: 64, totalCostSun: 4_492_800n, availableEnergy: 900_000 }),
        create: async () => ({ orderId: "ord-deep" }),
        status: async () => ({ fulfilledPercent: 100, paidSun: null })
      },
      "deep-market"
    );
    const client = fakeClient({
      triggerConstantContract: constantContract({ receiverHoldsToken: true }),
      getAccountResources: resourcesQueue([0, 200_000])
    });

    const result = await prep(client, rentalConfig([thin.provider, deep.provider]));

    expect(result).toMatchObject({ kind: "rented", provider: "deep-market" });
    expect(thin.calls.create).toHaveLength(0);
  });

  it("keeps renting when one provider's estimate errors entirely", async () => {
    const broken = scriptedProvider(
      {
        estimate: async () => {
          throw new Error("502 from provider");
        }
      },
      "broken-market"
    );
    const healthy = scriptedProvider(
      {
        estimate: async () => ({ unitPriceSun: 64, totalCostSun: 4_492_800n, availableEnergy: 900_000 }),
        create: async () => ({ orderId: "ord-healthy" }),
        status: async () => ({ fulfilledPercent: 100, paidSun: null })
      },
      "healthy-market"
    );
    const client = fakeClient({
      triggerConstantContract: constantContract({ receiverHoldsToken: true }),
      getAccountResources: resourcesQueue([0, 200_000])
    });

    const result = await prep(client, rentalConfig([broken.provider, healthy.provider]));
    expect(result).toMatchObject({ kind: "rented", provider: "healthy-market" });
  });

  it("cancels an unfilled order on timeout and burns instead of deferring", async () => {
    const { provider, calls } = scriptedProvider({
      estimate: async () => ({ unitPriceSun: 35, totalCostSun: 2_400_000n, availableEnergy: 900_000 }),
      create: async () => ({ orderId: "ord-stuck" }),
      status: async () => ({ fulfilledPercent: 0, paidSun: null }),
      cancel: async () => true
    });
    const client = fakeClient({
      triggerConstantContract: constantContract({ receiverHoldsToken: true }),
      getAccountResources: resourcesQueue([0])
    });

    const result = await prep(client, rentalConfig(provider));

    // Payment reclaimed → burn path this tick, no zombie order left behind.
    expect(result).toEqual({ kind: "none" });
    expect(calls.cancel).toBe(1);
  });

  it("still defers on timeout when the cancellation is rejected (order may have just filled)", async () => {
    const { provider } = scriptedProvider({
      estimate: async () => ({ unitPriceSun: 35, totalCostSun: 2_400_000n, availableEnergy: 900_000 }),
      create: async () => ({ orderId: "ord-racing" }),
      status: async () => ({ fulfilledPercent: 0, paidSun: null }),
      cancel: async () => false
    });
    const client = fakeClient({
      triggerConstantContract: constantContract({ receiverHoldsToken: true }),
      getAccountResources: resourcesQueue([0])
    });

    const result = await prep(client, rentalConfig(provider));
    expect(result).toMatchObject({ kind: "deferred" });
  });

  it("defers when the fill is confirmed but the delegation isn't visible on-chain yet", async () => {
    const { provider } = scriptedProvider({
      estimate: async () => ({ unitPriceSun: 64, totalCostSun: 4_492_800n, availableEnergy: 900_000 }),
      create: async () => ({ orderId: "ord-lag" }),
      status: async () => ({ fulfilledPercent: 100, paidSun: 4_492_800n })
    });
    const client = fakeClient({
      triggerConstantContract: constantContract({ receiverHoldsToken: true }),
      // Energy never shows up within verifyTimeoutMs.
      getAccountResources: resourcesQueue([0])
    });

    const result = await prep(client, rentalConfig(provider));

    expect(result).toMatchObject({ kind: "deferred" });
    expect((result as { reason: string }).reason).toContain("not yet visible");
  });
});

// Phase-2 planner integration: with a rental market wired, a source with no
// TRX at all qualifies for direct picking as long as its free bandwidth
// covers the tx bytes — energy arrives at broadcast time via rental.
describe("tronChainAdapter.hasSufficientFreeGas — rental-aware", () => {
  function probeArgs() {
    return { chainId: TRON_MAINNET_CHAIN_ID, address: SOURCE, token: "USDT" } as Parameters<
      NonNullable<ReturnType<typeof tronChainAdapter>["hasSufficientFreeGas"]>
    >[0];
  }
  function resourcesWith(energy: number, bandwidth: number) {
    return async (): Promise<TronAccountResources> => ({
      energyAvailable: energy,
      energyLimit: energy,
      bandwidthAvailable: bandwidth,
      bandwidthLimit: bandwidth
    });
  }

  it("treats a zero-TRX source as free-gas when rental is wired and bandwidth covers the tx", async () => {
    const { provider } = scriptedProvider({});
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: fakeClient({ getAccountResources: resourcesWith(0, 600) }) },
      energyRental: rentalConfig(provider)
    });
    expect(await adapter.hasSufficientFreeGas!(probeArgs())).toBe(true);
  });

  it("requires the burn-path planner for bandwidth-dry sources even with rental wired", async () => {
    const { provider } = scriptedProvider({});
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: fakeClient({ getAccountResources: resourcesWith(0, 100) }) },
      energyRental: rentalConfig(provider)
    });
    expect(await adapter.hasSufficientFreeGas!(probeArgs())).toBe(false);
  });

  it("keeps the legacy delegated-energy threshold when no rental is configured", async () => {
    const lowEnergy = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: fakeClient({ getAccountResources: resourcesWith(0, 600) }) }
    });
    expect(await lowEnergy.hasSufficientFreeGas!(probeArgs())).toBe(false);

    const staked = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: fakeClient({ getAccountResources: resourcesWith(140_000, 0) }) }
    });
    expect(await staked.hasSufficientFreeGas!(probeArgs())).toBe(true);
  });
});

// Burn-coverage guard: buildTransfer refuses to broadcast a TRC-20 transfer
// whose energy gap the source cannot pay for in TRX — the executor routes
// the thrown "insufficient native balance" into the sponsor top-up rail.
describe("tronChainAdapter.buildTransfer — burn-coverage guard", () => {
  const triggerSmartContractOk = async () => ({
    transaction: { txID: "ab".repeat(32), raw_data_hex: "deadbeef", raw_data: {} },
    result: { result: true },
    energy_used: 4_000
  });

  function buildArgs() {
    return {
      chainId: TRON_MAINNET_CHAIN_ID,
      fromAddress: SOURCE,
      toAddress: DEST,
      token: "USDT",
      amountRaw: "25000000"
    } as Parameters<ReturnType<typeof tronChainAdapter>["buildTransfer"]>[0];
  }

  it("throws the executor-recognized error when the energy gap exceeds the source's TRX", async () => {
    const client = fakeClient({
      triggerSmartContract: triggerSmartContractOk,
      // No delegation at all → gap = MIN floor (135k) → ~13.5 TRX needed.
      getAccountResources: resourcesQueue([0]),
      getAccount: async () => ({ balanceSun: "1000000", trc20: {} })
    });
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: client }
    });
    await expect(adapter.buildTransfer(buildArgs())).rejects.toThrow(/insufficient native balance/);
  });

  it("builds when the source's TRX covers the worst-case burn", async () => {
    const client = fakeClient({
      triggerSmartContract: triggerSmartContractOk,
      getAccountResources: resourcesQueue([0]),
      getAccount: async () => ({ balanceSun: "20000000", trc20: {} })
    });
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: client }
    });
    const unsigned = await adapter.buildTransfer(buildArgs());
    expect((unsigned.raw as { txID: string }).txID).toBe("ab".repeat(32));
  });

  it("accepts rental-sized delegation below the reservation floor via the prep handoff", async () => {
    const { provider } = scriptedProvider({});
    // 70k delegated: below the 135k floor, above the warm-receiver rental
    // sizing (66.3k). Zero TRX, so without the prep handoff the guard would
    // demand floor coverage and throw.
    const client = fakeClient({
      triggerConstantContract: constantContract({ receiverHoldsToken: true }),
      triggerSmartContract: triggerSmartContractOk,
      getAccountResources: resourcesQueue([70_000]),
      getAccount: async () => ({ balanceSun: "0", trc20: {} })
    });
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: client },
      energyRental: rentalConfig(provider)
    });

    // Same executor sequence as broadcastMain: prep (resolves "covered"
    // and records its sizing), then build.
    const prepResult = await adapter.prepareGasForBroadcast!(buildArgs());
    expect(prepResult).toEqual({ kind: "covered" });
    const unsigned = await adapter.buildTransfer(buildArgs());
    expect((unsigned.raw as { txID: string }).txID).toBe("ab".repeat(32));
  });

  it("does not block the broadcast when the resource read flaps", async () => {
    // fakeClient's default getAccountResources throws — the guard treats
    // that as "can't verify" and lets the chain arbitrate, as before.
    const client = fakeClient({ triggerSmartContract: triggerSmartContractOk });
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: client }
    });
    const unsigned = await adapter.buildTransfer(buildArgs());
    expect((unsigned.raw as { txID: string }).txID).toBe("ab".repeat(32));
  });
});
