import { z } from "zod";
import type { AppDeps } from "../app-deps.js";
import { ChainIdSchema } from "../types/chain.js";
import { AmountRawSchema, FiatAmountSchema, FiatCurrencySchema } from "../types/money.js";
import { MerchantIdSchema } from "../types/merchant.js";
import type { Order, OrderId } from "../types/order.js";
import { TokenSymbolSchema } from "../types/token.js";
import { findToken } from "../types/token-registry.js";
import { findChainAdapter } from "./chain-lookup.js";
import { rowToOrder, type OrderRow } from "./mappers.js";
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

  // 4. Allocate a receive address from the pool for this chain's family.
  //    The pool was initialized via POST /admin/pool/initialize; allocation
  //    CAS-claims the cheapest-by-reuse available row, and triggers a
  //    background refill if the pool's low. Legacy per-order HD derivation
  //    is gone — all addresses come from the shared pool now, which gives
  //    us reuse (critical for high-gas chains like ETH) + pre-registration
  //    with Alchemy webhooks at pool-generation time.
  const now = deps.clock.now().getTime();
  const orderId = globalThis.crypto.randomUUID();
  const chainAdapter = findChainAdapter(deps, parsed.chainId);
  const allocated = await allocateForOrder(deps, orderId, chainAdapter.family);
  const receiveAddress = chainAdapter.canonicalizeAddress(allocated.address);

  // 5. Insert the order. Denormalize the pool allocation onto the order row
  //    for back-compat with detection code that looks at orders.receive_address
  //    directly (multi-family lookups in A1.b will use order_receive_addresses).
  const expiresAt = now + parsed.expiresInMinutes * 60_000;
  await deps.db
    .prepare(
      `INSERT INTO orders
         (id, merchant_id, status, chain_id, token, receive_address, address_index,
          required_amount_raw, received_amount_raw, fiat_amount, fiat_currency, quoted_rate,
          external_id, metadata_json, created_at, expires_at, updated_at)
       VALUES (?, ?, 'created', ?, ?, ?, ?, ?, '0', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      orderId,
      parsed.merchantId,
      parsed.chainId,
      parsed.token,
      receiveAddress,
      allocated.addressIndex,
      requiredAmountRaw,
      parsed.fiatAmount ?? null,
      parsed.fiatCurrency ?? null,
      quotedRate,
      parsed.externalId ?? null,
      parsed.metadata !== undefined ? JSON.stringify(parsed.metadata) : null,
      now,
      expiresAt,
      now
    )
    .run();

  // Record the allocation in the join table. Single-family in A1.a; A1.b
  // populates this with multiple rows for multi-family orders.
  await deps.db
    .prepare(
      `INSERT INTO order_receive_addresses (order_id, family, address, pool_address_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(orderId, chainAdapter.family, receiveAddress, allocated.id, now)
    .run();

  const order = rowToOrder({
    id: orderId,
    merchant_id: parsed.merchantId,
    status: "created",
    chain_id: parsed.chainId,
    token: parsed.token,
    receive_address: receiveAddress,
    address_index: allocated.addressIndex,
    required_amount_raw: requiredAmountRaw,
    received_amount_raw: "0",
    fiat_amount: parsed.fiatAmount ?? null,
    fiat_currency: parsed.fiatCurrency ?? null,
    quoted_rate: quotedRate,
    external_id: parsed.externalId ?? null,
    metadata_json: parsed.metadata !== undefined ? JSON.stringify(parsed.metadata) : null,
    created_at: now,
    expires_at: expiresAt,
    confirmed_at: null,
    updated_at: now
  });

  await deps.events.publish({ type: "order.created", orderId: order.id, order, at: new Date(now) });

  return order;
}

export async function getOrder(deps: AppDeps, orderId: OrderId): Promise<Order | null> {
  const row = await deps.db
    .prepare("SELECT * FROM orders WHERE id = ?")
    .bind(orderId)
    .first<OrderRow>();
  return row ? rowToOrder(row) : null;
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
  const order = rowToOrder(row);
  await deps.events.publish({ type: "order.expired", orderId: order.id, order, at: new Date(now) });
  return order;
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
