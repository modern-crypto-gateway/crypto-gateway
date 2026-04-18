// Shared db-error predicates. Domain services that catch driver errors look
// here for the predicate rather than re-implementing the cause-chain walk.

export function isUniqueViolation(err: unknown): boolean {
  // libSQL / SQLite surface UNIQUE violations with "UNIQUE constraint failed"
  // in the message. Drizzle wraps the driver error in a DrizzleQueryError whose
  // own message is "Failed query: ..." — walk the `.cause` chain to find the
  // inner error. libsql's batch path also wraps, so the walk handles both.
  let current: unknown = err;
  while (current instanceof Error) {
    if (/UNIQUE constraint failed/i.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
