import { defineConfig } from "drizzle-kit";

// Drizzle Kit config — schema lives in src/db/schema.ts, generated migrations
// land in drizzle/migrations. Dialect is libSQL (Turso) — the same SQLite
// dialect works for local @libsql/client file URLs and remote Turso.
//
// Generate a new migration after editing the schema:
//   npx drizzle-kit generate
//
// Apply migrations against a remote Turso DB (Workers/Vercel-Edge ship with
// no filesystem, so migrations are applied CLI-side by operators):
//   TURSO_URL="libsql://..." TURSO_AUTH_TOKEN="..." npx drizzle-kit push
//
// Node / Deno entrypoints replay `drizzle/migrations/*` on boot via Drizzle's
// `migrate()`, so those runtimes don't need a CLI push — just restart.
//
// DATABASE_URL / DATABASE_TOKEN are accepted as legacy aliases for one
// release cycle; TURSO_URL / TURSO_AUTH_TOKEN are canonical.

const url = process.env["TURSO_URL"] ?? process.env["DATABASE_URL"] ?? "file:./local.db";
const authToken = process.env["TURSO_AUTH_TOKEN"] ?? process.env["DATABASE_TOKEN"];

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "turso",
  casing: "snake_case",
  dbCredentials: authToken !== undefined ? { url, authToken } : { url }
});
