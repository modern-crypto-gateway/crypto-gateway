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
// in the given order. Idempotent: previously-applied ids are skipped.
//
// Atomicity: each migration's DDL + the schema_migrations INSERT are sent as
// a single multi-statement `db.exec` call wrapped in BEGIN/COMMIT. Both
// SQLite-family adapters we ship (D1, libSQL) support DDL inside transactions
// and execute the batch atomically; a failure anywhere in the migration rolls
// back the partial DDL AND the tracking insert together, so a retry starts
// from a clean slate. This lets migrations use non-idempotent DDL like
// `ALTER TABLE ADD COLUMN` (which SQLite has no IF NOT EXISTS for) without
// risking "duplicate column" errors on retry.
//
// Each migration SHOULD still prefer `IF NOT EXISTS`-style DDL where it's
// available, so a manual partial-apply is easy to reconcile. Any migration
// SQL must NOT include its own BEGIN/COMMIT — the runner wraps it.
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
    const appliedAt = Date.now();
    // Embed the tracking insert into the migration's own exec call so they
    // commit as one atomic unit. Values are literal (not parameterized)
    // because `exec` is multi-statement-only and doesn't bind — the id comes
    // from trusted migration metadata, not user input.
    const idLiteral = sqlEscapeLiteral(migration.id);
    const wrapped =
      `BEGIN;\n` +
      `${migration.sql}\n` +
      `INSERT INTO schema_migrations (id, applied_at) VALUES (${idLiteral}, ${appliedAt});\n` +
      `COMMIT;`;
    await db.exec(wrapped);
    appliedIds.push(migration.id);
  }

  return { applied: appliedIds, skipped: skippedIds };
}

// Escape a string value for safe embedding in SQL. Doubles single quotes.
// Guards only against accidental quote-in-id — migration ids come from our
// own filenames, never user input, so the adversarial threat model is nil.
function sqlEscapeLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
