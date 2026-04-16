import { createClient, type Client, type InValue } from "@libsql/client";
import type {
  AllResult,
  BatchResult,
  DbAdapter,
  PreparedStatement,
  RunResult
} from "../../core/ports/db.port.ts";

export interface LibsqlAdapterConfig {
  // libSQL URL. `file:./local.db`, `:memory:`, or `libsql://... @ Turso`.
  url: string;
  // Auth token for Turso-hosted instances. Ignored for local `file:` / `:memory:`.
  authToken?: string;
}

// Thin DbAdapter over @libsql/client. Preserves D1's prepare/bind/first/all/run
// surface so query call sites written against the DbAdapter port port mechanically.
//
// libSQL accepts a narrower set of bind types (strings/numbers/bigints/boolean/
// Date/Uint8Array/null) than JavaScript's `unknown`. We coerce at the boundary:
// Date -> epoch-ms integer, undefined -> null. bigint passes through.

export function libsqlAdapter(config: LibsqlAdapterConfig): DbAdapter {
  const client: Client = createClient({
    url: config.url,
    ...(config.authToken !== undefined ? { authToken: config.authToken } : {})
  });
  return libsqlAdapterFromClient(client);
}

export function libsqlAdapterFromClient(client: Client): DbAdapter {
  const prepareStatement = (sql: string, args: readonly unknown[]): PreparedStatement => {
    return new LibsqlPreparedStatement(client, sql, args);
  };

  return {
    prepare(sql) {
      return prepareStatement(sql, []);
    },

    async batch(statements) {
      const start = Date.now();
      const batched = statements.map((s) => {
        const impl = s as LibsqlPreparedStatement;
        return { sql: impl.sql, args: impl.coercedArgs() };
      });
      const results = await client.batch(batched, "write");
      const duration = Date.now() - start;
      return results.map<BatchResult>((r) => ({
        success: true,
        meta: {
          duration,
          changes: r.rowsAffected,
          ...(r.lastInsertRowid !== undefined ? { lastRowId: r.lastInsertRowid } : {})
        }
      }));
    },

    async exec(sql) {
      const start = Date.now();
      await client.executeMultiple(sql);
      const duration = Date.now() - start;
      // `executeMultiple` does not report a statement count; consumers (migrations)
      // rarely care about the exact number, so we return 0 and let the timing speak.
      return { count: 0, duration };
    }
  };
}

class LibsqlPreparedStatement implements PreparedStatement {
  constructor(
    private readonly client: Client,
    readonly sql: string,
    private readonly args: readonly unknown[]
  ) {}

  bind(...values: readonly unknown[]): PreparedStatement {
    return new LibsqlPreparedStatement(this.client, this.sql, [...this.args, ...values]);
  }

  coercedArgs(): InValue[] {
    return this.args.map(coerceBindValue);
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const rs = await this.client.execute({ sql: this.sql, args: this.coercedArgs() });
    const row = rs.rows[0];
    if (!row) return null;
    if (colName !== undefined) {
      const value = (row as unknown as Record<string, unknown>)[colName];
      return (value ?? null) as T | null;
    }
    return row as unknown as T;
  }

  async all<T = unknown>(): Promise<AllResult<T>> {
    const start = Date.now();
    const rs = await this.client.execute({ sql: this.sql, args: this.coercedArgs() });
    return {
      results: rs.rows as unknown as readonly T[],
      meta: {
        duration: Date.now() - start,
        changes: rs.rowsAffected
      }
    };
  }

  async run(): Promise<RunResult> {
    const start = Date.now();
    const rs = await this.client.execute({ sql: this.sql, args: this.coercedArgs() });
    return {
      success: true,
      meta: {
        duration: Date.now() - start,
        changes: rs.rowsAffected,
        ...(rs.lastInsertRowid !== undefined ? { lastRowId: rs.lastInsertRowid } : {})
      }
    };
  }
}

function coerceBindValue(value: unknown): InValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.getTime();
  if (value instanceof Uint8Array) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  // Anything else (objects, arrays) gets JSON-stringified. Callers should
  // normally serialize before bind, but this keeps call sites forgiving.
  return JSON.stringify(value);
}
