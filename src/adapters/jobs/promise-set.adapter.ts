import type { JobRunner } from "../../core/ports/jobs.port.ts";

export interface PromiseSetJobsOptions {
  // Soft cap to surface leaks early: if more than `maxInFlight` tasks queue
  // up before any resolve, something is wrong upstream. Defaults to 500.
  maxInFlight?: number;
  // Optional sink for unhandled task errors. Defaults to console.error.
  onError?: (err: unknown, jobName?: string) => void;
}

// JobRunner for Node/Bun/Deno. Keeps a Set of in-flight promises so SIGTERM
// handlers can call `drain(timeoutMs)` for graceful shutdown before exit.
// On Workers, use wait-until.adapter.ts instead — it forwards to ctx.waitUntil.

export function promiseSetJobs(opts: PromiseSetJobsOptions = {}): JobRunner {
  const maxInFlight = opts.maxInFlight ?? 500;
  const onError =
    opts.onError ??
    ((err, name) => {
      // Node globals are allowed in this file (see eslint.config.js narrow override).
      console.error(`[jobs] deferred task ${name ?? "<anon>"} failed:`, err);
    });

  const inFlight = new Set<Promise<void>>();

  return {
    defer(task, deferOpts) {
      if (inFlight.size >= maxInFlight) {
        onError(new Error(`promiseSetJobs at capacity (${maxInFlight} in-flight); dropping task`), deferOpts?.name);
        return;
      }

      const run = async (): Promise<void> => {
        try {
          if (deferOpts?.timeoutMs !== undefined) {
            await Promise.race([
              task(),
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error(`Job ${deferOpts.name ?? "<anon>"} timed out after ${deferOpts.timeoutMs}ms`)), deferOpts.timeoutMs)
              )
            ]);
          } else {
            await task();
          }
        } catch (err) {
          onError(err, deferOpts?.name);
        }
      };

      const promise = run();
      inFlight.add(promise);
      void promise.finally(() => inFlight.delete(promise));
    },

    async drain(timeoutMs) {
      if (inFlight.size === 0) return;
      const all = Promise.all(Array.from(inFlight));
      await Promise.race([
        all,
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
      ]);
    },

    inFlight() {
      return inFlight.size;
    }
  };
}
