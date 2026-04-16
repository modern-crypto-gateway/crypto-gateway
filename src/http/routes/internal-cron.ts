import { Hono } from "hono";
import type { AppDeps } from "../../core/app-deps.js";
import { runScheduledJobs } from "../../core/domain/scheduled-jobs.js";

// HTTP trigger for external schedulers — Vercel Cron, Upstash QStash, an
// external monitor, or a bare curl from a k8s CronJob. Runs the same sequence
// of jobs as the Workers `scheduled` handler.
//
// Auth: `Authorization: Bearer <CRON_SECRET>`. Vercel Cron automatically sets
// this header when CRON_SECRET is defined in the project. Constant-time
// compared, blanket 401 on mismatch.

export function internalCronRouter(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/tick", async (c) => {
    const expected = deps.secrets.getOptional("CRON_SECRET");
    if (!expected) {
      // Cron endpoint disabled on this deployment.
      return c.json({ error: { code: "NOT_CONFIGURED" } }, 404);
    }

    const auth = c.req.header("authorization");
    const provided = extractBearer(auth);
    if (!provided || !constantTimeEqual(expected, provided)) {
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    }

    const result = await runScheduledJobs(deps);
    return c.json({ ok: true, result });
  });

  return app;
}

function extractBearer(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue);
  return match?.[1];
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
