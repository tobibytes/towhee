import {
  type Access,
  inboxRoomFor,
  isAccess,
  isRoomUserInfo,
  isValidRoomPattern,
  isValidUserId,
  MAX_TOKEN_LENGTH,
  patternWithin,
  type RoomUser,
  type RoomUserInfo,
  roomMatches,
} from "@towhee/protocol";
import { decodeBase64Url, encodeBase64Url } from "./base64url";

/**
 * A signing key. A deployment can have several (for rotation, or one per app). A key limited to a
 * room pattern can only sign and open tokens for rooms inside it, so two apps sharing a deployment
 * can't open each other's rooms.
 */
export interface RoomKey {
  /** Goes in the token header as `kid`. Letters, digits, `.`, `_` and `-`, up to 64 characters. */
  id: string;
  /** At least 32 characters. `generateSecret()` makes a good one. */
  secret: string;
  /** Rooms this key covers. Default `*` (all). */
  rooms?: string;
}

export interface RoomTokenInput {
  /** The user's id in your app. */
  userId: string;
  /** A room id (`doc:42`) or a pattern (`team:7:*`). */
  room: string;
  access: Access;
  /** Shown to others in presence and on comments. */
  user?: RoomUserInfo;
  /** Seconds until the token expires. Default 3600 (1 hour), at most 86400 (24 hours). */
  expiresIn?: number;
}

export interface VerifiedRoomToken {
  userId: string;
  /** The room id or pattern the token covers. */
  room: string;
  access: Access;
  /** `id` plus the display info from the token. */
  user: RoomUser;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  keyId: string;
}

export interface VerifyOptions {
  /** The room being joined. When set, the token must cover it. */
  room?: string;
  /** Milliseconds since the epoch. Default `Date.now()`. */
  now?: number;
  /** Seconds of clock difference to allow between servers. Default 60, at most 300. */
  clockSkew?: number;
}

export type TokenErrorCode =
  | "malformed"
  | "unsupported_algorithm"
  | "unknown_key"
  | "bad_signature"
  | "invalid_claims"
  | "expired"
  | "not_yet_valid"
  | "wrong_room"
  | "key_scope";

/** Why a token was refused. Hosts close with `token_expired` for `expired` and `unauthorized` otherwise. */
export class TokenError extends Error {
  readonly code: TokenErrorCode;
  constructor(code: TokenErrorCode, message: string) {
    super(message);
    this.name = "TokenError";
    this.code = code;
  }
}

export const DEFAULT_EXPIRES_IN = 60 * 60;
export const MAX_EXPIRES_IN = 24 * 60 * 60;
export const MIN_SECRET_LENGTH = 32;
const DEFAULT_CLOCK_SKEW = 60;
const MAX_CLOCK_SKEW = 300;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Keys are configuration, so a bad one throws a TypeError right away instead of failing every token. */
function checkKey(key: RoomKey): Required<RoomKey> {
  if (typeof key !== "object" || key === null) throw new TypeError("A room key must be an object { id, secret, rooms? }");
  if (typeof key.id !== "string" || !KEY_ID.test(key.id)) {
    throw new TypeError(`Room key id "${String(key.id)}" must be 1-64 letters, digits, ".", "_" or "-"`);
  }
  if (typeof key.secret !== "string" || key.secret.length < MIN_SECRET_LENGTH) {
    throw new TypeError(`Room key "${key.id}" needs a secret of at least ${MIN_SECRET_LENGTH} characters`);
  }
  const rooms = key.rooms ?? "*";
  if (!isValidRoomPattern(rooms)) throw new TypeError(`Room key "${key.id}" has an invalid rooms pattern "${String(rooms)}"`);
  return { id: key.id, secret: key.secret, rooms };
}

// Importing a key costs a little; cache per secret. Secrets are few and long-lived.
const cryptoKeys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let key = cryptoKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", utf8Encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    cryptoKeys.set(secret, key);
  }
  return key;
}

const encodeJson = (value: unknown) => encodeBase64Url(utf8Encoder.encode(JSON.stringify(value)));

function decodeJson(part: string): Record<string, unknown> | undefined {
  const bytes = decodeBase64Url(part);
  if (!bytes) return undefined;
  try {
    const value: unknown = JSON.parse(utf8Decoder.decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const isNumericDate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Signs a room token for one user. Call it from your backend after checking the user's session,
 * and send the result to the browser. It is a standard HS256 JWT, so backends in other languages
 * can mint the same tokens with any JWT library (claims: `sub`, `room`, `access`, `user`, `iat`,
 * `exp`; header `kid`).
 */
export async function createRoomToken(input: RoomTokenInput, key: RoomKey, options: { now?: number } = {}): Promise<string> {
  const k = checkKey(key);
  if (!isValidUserId(input.userId)) throw new TypeError("userId must be a non-empty string of at most 256 characters");
  if (!isValidRoomPattern(input.room)) throw new TypeError(`"${String(input.room)}" isn't a valid room id or pattern`);
  if (!patternWithin(input.room, k.rooms)) {
    throw new TypeError(`Key "${k.id}" covers rooms "${k.rooms}" and can't sign a token for "${input.room}"`);
  }
  if (!isAccess(input.access)) throw new TypeError(`access must be "read", "comment" or "write"`);
  if (input.user !== undefined && !isRoomUserInfo(input.user)) {
    throw new TypeError("user may only have name (up to 128 characters), avatar (an http(s) URL) and color (a hex color)");
  }
  const expiresIn = input.expiresIn ?? DEFAULT_EXPIRES_IN;
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_EXPIRES_IN) {
    throw new TypeError(`expiresIn must be a whole number of seconds from 1 to ${MAX_EXPIRES_IN}`);
  }

  const iat = Math.floor((options.now ?? Date.now()) / 1000);
  const header = encodeJson({ alg: "HS256", typ: "JWT", kid: k.id });
  const payload = encodeJson({
    sub: input.userId,
    room: input.room,
    access: input.access,
    ...(input.user ? { user: input.user } : {}),
    iat,
    exp: iat + expiresIn,
  });
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(k.secret), utf8Encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/**
 * Checks a room token: format, algorithm, key, signature, claims, expiry, the key's room scope and
 * (with `options.room`) the room being joined. Throws a {@link TokenError} saying why it failed.
 */
/**
 * Checks a deployment's keys: at least one, unique ids, valid secrets and room patterns. Servers
 * call this at startup so a bad key fails loudly once instead of refusing every token.
 */
export function validateRoomKeys(keys: RoomKey | readonly RoomKey[]): void {
  checkKeys(keys);
}

function checkKeys(keys: RoomKey | readonly RoomKey[]): Required<RoomKey>[] {
  const list = (Array.isArray(keys) ? keys : [keys as RoomKey]).map(checkKey);
  if (list.length === 0) throw new TypeError("At least one room key is needed");
  if (new Set(list.map((k) => k.id)).size !== list.length) throw new TypeError("Room key ids must be unique");
  return list;
}

export async function verifyRoomToken(token: string, keys: RoomKey | readonly RoomKey[], options: VerifyOptions = {}): Promise<VerifiedRoomToken> {
  const list = checkKeys(keys);
  const clockSkew = options.clockSkew ?? DEFAULT_CLOCK_SKEW;
  if (!Number.isFinite(clockSkew) || clockSkew < 0 || clockSkew > MAX_CLOCK_SKEW) {
    throw new TypeError(`clockSkew must be 0-${MAX_CLOCK_SKEW} seconds`);
  }

  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new TokenError("malformed", "The token is empty or too long");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("malformed", "The token isn't a JWT");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeJson(headerPart);
  const signature = decodeBase64Url(signaturePart);
  if (!header || !signature) throw new TokenError("malformed", "The token isn't a JWT");
  // Only HS256. Accepting whatever the header says is how "alg: none" attacks work.
  if (header.alg !== "HS256") throw new TokenError("unsupported_algorithm", `Tokens must be signed with HS256, not ${String(header.alg)}`);

  let key: Required<RoomKey> | undefined;
  if (header.kid === undefined) {
    if (list.length === 1) key = list[0];
  } else if (typeof header.kid === "string") {
    key = list.find((k) => k.id === header.kid);
  }
  if (!key) throw new TokenError("unknown_key", header.kid === undefined ? "The token has no key id (kid)" : "The token was signed with an unknown key");

  const valid = await crypto.subtle.verify("HMAC", await hmacKey(key.secret), signature, utf8Encoder.encode(`${headerPart}.${payloadPart}`));
  if (!valid) throw new TokenError("bad_signature", "The token's signature doesn't match");

  // Claims are only read after the signature checks out.
  const claims = decodeJson(payloadPart);
  if (!claims) throw new TokenError("malformed", "The token's payload isn't JSON");
  const { sub, room, access, user, exp, iat, nbf } = claims;
  if (!isValidUserId(sub)) throw new TokenError("invalid_claims", "sub must be a user id");
  if (!isValidRoomPattern(room)) throw new TokenError("invalid_claims", "room must be a room id or pattern");
  if (!isAccess(access)) throw new TokenError("invalid_claims", "access must be read, comment or write");
  if (user !== undefined && !isRoomUserInfo(user)) throw new TokenError("invalid_claims", "user has invalid display info");
  if (!isNumericDate(exp)) throw new TokenError("invalid_claims", "exp is required");
  if (iat !== undefined && !isNumericDate(iat)) throw new TokenError("invalid_claims", "iat must be a number");
  if (nbf !== undefined && !isNumericDate(nbf)) throw new TokenError("invalid_claims", "nbf must be a number");

  const now = (options.now ?? Date.now()) / 1000;
  if (now > exp + clockSkew) throw new TokenError("expired", "The token has expired");
  if (exp - now > MAX_EXPIRES_IN + clockSkew) throw new TokenError("invalid_claims", "The token expires more than 24 hours from now");
  if (iat !== undefined && iat > now + clockSkew) throw new TokenError("invalid_claims", "The token was issued in the future");
  if (nbf !== undefined && nbf > now + clockSkew) throw new TokenError("not_yet_valid", "The token isn't valid yet");

  if (!patternWithin(room, key.rooms)) {
    throw new TokenError("key_scope", `Key "${key.id}" can't open rooms "${room}"`);
  }
  if (options.room !== undefined && !roomMatches(room, options.room)) {
    throw new TokenError("wrong_room", "The token is for another room");
  }

  return {
    userId: sub,
    room,
    access,
    user: { ...(user as RoomUserInfo | undefined), id: sub },
    expiresAt: exp * 1000,
    keyId: key.id,
  };
}

/**
 * A token that opens one user's inbox (`client.inbox`) and nothing else. It's for the key's
 * reserved inbox room: `towhee.inbox`, or `talvra:towhee.inbox` for a key covering `talvra:*`.
 * Return it from your token endpoint when the client asks for room `towhee.inbox`.
 */
export function createInboxToken(
  input: { userId: string; user?: RoomUserInfo; expiresIn?: number },
  key: RoomKey,
  options: { now?: number } = {},
): Promise<string> {
  const room = inboxRoomFor(checkKey(key).rooms);
  if (!room) throw new TypeError(`Key "${key.id}" covers a single room, so it can't sign inbox tokens`);
  return createRoomToken({ ...input, room, access: "read" }, key, options);
}

/** 32 random bytes as base64url (43 characters), for a key's secret. */
export function generateSecret(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
