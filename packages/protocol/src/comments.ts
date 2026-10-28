import { isRoomUser, isValidUserId, type RoomUser } from "./user";

/**
 * Where a thread points. `text` holds two Yjs relative positions (base64 of
 * `Y.encodeRelativePosition`), so it follows its text through edits; the client resolves them.
 * `app` is any id the app uses: a block, a cell, a point on a canvas.
 */
export type Anchor = { type: "text"; start: string; end: string } | { type: "app"; id: string };

/** Comment text as a small rich-text tree. Clients render it; it is never HTML. */
export interface CommentBody {
  version: 1;
  content: Paragraph[];
}

export interface Paragraph {
  type: "paragraph";
  children: Inline[];
}

export type Inline = TextRun | LinkRun | Mention;

export interface TextRun {
  type: "text";
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
}

export interface LinkRun {
  type: "link";
  /** http, https or mailto only. */
  url: string;
  children: TextRun[];
}

export interface Mention {
  type: "mention";
  userId: string;
}

export interface Comment {
  id: string;
  threadId: string;
  /** Who wrote it, as their token said when they did. */
  author: RoomUser;
  /** Empty once deleted. */
  body: CommentBody;
  /** Emoji to the ids of users who reacted with it. */
  reactions: Record<string, string[]>;
  createdAt: number;
  editedAt?: number;
  deletedAt?: number;
}

/** Simple values the app can attach to a thread (a status, a label). */
export type ThreadMetadata = Record<string, string | number | boolean>;

export interface Thread {
  id: string;
  anchor?: Anchor;
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: number;
  metadata?: ThreadMetadata;
  /** User id of whoever started it. */
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  comments: Comment[];
}

/** Limits that keep one thread well under the 2 MB row size some storage has. */
export const COMMENT_LIMITS = {
  /** UTF-8 bytes of a comment body as JSON. */
  bodyBytes: 8 * 1024,
  commentsPerThread: 200,
  threadsPerRoom: 5000,
  reactionsPerComment: 50,
  /** Characters in a reaction (one emoji, possibly with modifiers). */
  reactionLength: 32,
  anchorLength: 1024,
  metadataKeys: 20,
  metadataValueLength: 512,
} as const;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const utf8 = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only known keys, so unexpected fields can't ride along into storage and other clients. */
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((k) => allowed.includes(k));
}

const optionalBoolean = (value: unknown) => value === undefined || typeof value === "boolean";

function isTextRun(value: unknown): value is TextRun {
  return (
    isRecord(value) &&
    value.type === "text" &&
    onlyKeys(value, ["type", "text", "bold", "italic", "code", "strike"]) &&
    typeof value.text === "string" &&
    optionalBoolean(value.bold) &&
    optionalBoolean(value.italic) &&
    optionalBoolean(value.code) &&
    optionalBoolean(value.strike)
  );
}

function isSafeUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    return URL_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isInline(value: unknown): value is Inline {
  if (isTextRun(value)) return true;
  if (!isRecord(value)) return false;
  if (value.type === "mention") return onlyKeys(value, ["type", "userId"]) && isValidUserId(value.userId);
  if (value.type === "link") {
    return (
      onlyKeys(value, ["type", "url", "children"]) &&
      isSafeUrl(value.url) &&
      Array.isArray(value.children) &&
      value.children.length > 0 &&
      value.children.every(isTextRun)
    );
  }
  return false;
}

/** Whether `value` is a well-formed comment body within the size limit. */
export function isCommentBody(value: unknown): value is CommentBody {
  if (!isRecord(value) || value.version !== 1 || !onlyKeys(value, ["version", "content"]) || !Array.isArray(value.content)) return false;
  const ok = value.content.every(
    (p) => isRecord(p) && p.type === "paragraph" && onlyKeys(p, ["type", "children"]) && Array.isArray(p.children) && p.children.every(isInline),
  );
  return ok && utf8.encode(JSON.stringify(value)).length <= COMMENT_LIMITS.bodyBytes;
}

/** Whether a body has any visible content. Empty comments are refused. */
export function hasContent(body: CommentBody): boolean {
  return body.content.some((p) => p.children.some((c) => c.type !== "text" || c.text.trim() !== ""));
}

export function isAnchor(value: unknown): value is Anchor {
  if (!isRecord(value)) return false;
  if (value.type === "app") {
    return onlyKeys(value, ["type", "id"]) && typeof value.id === "string" && value.id.length > 0 && value.id.length <= COMMENT_LIMITS.anchorLength;
  }
  if (value.type === "text") {
    const valid = (s: unknown) => typeof s === "string" && s.length > 0 && s.length <= COMMENT_LIMITS.anchorLength && BASE64.test(s);
    return onlyKeys(value, ["type", "start", "end"]) && valid(value.start) && valid(value.end);
  }
  return false;
}

export function isThreadMetadata(value: unknown): value is ThreadMetadata {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > COMMENT_LIMITS.metadataKeys) return false;
  return entries.every(
    ([k, v]) =>
      k.length > 0 &&
      k.length <= 64 &&
      (typeof v === "number" ? Number.isFinite(v) : typeof v === "boolean" || (typeof v === "string" && v.length <= COMMENT_LIMITS.metadataValueLength)),
  );
}

/** A reaction is a short string; apps send one emoji. */
export function isReaction(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= COMMENT_LIMITS.reactionLength && !/\s/.test(value);
}

/* Helpers for apps ---------------------------------------------------------------------------- */

/** A body from plain text: one paragraph per line. */
export function textBody(text: string): CommentBody {
  return { version: 1, content: text.split("\n").map((line) => ({ type: "paragraph", children: line ? [{ type: "text", text: line }] : [] })) };
}

/** A body as plain text, with mentions as `@userId`. */
export function bodyText(body: CommentBody): string {
  const inline = (c: Inline): string =>
    c.type === "text" ? c.text : c.type === "mention" ? `@${c.userId}` : c.children.map((t) => t.text).join("");
  return body.content.map((p) => p.children.map(inline).join("")).join("\n");
}

/** Ids of everyone mentioned in a body, once each. */
export function bodyMentions(body: CommentBody): string[] {
  const ids = new Set<string>();
  for (const p of body.content) for (const c of p.children) if (c.type === "mention") ids.add(c.userId);
  return [...ids];
}

/** Checks a thread as stored or received: structure only, not access. */
export function isThread(value: unknown): value is Thread {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.createdBy !== "string") return false;
  if (typeof value.resolved !== "boolean" || typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") return false;
  if (value.anchor !== undefined && !isAnchor(value.anchor)) return false;
  if (value.metadata !== undefined && !isThreadMetadata(value.metadata)) return false;
  return (
    Array.isArray(value.comments) &&
    value.comments.every(
      (c) =>
        isRecord(c) &&
        typeof c.id === "string" &&
        c.threadId === value.id &&
        isRoomUser(c.author) &&
        isRecord(c.body) &&
        isRecord(c.reactions) &&
        typeof c.createdAt === "number",
    )
  );
}
