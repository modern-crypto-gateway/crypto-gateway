import { Hono } from "hono";
import type { AppDeps } from "../../core/app-deps.js";
import { getInvoice } from "../../core/domain/invoice.service.js";
import { payableAmountRaw, tokenDecimalsFor } from "../../core/domain/rate-window.js";
import { InvoiceIdSchema, type Invoice, type InvoiceId } from "../../core/types/invoice.js";
import type { ChainFamily } from "../../core/types/chain.js";
import { formatRawAmount } from "../../core/types/money.js";
import { TOKEN_REGISTRY } from "../../core/types/token-registry.js";
import { getClientIp, rateLimit } from "../middleware/rate-limit.js";

// Public checkout view. Anyone with an invoice id can fetch the details needed
// to render a "send N TOKEN to ADDRESS" page / QR code. The invoice id itself
// is a UUID — high entropy, unguessable. No merchant API key required here.
//
// Surface is deliberately narrower than the merchant API:
//   - merchant identifier is NOT exposed
//   - internal timestamps (updatedAt) omitted
//   - metadata field omitted (may contain merchant-private data)
//
// For USD-path invoices the response also includes `payableTokens`: the
// checkout UI renders a chooser like "Pay with USDC on Polygon (100.00
// USDC)" / "Pay with ETH on Ethereum (0.04 ETH)" without having to know
// any token decimals or rate math itself. One entry per (family, chainId,
// token) combination the gateway can accept for this invoice.

// Family-native symbols the oracle quotes by default. Used to enumerate
// payable natives per family even though they aren't in the token registry.
const FAMILY_NATIVE_SYMBOLS: Readonly<Record<ChainFamily, readonly string[]>> = {
  evm: ["ETH", "BNB", "MATIC", "AVAX", "POL"],
  tron: ["TRX"],
  solana: ["SOL"]
};

interface PayableToken {
  family: ChainFamily;
  chainId: number;
  token: string;
  decimals: number;
  // Minimum raw-units amount the payer must send on this (chain, token)
  // pair to satisfy the full invoice at the pinned rate. Ceiling-rounded
  // so floating-point truncation can't leave a partial balance.
  amountRawMinimum: string;
  // Human-readable token amount (e.g. "100" for USDC, "0.04" for ETH).
  // Derived from amountRawMinimum / 10^decimals and trimmed of trailing
  // zeros — the checkout UI can show this directly without reformatting.
  amountDisplay: string;
  // USD per whole token, as pinned in the invoice's rate window. Echoed
  // so the UI can show "1 USDC = $1" / "1 ETH = $2500" next to each row.
  rate: string;
  // The gateway-owned address on this family. All chains in a family share
  // the same address (EVM chains reuse one pubkey), so this value is the
  // same across (chainId) entries within the same family — included per
  // row for convenience.
  address: string;
}

export function checkoutRouter(deps: AppDeps): Hono {
  const app = new Hono();

  // Per-IP limit on the public checkout surface. Abusive scanning of many
  // invoice ids from one IP trips this; normal merchants serve their end
  // users from distinct IPs.
  app.use(
    "*",
    rateLimit(deps, {
      scope: "checkout",
      keyFn: (c) => getClientIp(c, deps.rateLimits.trustedIpHeaders),
      limit: deps.rateLimits.checkoutPerMinute,
      windowSeconds: 60
    })
  );

  app.get("/:id", async (c) => {
    const raw = c.req.param("id");
    // Public endpoint: validate the UUID shape before a DB hit so bots
    // scanning the checkout surface with garbage ids can't waste round-trips.
    const parsed = InvoiceIdSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: { code: "NOT_FOUND", message: "Invoice not found" } }, 404);
    }
    const id = parsed.data as InvoiceId;
    const invoice = await getInvoice(deps, id);
    if (!invoice) {
      return c.json({ error: { code: "NOT_FOUND", message: `Invoice ${id} not found` } }, 404);
    }
    const payableTokens =
      invoice.amountUsd === null || invoice.rates === null
        ? null
        : computePayableTokens(deps, invoice);

    return c.json({
      invoice: {
        id: invoice.id,
        status: invoice.status,
        chainId: invoice.chainId,
        token: invoice.token,
        receiveAddress: invoice.receiveAddress,
        // Multi-family: one address per accepted family. The checkout UI
        // renders all of them so the payer can choose which chain to pay on.
        // Single-family invoices have exactly one entry; UI can fall back to
        // `receiveAddress` + `chainId` for simple cases.
        acceptedFamilies: invoice.acceptedFamilies,
        receiveAddresses: invoice.receiveAddresses.map((r) => ({
          family: r.family,
          address: r.address
        })),
        requiredAmountRaw: invoice.requiredAmountRaw,
        receivedAmountRaw: invoice.receivedAmountRaw,
        fiatAmount: invoice.fiatAmount,
        fiatCurrency: invoice.fiatCurrency,
        // USD-path fields: merchants pricing in USD see the target, rates
        // pinned, and the running paid/overpaid totals. null for legacy
        // single-token invoices.
        amountUsd: invoice.amountUsd,
        paidUsd: invoice.paidUsd,
        overpaidUsd: invoice.overpaidUsd,
        rates: invoice.rates,
        rateWindowExpiresAt:
          invoice.rateWindowExpiresAt === null
            ? null
            : invoice.rateWindowExpiresAt.toISOString(),
        payableTokens,
        createdAt: invoice.createdAt.toISOString(),
        expiresAt: invoice.expiresAt.toISOString(),
        confirmedAt: invoice.confirmedAt === null ? null : invoice.confirmedAt.toISOString()
      }
    });
  });

  return app;
}

// Enumerate every (family, chainId, token) payment option supported for this
// invoice at the rates currently pinned in its window. The checkout UI maps
// these to payment choices.
function computePayableTokens(deps: AppDeps, invoice: Invoice): readonly PayableToken[] {
  const amountUsd = invoice.amountUsd!;
  const rates = invoice.rates!;
  const addressByFamily = new Map<ChainFamily, string>();
  for (const r of invoice.receiveAddresses) addressByFamily.set(r.family, r.address);

  const out: PayableToken[] = [];

  for (const family of invoice.acceptedFamilies) {
    const address = addressByFamily.get(family);
    if (address === undefined) continue;

    // Chains wired in the gateway deployment that belong to this family.
    // Only these can actually settle a payment — we don't advertise chains
    // whose adapter isn't configured.
    const chainIds = new Set<number>(
      deps.chains.filter((c) => c.family === family).map((c) => c.supportedChainIds).flat()
    );

    for (const chainId of chainIds) {
      // Registry tokens on this chain (USDC/USDT/DAI/etc. + dev DEV).
      const registryTokens = TOKEN_REGISTRY.filter((t) => t.chainId === chainId).map((t) => t.symbol as string);
      // Family natives, added per chain so the UI can render "ETH on Ethereum"
      // vs "MATIC on Polygon" distinctly even though both are EVM.
      const natives = FAMILY_NATIVE_SYMBOLS[family];
      const uniqueTokens = Array.from(new Set<string>([...registryTokens, ...natives]));

      for (const token of uniqueTokens) {
        const rate = rates[token];
        if (rate === undefined) continue; // oracle didn't quote it — can't render an amount
        const decimals = tokenDecimalsFor(chainId, token);
        if (decimals === null) continue;
        const amountRawMinimum = payableAmountRaw(amountUsd, rate, decimals);
        out.push({
          family,
          chainId,
          token,
          decimals,
          amountRawMinimum,
          amountDisplay: formatRawAmount(amountRawMinimum, decimals),
          rate,
          address
        });
      }
    }
  }

  // Stable ordering: family → chainId → token. Predictable for UI diffs
  // and easier to eyeball during debugging.
  out.sort((a, b) => {
    if (a.family !== b.family) return a.family.localeCompare(b.family);
    if (a.chainId !== b.chainId) return a.chainId - b.chainId;
    return a.token.localeCompare(b.token);
  });

  return out;
}

