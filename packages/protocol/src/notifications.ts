import { isRoomUser, type RoomUser } from "./user";

/**
 * The reserved room an inbox token is for. A key covering `talvra:*` signs inbox tokens for
 * `talvra:towhee.inbox`; a key covering everything, for `towhee.inbox`. Such a token opens only its
 * user's inbox: no document room can have an id ending in this.
 *
 * Clients pass this to their token endpoint to ask for an inbox token.
 */
export const INBOX_ROOM = "towhee.inbox";

/** The inbox room for a key's room pattern, or undefined for keys limited to one exact room. */
export function inboxRoomFor(keyRooms: string): string | undefined {
  if (keyRooms === "*") return INBOX_ROOM;
  if (!keyRooms.endsWith("*")) return undefined;
  return `${keyRooms.slice(0, -1)}${INBOX_ROOM}`;
}

/** Room ids hosts refuse to open as documents. */
export function isReservedRoomId(id: string): boolean {
  return id.endsWith(INBOX_ROOM);
}

/** `mention`: someone mentioned you. `reply`: someone replied in a thread you started or commented in. */
export type NotificationKind = "mention" | "reply";

export interface Notification {
  id: string;
  kind: NotificationKind;
  room: string;
  threadId: string;
  commentId: string;
  /** Who caused it. */
  actor: RoomUser;
  /** The start of the comment, as plain text. */
  excerpt: string;
  createdAt: number;
  readAt?: number;
}

export const MAX_EXCERPT_LENGTH = 200;

export function isNotification(value: unknown): value is Notification {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const n = value as Record<string, unknown>;
  return (
    typeof n.id === "string" &&
    (n.kind === "mention" || n.kind === "reply") &&
    typeof n.room === "string" &&
    typeof n.threadId === "string" &&
    typeof n.commentId === "string" &&
    isRoomUser(n.actor) &&
    typeof n.excerpt === "string" &&
    typeof n.createdAt === "number" &&
    (n.readAt === undefined || typeof n.readAt === "number")
  );
}
