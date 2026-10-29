import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { RoomKey } from "@towhee/auth";
import {
  type AdminOps,
  type Connection,
  handleAdmin,
  Inbox,
  isAdminPath,
  type Limits,
  landingPage,
  Room,
  resolveLimits,
  type Storage,
  sendWebhook,
  type WebhookTarget,
} from "@towhee/core";
import { closeCodeFor, encodeMessage, isReservedRoomId, isValidRoomId, isValidUserId, type Notification } from "@towhee/protocol";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { SqliteStorage } from "./sqlite";

export interface ServerOptions {
  /** Keys that sign this deployment's tokens. */
  keys: RoomKey | readonly RoomKey[];
  /** A SQLite file for documents. Ignored when `storage` is given. */
  dataPath?: string;
  /** Your own storage. One of `storage` or `dataPath` is required. */
  storage?: Storage;
  limits?: Partial<Limits>;
  /** How long an empty room stays loaded before it's saved and freed. Default 30 seconds. */
  unloadAfterMs?: number;
  /** How often to ping clients; a client that misses a ping is dropped. Default 30 seconds. */
  heartbeatMs?: number;
  /** Unexpected errors (storage failures, bugs). Default: logged with console.error. */
  onError?: (error: unknown, room?: string) => void;
  /** Where to POST each notification, signed with the secret (see `verifyWebhook` in `@towhee/auth`). */
  webhook?: WebhookTarget;
  /** Turns on the admin API at /v1/admin (see `handleAdmin`). At least 32 characters. */
  adminSecret?: string;
}

interface ActiveRoom {
  room: Promise<Room>;
  unloadTimer?: ReturnType<typeof setTimeout>;
}

const ROOM_PATH = /^\/v1\/rooms\/([^/?#]+)$/;
const INBOX_PATH = /^\/v1\/inbox\/([^/?#]+)$/;

function refuseUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Towhee on Node. Serves rooms at `/v1/rooms/<room>` over WebSocket and `GET /health`. One process
 * holds its rooms in memory, so run a single instance per data file.
 */
export class TowheeServer {
  readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly storage: Storage;
  private readonly ownsStorage: boolean;
  private readonly limits: Limits;
  private readonly keys: RoomKey | readonly RoomKey[];
  private readonly unloadAfterMs: number;
  private readonly onError: (error: unknown, room?: string) => void;
  private readonly active = new Map<string, ActiveRoom>();
  /** Rooms being saved and freed. A room isn't loaded again until its close has finished. */
  private readonly closing = new Map<string, Promise<void>>();
  private readonly alive = new WeakMap<WebSocket, boolean>();
  /** Inboxes hold no state of their own (it's all in storage), so they live only while used. */
  private readonly inboxes = new Map<string, Inbox>();
  private readonly webhook?: WebhookTarget;
  private readonly adminSecret?: string;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(options: ServerOptions) {
    if (!options.storage && !options.dataPath) throw new TypeError("Pass storage or dataPath");
    this.keys = options.keys;
    this.limits = resolveLimits(options.limits);
    this.storage = options.storage ?? new SqliteStorage(options.dataPath!);
    this.ownsStorage = !options.storage;
    this.unloadAfterMs = options.unloadAfterMs ?? 30_000;
    this.onError = options.onError ?? ((error, room) => console.error(`[towhee]${room ? ` room ${room}:` : ""}`, error));
    if (options.webhook && (!/^https?:\/\//.test(options.webhook.url) || options.webhook.secret.length < 32)) {
      throw new TypeError("webhook needs an http(s) url and a secret of at least 32 characters");
    }
    this.webhook = options.webhook;
    if (options.adminSecret !== undefined && options.adminSecret.length < 32) throw new TypeError("adminSecret must be at least 32 characters");
    this.adminSecret = options.adminSecret;

    this.wss = new WebSocketServer({
      noServer: true,
      // The room checks the exact limit and closes with message_too_large; this only bounds memory.
      maxPayload: this.limits.maxMessageBytes * 2,
    });
    this.http = createHttpServer((req, res) => {
      if (isAdminPath(new URL(req.url ?? "/", "http://localhost").pathname)) {
        this.admin(req, res).catch((error) => {
          this.onError(error);
          if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Internal error" }));
        });
        return;
      }
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true, rooms: this.active.size, connections: this.wss.clients.size }));
        return;
      }
      if (req.method === "GET" && req.url === "/") {
        // Behind a TLS proxy the public scheme is https; say so in the page's URLs.
        const scheme = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(landingPage(`${scheme}://${req.headers.host ?? "localhost"}`));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    });
    this.http.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head));

    const heartbeatMs = options.heartbeatMs ?? 30_000;
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (this.alive.get(ws) === false) {
          ws.terminate();
          continue;
        }
        this.alive.set(ws, false);
        ws.ping();
      }
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  /** Starts listening. Port 0 picks a free port. */
  listen(port: number, host = "0.0.0.0"): Promise<{ port: number; url: string }> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(port, host, () => {
        this.http.off("error", reject);
        const address = this.http.address() as AddressInfo;
        const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
        resolve({ port: address.port, url: `ws://${shown}:${address.port}` });
      });
    });
  }

  /** Stops accepting connections, closes every room with `server_restarting` (saving each) and closes storage. */
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.heartbeat);
    const httpClosed = new Promise<void>((resolve) => this.http.close(() => resolve()));
    for (const inbox of this.inboxes.values()) inbox.close();
    for (const id of [...this.active.keys()]) this.unload(id, true);
    await Promise.all(this.closing.values());
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
    await httpClosed;
    if (this.ownsStorage) (this.storage as SqliteStorage).close();
  }

  /* WebSockets -------------------------------------------------------------------------------- */

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.stopped) {
      refuseUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const decode = (raw: string) => {
      try {
        return decodeURIComponent(raw);
      } catch {
        return undefined; // malformed percent-encoding
      }
    };
    const inbox = INBOX_PATH.exec(path);
    if (inbox) {
      const userId = decode(inbox[1]!);
      if (!isValidUserId(userId)) refuseUpgrade(socket, 400, "Bad Request");
      else this.wss.handleUpgrade(req, socket, head, (ws) => this.attachInbox(ws, userId));
      return;
    }
    const match = ROOM_PATH.exec(path);
    const roomId = match ? decode(match[1]!) : undefined;
    if (!match) refuseUpgrade(socket, 404, "Not Found");
    else if (!isValidRoomId(roomId) || isReservedRoomId(roomId)) refuseUpgrade(socket, 400, "Bad Request");
    else this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, roomId));
  }

  private attach(ws: WebSocket, roomId: string): void {
    this.alive.set(ws, true);
    ws.on("pong", () => this.alive.set(ws, true));

    const conn: Connection = {
      send: (frame) => {
        if (ws.readyState === ws.OPEN) ws.send(frame, { binary: true });
      },
      close: (code, reason) => ws.close(code, reason),
    };
    let room: Room | undefined;
    let closed = false;
    // Frames that arrive while the room loads are held, then handed over in order.
    const early: Uint8Array[] = [];

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) {
        ws.close(closeCodeFor("protocol_error"), "protocol_error");
        return;
      }
      const frame = toUint8Array(data);
      if (room) void room.receive(conn, frame);
      else early.push(frame);
    });
    ws.on("close", () => {
      closed = true;
      room?.disconnect(conn);
    });
    ws.on("error", () => {
      // "close" follows.
    });

    this.room(roomId).then(
      (loaded) => {
        if (closed) return;
        room = loaded;
        loaded.connect(conn);
        for (const frame of early.splice(0)) void loaded.receive(conn, frame);
      },
      (error: unknown) => {
        this.onError(error, roomId);
        if (!closed) {
          ws.send(encodeMessage({ type: "error", code: "internal", message: "The room couldn't be loaded" }));
          ws.close(closeCodeFor("internal"), "internal");
        }
      },
    );
  }

  private attachInbox(ws: WebSocket, userId: string): void {
    this.alive.set(ws, true);
    ws.on("pong", () => this.alive.set(ws, true));
    const conn: Connection = {
      send: (frame) => {
        if (ws.readyState === ws.OPEN) ws.send(frame, { binary: true });
      },
      close: (code, reason) => ws.close(code, reason),
    };
    const inbox = this.inbox(userId);
    inbox.connect(conn);
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) {
        ws.close(closeCodeFor("protocol_error"), "protocol_error");
        return;
      }
      void inbox.receive(conn, toUint8Array(data));
    });
    ws.on("close", () => {
      inbox.disconnect(conn);
      this.releaseInbox(userId);
    });
    ws.on("error", () => {});
  }

  /* Inboxes ------------------------------------------------------------------------------------ */

  private inbox(userId: string): Inbox {
    let inbox = this.inboxes.get(userId);
    if (!inbox) {
      inbox = Inbox.create({
        userId,
        store: this.storage.inbox,
        keys: this.keys,
        limits: this.limits,
        onError: (error) => this.onError(error),
        onDelivered: (scope, notification) => {
          const target = this.webhook;
          if (!target) return;
          void sendWebhook(target, { type: "notification", userId, scope, notification }).then(
            (ok) => ok || this.onError(new Error(`Webhook for notification ${notification.id} failed`)),
            (error) => this.onError(error),
          );
        },
      });
      this.inboxes.set(userId, inbox);
    }
    return inbox;
  }

  private releaseInbox(userId: string): void {
    if (this.inboxes.get(userId)?.connectionCount === 0) this.inboxes.delete(userId);
  }

  private deliver(scope: string, deliveries: { userId: string; notification: Notification }[]): void {
    for (const { userId, notification } of deliveries) {
      const inbox = this.inbox(userId);
      inbox.deliver(scope, notification).then(
        () => this.releaseInbox(userId),
        (error: unknown) => this.onError(error),
      );
    }
  }

  /* Admin ------------------------------------------------------------------------------------- */

  private async admin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > 64 * 1024) {
        res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: "Too large" }));
        return;
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
    const method = req.method ?? "GET";
    const request = new Request(`http://localhost${req.url ?? "/"}`, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" || chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
    });
    const response = await handleAdmin(request, this.adminSecret, this.adminOps);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }

  private get adminOps(): AdminOps {
    const storage = this.storage;
    return {
      ...(storage.listRooms ? { list: (options) => storage.listRooms!(options) } : {}),
      info: async (id) => (await this.existingRoom(id))?.info() ?? null,
      export: async (id) => (await this.existingRoom(id))?.export() ?? null,
      delete: (id) => this.deleteRoom(id),
      kick: async (id, userId) => {
        const entry = this.active.get(id);
        return entry ? (await entry.room).kick(userId) : 0;
      },
    };
  }

  private async hasData(id: string): Promise<boolean> {
    return (
      (await this.storage.loadDocument(id)) !== null ||
      (await this.storage.threads.count(id)) > 0 ||
      (await this.storage.versions.list(id)).length > 0
    );
  }

  /** A room that's loaded or has saved data, loaded; null otherwise (an admin look never creates one). */
  private async existingRoom(id: string): Promise<Room | null> {
    if (!this.active.has(id) && !(await this.hasData(id))) return null;
    const room = await this.room(id);
    if (room.connectionCount === 0) this.scheduleUnload(id);
    return room;
  }

  /** Disconnects everyone with `room_deleted`, then deletes the room's data. The room can't load until that's done. */
  private async deleteRoom(id: string): Promise<boolean> {
    const entry = this.active.get(id);
    if (!entry && !(await this.hasData(id))) return false;
    if (entry) {
      this.active.delete(id);
      clearTimeout(entry.unloadTimer);
    }
    const previous = this.closing.get(id);
    const work = (async () => {
      await previous;
      const room = entry ? await entry.room.catch(() => null) : null;
      await room?.close("room_deleted");
      await this.storage.deleteRoom(id);
    })();
    const tracked = work.finally(() => {
      if (this.closing.get(id) === tracked) this.closing.delete(id);
    });
    this.closing.set(id, tracked);
    await tracked;
    return true;
  }

  /* Rooms ------------------------------------------------------------------------------------- */

  private room(id: string): Promise<Room> {
    const active = this.active.get(id);
    if (active) {
      clearTimeout(active.unloadTimer);
      active.unloadTimer = undefined;
      return active.room;
    }
    const entry: ActiveRoom = {
      room: (async () => {
        await this.closing.get(id);
        return Room.load({
          id,
          storage: this.storage,
          keys: this.keys,
          limits: this.limits,
          onEmpty: () => this.scheduleUnload(id),
          onNotify: (scope, deliveries) => this.deliver(scope, deliveries),
          onError: (error) => this.onError(error, id),
        });
      })(),
    };
    this.active.set(id, entry);
    entry.room.catch(() => {
      if (this.active.get(id) === entry) this.active.delete(id);
    });
    return entry.room;
  }

  private scheduleUnload(id: string): void {
    const entry = this.active.get(id);
    if (!entry || this.stopped) return;
    clearTimeout(entry.unloadTimer);
    entry.unloadTimer = setTimeout(() => this.unload(id, false), this.unloadAfterMs);
    entry.unloadTimer.unref();
  }

  /** Saves and frees a room: always on shutdown, otherwise only if it's still empty. */
  private unload(id: string, force: boolean): void {
    const entry = this.active.get(id);
    if (!entry) return;
    clearTimeout(entry.unloadTimer);
    const done = entry.room.then(
      async (room) => {
        if (!force && room.connectionCount > 0) return;
        if (this.active.get(id) === entry) this.active.delete(id);
        await room.close("server_restarting");
      },
      () => {},
    );
    const tracked = done.finally(() => {
      if (this.closing.get(id) === tracked) this.closing.delete(id);
    });
    this.closing.set(id, tracked);
  }
}

function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function createServer(options: ServerOptions): TowheeServer {
  return new TowheeServer(options);
}
