import { createClient, type Client, type Config } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

// Typed Drizzle factory over a single libSQL `Client`. `@libsql/client`'s
// package.json conditional exports route to `./web.js` on workerd + edge-light
// (pure HTTP, no node:net) and `./node.js` on Node/Deno (supports WS for
// lower latency). One import, all runtimes — the entrypoint just has to pass
// a url + authToken.

export type Db = LibSQLDatabase<typeof schema>;

export interface LibsqlClientConfig {
  // libSQL URL: `libsql://<db>-<org>.turso.io` for hosted Turso, or
  // `file:./local.db` / `:memory:` for local dev and tests.
  url: string;
  // Required for Turso-hosted instances; ignored for local `file:` / `:memory:`.
  authToken?: string;
}

export function createLibsqlClient(config: LibsqlClientConfig): Client {
  const clientConfig: Config = {
    url: config.url,
    ...(config.authToken !== undefined ? { authToken: config.authToken } : {})
  };
  return createClient(clientConfig);
}

// Produces a Drizzle db typed against the full schema. `casing: "snake_case"`
// matches drizzle.config.ts so TS field names (camelCase) round-trip with the
// SQL column names (snake_case) declared in `schema.ts` without explicit
// aliasing at each call site.
export function createDb(client: Client): Db {
  return drizzle(client, { schema, casing: "snake_case" });
}
