// The only approved way for core/domain to read configuration. Keeps
// `process.env` / Workers `env` binding / `Deno.env` access confined to a
// handful of adapter files (enforced by the ESLint no-restricted-globals rule).

export interface SecretsProvider {
  // Returns a required secret. Throws a typed error at boot if missing —
  // never returns undefined so domain code can use the value directly.
  getRequired(key: string): string;

  // Returns the value or `undefined` when unset. For genuinely optional config.
  getOptional(key: string): string | undefined;
}
