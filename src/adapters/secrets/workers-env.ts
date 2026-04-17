import type { SecretsProvider } from "../../core/ports/secrets.port.ts";

// SecretsProvider backed by a Cloudflare Worker's env binding. `env` is a
// plain object populated from wrangler.jsonc `vars` + `secrets` (injected via
// `wrangler secret put`) + binding objects (KV, rate-limit bindings, etc.).
//
// We accept `Record<string, unknown>` rather than the generated Env interface
// so this adapter stays decoupled from wrangler's type generation. The worker
// entrypoint is the only place that knows the full Env shape.

export function workersEnvSecrets(env: Record<string, unknown>): SecretsProvider {
  return {
    getRequired(key) {
      const value = env[key];
      if (typeof value !== "string" || value === "") {
        throw new Error(`Required secret ${key} is not set in the Worker env`);
      }
      return value;
    },
    getOptional(key) {
      const value = env[key];
      return typeof value === "string" && value !== "" ? value : undefined;
    }
  };
}
