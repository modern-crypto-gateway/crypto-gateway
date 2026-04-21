import { describe, expect, it } from "vitest";
import { createLibsqlClient } from "../../db/client.js";
import { assertSchemaInSync } from "../../entrypoints/node.js";
import { bufferingLogger } from "../../adapters/logging/console.adapter.js";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { unlink } from "node:fs/promises";

// `assertSchemaInSync` is the startup guard against the "edit 0000_initial.sql
// in place, journal says already-applied, silent schema drift" footgun.
// Protects the pre-prod cutover — must fail loud if `fee_wallets` (or any
// future dropped table) still exists.

describe("assertSchemaInSync startup guard", () => {
  async function freshClient(): Promise<{ client: ReturnType<typeof createLibsqlClient>; path: string; cleanup: () => Promise<void> }> {
    const path = resolve(tmpdir(), `schema-drift-test-${globalThis.crypto.randomUUID()}.db`);
    const client = createLibsqlClient({ url: `file:${path}` });
    return {
      client,
      path,
      cleanup: async () => {
        client.close();
        await unlink(path).catch(() => {});
      }
    };
  }

  it("passes on a DB that does NOT contain the dropped fee_wallets table", async () => {
    const { client, cleanup } = await freshClient();
    try {
      const logger = bufferingLogger();
      // No fee_wallets CREATE — baseline fresh DB.
      await expect(assertSchemaInSync(client, logger)).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("throws loudly when the DB still contains fee_wallets (upgraded-in-place scenario)", async () => {
    const { client, cleanup } = await freshClient();
    try {
      // Simulate a pre-refactor DB: create the old fee_wallets table.
      await client.execute("CREATE TABLE fee_wallets (id text primary key)");
      const logger = bufferingLogger();
      await expect(assertSchemaInSync(client, logger)).rejects.toThrow(
        /Schema drift detected.*fee_wallets/
      );
      // Operator-facing log carries the table name so alerting can key on it.
      const errorLog = logger.entries.find((e) => e.message === "startup_schema_drift");
      expect(errorLog).toBeDefined();
      expect(errorLog?.fields?.["table"]).toBe("fee_wallets");
    } finally {
      await cleanup();
    }
  });
});
