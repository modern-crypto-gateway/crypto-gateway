import type { LogFields, LogLevel } from "../../core/ports/logger.port.ts";

// Fire-and-forget HTTP alert sink. Designed to be plugged into consoleLogger's
// `alertSink` — every error-level (or higher, per `alertMinLevel`) log line is
// POSTed to the configured URL as a JSON body. Intended for Slack/Discord/
// PagerDuty Events API style endpoints, or an operator-run collector.
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
    const body: Record<string, unknown> = {
      level,
      line,
      fields,
      ...(droppedSinceLast > 0 ? { droppedSinceLastAlert: droppedSinceLast } : {})
    };
    droppedSinceLast = 0;

    // Fire-and-forget. We intentionally don't await — the logger emit path
    // must remain synchronous. Any error is swallowed.
    void send(doFetch, config.url, config.headers ?? {}, body, timeoutMs);
  };
}

async function send(
  doFetch: typeof fetch,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch {
    // Swallow — best effort.
  } finally {
    clearTimeout(timer);
  }
}
