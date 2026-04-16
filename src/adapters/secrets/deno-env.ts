import type { SecretsProvider } from "../../core/ports/secrets.port.ts";

// SecretsProvider backed by `Deno.env`. Used by the Deno entrypoint + any Deno
// Deploy deployment. The ESLint rule narrow-override allows `Deno` in this file.

// Local type declaration. Keeps `Deno` from leaking into the global scope of
// the rest of the project — other files stay blind to it.
declare const Deno: {
  env: {
    get(name: string): string | undefined;
    toObject(): Record<string, string>;
  };
};

export function denoEnvSecrets(overrides: Readonly<Record<string, string>> = {}): SecretsProvider {
  // Snapshot at construction so callers can't race an env mutation mid-request.
  const snapshot: Record<string, string | undefined> = { ...Deno.env.toObject(), ...overrides };

  return {
    getRequired(key) {
      const value = snapshot[key];
      if (value === undefined || value === "") {
        throw new Error(`Required secret ${key} is not set`);
      }
      return value;
    },
    getOptional(key) {
      const value = snapshot[key];
      return value === "" ? undefined : value;
    }
  };
}
