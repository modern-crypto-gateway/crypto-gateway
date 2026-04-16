import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type {
  AllResult,
  BatchResult,
  DbAdapter,
  PreparedStatement,
  RunResult
} from "../../core/ports/db.port.ts";

// DbAdapter over a Cloudflare D1 binding. The DbAdapter port was shaped after
// D1's API on purpose (prepare/bind/first/all/run), so this adapter is almost
// a one-to-one pass-through. Only the result-metadata shape differs slightly
// between D1's native types and our port, so we normalize it here.

export function d1Adapter(db: D1Database): DbAdapter {
  return {
    prepare(sql) {
      return new D1PreparedStatementAdapter(db.prepare(sql));
    },

    async batch(statements) {
      const d1Statements = statements.map((s) => {
        const impl = s as D1PreparedStatementAdapter;
        return impl.underlying;
      });
      const results = await db.batch(d1Statements);
      return results.map<BatchResult>((r) => ({
        success: r.success,
        meta: {
          duration: r.meta?.duration ?? 0,
          ...(r.meta?.changes !== undefined ? { changes: r.meta.changes } : {}),
          ...(r.meta?.last_row_id !== undefined ? { lastRowId: r.meta.last_row_id } : {})
        }
      }));
    },

    async exec(sql) {
      const result = await db.exec(sql);
      return { count: result.count, duration: result.duration };
    }
  };
}

class D1PreparedStatementAdapter implements PreparedStatement {
  constructor(readonly underlying: D1PreparedStatement) {}

  bind(...values: readonly unknown[]): PreparedStatement {
    // D1's bind returns a new statement with args attached — it does NOT
    // accept `readonly` arrays as the rest arg type, so we spread.
    return new D1PreparedStatementAdapter(this.underlying.bind(...(values as unknown[])));
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    if (colName !== undefined) {
      const value = await this.underlying.first<T>(colName);
      return value ?? null;
    }
    const row = await this.underlying.first<T>();
    return row ?? null;
  }

  async all<T = unknown>(): Promise<AllResult<T>> {
    const result = await this.underlying.all<T>();
    return {
      results: (result.results ?? []) as readonly T[],
      meta: {
        duration: result.meta?.duration ?? 0,
        ...(result.meta?.changes !== undefined ? { changes: result.meta.changes } : {})
      }
    };
  }

  async run(): Promise<RunResult> {
    const result = await this.underlying.run();
    return {
      success: result.success,
      meta: {
        duration: result.meta?.duration ?? 0,
        ...(result.meta?.changes !== undefined ? { changes: result.meta.changes } : {}),
        ...(result.meta?.last_row_id !== undefined ? { lastRowId: result.meta.last_row_id } : {})
      }
    };
  }
}
