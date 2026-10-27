export const MAX_ROOM_ID_LENGTH = 128;

/**
 * Room ids go into URL paths, storage keys and Durable Object names, so they're kept to a safe
 * set: letters, digits and `. _ : -`, starting with a letter or digit. `*` is reserved for
 * patterns and `/` for paths.
 */
const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function isValidRoomId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ROOM_ID_LENGTH && ROOM_ID.test(value);
}

/**
 * A room pattern is a room id (`doc:42`), a prefix ending in `*` (`team:7:*`), or `*` for every
 * room. Tokens and keys use patterns to say which rooms they cover.
 */
export function isValidRoomPattern(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_ROOM_ID_LENGTH) return false;
  if (value === "*") return true;
  const prefix = value.endsWith("*") ? value.slice(0, -1) : value;
  return ROOM_ID.test(prefix);
}

/** Whether `room` is covered by `pattern`. Invalid input never matches. */
export function roomMatches(pattern: string, room: string): boolean {
  if (!isValidRoomPattern(pattern) || !isValidRoomId(room)) return false;
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return room.startsWith(pattern.slice(0, -1));
  return room === pattern;
}

/** Whether every room covered by `inner` is also covered by `outer`. Invalid input is never within. */
export function patternWithin(inner: string, outer: string): boolean {
  if (!isValidRoomPattern(inner) || !isValidRoomPattern(outer)) return false;
  if (outer === "*") return true;
  if (inner === "*") return false;
  if (!outer.endsWith("*")) return inner === outer;
  const prefix = outer.slice(0, -1);
  return (inner.endsWith("*") ? inner.slice(0, -1) : inner).startsWith(prefix);
}
