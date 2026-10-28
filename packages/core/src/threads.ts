import {
  type Access,
  type Anchor,
  type Comment,
  type CommentBody,
  COMMENT_LIMITS,
  canComment,
  canModerate,
  type ErrorCode,
  hasContent,
  isAnchor,
  isCommentBody,
  isReaction,
  isThreadMetadata,
  type RoomUser,
  type Thread,
  type ThreadMetadata,
} from "@towhee/protocol";
import type { ThreadStore } from "./storage";

/** A request that can't be done; becomes an error response, and the connection stays open. */
export class RequestFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RequestFailure";
  }
}

export interface Caller {
  user: RoomUser;
  access: Access;
}

export interface Outcome {
  result: unknown;
  /** Events for everyone in the room, the caller included. */
  events: { name: string; data: unknown }[];
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function newId(prefix: string): string {
  return `${prefix}_${Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function params(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new RequestFailure("protocol_error", "params must be an object");
  return value;
}

function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new RequestFailure("protocol_error", `${name} must be an id`);
  return value;
}

function body(value: unknown): CommentBody {
  if (!isCommentBody(value)) {
    throw new RequestFailure("protocol_error", `body must be a comment body of at most ${COMMENT_LIMITS.bodyBytes} bytes`);
  }
  if (!hasContent(value)) throw new RequestFailure("protocol_error", "body is empty");
  return value;
}

const EMPTY_BODY: CommentBody = { version: 1, content: [] };

/** Comments and threads for one room. Changes run one at a time, so concurrent replies don't overwrite each other. */
export class Threads {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly room: string,
    private readonly store: ThreadStore,
    private readonly now: () => number,
  ) {}

  /** Whether this handles `method`. */
  static handles(method: string): boolean {
    return method.startsWith("threads.");
  }

  handle(method: string, rawParams: unknown, caller: Caller): Promise<Outcome> {
    const run = this.queue.then(() => this.dispatch(method, params(rawParams), caller));
    this.queue = run.catch(() => {});
    return run;
  }

  private async dispatch(method: string, p: Record<string, unknown>, caller: Caller): Promise<Outcome> {
    switch (method) {
      case "threads.list":
        return { result: { threads: await this.store.list(this.room) }, events: [] };
      case "threads.create":
        return this.create(p, caller);
      case "threads.reply":
        return this.reply(p, caller);
      case "threads.edit":
        return this.editComment(p, caller);
      case "threads.deleteComment":
        return this.deleteComment(p, caller);
      case "threads.react":
        return this.react(p, caller);
      case "threads.resolve":
        return this.resolve(p, caller);
      case "threads.setMetadata":
        return this.setMetadata(p, caller);
      case "threads.delete":
        return this.deleteThread(p, caller);
      default:
        throw new RequestFailure("not_found", `Unknown method ${method}`);
    }
  }

  /* Methods ------------------------------------------------------------------------------------ */

  private async create(p: Record<string, unknown>, caller: Caller): Promise<Outcome> {
    this.mayComment(caller);
    let anchor: Anchor | undefined;
    if (p.anchor !== undefined) {
      if (!isAnchor(p.anchor)) throw new RequestFailure("protocol_error", "anchor is invalid");
      anchor = p.anchor;
    }
    let metadata: ThreadMetadata | undefined;
    if (p.metadata !== undefined) {
      if (!isThreadMetadata(p.metadata)) throw new RequestFailure("protocol_error", "metadata is invalid");
      metadata = p.metadata;
    }
    const first = body(p.body);
    if ((await this.store.count(this.room)) >= COMMENT_LIMITS.threadsPerRoom) {
      throw new RequestFailure("forbidden", `A room can have at most ${COMMENT_LIMITS.threadsPerRoom} threads`);
    }
    const now = this.now();
    const threadId = newId("th");
    const thread: Thread = {
      id: threadId,
      ...(anchor ? { anchor } : {}),
      resolved: false,
      ...(metadata ? { metadata } : {}),
      createdBy: caller.user.id,
      createdAt: now,
      updatedAt: now,
      comments: [this.comment(threadId, first, caller, now)],
    };
    await this.store.put(this.room, thread);
    return { result: { thread }, events: [{ name: "thread.created", data: { thread } }] };
  }

  private async reply(p: Record<string, unknown>, caller: Caller): Promise<Outcome> {
    this.mayComment(caller);
    const thread = await this.thread(p.threadId);
    const text = body(p.body);
    if (thread.comments.length >= COMMENT_LIMITS.commentsPerThread) {
      throw new RequestFailure("forbidden", `A thread can have at most ${COMMENT_LIMITS.commentsPerThread} comments`);
    }
    const now = this.now();
    const comment = this.comment(thread.id, text, caller, now);
    thread.comments.push(comment);
    thread.updatedAt = now;
    return this.save(thread, { thread, comment });
  }

  private async editComment(p: Record<string, unknown>, caller: Caller): Promise<Outcome> {
    this.mayComment(caller);
    const thread = await this.thread(p.threadId);
    const comment = this.liveComment(thread, p.commentId);
    this.mayChange(caller, comment.author.id, "edit other people's comments");
    comment.body = body(p.body);
    comment.editedAt = thread.updatedAt = this.now();
    return this.save(thread, { thread, comment });
  }

  private async deleteComment(p: Record<string, unknown>, caller: Caller): Promise<Outcome> {
    this.mayComment(caller);
    const thread = await this.thread(p.threadId);
    const comment = this.liveComment(thread, p.commentId);
    this.mayChange(caller, comment.author.id, "delete other people's comments");
    comment.body = EMPTY_BODY;
    comment.reactions = {};
    comment.deletedAt = thread.updatedAt = this.now();
    return this.save(thread, { thread, comment });
  }

  private async react(p: Record<string, unknown>, caller: Caller): Promise<Outcome> {
    this.mayComment(caller);
    if (!isReaction(p.reaction)) throw new RequestFailure("protocol_error", "reaction must be a short string, like one emoji");
    if (typeof p.add !== "boolean") throw new RequestFailure("protocol_error", "add must be true or false");
    const thread = await this.thread(p.threadId);
    const comment = this.liveComment(thread, p.commentId);
    const users = comment.reactions[p.reaction] ?? [];
    if (p.add) {
      if (users.includes(caller.user.id)) return { result: { thread, comment }, events: [] };
      if (!comment.reactions[p.reaction] && Object.keys(comment.reactions).length >= COMMENT_LIMITS.reactionsPerComment) {
        throw new RequestFailure("forbidden", `A comment can have at most ${COMMENT_LIMITS.reactionsPerComment} different reactions`);
      }
      comment.reactions[p.reaction] = [...users, caller.user.id];
    } else {
      if (!users.includes(caller.user.id)) return { result: { thread, comment }, events: [] };
      const rest = users.filter((u) => u !== caller.user.id);
      if (rest.length > 0) comment.reactions[p.reaction] = rest;
      else delete comment.reactions[p.reaction];
    }
    thread.updatedAt = this.now();
    return this.save(thread, { thread, comment });
  }

  private async resolve(p: Record<string, unknown>, caller: Caller): Promise<Outcome> {
    this.mayComment(caller);
    if (typeof p.resolved !== "boolean") throw new RequestFailure("protocol_error", "resolved must be true or false");
    const thread = await this.thread(p.threadId);
    this.mayChange(caller, thread.createdBy, "resolve other people's threads");
    if (thread.resolved === p.resolved) return { result: { thread }, events: [] };
    const now = this.now();
    thread.resolved = p.resolved;
    if (p.resolved) {
      thread.resolvedBy = caller.user.id;
      thread.resolvedAt = now;
    } else {
      delete thread.resolvedBy;
      delete thread.resolvedAt;
    }
    thread.updatedAt = now;
    return this.save(thread, { thread });
  }

  private async setMetadata(p: Record<string, unknown>, caller: Caller): Promise<Outcome> {
    this.mayComment(caller);
    if (!isThreadMetadata(p.metadata)) throw new RequestFailure("protocol_error", "metadata is invalid");
    const thread = await this.thread(p.threadId);
    this.mayChange(caller, thread.createdBy, "change other people's threads");
    thread.metadata = p.metadata;
    thread.updatedAt = this.now();
    return this.save(thread, { thread });
  }

  private async deleteThread(p: Record<string, unknown>, caller: Caller): Promise<Outcome> {
    this.mayComment(caller);
    const thread = await this.thread(p.threadId);
    this.mayChange(caller, thread.createdBy, "delete other people's threads");
    await this.store.delete(this.room, thread.id);
    return { result: { threadId: thread.id }, events: [{ name: "thread.deleted", data: { threadId: thread.id } }] };
  }

  /* Helpers ------------------------------------------------------------------------------------ */

  private comment(threadId: string, text: CommentBody, caller: Caller, now: number): Comment {
    return { id: newId("cm"), threadId, author: caller.user, body: text, reactions: {}, createdAt: now };
  }

  private async thread(value: unknown): Promise<Thread> {
    const thread = await this.store.get(this.room, id(value, "threadId"));
    if (!thread) throw new RequestFailure("not_found", "No such thread");
    return thread;
  }

  private liveComment(thread: Thread, value: unknown): Comment {
    const commentId = id(value, "commentId");
    const comment = thread.comments.find((c) => c.id === commentId);
    if (!comment) throw new RequestFailure("not_found", "No such comment");
    if (comment.deletedAt !== undefined) throw new RequestFailure("not_found", "That comment was deleted");
    return comment;
  }

  private async save(thread: Thread, result: unknown): Promise<Outcome> {
    await this.store.put(this.room, thread);
    return { result, events: [{ name: "thread.updated", data: { thread } }] };
  }

  private mayComment(caller: Caller): void {
    if (!canComment(caller.access)) throw new RequestFailure("forbidden", "This connection can't comment");
  }

  /** Your own things with comment access; anyone's with write access. */
  private mayChange(caller: Caller, owner: string, what: string): void {
    if (owner !== caller.user.id && !canModerate(caller.access)) throw new RequestFailure("forbidden", `Only write access can ${what}`);
  }
}
