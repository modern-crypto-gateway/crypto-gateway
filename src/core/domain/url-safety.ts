// Merchant-supplied URLs (outbound webhook targets) are a classic SSRF vector.
// A malicious merchant who registers, say, `http://169.254.169.254/latest/
// meta-data/iam/security-credentials/` will get the gateway to POST event
// payloads at cloud metadata services on every invoice:completed. Even when
// we don't surface the response body, the mere act of issuing requests from
// the gateway's network vantage point is what matters — reaching otherwise
// private services, probing port reachability, or coaxing state changes out
// of loosely-authenticated internal endpoints.
//
// This module enforces a conservative allow-scheme + deny-host policy for any
// URL we will eventually `fetch` with merchant authority. It is a defense-in-
// depth guard applied both at ingress (so a bad URL is rejected at
// registration time) and at dispatch time (so a record stored before this
// guard existed still can't reach a forbidden host). The deny list covers
// hostname-literal attacks; it does NOT resolve DNS to catch name-based
// rebinding, which requires runtime-specific DNS APIs and is considered a
// Tier-2 hardening step.

export type UrlSafetyError =
  | "INVALID_URL"
  | "UNSUPPORTED_SCHEME"
  | "FORBIDDEN_HOST"
  | "FORBIDDEN_PORT";

export interface UrlSafetyResult {
  ok: boolean;
  reason?: UrlSafetyError;
  detail?: string;
}

// Hostnames matched as literal lower-case strings before any parsing trick.
// `metadata.google.internal` and `metadata.goog` serve GCP credentials; the
// two AWS/Azure/DO metadata endpoints live at the 169.254.169.254 link-local
// IP, so the numeric check below catches those.
const DENIED_HOSTNAMES: ReadonlySet<string> = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "localhost",
  "ip6-localhost",
  "ip6-loopback"
]);

// IPv4 deny ranges expressed as [first, last] 32-bit integers, inclusive.
// Covers: loopback, link-local (RFC 3927, including AWS/GCP/Azure metadata
// at 169.254.169.254), private (RFC 1918), carrier-grade NAT, benchmark,
// unspecified, and multicast / reserved.
const IPV4_DENY_RANGES: ReadonlyArray<readonly [number, number]> = [
  [ipv4ToInt(0, 0, 0, 0), ipv4ToInt(0, 255, 255, 255)],         // 0.0.0.0/8 — unspecified
  [ipv4ToInt(10, 0, 0, 0), ipv4ToInt(10, 255, 255, 255)],       // 10/8
  [ipv4ToInt(100, 64, 0, 0), ipv4ToInt(100, 127, 255, 255)],    // 100.64/10 — CGNAT
  [ipv4ToInt(127, 0, 0, 0), ipv4ToInt(127, 255, 255, 255)],     // 127/8 — loopback
  [ipv4ToInt(169, 254, 0, 0), ipv4ToInt(169, 254, 255, 255)],   // 169.254/16 — link-local
  [ipv4ToInt(172, 16, 0, 0), ipv4ToInt(172, 31, 255, 255)],     // 172.16/12
  [ipv4ToInt(192, 0, 0, 0), ipv4ToInt(192, 0, 0, 255)],         // 192.0.0/24 — IETF
  [ipv4ToInt(192, 0, 2, 0), ipv4ToInt(192, 0, 2, 255)],         // 192.0.2/24 — TEST-NET
  [ipv4ToInt(192, 168, 0, 0), ipv4ToInt(192, 168, 255, 255)],   // 192.168/16
  [ipv4ToInt(198, 18, 0, 0), ipv4ToInt(198, 19, 255, 255)],     // 198.18/15 — benchmark
  [ipv4ToInt(198, 51, 100, 0), ipv4ToInt(198, 51, 100, 255)],   // TEST-NET-2
  [ipv4ToInt(203, 0, 113, 0), ipv4ToInt(203, 0, 113, 255)],     // TEST-NET-3
  [ipv4ToInt(224, 0, 0, 0), ipv4ToInt(255, 255, 255, 255)]      // multicast + reserved
];

// Ports we never want outbound events to reach. These are internal service
// endpoints (databases, caches, metrics) where even an unauthenticated POST
// with no inspection of the response can trigger side effects or DoS.
const DENIED_PORTS: ReadonlySet<number> = new Set([
  22,     // SSH
  23,     // Telnet
  25,     // SMTP
  111,    // portmap
  135,    // MSRPC
  139,    // NetBIOS
  445,    // SMB
  465,    // SMTPS
  587,    // SMTP submission
  1433,   // MSSQL
  2049,   // NFS
  2375,   // Docker
  2376,   // Docker TLS
  3306,   // MySQL
  3389,   // RDP
  4369,   // erlang port mapper
  5432,   // Postgres
  5672,   // AMQP
  5984,   // CouchDB
  6379,   // Redis
  9200,   // Elasticsearch
  9300,   // Elasticsearch internode
  11211,  // Memcached
  15672,  // RabbitMQ mgmt
  25565,  // Minecraft (benign — often repurposed as honeypot probe)
  27017,  // MongoDB
  27018,  // MongoDB shard
  27019   // MongoDB config
]);

// Require https for production deployments; http is only ever acceptable
// when the caller opts in (local dev, integration tests).
export interface UrlSafetyOptions {
  // If true, http:// is allowed in addition to https://. Default: false.
  // Tests and local-dev entrypoints pass `true`; everywhere else rejects http.
  allowHttp?: boolean;
}

export function assertWebhookUrlSafe(url: string, opts: UrlSafetyOptions = {}): UrlSafetyResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "INVALID_URL", detail: "not a parseable URL" };
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "https:" && !(opts.allowHttp === true && scheme === "http:")) {
    return {
      ok: false,
      reason: "UNSUPPORTED_SCHEME",
      detail: `only ${opts.allowHttp ? "http:// or https://" : "https://"} is allowed (got ${scheme})`
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname.length === 0) {
    return { ok: false, reason: "INVALID_URL", detail: "missing host" };
  }

  // Literal-name block list (covers metadata hostnames that don't resolve to
  // a detectable link-local IP literal — e.g. GCP's `metadata.google.internal`
  // resolves inside the VPC only).
  if (DENIED_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: "FORBIDDEN_HOST", detail: `hostname '${hostname}' is blocked` };
  }

  // IPv4 literal — check against private / loopback / link-local ranges.
  const ipv4 = parseIpv4(hostname);
  if (ipv4 !== null) {
    for (const [lo, hi] of IPV4_DENY_RANGES) {
      if (ipv4 >= lo && ipv4 <= hi) {
        return {
          ok: false,
          reason: "FORBIDDEN_HOST",
          detail: `IPv4 ${hostname} is in a private/reserved range`
        };
      }
    }
  }

  // IPv6 literal — reject any loopback, unspecified, link-local, unique-local,
  // or mapped IPv4. Cheap: the string representation captures these by prefix.
  if (isIpv6Literal(hostname)) {
    if (isForbiddenIpv6(hostname)) {
      return {
        ok: false,
        reason: "FORBIDDEN_HOST",
        detail: `IPv6 ${hostname} is in a private/reserved range`
      };
    }
  }

  // Explicit port check. Default port (empty) means the scheme's canonical
  // port (80 / 443) which is always fine.
  if (parsed.port !== "") {
    const port = Number(parsed.port);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      return { ok: false, reason: "INVALID_URL", detail: `invalid port '${parsed.port}'` };
    }
    if (DENIED_PORTS.has(port)) {
      return { ok: false, reason: "FORBIDDEN_PORT", detail: `port ${port} is blocked` };
    }
  }

  return { ok: true };
}

function ipv4ToInt(a: number, b: number, c: number, d: number): number {
  // Unsigned 32-bit packing. `>>> 0` keeps the result non-negative so the
  // range comparisons below work with ordinary JS numbers.
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function parseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return ipv4ToInt(nums[0]!, nums[1]!, nums[2]!, nums[3]!);
}

function isIpv6Literal(host: string): boolean {
  // URL parsing strips the surrounding brackets from IPv6 literals, so a bare
  // colon-rich hostname is the signal.
  return host.includes(":");
}

function isForbiddenIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;                              // unspecified, loopback
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) {
    return true; // fe80::/10 link-local
  }
  if (h.startsWith("fc") || h.startsWith("fd")) return true;               // fc00::/7 unique-local
  if (h.startsWith("ff")) return true;                                      // ff00::/8 multicast
  if (h.startsWith("::ffff:")) return true;                                 // mapped IPv4 — re-do v4 check
  if (h.startsWith("64:ff9b:")) return true;                                // IPv4/IPv6 translation
  return false;
}
