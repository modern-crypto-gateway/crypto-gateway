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
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

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

  return makeLogger(baseFields);

  function makeLogger(boundFields: LogFields): Logger {
    const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
      if (LEVEL_ORDER[level] < minLevelOrder) return;
      const merged: LogFields = { ...boundFields, ...(fields ?? {}) };
      const timestamp = now().toISOString();
      if (format === "json") {
        sink(level, JSON.stringify({ ts: timestamp, level, msg: message, ...merged }));
      } else {
        sink(level, formatPretty(timestamp, level, message, merged));
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
