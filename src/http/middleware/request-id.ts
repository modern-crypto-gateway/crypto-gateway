import type { MiddlewareHandler } from "hono";

// Request-id middleware. Reads `X-Request-Id` if the caller provided one
// (common in upstream proxies), otherwise mints a UUID. Attaches it to the
// Hono context under `requestId` so route handlers can pull it for logging,
// and echoes it back in the response header so clients can correlate.
//
// Also binds a per-request child logger (if `deps.logger` is available in
// context) so every subsequent log inside the handler carries the request id.

export interface RequestIdVariables {
  requestId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requestIdMiddleware(): MiddlewareHandler<{ Variables: RequestIdVariables }> {
  return async (c, next) => {
    const provided = c.req.header("x-request-id");
    // Only accept the caller-provided id if it's a UUID — otherwise callers
    // could inject arbitrary values that poison log aggregation.
    const requestId = provided && UUID_RE.test(provided) ? provided : globalThis.crypto.randomUUID();
    c.set("requestId", requestId);
    c.res.headers.set("x-request-id", requestId);
    await next();
  };
}
