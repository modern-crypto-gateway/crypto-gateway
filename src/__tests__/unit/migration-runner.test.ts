import { describe, expect, it } from "vitest";
import { libsqlAdapter } from "../../adapters/db/libsql.adapter.js";
import { applyMigrations, type Migration } from "../../adapters/db/migration-runner.js";

function freshDb(): ReturnType<typeof libsqlAdapter> {
  return libsqlAdapter({ url: ":memory:" });
}

describe("applyMigrations", () => {
  it("creates the schema_migrations table and runs every given migration once", async () => {
    const db = freshDb();
    const migrations: Migration[] = [
      { id: "0001_init", sql: "CREATE TABLE IF NOT EXISTS foo (id TEXT PRIMARY KEY);" },
      { id: "0002_bar", sql: "CREATE TABLE IF NOT EXISTS bar (id TEXT PRIMARY KEY);" }
    ];

    const result = await applyMigrations(db, migrations);
    expect(result.applied).toEqual(["0001_init", "0002_bar"]);
    expect(result.skipped).toEqual([]);

    const rows = await db
      .prepare("SELECT id FROM schema_migrations ORDER BY id")
      .all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).toEqual(["0001_init", "0002_bar"]);
  });

  it("is idempotent: re-running with the same set applies nothing new", async () => {
    const db = freshDb();
    const migrations: Migration[] = [
      { id: "0001_init", sql: "CREATE TABLE IF NOT EXISTS foo (id TEXT PRIMARY KEY);" }
    ];

    await applyMigrations(db, migrations);
    const result = await applyMigrations(db, migrations);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(["0001_init"]);
  });

  it("applies only newly-added migrations on a second run", async () => {
    const db = freshDb();
    await applyMigrations(db, [
      { id: "0001_init", sql: "CREATE TABLE IF NOT EXISTS foo (id TEXT PRIMARY KEY);" }
    ]);

    const second = await applyMigrations(db, [
      { id: "0001_init", sql: "CREATE TABLE IF NOT EXISTS foo (id TEXT PRIMARY KEY);" },
      { id: "0002_bar", sql: "CREATE TABLE IF NOT EXISTS bar (id TEXT PRIMARY KEY);" }
    ]);

    expect(second.applied).toEqual(["0002_bar"]);
    expect(second.skipped).toEqual(["0001_init"]);
  });

  it("does NOT record a migration that throws, so a retry re-applies it", async () => {
    const db = freshDb();
    const migrations: Migration[] = [
      { id: "0001_broken", sql: "THIS IS NOT VALID SQL;" }
    ];

    await expect(applyMigrations(db, migrations)).rejects.toBeDefined();

    const rows = await db
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .bind("0001_broken")
      .all<{ id: string }>();
    expect(rows.results).toEqual([]);
  });
});
