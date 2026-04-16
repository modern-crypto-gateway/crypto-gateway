import type { SecretsProvider } from "../../core/ports/secrets.port.ts";

// SecretsProvider backed by `process.env`. Used by the Node entrypoint.
// The ESLint rule ban on `process` is narrowed to allow this file (see eslint.config.js).

export function processEnvSecrets(overrides: Readonly<Record<string, string>> = {}): SecretsProvider {
  // Snapshot at construction so callers can't mutate env out from under us mid-request.
  const snapshot: Record<string, string | undefined> = { ...process.env, ...overrides };

  return {
    getRequired(key: string): string {
      const value = snapshot[key];
      if (value === undefined || value === "") {
        throw new Error(`Required secret ${key} is not set`);
      }
      return value;
    },
    getOptional(key: string): string | undefined {
      const value = snapshot[key];
      return value === "" ? undefined : value;
    }
  };
}
