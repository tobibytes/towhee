/**
 * Webhook signatures. Towhee signs each webhook it sends: header `x-towhee-timestamp` holds the
 * time in seconds and `x-towhee-signature` holds `v1=` plus the hex HMAC-SHA256 of
 * `<timestamp>.<body>` with the webhook secret. Apps check it with {@link verifyWebhook}.
 */

const utf8 = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keys.set(secret, key);
  }
  return key;
}

const toHex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

function fromHex(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** The `x-towhee-signature` value for a body sent at `timestamp` (seconds). */
export async function signWebhook(secret: string, timestamp: number, body: string): Promise<string> {
  if (typeof secret !== "string" || secret.length < 32) throw new TypeError("The webhook secret must be at least 32 characters");
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8.encode(`${timestamp}.${body}`));
  return `v1=${toHex(signature)}`;
}

export interface WebhookToVerify {
  /** The raw request body, exactly as received. */
  body: string;
  /** The `x-towhee-timestamp` header. */
  timestamp: string | null;
  /** The `x-towhee-signature` header. */
  signature: string | null;
}

/**
 * Whether a webhook really came from Towhee: the signature matches (checked in constant time) and
 * the timestamp is within `toleranceSeconds` (default 300) of now, so an old request can't be replayed.
 */
export async function verifyWebhook(secret: string, webhook: WebhookToVerify, options: { now?: number; toleranceSeconds?: number } = {}): Promise<boolean> {
  const { body, timestamp, signature } = webhook;
  if (typeof body !== "string" || !timestamp || !signature?.startsWith("v1=")) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(now - Number(timestamp)) > (options.toleranceSeconds ?? 300)) return false;
  const expected = fromHex(signature.slice(3));
  if (!expected) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), expected, utf8.encode(`${timestamp}.${body}`));
}
