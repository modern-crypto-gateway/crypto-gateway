// Base class for every domain-signalled error. Carries an HTTP status the
// transport layer can map to 1:1 and a code field merchants can branch on.
// Subclass (InvoiceError, PayoutError, ...) to enumerate per-domain codes as a
// type-safe union.
//
// The point of a shared base class is that the app-level error handler can
// check `err instanceof DomainError` once and produce a consistent response
// shape — routes don't each reinvent their own `handleError`.

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number = 500,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "DomainError";
  }

  // JSON-safe shape for the HTTP response body.
  toResponseBody(): { error: { code: string; message: string; details?: Record<string, unknown> } } {
    return this.details !== undefined
      ? { error: { code: this.code, message: this.message, details: this.details } }
      : { error: { code: this.code, message: this.message } };
  }
}

// 503: no available pool addresses for one of the requested families.
// Actionable for operators — run the family's initialize endpoint to mint more.
// The refill path is also async-triggered at invoice creation when the pool
// runs low, so in practice this only fires if the initial pool was never
// seeded or the refill mutex was held through a process death.
//
// Monero has its OWN pool table + endpoint (it's inbound-only and isolated
// from the shared address_pool), so the hint must point at the right one or
// an operator following it will seed the wrong pool and stay stuck.
export class PoolExhaustedError extends DomainError {
  constructor(family: string) {
    const endpoint =
      family === "monero" ? "POST /admin/monero-pool/initialize" : "POST /admin/pool/initialize";
    super(
      "POOL_EXHAUSTED",
      `No available pool addresses for family '${family}'. Run ${endpoint} to mint more.`,
      503,
      { family, hint: endpoint }
    );
    this.name = "PoolExhaustedError";
  }
}
