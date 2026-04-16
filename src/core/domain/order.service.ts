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

  // 4. Atomically allocate the next HD index for this chain.
  const now = deps.clock.now().getTime();
  const counterRow = await deps.db
    .prepare(
      `INSERT INTO address_index_counters (chain_id, next_index, updated_at)
       VALUES (?, 1, ?)
       ON CONFLICT(chain_id) DO UPDATE
         SET next_index = next_index + 1, updated_at = excluded.updated_at
       RETURNING next_index - 1 AS allocated_index`
    )
    .bind(parsed.chainId, now)
    .first<{ allocated_index: number }>();
  if (!counterRow) {
    throw new OrderError("ADDRESS_ALLOCATION_FAILED", "Failed to allocate receive address index");
  }
  const addressIndex = counterRow.allocated_index;

  // 5. Derive and canonicalize the receive address.
  const chainAdapter = findChainAdapter(deps, parsed.chainId);
  const seed = deps.secrets.getRequired("MASTER_SEED");
  const { address } = chainAdapter.deriveAddress(seed, addressIndex);
  const receiveAddress = chainAdapter.canonicalizeAddress(address);

  // 6. Insert the order. One statement, no transaction needed — counter was
  //    already bumped atomically above.
  const orderId = globalThis.crypto.randomUUID();
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
      addressIndex,
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

  const order = rowToOrder({
    id: orderId,
    merchant_id: parsed.merchantId,
    status: "created",
    chain_id: parsed.chainId,
    token: parsed.token,
    receive_address: receiveAddress,
    address_index: addressIndex,
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
       WHERE id = ? AND status IN ('created','pending','partial')
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
  | "ADDRESS_ALLOCATION_FAILED"
  | "EXPIRE_NOT_ALLOWED";

export class OrderError extends Error {
  constructor(readonly code: OrderErrorCode, message: string) {
    super(message);
    this.name = "OrderError";
  }
}
