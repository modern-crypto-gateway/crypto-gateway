import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Migration } from "./migration-runner.js";

// Node/Deno filesystem loader. Reads every `*.sql` file in `dir` and returns
// them as Migration rows sorted by filename. `dir` accepts either a `file://`
// URL (typical — callers pass `import.meta.url` + a relative path) or a plain
// absolute path string.
//
// NOT usable from Cloudflare Workers or Vercel Edge — both forbid synchronous
// filesystem access at runtime. Those runtimes apply migrations via a separate
// mechanism (wrangler CLI for D1, standalone migration script for Turso);
// this loader stays in adapter-land so the core doesn't accidentally import
// node:fs.

export function loadMigrationsFromDir(dir: URL | string): readonly Migration[] {
  const absDir = typeof dir === "string" ? dir : fileURLToPath(dir);
  const files = readdirSync(absDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  return files.map((filename) => {
    const id = filename.replace(/\.sql$/, "");
    const sql = readFileSync(resolve(absDir, filename), "utf8");
    return { id, sql };
  });
}
