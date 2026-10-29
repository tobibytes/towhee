import type { RoomKey } from "@towhee/auth";
import { validateRoomKeys } from "@towhee/auth";
import type { ServerOptions } from "./server";

export interface EnvConfig {
  server: ServerOptions;
  port: number;
  host: string;
}

/**
 * Reads the server's settings from environment variables:
 *
 * - `TOWHEE_KEYS`: JSON array of keys, `[{"id":"main","secret":"...","rooms":"app:*"}]`
 * - `TOWHEE_SECRET`: shortcut for one key with id `default` covering every room
 * - `TOWHEE_DATA`: SQLite file (default `./data/towhee.sqlite`)
 * - `PORT` or `TOWHEE_PORT` (default 8080), `TOWHEE_HOST` (default 0.0.0.0)
 * - `TOWHEE_UNLOAD_AFTER_MS`, `TOWHEE_MAX_CONNECTIONS`, `TOWHEE_MAX_MESSAGE_BYTES`, `TOWHEE_MAX_DOCUMENT_BYTES`
 * - `TOWHEE_ADMIN_SECRET`: turns on the admin API at /v1/admin (at least 32 characters)
 * - `TOWHEE_WEBHOOK_URL` and `TOWHEE_WEBHOOK_SECRET`: POST each notification to your app, signed
 */
function requireWebhookSecret(secret: string | undefined): string {
  if (!secret || secret.length < 32) throw new Error("TOWHEE_WEBHOOK_URL needs TOWHEE_WEBHOOK_SECRET (at least 32 characters)");
  return secret;
}

export function configFromEnv(env: Record<string, string | undefined>): EnvConfig {
  let keys: RoomKey[];
  if (env.TOWHEE_KEYS) {
    try {
      keys = JSON.parse(env.TOWHEE_KEYS) as RoomKey[];
    } catch {
      throw new Error("TOWHEE_KEYS must be a JSON array like [{\"id\":\"main\",\"secret\":\"...\"}]");
    }
  } else if (env.TOWHEE_SECRET) {
    keys = [{ id: "default", secret: env.TOWHEE_SECRET }];
  } else {
    throw new Error("Set TOWHEE_SECRET (one key) or TOWHEE_KEYS (several). Make a secret with: node -e \"console.log(crypto.randomBytes(32).toString('base64url'))\"");
  }
  validateRoomKeys(keys);

  const number = (name: string, fallback?: number): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number`);
    return value;
  };
  const limits = Object.fromEntries(
    (
      [
        ["maxConnections", number("TOWHEE_MAX_CONNECTIONS")],
        ["maxMessageBytes", number("TOWHEE_MAX_MESSAGE_BYTES")],
        ["maxDocumentBytes", number("TOWHEE_MAX_DOCUMENT_BYTES")],
      ] as const
    ).filter(([, v]) => v !== undefined),
  );

  return {
    server: {
      keys,
      dataPath: env.TOWHEE_DATA || "./data/towhee.sqlite",
      limits,
      unloadAfterMs: number("TOWHEE_UNLOAD_AFTER_MS"),
      ...(env.TOWHEE_ADMIN_SECRET ? { adminSecret: env.TOWHEE_ADMIN_SECRET } : {}),
      ...(env.TOWHEE_WEBHOOK_URL ? { webhook: { url: env.TOWHEE_WEBHOOK_URL, secret: requireWebhookSecret(env.TOWHEE_WEBHOOK_SECRET) } } : {}),
    },
    port: number("TOWHEE_PORT", number("PORT", 8080))!,
    host: env.TOWHEE_HOST || "0.0.0.0",
  };
}
