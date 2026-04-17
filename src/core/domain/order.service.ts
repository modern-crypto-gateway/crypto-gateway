import { z } from "zod";
import type { AppDeps } from "../app-deps.js";
import { ChainFamilySchema, ChainIdSchema, type ChainFamily } from "../types/chain.js";
import { AmountRawSchema, FiatAmountSchema, FiatCurrencySchema } from "../types/money.js";
import { MerchantIdSchema } from "../types/merchant.js";
import type { Order, OrderId, OrderReceiveAddress } from "../types/order.js";
import { TokenSymbolSchema } from "../types/token.js";
import { findToken, TOKEN_REGISTRY } from "../types/token-registry.js";
import { findChainAdapter } from "./chain-lookup.js";
import { fetchOrderReceiveAddresses, loadOrder, rowToOrder, type OrderRow } from "./mappers.js";
import { DomainError } from "../errors.js";
import { allocateForOrder } from "./pool.service.js";

// ---- Input validation ----

export const CreateOrderInputSchema = z
  .object({
    merchantId: MerchantIdSchema,
    chainId: ChainIdSchema,
    token: TokenSymbolSchema,
    // Either provide a fiat-priced amount (+ currency) and let the oracle convert,
    // OR provide a raw token amount directly. Enforced by the .refine below.
    fiatAmount: FiatAmountSchema.optional(),
    fiatCurrency: FiatCurrencySchema.optional(),
    amountRaw: AmountRawSchema.optional(),
    // Multi-family acceptance. When set, the order gets one receive address
    // per family (e.g. ["evm","tron"] = one EVM address + one Tron address).
    // Omitted = single-family, derived from `chainId`'s family. In A1.b the
    // token is still scoped per-chain; multi-family orders require the token
    // to exist in the registry for at least one chain in each accepted family.
    // A2 introduces USD-pegged amounts + any-token acceptance.
    acceptedFamilies: z.array(ChainFamilySchema).min(1).optional(),
    externalId: z.string().max(256).optional(),
    metadata: z.record(z.unknown()).optional(),
    // Default 30 minutes. Hard ceiling at 24 hours — the scheduler promotes
    // long-expired orders and merchants who need days-long expiries are doing
    // something unusual.
    expiresInMinutes: z.number().int().min(1).max(60 * 24).default(30)
  })
  .refine(
    (v) => v.amountRaw !== undefined || (v.fiatAmount !== undefined && v.fiatCurrency !== undefined),
    { message: "Either amountRaw or (fiatAmount + fiatCurrency) must be provided" }
  );
export type CreateOrderInput = z.infer<typeof CreateOrderInputSchema>;

// ---- Operations ----

export async function createOrder(deps: AppDeps, input: unknown): Promise<Order> {
  const parsed = CreateOrderInputSchema.parse(input);

  // 1. Merchant must exist + be active.
  const merchant = await deps.db
    .prepare("SELECT id, active FROM merchants WHERE id = ?")
    .bind(parsed.merchantId)
    .first<{ id: string; active: number }>();
  if (!merchant) {
    throw new OrderError("MERCHANT_NOT_FOUND", `Merchant not found: ${parsed.merchantId}`);
  }
  if (merchant.active !== 1) {
    throw new OrderError("MERCHANT_INACTIVE", `Merchant is inactive: ${parsed.merchantId}`);
  }

  // 2. Token must be registered for this chain.
  const token = findToken(parsed.chainId, parsed.token);
  if (!token) {
    throw new OrderError("TOKEN_NOT_SUPPORTED", `Token ${parsed.token} not supported on chain ${parsed.chainId}`);
  }

  // 3. Compute required raw amount. Either merchant supplied it directly, or
  //    we convert from fiat via the oracle and record the quoted rate.
  let requiredAmountRaw: string;
  let quotedRate: string | null = null;
  if (parsed.amountRaw !== undefined) {
    requiredAmountRaw = parsed.amountRaw;
  } else {
    const conversion = await deps.priceOracle.fiatToTokenAmount(
      parsed.fiatAmount!,
      parsed.token,
      parsed.fiatCurrency!,
      token.decimals
    );
    requiredAmountRaw = conversion.amountRaw;
    quotedRate = conversion.rate;
  }

  // 4. Resolve the family set for this order.
  //      - `acceptedFamilies` explicit → exactly those families.
  //      - omitted → infer `[familyOf(chainId)]` (single-family legacy).
  //    For each family in the set, validate the requested token is
  //    registered on at least one of that family's chains — an order for
  //    "USDC on Tron family" requires USDC on Tron mainnet (or Nile). If
  //    none of a family's chains have the token, the order would be
  //    unfulfillable on that family, so reject at creation time.
  const primaryChainAdapter = findChainAdapter(deps, parsed.chainId);
  const acceptedFamilies: ChainFamily[] =
    parsed.acceptedFamilies ?? [primaryChainAdapter.family];

  for (const family of acceptedFamilies) {
    if (!familyHasToken(family, parsed.token)) {
      throw new OrderError(
        "TOKEN_NOT_SUPPORTED",
        `Token ${parsed.token} is not registered on any chain in family '${family}'`
      );
    }
  }

  // 5. Allocate one pool row per accepted family. The `primary` family
  //    (from chainId) lands first, so its address is what goes into the
  //    legacy `orders.receive_address` column for back-compat. Order ID
  //    generated up-front so allocateForOrder can write it into the pool
  //    rows.
  const now = deps.clock.now().getTime();
  const orderId = globalThis.crypto.randomUUID();
  const primaryFamily = primaryChainAdapter.family;
  const familyOrder: ChainFamily[] = [
    primaryFamily,
    ...acceptedFamilies.filter((f) => f !== primaryFamily)
  ];
  const receiveRows: OrderReceiveAddress[] = [];
  let primaryAddress: string | null = null;
  let primaryAddressIndex = 0;
  for (const family of familyOrder) {
    const familyAdapter = deps.chains.find((c) => c.family === family);
    if (!familyAdapter) {
      throw new OrderError(
        "TOKEN_NOT_SUPPORTED",
        `No chain adapter wired for family '${family}'. Order creation requires all accepted families to be configured on the gateway.`
      );
    }
    const allocated = await allocateForOrder(deps, orderId, family);
    const canonical = familyAdapter.canonicalizeAddress(allocated.address);
    receiveRows.push({
      family,
      address: canonical as OrderReceiveAddress["address"],
      poolAddressId: allocated.id
    });
    if (family === primaryFamily) {
      primaryAddress = canonical;
      primaryAddressIndex = allocated.addressIndex;
    }
  }
  if (primaryAddress === null) {
    throw new Error("Invariant: primary family allocation missing");
  }

  // 6. Insert the order row (denormalizes the primary family's address)
  //    and the per-family join rows in a single batch so a partial write
  //    can't leave the order unreachable for detection.
  const expiresAt = now + parsed.expiresInMinutes * 60_000;
  const metadataJson = parsed.metadata !== undefined ? JSON.stringify(parsed.metadata) : null;
  const statements = [
    deps.db
      .prepare(
        `INSERT INTO orders
           (id, merchant_id, status, chain_id, token, receive_address, address_index,
            required_amount_raw, received_amount_raw, fiat_amount, fiat_currency, quoted_rate,
            external_id, metadata_json, accepted_families, created_at, expires_at, updated_at)
         VALUES (?, ?, 'created', ?, ?, ?, ?, ?, '0', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        orderId,
        parsed.merchantId,
        parsed.chainId,
        parsed.token,
        primaryAddress,
        primaryAddressIndex,
        requiredAmountRaw,
        parsed.fiatAmount ?? null,
        parsed.fiatCurrency ?? null,
        quotedRate,
        parsed.externalId ?? null,
        metadataJson,
        JSON.stringify(acceptedFamilies),
        now,
        expiresAt,
        now
      ),
    ...receiveRows.map((rx) =>
      deps.db
        .prepare(
          `INSERT INTO order_receive_addresses (order_id, family, address, pool_address_id, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(orderId, rx.family, rx.address, rx.poolAddressId, now)
    )
  ];
  await deps.db.batch(statements);

  const order = rowToOrder(
    {
      id: orderId,
      merchant_id: parsed.merchantId,
      status: "created",
      chain_id: parsed.chainId,
      token: parsed.token,
      receive_address: primaryAddress,
      address_index: primaryAddressIndex,
      required_amount_raw: requiredAmountRaw,
      received_amount_raw: "0",
      fiat_amount: parsed.fiatAmount ?? null,
      fiat_currency: parsed.fiatCurrency ?? null,
      quoted_rate: quotedRate,
      external_id: parsed.externalId ?? null,
      metadata_json: metadataJson,
      created_at: now,
      expires_at: expiresAt,
      confirmed_at: null,
      updated_at: now
    },
    receiveRows
  );

  await deps.events.publish({ type: "order.created", orderId: order.id, order, at: new Date(now) });

  return order;
}

export async function getOrder(deps: AppDeps, orderId: OrderId): Promise<Order | null> {
  return loadOrder(deps, orderId);
}

export async function expireOrder(deps: AppDeps, orderId: OrderId): Promise<Order> {
  const now = deps.clock.now().getTime();
  const row = await deps.db
    .prepare(
      `UPDATE orders
         SET status = 'expired', updated_at = ?
       WHERE id = ? AND status IN ('created','partial')
       RETURNING *`
    )
    .bind(now, orderId)
    .first<OrderRow>();
  if (!row) {
    throw new OrderError(
      "EXPIRE_NOT_ALLOWED",
      `Order ${orderId} cannot be expired — either it does not exist or it is already in a terminal state`
    );
  }
  const addresses = await fetchOrderReceiveAddresses(deps, orderId);
  const order = rowToOrder(row, addresses);
  await deps.events.publish({ type: "order.expired", orderId: order.id, order, at: new Date(now) });
  return order;
}

// Returns true when at least one chain in the family has `token` registered.
// Used at order creation to reject "USDC on Solana" before Solana SPL tokens
// are in the registry, for instance.
function familyHasToken(family: ChainFamily, token: string): boolean {
  for (const entry of TOKEN_REGISTRY) {
    if (entry.symbol !== token) continue;
    const adapterFamily = familyForChainId(entry.chainId);
    if (adapterFamily === family) return true;
  }
  return false;
}

// Small helper mapping chain ids to their families. Mirrors the adapter's
// family property without requiring an adapter lookup — the token registry
// is already loaded in memory, and we only need the family label.
function familyForChainId(chainId: number): ChainFamily | null {
  if (chainId >= 900 && chainId <= 901) return "solana";
  if (chainId === 728126428 || chainId === 3448148188) return "tron";
  return "evm";
}

// ---- Typed domain error ----

export type OrderErrorCode =
  | "MERCHANT_NOT_FOUND"
  | "MERCHANT_INACTIVE"
  | "TOKEN_NOT_SUPPORTED"
  | "EXPIRE_NOT_ALLOWED";

// HTTP status per code lives here (next to the codes themselves) rather than
// in the route's handleError — routes shouldn't reverse-engineer semantics
// from a code name. Note: POOL_EXHAUSTED (503) is thrown by pool.service as
// a PoolExhaustedError; it's a DomainError so renderError handles it
// uniformly — no need to duplicate the code here.
const ORDER_ERROR_HTTP_STATUS: Readonly<Record<OrderErrorCode, number>> = {
  MERCHANT_NOT_FOUND: 404,
  MERCHANT_INACTIVE: 403,
  TOKEN_NOT_SUPPORTED: 400,
  EXPIRE_NOT_ALLOWED: 409
};

export class OrderError extends DomainError {
  declare readonly code: OrderErrorCode;
  constructor(code: OrderErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, ORDER_ERROR_HTTP_STATUS[code], details);
    this.name = "OrderError";
  }
}
