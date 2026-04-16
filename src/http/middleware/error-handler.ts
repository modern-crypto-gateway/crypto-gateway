import type { Context } from "hono";
import { ZodError } from "zod";
import { DomainError } from "../../core/errors.js";
import type { Logger } from "../../core/ports/logger.port.js";

// Convert any thrown error into a structured JSON response. Called from
// per-route catch-blocks AND from the top-level app.onError — in both places
// we want the same code/message shape so the merchant never sees two different
// error formats depending on which handler crashed.
//
// Status mapping:
//   - DomainError subclasses use their own `httpStatus`
//   - ZodError -> 400 with a `details` field carrying issues
//   - anything else -> 500 with a generic message (no internals leaked)

export function renderError(c: Context, err: unknown, logger?: Logger): Response {
  if (err instanceof DomainError) {
    // DomainError is expected — the service layer deliberately threw to signal
    // a business rule. Log at warn so it surfaces without flooding error alerts.
    logger?.warn("domain error", { code: err.code, httpStatus: err.httpStatus, message: err.message });
    return c.json(err.toResponseBody(), err.httpStatus as 400);
  }
  if (err instanceof ZodError) {
    logger?.warn("validation error", { issueCount: err.issues.length });
    return c.json(
      { error: { code: "VALIDATION", message: "Invalid request", details: err.issues } },
      400
    );
  }
  // Unknown error. Log the full shape for operators; return a blanket 500 so
  // we never leak internals (stack traces, SQL, RPC payloads) to merchants.
  const stack = err instanceof Error ? err.stack : undefined;
  const message = err instanceof Error ? err.message : String(err);
  logger?.error("unhandled error", { message, stack });
  return c.json({ error: { code: "INTERNAL", message: "Internal server error" } }, 500);
}
