import type { Logger, LogFields, LogLevel } from "../../core/ports/logger.port.ts";

export interface ConsoleLoggerConfig {
  // "json" emits one single-line JSON object per log (production friendly).
  // "pretty" emits a human-readable format (dev friendly).
  format?: "json" | "pretty";
  // Minimum level to emit. Below this the call is a no-op. Default "info".
  minLevel?: LogLevel;
  // Fixed fields merged into every log line (e.g. service name, environment).
  baseFields?: LogFields;
  // Clock function — tests inject a fixed timestamp for deterministic output.
  now?: () => Date;
  // Underlying sink. Defaults to console.{debug,error}. Swap in a buffer for tests.
  sink?: (level: LogLevel, line: string) => void;
  // Optional fan-out sink for critical log lines. Called in addition to `sink`
  // for any log at or above `alertMinLevel`. Fire-and-forget from the logger's
  // point of view — the adapter is responsible for its own retry/error
  // handling. A throw here must not propagate to the calling domain code.
  alertSink?: (level: LogLevel, line: string, fields: LogFields) => void;
  // Minimum level routed to `alertSink`. Default "error" — page-worthy only.
  alertMinLevel?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// Known secret-carrying patterns that appear in upstream error messages
// (viem RPC failures, fetch-level stack traces, Alchemy SDK logs). Applied to
// the final serialized line before the sink writes, so no caller has to
// remember to sanitize per-error fields. Conservative: only masks shapes we
// know leak real secrets — never generic tokens or IDs.
const SECRET_REDACTORS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // Alchemy-style RPC URLs with key in path: /v2/<key>, /nft/v2/<key>, etc.
  // The hostname is preserved so the log still identifies the provider.
  { pattern: /(\/v2\/)[A-Za-z0-9_-]{20,}/g, replacement: "$1[REDACTED]" },
  // Bearer tokens in Authorization headers echoed back in error strings.
  { pattern: /([Bb]earer\s+)[A-Za-z0-9_.\-]+/g, replacement: "$1[REDACTED]" },
  // `x-api-key`/`X-API-KEY` header values echoed in error strings or curl dumps.
  { pattern: /([Xx]-[Aa]pi-[Kk]ey['":\s]+)[A-Za-z0-9_\-]{12,}/g, replacement: "$1[REDACTED]" },
  // authToken=... in query strings or debug dumps.
  { pattern: /(auth[_-]?token['"]?\s*[:=]\s*['"]?)[A-Za-z0-9_\-.]{12,}/gi, replacement: "$1[REDACTED]" }
];

function redactSecrets(line: string): string {
  let out = line;
  for (const { pattern, replacement } of SECRET_REDACTORS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function consoleLogger(config: ConsoleLoggerConfig = {}): Logger {
  const format = config.format ?? "json";
  const minLevelOrder = LEVEL_ORDER[config.minLevel ?? "info"];
  const baseFields = config.baseFields ?? {};
  const now = config.now ?? (() => new Date());
  const sink =
    config.sink ??
    ((level, line) => {
      // The ESLint rule `no-console` warns on `.log` but allows `.warn` / `.error`.
      // Route debug+info to `.warn` so they appear in the same stream without
      // a linter exception (standardizing on stderr-ish output is the v1
      // convention the ops panel already ingests).
      if (level === "error") {
        console.error(line);
      } else {
        console.warn(line);
      }
    });
  const alertSink = config.alertSink;
  const alertMinOrder = LEVEL_ORDER[config.alertMinLevel ?? "error"];

  return makeLogger(baseFields);

  function makeLogger(boundFields: LogFields): Logger {
    const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
      if (LEVEL_ORDER[level] < minLevelOrder) return;
      const merged: LogFields = { ...boundFields, ...(fields ?? {}) };
      const timestamp = now().toISOString();
      const line = format === "json"
        ? JSON.stringify({ ts: timestamp, level, msg: message, ...merged })
        : formatPretty(timestamp, level, message, merged);
      const redacted = redactSecrets(line);
      sink(level, redacted);
      if (alertSink !== undefined && LEVEL_ORDER[level] >= alertMinOrder) {
        // Swallow sink exceptions — an alert channel failing must never break
        // the caller's normal logging path.
        try {
          alertSink(level, redacted, { ts: timestamp, msg: message, ...merged });
        } catch {
          // intentionally ignored
        }
      }
    };

    return {
      debug: (m, f) => emit("debug", m, f),
      info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f),
      error: (m, f) => emit("error", m, f),
      child: (fields) => makeLogger({ ...boundFields, ...fields })
    };
  }
}

function formatPretty(timestamp: string, level: LogLevel, message: string, fields: LogFields): string {
  const tag = level.toUpperCase().padEnd(5);
  const tail = Object.keys(fields).length === 0 ? "" : ` ${JSON.stringify(fields)}`;
  return `${timestamp} ${tag} ${message}${tail}`;
}

// No-op logger for tests that don't care about log output. `child` returns the
// same instance so bindings are silently ignored.
export function nullLogger(): Logger {
  const self: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => self
  };
  return self;
}

// Buffer-backed logger for tests that want to assert log output. `entries` is
// mutable and accumulates every emitted call.
export interface BufferingLoggerRecord {
  level: LogLevel;
  message: string;
  fields: LogFields;
}

export interface BufferingLogger extends Logger {
  entries: BufferingLoggerRecord[];
}

export function bufferingLogger(): BufferingLogger {
  const entries: BufferingLoggerRecord[] = [];
  const make = (bound: LogFields): Logger => {
    const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields: { ...bound, ...(fields ?? {}) } });
    };
    return {
      debug: (m, f) => emit("debug", m, f),
      info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f),
      error: (m, f) => emit("error", m, f),
      child: (fields) => make({ ...bound, ...fields })
    };
  };
  const root = make({});
  return Object.assign(root, { entries });
}
