import type { DbAdapter } from "../../core/ports/db.port.js";

export interface Migration {
  // Monotonic identifier. Filenames like `0001_initial` produce lexicographic
  // ordering — newer migrations MUST have a higher id than any predecessor or
  // a deployed instance will refuse to apply them.
  id: string;
  sql: string;
}

export interface ApplyMigrationsResult {
  applied: readonly string[];
  skipped: readonly string[];
}

// Creates the tracking table (if absent) and applies every pending migration
// in the given order. Idempotent: previously-applied ids are skipped. Each
// migration's SQL is executed via `db.exec` so it can contain multiple
// statements; individual adapter implementations are responsible for
// statement splitting (libSQL's `executeMultiple`, D1's native multi-stmt
// exec).
//
// Atomicity caveat: we do NOT wrap (DDL + tracking-insert) in a transaction.
// Most dialects don't allow DDL inside transactions, and D1 has no
// multi-statement transaction at all. If a migration fails partway through,
// the schema_migrations row is NOT inserted — so a retry will re-run it.
// Every migration SQL must therefore be idempotent (CREATE TABLE IF NOT
// EXISTS, CREATE INDEX IF NOT EXISTS, etc.), which the initial migration
// already is.
export async function applyMigrations(
  db: DbAdapter,
  migrations: readonly Migration[]
): Promise<ApplyMigrationsResult> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL
     );`
  );

  const applied = await db
    .prepare("SELECT id FROM schema_migrations")
    .all<{ id: string }>();
  const alreadyApplied = new Set(applied.results.map((r) => r.id));

  const appliedIds: string[] = [];
  const skippedIds: string[] = [];

  for (const migration of migrations) {
    if (alreadyApplied.has(migration.id)) {
      skippedIds.push(migration.id);
      continue;
    }
    await db.exec(migration.sql);
    await db
      .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
      .bind(migration.id, Date.now())
      .run();
    appliedIds.push(migration.id);
  }

  return { applied: appliedIds, skipped: skippedIds };
}
