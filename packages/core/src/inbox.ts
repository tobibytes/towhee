import { type RoomKey, TokenError, validateRoomKeys, verifyRoomToken } from "@towhee/auth";
import {
  type AuthMessage,
  closeCodeFor,
  decodeClientMessage,
  type ErrorCode,
  encodeMessage,
  inboxRoomFor,
  isValidUserId,
  type Notification,
  PROTOCOL_VERSION,
  ProtocolError,
  type RequestMessage,
  type RoomUser,
  type ServerMessage,
} from "@towhee/protocol";
import { type Limits, resolveLimits } from "./limits";
import type { Connection, ConnectionState, Timers } from "./room";
import type { InboxStore } from "./storage";

/** Notifications kept per user and scope; older ones are deleted. */
export const KEEP_NOTIFICATIONS = 500;
const MAX_LIST = 200;
const MAX_MARK = 200;
const CLOCK_SKEW_MS = 60_000;

export interface InboxOptions {
  /** The user whose inbox this is. */
  userId: string;
  store: InboxStore;
  keys: RoomKey | readonly RoomKey[];
  limits?: Partial<Limits>;
  now?: () => number;
  /** As for rooms: `"manual"` sets no timers; call `sweep()` at `nextDeadline()`. */
  timers?: Timers | "manual";
  onConnectionChange?: (conn: Connection, state: ConnectionState | null) => void;
  /** After a notification is stored, for example to send a webhook. */
  onDelivered?: (scope: string, notification: Notification) => void;
  onError?: (error: unknown) => void;
}

interface InboxConnection {
  id: string;
  phase: "pending" | "ready" | "closed";
  connectedAt: number;
  user?: RoomUser;
  scope?: string;
  expiresAt?: number;
  queue: Promise<void>;
  windowStart: number;
  windowCount: number;
  authTimer?: unknown;
  expiryTimer?: unknown;
}

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class RequestFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One user's notifications and their open inbox connections (`/v1/inbox/<user>`). It opens with an
 * inbox token (`createInboxToken`): the token's user must be this inbox's user and its room the
 * signing key's inbox room. Each connection sees the notifications of its key's scope.
 */
export class Inbox {
  readonly userId: string;
  readonly limits: Limits;
  private readonly store: InboxStore;
  private readonly keys: RoomKey | readonly RoomKey[];
  private readonly keyList: readonly RoomKey[];
  private readonly now: () => number;
  private readonly timers: Timers | undefined;
  private readonly options: InboxOptions;
  private readonly connections = new Map<Connection, InboxConnection>();
  private closed = false;

  /** Throws a TypeError for an invalid user id or keys. */
  static create(options: InboxOptions): Inbox {
    if (!isValidUserId(options.userId)) throw new TypeError("userId must be a non-empty string of at most 256 characters");
    validateRoomKeys(options.keys);
    return new Inbox(options);
  }

  private constructor(options: InboxOptions) {
    this.options = options;
    this.userId = options.userId;
    this.store = options.store;
    this.keys = options.keys;
    this.keyList = Array.isArray(options.keys) ? options.keys : [options.keys as RoomKey];
    this.limits = resolveLimits(options.limits);
    this.now = options.now ?? Date.now;
    this.timers = options.timers === "manual" ? undefined : (options.timers ?? defaultTimers);
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** Stores a notification and shows it to this user's open inboxes in that scope. */
  async deliver(scope: string, notification: Notification): Promise<void> {
    await this.store.add(scope, this.userId, notification);
    await this.store.prune(scope, this.userId, KEEP_NOTIFICATIONS);
    this.broadcast(scope, "notification.created", { notification });
    this.options.onDelivered?.(scope, notification);
  }

  connect(conn: Connection): void {
    if (this.closed) {
      this.reject(conn, "server_restarting", "The inbox is closing");
      return;
    }
    if (this.connections.size >= this.limits.maxConnections) {
      this.reject(conn, "room_full", "Too many inbox connections");
      return;
    }
    const now = this.now();
    const data: InboxConnection = { id: randomId(), phase: "pending", connectedAt: now, queue: Promise.resolve(), windowStart: now, windowCount: 0 };
    data.authTimer = this.timers?.setTimeout(() => {
      if (data.phase === "pending") this.fail(conn, "auth_timeout", "No auth message arrived in time");
    }, this.limits.authTimeoutMs);
    this.connections.set(conn, data);
    this.notifyChange(conn, data);
  }

  restore(conn: Connection, state: ConnectionState): void {
    if (this.closed || this.connections.has(conn)) return;
    const now = this.now();
    const data: InboxConnection = {
      id: state.id,
      phase: state.phase,
      connectedAt: state.connectedAt,
      user: state.user,
      scope: state.scope,
      expiresAt: state.expiresAt,
      queue: Promise.resolve(),
      windowStart: now,
      windowCount: 0,
    };
    this.connections.set(conn, data);
    if (data.phase === "pending") {
      data.authTimer = this.timers?.setTimeout(
        () => data.phase === "pending" && this.fail(conn, "auth_timeout", "No auth message arrived in time"),
        Math.max(0, data.connectedAt + this.limits.authTimeoutMs - now),
      );
    } else if (data.expiresAt !== undefined) {
      data.expiryTimer = this.timers?.setTimeout(
        () => this.fail(conn, "token_expired", "The token has expired"),
        Math.max(0, data.expiresAt + CLOCK_SKEW_MS - now),
      );
    }
  }

  receive(conn: Connection, frame: Uint8Array): Promise<void> {
    const data = this.connections.get(conn);
    if (!data) return Promise.resolve();
    data.queue = data.queue.then(() => this.handle(conn, data, frame));
    return data.queue;
  }

  disconnect(conn: Connection): void {
    const data = this.connections.get(conn);
    if (data) this.cleanup(conn, data);
  }

  sweep(now: number = this.now()): void {
    for (const [conn, data] of [...this.connections]) {
      if (data.phase === "pending" && now >= data.connectedAt + this.limits.authTimeoutMs) this.fail(conn, "auth_timeout", "No auth message arrived in time");
      else if (data.phase === "ready" && data.expiresAt !== undefined && now > data.expiresAt + CLOCK_SKEW_MS) this.fail(conn, "token_expired", "The token has expired");
    }
  }

  nextDeadline(): number | undefined {
    let next = Number.POSITIVE_INFINITY;
    for (const data of this.connections.values()) {
      if (data.phase === "pending") next = Math.min(next, data.connectedAt + this.limits.authTimeoutMs);
      else if (data.expiresAt !== undefined) next = Math.min(next, data.expiresAt + CLOCK_SKEW_MS + 1);
    }
    return Number.isFinite(next) ? next : undefined;
  }

  close(code: ErrorCode = "server_restarting"): void {
    this.closed = true;
    for (const conn of [...this.connections.keys()]) this.fail(conn, code, "The inbox is closing");
  }

  /* Frames --------------------------------------------------------------------------------- */

  private async handle(conn: Connection, data: InboxConnection, frame: Uint8Array): Promise<void> {
    if (data.phase === "closed") return;
    try {
      if (frame.length > this.limits.maxMessageBytes) {
        this.fail(conn, "message_too_large", "Frame too large");
        return;
      }
      const now = this.now();
      if (now - data.windowStart >= 1000) {
        data.windowStart = now;
        data.windowCount = 0;
      }
      if (++data.windowCount > this.limits.maxMessagesPerSecond) {
        this.fail(conn, "rate_limited", "Too many messages");
        return;
      }
      if (data.expiresAt !== undefined && now > data.expiresAt + CLOCK_SKEW_MS) {
        this.fail(conn, "token_expired", "The token has expired");
        return;
      }
      if (data.phase === "pending" && now >= data.connectedAt + this.limits.authTimeoutMs) {
        this.fail(conn, "auth_timeout", "No auth message arrived in time");
        return;
      }

      const message = decodeClientMessage(frame);
      if (data.phase === "pending") {
        if (message.type !== "auth") throw new ProtocolError("The first message must be auth");
        await this.authenticate(conn, data, message);
        return;
      }
      if (message.type === "request") await this.handleRequest(conn, data, message);
      else if (message.type === "auth") throw new ProtocolError("Already authenticated");
      else throw new ProtocolError("Inboxes don't sync documents or presence");
    } catch (error) {
      if (error instanceof ProtocolError) this.fail(conn, "protocol_error", error.message);
      else {
        this.options.onError?.(error);
        this.fail(conn, "internal", "Something went wrong on the server");
      }
    }
  }

  private async authenticate(conn: Connection, data: InboxConnection, message: AuthMessage): Promise<void> {
    if (message.protocol !== PROTOCOL_VERSION) {
      this.fail(conn, "unsupported_protocol", `This server speaks protocol ${PROTOCOL_VERSION}`);
      return;
    }
    let token: Awaited<ReturnType<typeof verifyRoomToken>>;
    try {
      token = await verifyRoomToken(message.token, this.keys, { now: this.now() });
    } catch (error) {
      if (!(error instanceof TokenError)) throw error;
      this.fail(conn, error.code === "expired" ? "token_expired" : "unauthorized", error.message);
      return;
    }
    if (data.phase !== "pending") return;
    if (this.closed) {
      this.fail(conn, "server_restarting", "The inbox is closing");
      return;
    }
    const scope = this.keyList.find((k) => k.id === token.keyId)?.rooms ?? "*";
    if (token.room !== inboxRoomFor(scope)) {
      this.fail(conn, "unauthorized", "Not an inbox token (use createInboxToken)");
      return;
    }
    if (token.userId !== this.userId) {
      this.fail(conn, "unauthorized", "The token is for another user's inbox");
      return;
    }

    this.timers?.clearTimeout(data.authTimer);
    data.phase = "ready";
    data.user = token.user;
    data.scope = scope;
    data.expiresAt = token.expiresAt;
    data.expiryTimer = this.timers?.setTimeout(
      () => this.fail(conn, "token_expired", "The token has expired"),
      Math.max(0, token.expiresAt + CLOCK_SKEW_MS - this.now()),
    );
    this.notifyChange(conn, data);
    this.send(conn, data, { type: "ready", protocol: PROTOCOL_VERSION, connectionId: data.id, access: token.access, user: token.user });
  }

  private async handleRequest(conn: Connection, data: InboxConnection, message: RequestMessage): Promise<void> {
    const scope = data.scope!;
    const params = message.params === undefined ? {} : message.params;
    try {
      if (!isRecord(params)) throw new RequestFailure("protocol_error", "params must be an object");
      let result: unknown;
      if (message.method === "inbox.list") {
        const limit = params.limit === undefined ? 50 : params.limit;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) {
          throw new RequestFailure("protocol_error", `limit must be 1-${MAX_LIST}`);
        }
        result = { notifications: await this.store.list(scope, this.userId, limit), unread: await this.store.unreadCount(scope, this.userId) };
      } else if (message.method === "inbox.markRead") {
        let ids: string[] | "all";
        if (params.all === true) ids = "all";
        else if (Array.isArray(params.ids) && params.ids.length <= MAX_MARK && params.ids.every((id) => typeof id === "string" && id.length <= 64)) {
          ids = params.ids as string[];
        } else throw new RequestFailure("protocol_error", `Pass { all: true } or { ids } with at most ${MAX_MARK} ids`);
        const readAt = this.now();
        const changed = await this.store.markRead(scope, this.userId, ids, readAt);
        if (changed.length > 0) this.broadcast(scope, "notification.read", { ids: changed, readAt });
        result = { ids: changed, readAt };
      } else {
        throw new RequestFailure("not_found", `Unknown method ${message.method}`);
      }
      this.send(conn, data, { type: "response", id: message.id, ok: true, result });
    } catch (error) {
      if (!(error instanceof RequestFailure)) {
        this.options.onError?.(error);
        this.send(conn, data, { type: "response", id: message.id, ok: false, error: { code: "internal", message: "Something went wrong on the server" } });
        return;
      }
      this.send(conn, data, { type: "response", id: message.id, ok: false, error: { code: error.code, message: error.message } });
    }
  }

  /* Connections ---------------------------------------------------------------------------- */

  private broadcast(scope: string, name: string, eventData: unknown): void {
    const frame = encodeMessage({ type: "event", name, data: eventData });
    for (const [conn, data] of this.connections) {
      if (data.phase === "ready" && data.scope === scope) this.sendFrame(conn, data, frame);
    }
  }

  private send(conn: Connection, data: InboxConnection, message: ServerMessage): void {
    this.sendFrame(conn, data, encodeMessage(message));
  }

  private sendFrame(conn: Connection, data: InboxConnection, frame: Uint8Array): void {
    if (data.phase === "closed") return;
    try {
      conn.send(frame);
    } catch {
      this.cleanup(conn, data);
    }
  }

  private reject(conn: Connection, code: ErrorCode, message: string): void {
    try {
      conn.send(encodeMessage({ type: "error", code, message }));
      conn.close(closeCodeFor(code), code);
    } catch {
      // Already closed.
    }
  }

  private fail(conn: Connection, code: ErrorCode, message: string): void {
    const data = this.connections.get(conn);
    if (!data || data.phase === "closed") return;
    this.reject(conn, code, message);
    this.cleanup(conn, data);
  }

  private cleanup(conn: Connection, data: InboxConnection): void {
    if (data.phase === "closed") return;
    data.phase = "closed";
    this.timers?.clearTimeout(data.authTimer);
    this.timers?.clearTimeout(data.expiryTimer);
    this.connections.delete(conn);
    this.notifyChange(conn, data);
  }

  private notifyChange(conn: Connection, data: InboxConnection): void {
    if (!this.options.onConnectionChange) return;
    if (data.phase === "closed") {
      this.options.onConnectionChange(conn, null);
      return;
    }
    this.options.onConnectionChange(conn, {
      id: data.id,
      phase: data.phase,
      connectedAt: data.connectedAt,
      ...(data.user ? { user: data.user } : {}),
      ...(data.scope !== undefined ? { scope: data.scope } : {}),
      ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
      presence: [],
    });
  }
}
