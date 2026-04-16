// Structured logging port. Levels follow the RFC-5424 convention trimmed to
// the four we actually emit. `fields` is a plain JSON-safe object — the adapter
// decides how to render (pretty in dev, one-line JSON in prod, etc.).
//
// `child(fields)` returns a new Logger whose subsequent calls always include
// those fields. The dispatching chain of bound fields is how we tag a whole
// request's logs with a request_id without threading it through every signature.

export type LogFields = Record<string, unknown>;

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;

  // Returns a logger whose every subsequent call emits the merged fields.
  // Bound fields are shallow-merged, with the new call's fields winning on conflict.
  child(fields: LogFields): Logger;
}
