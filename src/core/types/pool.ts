import { z } from "zod";
import { ChainFamilySchema, type ChainFamily } from "./chain.js";

// Address-pool schema. Pool rows are shared across all merchants — one
// family-scoped pool (EVM, Tron, Solana) feeds every invoice that asks for
// that family. Reuse on invoice-terminal means a single pool row can serve
// thousands of invoices across its lifetime; `total_allocations` tracks that.

export const PoolStatusSchema = z.enum(["available", "allocated", "quarantined"]);
export type PoolStatus = z.infer<typeof PoolStatusSchema>;

export const PoolAddressSchema = z.object({
  id: z.string().uuid(),
  family: ChainFamilySchema,
  addressIndex: z.number().int().nonnegative(),
  address: z.string().min(1),
  status: PoolStatusSchema,
  allocatedToInvoiceId: z.string().nullable(),
  allocatedAt: z.date().nullable(),
  totalAllocations: z.number().int().nonnegative(),
  createdAt: z.date()
});
export type PoolAddress = z.infer<typeof PoolAddressSchema>;

export type { ChainFamily };

// Stats aggregate returned by GET /admin/pool/stats. Per-family counters so
// operators can see at a glance "evm has 3 available / 17 allocated" and
// top up via POST /admin/pool/initialize before exhaustion bites.
export interface PoolFamilyStats {
  family: ChainFamily;
  available: number;
  allocated: number;
  quarantined: number;
  total: number;
  highestIndex: number | null;
}
