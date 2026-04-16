// Shaped like Cloudflare D1 on purpose. v1 has 243 direct D1 call sites using
// `prepare().bind().first() / .all() / .run()`; keeping that surface means
// queries port mechanically to libSQL and Postgres adapters without rewriting
// call sites. Any temptation to "improve" this into a query-builder should be
// resisted — adapters stay thin, query strings live with the call site.

export interface QueryMeta {
  // Milliseconds spent in the underlying driver. Useful for slow-query logging.
  duration: number;
  // Rows affected by a write (INSERT/UPDATE/DELETE). Undefined for reads.
  changes?: number;
  // Last inserted rowid for AUTOINCREMENT tables; only meaningful for INSERT.
  lastRowId?: number | bigint;
}

export interface AllResult<T> {
  results: readonly T[];
  meta: QueryMeta;
}

export interface RunResult {
  success: boolean;
  meta: QueryMeta;
}

export interface PreparedStatement {
  // Positional bind only. D1 supports named bindings but to keep the widest
  // compatibility across libSQL + D1 + pg-adapter, the domain uses positional.
  bind(...values: readonly unknown[]): PreparedStatement;

  // Returns the first row (or a single column if `colName` is provided), or null
  // when the query returns zero rows.
  first<T = unknown>(colName?: string): Promise<T | null>;

  all<T = unknown>(): Promise<AllResult<T>>;

  run(): Promise<RunResult>;
}

export interface BatchResult {
  success: boolean;
  meta: QueryMeta;
}

export interface DbAdapter {
  prepare(sql: string): PreparedStatement;

  // Atomic across adapters that support it (D1, libSQL). The pg adapter wraps
  // the statements in a single transaction.
  batch(statements: readonly PreparedStatement[]): Promise<readonly BatchResult[]>;

  // Multi-statement DDL used for migrations. Not parameterized.
  exec(sql: string): Promise<{ count: number; duration: number }>;
}
