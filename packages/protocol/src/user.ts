/**
 * Who a connection is, as the app's token says. Presence and comment authors come from here, never
 * from what a client claims about itself.
 */
export interface RoomUser {
  /** The user's id in the app (the token's `sub`). */
  id: string;
  name?: string;
  /** An http(s) image URL. */
  avatar?: string;
  /** A hex color like `#0ea5e9`, for cursors and avatars. */
  color?: string;
}

/** Display info an app puts in a token, next to the user id. */
export type RoomUserInfo = Omit<RoomUser, "id">;

export const MAX_USER_ID_LENGTH = 256;
export const MAX_USER_NAME_LENGTH = 128;
export const MAX_AVATAR_URL_LENGTH = 2048;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidUserId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_USER_ID_LENGTH;
}

/** Only http(s) URLs: clients put avatars in `<img src>`, so other schemes aren't allowed. */
function isAvatarUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_AVATAR_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Checks display info. Unknown fields are not allowed, so typos surface instead of vanishing. */
export function isRoomUserInfo(value: unknown): value is RoomUserInfo {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (key !== "name" && key !== "avatar" && key !== "color") return false;
  }
  const { name, avatar, color } = value;
  if (name !== undefined && (typeof name !== "string" || name.length > MAX_USER_NAME_LENGTH)) return false;
  if (avatar !== undefined && !isAvatarUrl(avatar)) return false;
  if (color !== undefined && (typeof color !== "string" || !HEX_COLOR.test(color))) return false;
  return true;
}

export function isRoomUser(value: unknown): value is RoomUser {
  if (!isRecord(value) || !isValidUserId(value.id)) return false;
  const { id: _id, ...info } = value;
  return isRoomUserInfo(info);
}
