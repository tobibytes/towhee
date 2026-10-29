import { type RoomKey, validateRoomKeys } from "@towhee/auth";
import {
  type AdminOps,
  type Connection,
  type ConnectionState,
  handleAdmin,
  Inbox,
  isAdminPath,
  type Limits,
  landingPage,
  Room,
  type RoomExport,
  type RoomInfo,
  sendWebhook,
  type WebhookTarget,
} from "@towhee/core";
import { closeCodeFor, isReservedRoomId, isValidRoomId, isValidUserId, type Notification, roomMatches } from "@towhee/protocol";
import { DurableObject } from "cloudflare:workers";
import { DurableObjectSqlStorage } from "./storage";

/** Bindings and settings. Secrets (`TOWHEE_SECRET` or `TOWHEE_KEYS`, `TOWHEE_WEBHOOK_SECRET`) go in with `wrangler secret put`. */
export interface TowheeEnv {
  /** Durable Object namespace bound to {@link TowheeRoom}, with a SQLite migration. */
  TOWHEE_ROOMS: DurableObjectNamespace<TowheeRoom>;
  /** Durable Object namespace bound to {@link TowheeInbox}. Without it, notifications are dropped. */
  TOWHEE_INBOXES?: DurableObjectNamespace<TowheeInbox>;
  /** One signing key (id `default`) for every room. */
  TOWHEE_SECRET?: string;
  /** Several keys as JSON: `[{"id":"talvra","secret":"...","rooms":"talvra:*"}]`. */
  TOWHEE_KEYS?: string;
  TOWHEE_MAX_CONNECTIONS?: string;
  TOWHEE_MAX_MESSAGE_BYTES?: string;
  TOWHEE_MAX_DOCUMENT_BYTES?: string;
  TOWHEE_AUTH_TIMEOUT_MS?: string;
  /** POST each notification here, signed with `TOWHEE_WEBHOOK_SECRET`. */
  TOWHEE_WEBHOOK_URL?: string;
  TOWHEE_WEBHOOK_SECRET?: string;
  /** Rooms matching this pattern (like `demo:*`) are wiped once they're older than `TOWHEE_EXPIRE_AFTER_HOURS`. */
  TOWHEE_EXPIRE_ROOMS?: string;
  /** Default 24. */
  TOWHEE_EXPIRE_AFTER_HOURS?: string;
  /** Turns on the admin API at /v1/admin (a secret, at least 32 characters). */
  TOWHEE_ADMIN_SECRET?: string;
}

/** The Worker passes the room id or user id to the Durable Object in these headers. */
const ROOM_HEADER = "x-towhee-room";
const USER_HEADER = "x-towhee-user";
const ROOM_PATH = /^\/v1\/rooms\/([^/]+)$/;
const INBOX_PATH = /^\/v1\/inbox\/([^/]+)$/;

/** Durable Object name of a user's inbox. */
const inboxName = (userId: string) => `inbox:${userId}`;

export function keysFromEnv(env: TowheeEnv): RoomKey[] {
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
    throw new Error("Set the TOWHEE_SECRET or TOWHEE_KEYS secret with `wrangler secret put`");
  }
  validateRoomKeys(keys);
  return keys;
}

/** How long rooms matching `TOWHEE_EXPIRE_ROOMS` live, in milliseconds. */
export function expireAfterFromEnv(env: TowheeEnv): number {
  const raw = env.TOWHEE_EXPIRE_AFTER_HOURS;
  if (raw === undefined || raw === "") return 24 * 3_600_000;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error("TOWHEE_EXPIRE_AFTER_HOURS must be a positive number");
  return hours * 3_600_000;
}

export function limitsFromEnv(env: TowheeEnv): Partial<Limits> {
  const limits: Partial<Limits> = {};
  const read = (name: keyof TowheeEnv, limit: keyof Limits) => {
    const raw = env[name];
    if (typeof raw !== "string" || raw === "") return;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive whole number`);
    limits[limit] = value;
  };
  read("TOWHEE_MAX_CONNECTIONS", "maxConnections");
  read("TOWHEE_MAX_MESSAGE_BYTES", "maxMessageBytes");
  read("TOWHEE_MAX_DOCUMENT_BYTES", "maxDocumentBytes");
  read("TOWHEE_AUTH_TIMEOUT_MS", "authTimeoutMs");
  return limits;
}

export function webhookFromEnv(env: TowheeEnv): WebhookTarget | undefined {
  if (!env.TOWHEE_WEBHOOK_URL) return undefined;
  if (!env.TOWHEE_WEBHOOK_SECRET || env.TOWHEE_WEBHOOK_SECRET.length < 32) {
    throw new Error("TOWHEE_WEBHOOK_URL needs the TOWHEE_WEBHOOK_SECRET secret (at least 32 characters)");
  }
  return { url: env.TOWHEE_WEBHOOK_URL, secret: env.TOWHEE_WEBHOOK_SECRET };
}

function decodeSegment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined; // malformed percent-encoding
  }
}

/**
 * The Worker: `GET /health`, WebSocket upgrades at `/v1/rooms/<room>` routed to that room's
 * Durable Object, and at `/v1/inbox/<user>` to that user's inbox.
 */
export async function handleRequest(request: Request, env: TowheeEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
  if (url.pathname === "/" && request.method === "GET") {
    return new Response(landingPage(url.origin), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" } });
  }
  if (isAdminPath(url.pathname)) {
    const stub = (id: string) => env.TOWHEE_ROOMS.getByName(id);
    const ops: AdminOps = {
      info: (id) => stub(id).adminInfo(id),
      export: (id) => stub(id).adminExport(id),
      delete: (id) => stub(id).adminDelete(id),
      kick: (id, userId) => stub(id).adminKick(id, userId),
    };
    return handleAdmin(request, env.TOWHEE_ADMIN_SECRET, ops);
  }
  const room = ROOM_PATH.exec(url.pathname);
  const inbox = INBOX_PATH.exec(url.pathname);
  if (!room && !inbox) return new Response("Not found", { status: 404 });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426, headers: { Upgrade: "websocket" } });
  }
  const headers = new Headers(request.headers);
  if (inbox) {
    const userId = decodeSegment(inbox[1]!);
    if (!isValidUserId(userId)) return new Response("Invalid user id", { status: 400 });
    if (!env.TOWHEE_INBOXES) return new Response("Inboxes aren't set up (bind TOWHEE_INBOXES)", { status: 404 });
    headers.set(USER_HEADER, userId);
    return env.TOWHEE_INBOXES.getByName(inboxName(userId)).fetch(new Request(request, { headers }));
  }
  const roomId = decodeSegment(room![1]!);
  if (!isValidRoomId(roomId) || isReservedRoomId(roomId)) return new Response("Invalid room id", { status: 400 });
  headers.set(ROOM_HEADER, roomId);
  return env.TOWHEE_ROOMS.getByName(roomId).fetch(new Request(request, { headers }));
}

/** What a Durable Object hosts: a room or an inbox, both running in manual timer mode. */
interface Hosted {
  connect(conn: Connection): void;
  receive(conn: Connection, frame: Uint8Array): Promise<void>;
  disconnect(conn: Connection): void;
  restore(conn: Connection, state: ConnectionState): void;
  sweep(): void;
  nextDeadline(): number | undefined;
  flush?(): Promise<void>;
}

/**
 * WebSocket hibernation for anything {@link Hosted}. Between messages the object can be evicted
 * while sockets stay open. Each connection's state is kept in SQLite (its id in the socket's
 * attachment), so the hosted room or inbox can be rebuilt on wake; an alarm runs its sweeps.
 */
abstract class SocketHost<Target extends Hosted> extends DurableObject<TowheeEnv> {
  protected readonly storage: DurableObjectSqlStorage;
  /** Work the current event must wait for, like notifications sent to inboxes. */
  protected readonly pending: Promise<unknown>[] = [];
  private target: Promise<Target> | undefined;
  private readonly sockets = new Map<Connection, WebSocket>();
  private readonly connections = new WeakMap<WebSocket, Connection>();
  private readonly connectionIds = new Map<Connection, string>();
  /** When the alarm is set for, as far as this instance knows. */
  private alarmAt: number | null | undefined;

  constructor(ctx: DurableObjectState, env: TowheeEnv) {
    super(ctx, env);
    this.storage = new DurableObjectSqlStorage(ctx.storage);
  }

  /** Builds the hosted room or inbox, passing `onConnectionChange` through. */
  protected abstract create(onConnectionChange: (conn: Connection, state: ConnectionState | null) => void): Promise<Target>;

  /** After sockets were restored on wake. */
  protected afterRestore(_target: Target, _restored: number): void {}

  /** A deadline of the host's own, on top of the target's; the alarm fires at the earlier one. */
  protected hostDeadline(_target: Target): number | undefined {
    return undefined;
  }

  /** Drops the in-memory target, so the next event rebuilds it from storage. */
  protected forget(): void {
    this.target = undefined;
    this.alarmAt = undefined;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const target = await this.getTarget();
    const conn = this.connection(ws);
    if (typeof message === "string") {
      ws.close(closeCodeFor("protocol_error"), "protocol_error");
      target.disconnect(conn);
    } else {
      await target.receive(conn, new Uint8Array(message));
    }
    await this.afterEvent(target);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.closed(ws, code);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.closed(ws, 1011);
  }

  override async alarm(): Promise<void> {
    this.alarmAt = null;
    const target = await this.getTarget();
    target.sweep();
    await this.afterEvent(target);
  }

  /** Accepts a WebSocket upgrade into the hosted room or inbox. */
  protected async accept(): Promise<Response> {
    const target = await this.getTarget();
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    target.connect(this.connection(server));
    await this.afterEvent(target);
    return new Response(null, { status: 101, webSocket: client });
  }

  protected getTarget(): Promise<Target> {
    this.target ??= this.load().catch((error: unknown) => {
      this.target = undefined;
      throw error;
    });
    return this.target;
  }

  /**
   * Waits for storage writes and pending work, then makes sure an alarm is set for the next
   * deadline. Only moves the alarm earlier: presence renewals push the deadline back constantly,
   * and the alarm reschedules itself when it fires.
   */
  protected async afterEvent(target: Target): Promise<void> {
    await target.flush?.();
    for (const result of await Promise.allSettled(this.pending.splice(0))) {
      if (result.status === "rejected") console.error("[towhee]", result.reason);
    }
    const next = earliest(target.nextDeadline(), this.hostDeadline(target));
    if (next === undefined) return;
    if (this.alarmAt === undefined) this.alarmAt = await this.ctx.storage.getAlarm();
    if (this.alarmAt === null || next < this.alarmAt) {
      await this.ctx.storage.setAlarm(next);
      this.alarmAt = next;
    }
  }

  private async closed(ws: WebSocket, code: number): Promise<void> {
    let target: Target;
    try {
      target = await this.getTarget();
    } catch {
      // The room was deleted while this socket was closing: nothing left to tidy up.
      return;
    }
    target.disconnect(this.connection(ws));
    try {
      // Completes the close handshake (1005/1006 can't be sent back).
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // Already closed.
    }
    await this.afterEvent(target);
  }

  private async load(): Promise<Target> {
    const target = await this.create((conn, state) => {
      const ws = this.sockets.get(conn);
      if (state) {
        this.connectionIds.set(conn, state.id);
        this.storage.putConnection(state);
        ws?.serializeAttachment({ id: state.id });
      } else {
        const known = this.connectionIds.get(conn);
        if (known) this.storage.deleteConnection(known);
        this.connectionIds.delete(conn);
        this.sockets.delete(conn);
      }
    });

    // Sockets that stayed open while this object slept get their connections back.
    const open = new Set<string>();
    let restored = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as { id?: unknown } | null;
      const state = typeof attachment?.id === "string" ? this.storage.getConnection(attachment.id) : undefined;
      const conn = this.connection(ws);
      if (state) {
        this.connectionIds.set(conn, state.id);
        open.add(state.id);
        target.restore(conn, state);
        restored++;
      } else {
        ws.close(closeCodeFor("internal"), "internal");
        this.sockets.delete(conn);
      }
    }
    this.storage.pruneConnections(open);
    this.afterRestore(target, restored);
    this.alarmAt = await this.ctx.storage.getAlarm();
    return target;
  }

  private connection(ws: WebSocket): Connection {
    let conn = this.connections.get(ws);
    if (!conn) {
      conn = {
        send: (frame) => ws.send(frame),
        close: (code, reason) => ws.close(code, reason),
      };
      this.connections.set(ws, conn);
      this.sockets.set(conn, ws);
    }
    return conn;
  }
}

const earliest = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

/** One room: a shared document, presence, threads and history. */
export class TowheeRoom extends SocketHost<Room> {
  override async fetch(request: Request): Promise<Response> {
    const roomId = request.headers.get(ROOM_HEADER);
    if (!isValidRoomId(roomId)) return new Response("Missing room id", { status: 400 });
    const known = this.storage.getMeta("room");
    if (known === undefined) {
      this.storage.setMeta("room", roomId);
      this.storage.setMeta("created", String(Date.now()));
    } else if (known !== roomId) return new Response("Wrong room", { status: 400 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
    return this.accept();
  }

  protected override async create(onConnectionChange: (conn: Connection, state: ConnectionState | null) => void): Promise<Room> {
    const id = this.storage.getMeta("room");
    if (!id) throw new Error("This Durable Object has no room id yet");
    return Room.load({
      id,
      storage: this.storage,
      keys: keysFromEnv(this.env),
      limits: limitsFromEnv(this.env),
      timers: "manual",
      onConnectionChange,
      onNotify: (scope, deliveries) => this.notify(scope, deliveries),
      onError: (error) => console.error(`[towhee] room ${id}:`, error),
    });
  }

  protected override afterRestore(room: Room, restored: number): void {
    if (restored > 0) room.requestPresence();
  }

  /* Admin (called by the Worker over RPC) ------------------------------------------------------ */

  /** This object's room, if it is that room and has ever been opened. An admin look never creates one. */
  private isRoom(id: string): boolean {
    return this.storage.getMeta("room") === id;
  }

  async adminInfo(id: string): Promise<RoomInfo | null> {
    if (!this.isRoom(id)) return null;
    const room = await this.getTarget();
    const info = await room.info();
    await this.afterEvent(room);
    return info;
  }

  async adminExport(id: string): Promise<RoomExport | null> {
    if (!this.isRoom(id)) return null;
    const room = await this.getTarget();
    const data = await room.export();
    await this.afterEvent(room);
    return data;
  }

  async adminKick(id: string, userId: string): Promise<number> {
    if (!this.isRoom(id)) return 0;
    const room = await this.getTarget();
    const closed = room.kick(userId);
    await this.afterEvent(room);
    return closed;
  }

  /** Disconnects everyone with `room_deleted` and erases this object's storage. */
  async adminDelete(id: string): Promise<boolean> {
    if (!this.isRoom(id)) return false;
    const room = await this.getTarget();
    await room.close("room_deleted");
    this.forget();
    await this.ctx.storage.deleteAlarm();
    await this.storage.clear();
    return true;
  }

  /**
   * Rooms matching `TOWHEE_EXPIRE_ROOMS` are wiped when they expire, but never under people who
   * are in them: then the last one to leave schedules it.
   */
  protected override hostDeadline(room: Room): number | undefined {
    const at = this.expiresAt();
    if (at === undefined || (room.connectionCount > 0 && at <= Date.now())) return undefined;
    return at;
  }

  override async alarm(): Promise<void> {
    const at = this.expiresAt();
    if (at !== undefined && at <= Date.now() && (await this.getTarget()).connectionCount === 0) {
      this.forget();
      await this.ctx.storage.deleteAlarm();
      await this.storage.clear();
      return;
    }
    await super.alarm();
  }

  /** When this room expires, or undefined when it doesn't. Rooms from before expiry was set start counting now. */
  private expiresAt(): number | undefined {
    const pattern = this.env.TOWHEE_EXPIRE_ROOMS;
    const room = this.storage.getMeta("room");
    if (!pattern || room === undefined || !roomMatches(pattern, room)) return undefined;
    let created = Number(this.storage.getMeta("created"));
    if (!created) {
      created = Date.now();
      this.storage.setMeta("created", String(created));
    }
    return created + expireAfterFromEnv(this.env);
  }

  /** Hands notifications to the users' inbox objects; the current event waits for them. */
  private notify(scope: string, deliveries: { userId: string; notification: Notification }[]): void {
    const inboxes = this.env.TOWHEE_INBOXES;
    if (!inboxes) return;
    for (const { userId, notification } of deliveries) {
      this.pending.push(inboxes.getByName(inboxName(userId)).deliver(userId, scope, notification));
    }
  }
}

/** One user's inbox: notifications from every room, live to their open tabs, plus the webhook. */
export class TowheeInbox extends SocketHost<Inbox> {
  override async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get(USER_HEADER);
    if (!isValidUserId(userId) || !this.claim(userId)) return new Response("Wrong user", { status: 400 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
    return this.accept();
  }

  /** Called by rooms (RPC) to store a notification and show it live. */
  async deliver(userId: string, scope: string, notification: Notification): Promise<void> {
    if (!isValidUserId(userId) || !this.claim(userId)) throw new Error("This inbox belongs to another user");
    const inbox = await this.getTarget();
    await inbox.deliver(scope, notification);
  }

  protected override async create(onConnectionChange: (conn: Connection, state: ConnectionState | null) => void): Promise<Inbox> {
    const userId = this.storage.getMeta("user");
    if (!userId) throw new Error("This inbox has no user yet");
    const webhook = webhookFromEnv(this.env);
    return Inbox.create({
      userId,
      store: this.storage.inbox,
      keys: keysFromEnv(this.env),
      limits: limitsFromEnv(this.env),
      timers: "manual",
      onConnectionChange,
      onDelivered: (scope, notification) => {
        if (!webhook) return;
        this.ctx.waitUntil(
          sendWebhook(webhook, { type: "notification", userId, scope, notification }).then((ok) => {
            if (!ok) console.error(`[towhee] webhook for notification ${notification.id} failed`);
          }),
        );
      },
      onError: (error) => console.error(`[towhee] inbox ${userId}:`, error),
    });
  }

  /** Each inbox object belongs to one user, fixed by the first request. */
  private claim(userId: string): boolean {
    const known = this.storage.getMeta("user");
    if (known === undefined) this.storage.setMeta("user", userId);
    return known === undefined || known === userId;
  }
}

export default { fetch: handleRequest } satisfies ExportedHandler<TowheeEnv>;
