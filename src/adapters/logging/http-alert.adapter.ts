import type { LogFields, LogLevel } from "../../core/ports/logger.port.ts";

// Fire-and-forget HTTP alert sink. Designed to be plugged into consoleLogger's
// `alertSink` — every error-level (or higher, per `alertMinLevel`) log line is
// POSTed to the configured URL. Intended for Slack/Discord/PagerDuty Events
// API style endpoints, or an operator-run collector.
//
// Body shape is chosen from the URL:
//   - Discord webhook URLs (discord.com / discordapp.com /api/webhooks/…)
//     get a native Discord message: a one-line `content` headline plus an
//     embed carrying the structured fields and a JSON detail block. Discord
//     rejects any body without `content`/`embeds` with HTTP 400, so the raw
//     JSON shape below would be silently dropped there.
//   - Everything else gets the raw `{ level, line, fields }` JSON body.
//
// Delivery is best-effort: the caller gets void back synchronously and we
// never throw, even on network failure. The purpose of this adapter is
// *notification*, not durable log shipping — structured logs themselves are
// still written to stdout/stderr by the base console sink.
//
// Rate limiting: an in-memory token bucket caps sustained alert volume at
// `maxPerMinute` (default 30). Overflow increments a dropped counter that
// piggybacks on the next delivered message so operators can tell at a glance
// when they're being rate-limited. This prevents a crash loop from
// hammering the alert channel with thousands of duplicates per minute.

export interface HttpAlertConfig {
  // Webhook URL the JSON body is POSTed to.
  url: string;
  // Optional extra headers (e.g. Authorization). Content-Type is forced to
  // application/json regardless.
  headers?: Readonly<Record<string, string>>;
  // Per-minute cap on outbound alerts. Overflow is dropped and counted.
  // Default 30. Pass 0 to disable rate limiting (not recommended).
  maxPerMinute?: number;
  // Request timeout ms. Default 3000. A slow endpoint must not block the
  // calling log emit longer than this.
  timeoutMs?: number;
  // Custom fetch for tests.
  fetch?: typeof fetch;
  // Clock — tests inject a fixed time for rate-limit determinism.
  now?: () => number;
}

export type HttpAlertSink = (level: LogLevel, line: string, fields: LogFields) => void;

export function httpAlertSink(config: HttpAlertConfig): HttpAlertSink {
  const maxPerMinute = config.maxPerMinute ?? 30;
  const timeoutMs = config.timeoutMs ?? 3000;
  const doFetch = config.fetch ?? fetch;
  const clock = config.now ?? (() => Date.now());

  // Sliding-window counter: track timestamps of the last minute's worth of
  // sends. Bounded by maxPerMinute so memory stays tiny even under flood.
  const recent: number[] = [];
  let droppedSinceLast = 0;

  return (level, line, fields) => {
    const now = clock();
    // Drop anything older than 60s.
    while (recent.length > 0 && (recent[0] ?? 0) < now - 60_000) recent.shift();
    if (maxPerMinute > 0 && recent.length >= maxPerMinute) {
      droppedSinceLast += 1;
      return;
    }
    recent.push(now);
    const dropped = droppedSinceLast;
    droppedSinceLast = 0;

    // Fire-and-forget. We intentionally don't await — the logger emit path
    // must remain synchronous. Any error is swallowed.
    void postAlert({
      url: config.url,
      headers: config.headers ?? {},
      level,
      line,
      fields,
      timeoutMs,
      fetch: doFetch,
      ...(dropped > 0 ? { droppedSinceLastAlert: dropped } : {})
    });
  };
}

export interface PostAlertInput {
  url: string;
  headers?: Readonly<Record<string, string>>;
  level: LogLevel;
  // The already-serialized (and secret-redacted) log line.
  line: string;
  // Structured fields for the same event. NOTE: only `line` has been through
  // the logger's secret redaction, so Discord formatting prefers the parsed
  // line over these when the line is JSON.
  fields: LogFields;
  timeoutMs?: number;
  fetch?: typeof fetch;
  droppedSinceLastAlert?: number;
}

export interface PostAlertResult {
  ok: boolean;
  status?: number;
  error?: string;
}

// One-shot alert POST with the same URL-based body selection as the sink.
// Exported so code paths that run BEFORE a logger exists (worker boot
// failure) can still deliver a well-formed alert. Never throws.
export async function postAlert(input: PostAlertInput): Promise<PostAlertResult> {
  const doFetch = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? 3000;
  const body = formatAlertBody(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(input.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(input.headers ?? {}) },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function isDiscordWebhookUrl(url: string): boolean {
  return /^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\//i.test(url);
}

// Build the POST body for `url`. Pure — tests assert on it directly.
export function formatAlertBody(input: PostAlertInput): Record<string, unknown> {
  if (isDiscordWebhookUrl(input.url)) return formatDiscordBody(input);
  return {
    level: input.level,
    line: input.line,
    fields: input.fields,
    ...(input.droppedSinceLastAlert !== undefined && input.droppedSinceLastAlert > 0
      ? { droppedSinceLastAlert: input.droppedSinceLastAlert }
      : {})
  };
}

// ---- Discord ----
//
// Limits we stay inside (Discord rejects the whole message otherwise):
//   content ≤ 2000 · embed title ≤ 256 · embed description ≤ 4096 ·
//   ≤ 25 fields, name ≤ 256, value ≤ 1024 · total embed text ≤ 6000.

const DISCORD_CONTENT_MAX = 1900;
const DISCORD_TITLE_MAX = 240;
const DISCORD_DESCRIPTION_MAX = 3400;
const DISCORD_FIELD_VALUE_MAX = 200;
const DISCORD_MAX_SUMMARY_FIELDS = 10;

const COLOR_ERROR = 0xe74c3c;
const COLOR_WARN = 0xf39c12;
const COLOR_RECOVERY = 0x2ecc71;
const COLOR_INFO = 0x3498db;

// Fields that already appear in the headline / footer, so the detail block
// doesn't repeat them.
const HEADLINE_KEYS = new Set(["ts", "level", "msg", "service", "runtime", "alertKind"]);

function formatDiscordBody(input: PostAlertInput): Record<string, unknown> {
  const f = resolveFields(input.line, input.fields);
  const alertKind = typeof f["alertKind"] === "string" ? f["alertKind"] : undefined;
  const msg = typeof f["msg"] === "string" && f["msg"].length > 0 ? f["msg"] : "(no message)";
  const service = typeof f["service"] === "string" ? f["service"] : "crypto-gateway";
  const runtime = typeof f["runtime"] === "string" ? f["runtime"] : undefined;
  const ts = typeof f["ts"] === "string" ? f["ts"] : new Date().toISOString();

  const isRecovery = alertKind === "recovery";
  const color = isRecovery
    ? COLOR_RECOVERY
    : input.level === "error"
      ? COLOR_ERROR
      : input.level === "warn"
        ? COLOR_WARN
        : COLOR_INFO;
  const emoji = isRecovery ? "✅" : input.level === "error" ? "🚨" : input.level === "warn" ? "⚠️" : "ℹ️";
  const headline = isRecovery ? "recovered" : input.level === "error" ? "ERROR" : input.level.toUpperCase();

  // Scalars go into inline embed fields (readable at a glance); everything
  // (scalars + nested objects) goes into the JSON detail block.
  const rest: Record<string, unknown> = {};
  const summary: Array<{ name: string; value: string; inline: boolean }> = [];
  for (const [key, value] of Object.entries(f)) {
    if (HEADLINE_KEYS.has(key)) continue;
    rest[key] = value;
    if (summary.length >= DISCORD_MAX_SUMMARY_FIELDS) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      summary.push({ name: key.slice(0, 256), value: truncate(String(value), DISCORD_FIELD_VALUE_MAX) || "—", inline: true });
    }
  }

  let details: string;
  try {
    details = JSON.stringify(rest, null, 2) ?? "{}";
  } catch {
    details = "(fields not serializable)";
  }
  const description = "```json\n" + truncate(details, DISCORD_DESCRIPTION_MAX) + "\n```";

  const footerBits = [runtime, input.level];
  if (input.droppedSinceLastAlert !== undefined && input.droppedSinceLastAlert > 0) {
    footerBits.push(`${input.droppedSinceLastAlert} alert(s) dropped by rate limit since last delivery`);
  }

  return {
    content: truncate(`${emoji} **${service}** ${headline}: ${msg}`, DISCORD_CONTENT_MAX),
    embeds: [
      {
        title: truncate(msg, DISCORD_TITLE_MAX),
        color,
        timestamp: ts,
        ...(summary.length > 0 ? { fields: summary } : {}),
        description,
        footer: { text: footerBits.filter((b): b is string => typeof b === "string" && b.length > 0).join(" • ") }
      }
    ],
    // Never ping @everyone/@here even if a log message contains the literal text.
    allowed_mentions: { parse: [] }
  };
}

// Prefer the parsed JSON line (already secret-redacted by the logger) over
// the raw fields object; fall back to the fields when the line isn't JSON
// (pretty format) or fails to parse.
function resolveFields(line: string, fields: LogFields): Record<string, unknown> {
  if (line.startsWith("{")) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }
  return { ...fields };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 12)) + "…(truncated)";
}
