// Abstracts fire-and-forget work. On Workers `defer` forwards to `ctx.waitUntil`;
// on Node it tracks the promise in an in-process set so `drain` can flush on
// SIGTERM. Callers must NOT await the deferred task — `defer` is the explicit
// opt-in for "this continues after the response is sent".

export interface JobRunner {
  defer(task: () => Promise<void>, opts?: { name?: string; timeoutMs?: number }): void;

  // Wait up to `timeoutMs` for in-flight deferred tasks to finish. No-op on Workers
  // (the runtime itself waits on waitUntil). Used by node.ts on SIGTERM for a clean shutdown.
  drain(timeoutMs: number): Promise<void>;

  inFlight(): number;
}
