// Base class for every domain-signalled error. Carries an HTTP status the
// transport layer can map to 1:1 and a code field merchants can branch on.
// Subclass (OrderError, PayoutError, ...) to enumerate per-domain codes as a
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
