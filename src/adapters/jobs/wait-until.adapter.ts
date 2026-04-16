import type { ExecutionContext } from "@cloudflare/workers-types";
import type { JobRunner } from "../../core/ports/jobs.port.ts";

// JobRunner backed by Cloudflare's `ctx.waitUntil`. The Workers runtime keeps
// the request isolate alive until every waitUntil'd promise settles (up to the
// 30s CPU-time limit per tail), so `defer` just forwards to it. There's no
// local in-flight tracking — waitUntil owns the lifetime.
//
// `drain()` is a no-op because the Workers runtime already drains on its own;
// Node's promise-set adapter is the one that needs an explicit drain on SIGTERM.

export function waitUntilJobs(ctx: ExecutionContext): JobRunner {
  const onError = (err: unknown, name?: string): void => {
    // `console` is available on Workers; `.error` is permitted by our ESLint rule.
    console.error(`[jobs] deferred task ${name ?? "<anon>"} failed:`, err);
  };

  return {
    defer(task, opts) {
      const wrapped = (async () => {
        try {
          if (opts?.timeoutMs !== undefined) {
            await Promise.race([
              task(),
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error(`Job ${opts.name ?? "<anon>"} timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs)
              )
            ]);
          } else {
            await task();
          }
        } catch (err) {
          onError(err, opts?.name);
        }
      })();
      ctx.waitUntil(wrapped);
    },

    async drain() {
      // Workers runtime handles draining on its own.
    },

    inFlight() {
      // Workers doesn't expose a count. Consumers of this method (tests,
      // health checks) should branch on the runtime, or accept 0 as "not tracked".
      return 0;
    }
  };
}
