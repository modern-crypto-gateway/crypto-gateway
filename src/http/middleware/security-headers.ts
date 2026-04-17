import type { MiddlewareHandler } from "hono";

// Security-headers middleware. Mounted globally in `buildApp` so every response
// (HTML, JSON, error, 404) carries a conservative baseline of hardening
// headers. Cheap (header set is static) and there's no runtime decision to
// make — every response benefits.
//
// What we set and why:
//
//   X-Content-Type-Options: nosniff
//     Stops browsers from MIME-sniffing a JSON response into something
//     executable (e.g. treating a ``\u003Cscript\u003E...\u003C/script\u003E``-bearing JSON
//     body as HTML). We only serve JSON and never intend to serve HTML — the
//     header reinforces that.
//
//   X-Frame-Options: DENY
//     Belt-and-suspenders against click-jacking of any future HTML surface
//     (admin UI, checkout page). JSON APIs don't need it, but costs nothing.
//
//   Referrer-Policy: no-referrer
//     Outbound navigations from any page we ever serve shouldn't leak the
//     full URL (which may carry invoice ids) to third parties.
//
//   Strict-Transport-Security: max-age=63072000; includeSubDomains
//     Tells browsers to refuse plaintext HTTP to this origin for 2 years.
//     Safe to send unconditionally — browsers ignore HSTS on plain HTTP and
//     production runs exclusively behind TLS-terminating proxies.
//
//   Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
//     Any response rendered as HTML by a misconfigured client gets no
//     inline scripts, no external scripts, no frames. JSON responses are
//     unaffected (CSP applies to HTML parsing).
//
// Intentionally NOT set:
//   - X-XSS-Protection: deprecated by modern browsers and can introduce
//     XS-Leaks in older ones. OWASP recommends leaving it off.
//   - Permissions-Policy: would require listing every sensor/api and drifts
//     as browsers evolve. Not worth the maintenance cost for a JSON API.

const HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'"
};

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    for (const [key, value] of Object.entries(HEADERS)) {
      // Don't clobber a downstream handler that intentionally set its own
      // (the checkout surface might one day need a permissive CSP).
      if (!c.res.headers.has(key)) {
        c.res.headers.set(key, value);
      }
    }
  };
}
