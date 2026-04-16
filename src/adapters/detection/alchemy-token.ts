import type { Logger } from "../../core/ports/logger.port.js";
import type { SecretsProvider } from "../../core/ports/secrets.port.js";

// Resolve the Alchemy Notify (webhook management) token from env.
//
// The env var was originally named ALCHEMY_AUTH_TOKEN, which turned out to
// be confusingly close to "auth token for RPC" — operators consistently
// fed the JSON-RPC API key into it and got 401s. The canonical name is now
// ALCHEMY_NOTIFY_TOKEN. The old name still works for one release cycle with
// a deprecation warning so existing deployments don't break on upgrade.

export function readAlchemyNotifyToken(
  secrets: SecretsProvider,
  logger?: Logger
): string | undefined {
  const preferred = secrets.getOptional("ALCHEMY_NOTIFY_TOKEN");
  if (preferred !== undefined) return preferred;
  const legacy = secrets.getOptional("ALCHEMY_AUTH_TOKEN");
  if (legacy !== undefined) {
    logger?.warn(
      "ALCHEMY_AUTH_TOKEN is deprecated; rename to ALCHEMY_NOTIFY_TOKEN (same value). The old name will be removed in a future release."
    );
    return legacy;
  }
  return undefined;
}

// Same as readAlchemyNotifyToken but reads from a raw env-like record — used
// by the Workers entrypoint, which accesses `env` directly rather than
// through a SecretsProvider.
export function readAlchemyNotifyTokenFromEnv(
  env: Readonly<Record<string, unknown>>,
  logger?: Logger
): string | undefined {
  const preferred = typeof env["ALCHEMY_NOTIFY_TOKEN"] === "string" ? (env["ALCHEMY_NOTIFY_TOKEN"] as string) : undefined;
  if (preferred !== undefined && preferred.length > 0) return preferred;
  const legacy = typeof env["ALCHEMY_AUTH_TOKEN"] === "string" ? (env["ALCHEMY_AUTH_TOKEN"] as string) : undefined;
  if (legacy !== undefined && legacy.length > 0) {
    logger?.warn(
      "ALCHEMY_AUTH_TOKEN is deprecated; rename to ALCHEMY_NOTIFY_TOKEN (same value). The old name will be removed in a future release."
    );
    return legacy;
  }
  return undefined;
}
