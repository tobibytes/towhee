import { type RoomKey, validateRoomKeys } from "@towhee/auth";
import { type Connection, type Limits, Room } from "@towhee/core";
import { closeCodeFor, isValidRoomId } from "@towhee/protocol";
import { DurableObject } from "cloudflare:workers";
import { DurableObjectSqlStorage } from "./storage";

/** Bindings and settings. Secrets (`TOWHEE_SECRET` or `TOWHEE_KEYS`) go in with `wrangler secret put`. */
export interface TowheeEnv {
  /** Durable Object namespace bound to {@link TowheeRoom}, with a SQLite migration. */
  TOWHEE_ROOMS: DurableObjectNamespace<TowheeRoom>;
  /** One signing key (id `default`) for every room. */
  TOWHEE_SECRET?: string;
  /** Several keys as JSON: `[{"id":"talvra","secret":"...","rooms":"talvra:*"}]`. */
  TOWHEE_KEYS?: string;
  TOWHEE_MAX_CONNECTIONS?: string;
  TOWHEE_MAX_MESSAGE_BYTES?: string;
  TOWHEE_MAX_DOCUMENT_BYTES?: string;
  TOWHEE_AUTH_TIMEOUT_MS?: string;
}

/** The Worker passes the room id to its Durable Object in this header. */
const ROOM_HEADER = "x-towhee-room";
const ROOM_PATH = /^\/v1\/rooms\/([^/]+)$/;

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

/**
 * The Worker: `GET /health`, and WebSocket upgrades at `/v1/rooms/<room>` routed to that room's
 * Durable Object.
 */
export async function handleRequest(request: Request, env: TowheeEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
  const match = ROOM_PATH.exec(url.pathname);
  if (!match) return new Response("Not found", { status: 404 });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426, headers: { Upgrade: "websocket" } });
  }
  let roomId: string | undefined;
  try {
    roomId = decodeURIComponent(match[1]!);
  } catch {
    // Malformed percent-encoding; refused below.
  }
  if (!isValidRoomId(roomId)) return new Response("Invalid room id", { status: 400 });
  const headers = new Headers(request.headers);
  headers.set(ROOM_HEADER, roomId);
  return env.TOWHEE_ROOMS.getByName(roomId).fetch(new Request(request, { headers }));
}

/**
 * One room. Uses WebSocket hibernation: between messages the object can be evicted while sockets
 * stay open. The room runs in manual timer mode, an alarm does its sweeps, and each connection's
 * state is kept in SQLite so the room can be rebuilt on wake.
 */
export class TowheeRoom extends DurableObject<TowheeEnv> {
  private readonly storage: DurableObjectSqlStorage;
  private room: Promise<Room> | undefined;
  private readonly sockets = new Map<Connection, WebSocket>();
  private readonly connections = new WeakMap<WebSocket, Connection>();
  private readonly connectionIds = new Map<Connection, string>();
  /** When the alarm is set for, as far as this instance knows. */
  private alarmAt: number | null | undefined;

  constructor(ctx: DurableObjectState, env: TowheeEnv) {
    super(ctx, env);
    this.storage = new DurableObjectSqlStorage(ctx.storage);
  }

  override async fetch(request: Request): Promise<Response> {
    const roomId = request.headers.get(ROOM_HEADER);
    if (!isValidRoomId(roomId)) return new Response("Missing room id", { status: 400 });
    const known = this.storage.getMeta("room");
    if (known === undefined) this.storage.setMeta("room", roomId);
    else if (known !== roomId) return new Response("Wrong room", { status: 400 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });

    const room = await this.getRoom();
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    room.connect(this.connection(server));
    await this.afterEvent(room);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const room = await this.getRoom();
    const conn = this.connection(ws);
    if (typeof message === "string") {
      ws.close(closeCodeFor("protocol_error"), "protocol_error");
      room.disconnect(conn);
    } else {
      await room.receive(conn, new Uint8Array(message));
    }
    await this.afterEvent(room);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.closed(ws, code);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.closed(ws, 1011);
  }

  override async alarm(): Promise<void> {
    this.alarmAt = null;
    const room = await this.getRoom();
    room.sweep();
    await this.afterEvent(room);
  }

  /* Internals ---------------------------------------------------------------------------------- */

  private async closed(ws: WebSocket, code: number): Promise<void> {
    const room = await this.getRoom();
    room.disconnect(this.connection(ws));
    try {
      // Completes the close handshake (1005/1006 can't be sent back).
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // Already closed.
    }
    await this.afterEvent(room);
  }

  private getRoom(): Promise<Room> {
    this.room ??= this.load().catch((error: unknown) => {
      this.room = undefined;
      throw error;
    });
    return this.room;
  }

  private async load(): Promise<Room> {
    const id = this.storage.getMeta("room");
    if (!id) throw new Error("This Durable Object has no room id yet");
    const room = await Room.load({
      id,
      storage: this.storage,
      keys: keysFromEnv(this.env),
      limits: limitsFromEnv(this.env),
      timers: "manual",
      onConnectionChange: (conn, state) => {
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
      },
      onError: (error) => console.error(`[towhee] room ${id}:`, error),
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
        room.restore(conn, state);
        restored++;
      } else {
        ws.close(closeCodeFor("internal"), "internal");
        this.sockets.delete(conn);
      }
    }
    this.storage.pruneConnections(open);
    if (restored > 0) room.requestPresence();
    this.alarmAt = await this.ctx.storage.getAlarm();
    return room;
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

  /**
   * Waits for storage writes, then makes sure an alarm is set for the room's next deadline. Only
   * moves the alarm earlier: presence renewals push the deadline back constantly, and the alarm
   * reschedules itself when it fires.
   */
  private async afterEvent(room: Room): Promise<void> {
    await room.flush();
    const next = room.nextDeadline();
    if (next === undefined) return;
    if (this.alarmAt === undefined) this.alarmAt = await this.ctx.storage.getAlarm();
    if (this.alarmAt === null || next < this.alarmAt) {
      await this.ctx.storage.setAlarm(next);
      this.alarmAt = next;
    }
  }
}

export default { fetch: handleRequest } satisfies ExportedHandler<TowheeEnv>;
