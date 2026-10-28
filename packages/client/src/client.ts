import {
  type Access,
  canEdit,
  decodeServerMessage,
  type ErrorCode,
  encodeMessage,
  errorCodeFromClose,
  isValidRoomId,
  PRESENCE_RESEND_EVENT,
  PROTOCOL_VERSION,
  type RoomUser,
  recoveryFor,
  type ServerMessage,
} from "@towhee/protocol";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { RequestError } from "./errors";
import { History } from "./history";
import { Threads } from "./threads";

export { RequestError };

/** The parts of the standard WebSocket the client uses. Browsers, Node 22+, Deno, Bun and Workers all have it. */
export interface SocketLike {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = new (url: string) => SocketLike;

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ClientOptions {
  /** The server's base URL, like `wss://collab.example.com`. Rooms are at `<url>/v1/rooms/<room>`. */
  url: string;
  /**
   * Where tokens come from. A URL gets a POST with `{ "room": "<id>" }` (cookies included) and must
   * answer `{ "token": "..." }`; a 401 or 403 stops reconnecting. Or pass a function.
   */
  authEndpoint: string | ((room: string) => Promise<string>);
  /** Default `globalThis.WebSocket`. */
  WebSocket?: SocketFactory;
  /** Default `globalThis.fetch`. Only used with a URL `authEndpoint`. */
  fetch?: typeof fetch;
  /** Reconnect backoff. Defaults: 500 ms doubling up to 30 s, with jitter. */
  reconnect?: { initialDelayMs?: number; maxDelayMs?: number };
  timers?: Timers;
  /** For jitter. Default `Math.random`. */
  random?: () => number;
}

export type Status = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface Self {
  connectionId: string;
  user: RoomUser;
  access: Access;
}

/** Someone else in the room. `presence` is what their app set, without `user`. */
export interface Other {
  clientId: number;
  user: RoomUser;
  presence: Record<string, unknown>;
}

export interface RoomError {
  code: ErrorCode | "auth_failed";
  message: string;
}

interface Events {
  status: Status;
  /** True once the server's copy of the document has arrived on this connection. */
  synced: boolean;
  self: Self | null;
  others: Other[];
  event: { name: string; data?: unknown };
  error: RoomError;
}


const OPEN = 1;
const defaultTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

class AuthRejected extends Error {}

/** Creates a client. Enter rooms with `client.enter(roomId)`. */
export function createClient(options: ClientOptions): TowheeClient {
  return new TowheeClient(options);
}

export class TowheeClient {
  private readonly rooms = new Map<string, RoomConnection>();

  constructor(readonly options: ClientOptions) {
    if (!/^wss?:\/\//.test(options.url)) throw new TypeError("url must start with ws:// or wss://");
  }

  /**
   * Joins a room and keeps it connected until `leave()`. Pass your own `doc` to bind an editor that
   * already has one. Entering a room you're already in returns the same connection.
   */
  enter(roomId: string, options: { doc?: Y.Doc } = {}): RoomConnection {
    if (!isValidRoomId(roomId)) throw new TypeError(`"${roomId}" isn't a valid room id`);
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new RoomConnection(this, roomId, options.doc ?? new Y.Doc(), () => this.rooms.delete(roomId));
      this.rooms.set(roomId, room);
    }
    return room;
  }

  /** @internal */
  async getToken(roomId: string): Promise<string> {
    const { authEndpoint } = this.options;
    if (typeof authEndpoint === "function") return authEndpoint(roomId);
    const doFetch = this.options.fetch ?? globalThis.fetch;
    const res = await doFetch(authEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ room: roomId }),
    });
    if (res.status === 401 || res.status === 403) throw new AuthRejected(`The auth endpoint refused access (${res.status})`);
    if (!res.ok) throw new Error(`The auth endpoint failed (${res.status})`);
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token !== "string") throw new Error("The auth endpoint didn't return { token }");
    return body.token;
  }
}

/**
 * A live connection to one room. It reconnects on its own: after a network drop with backoff, and
 * after its token expires with a fresh token. Edits made while disconnected sync on reconnect.
 */
export class RoomConnection {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  status: Status = "connecting";
  /** Whether the doc has caught up with the server since the last (re)connect. */
  synced = false;
  self: Self | null = null;
  /** The error that last closed or refused the connection. */
  lastError: RoomError | null = null;

  private socket: SocketLike | null = null;
  private threadsApi: Threads | undefined;
  private historyApi: History | undefined;
  private left = false;
  private failures = 0;
  private retryTimer: unknown;
  private nextRequestId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly listeners: { [K in keyof Events]: Set<(value: Events[K]) => void> } = {
    status: new Set(),
    synced: new Set(),
    self: new Set(),
    others: new Set(),
    event: new Set(),
    error: new Set(),
  };
  private readonly timers: Timers;

  constructor(
    private readonly client: TowheeClient,
    readonly id: string,
    doc: Y.Doc,
    private readonly onLeave: () => void,
  ) {
    this.doc = doc;
    this.awareness = new Awareness(doc);
    this.timers = client.options.timers ?? defaultTimers;
    this.doc.on("update", this.onDocumentUpdate);
    this.awareness.on("update", this.onPresenceUpdate);
    this.awareness.on("change", this.onPresenceChange);
    // Start on the next microtask so listeners added right after enter() see everything.
    queueMicrotask(() => void this.connect());
  }

  /** Subscribes to changes. Returns a function that unsubscribes. */
  on<K extends keyof Events>(event: K, listener: (value: Events[K]) => void): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  private readonly transport = {
    request: (method: string, params?: unknown) => this.request(method, params),
    onEvent: (listener: (event: { name: string; data?: unknown }) => void) => this.on("event", listener),
    onConnected: (listener: () => void) => this.on("status", (status) => status === "connected" && listener()),
    isConnected: () => this.status === "connected",
  };

  /** The room's comment threads. Created on first use; it fetches the list and keeps it current. */
  get threads(): Threads {
    this.threadsApi ??= new Threads(this.transport);
    return this.threadsApi;
  }

  /** Saved versions of the document: list, preview, save and restore. Created on first use. */
  get history(): History {
    this.historyApi ??= new History(this.transport, this.doc, () => this.self?.access);
    return this.historyApi;
  }

  /** Everyone else in the room, with identities from their tokens. */
  others(): Other[] {
    const others: Other[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.doc.clientID) continue;
      const { user, ...presence } = state as { user?: RoomUser } & Record<string, unknown>;
      if (user) others.push({ clientId, user, presence });
    }
    return others;
  }

  /** Replaces your presence (cursor, selection...). `null` hides you. The server adds `user`. */
  setPresence(presence: Record<string, unknown> | null): void {
    this.awareness.setLocalState(presence);
  }

  /** Changes some fields of your presence. */
  updatePresence(fields: Record<string, unknown>): void {
    this.awareness.setLocalState({ ...(this.awareness.getLocalState() ?? {}), ...fields });
  }

  /** Calls a room feature on the server. Rejects with a {@link RequestError}. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.status !== "connected" || !this.socket) {
      return Promise.reject(new RequestError("disconnected", "The room isn't connected"));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type: "request", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  /** Disconnects for good. The doc stays usable; you can enter the room again later. */
  leave(): void {
    if (this.left) return;
    this.left = true;
    this.timers.clearTimeout(this.retryTimer);
    // Tell the others we're gone before closing.
    this.awareness.setLocalState(null);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close(1000, "left");
    }
    this.afterDisconnect();
    this.doc.off("update", this.onDocumentUpdate);
    this.awareness.destroy();
    this.setStatus("disconnected");
    this.onLeave();
  }

  /* Connecting ------------------------------------------------------------------------------ */

  private async connect(): Promise<void> {
    if (this.left) return;
    this.setStatus(this.failures === 0 && this.self === null ? "connecting" : "reconnecting");
    let token: string;
    try {
      token = await this.client.getToken(this.id);
    } catch (error) {
      if (this.left) return;
      this.report({ code: "auth_failed", message: error instanceof Error ? error.message : String(error) });
      if (error instanceof AuthRejected) {
        this.stop();
        return;
      }
      this.retry();
      return;
    }
    if (this.left) return;

    const SocketClass = this.client.options.WebSocket ?? (globalThis.WebSocket as unknown as SocketFactory);
    const base = this.client.options.url.replace(/\/+$/, "");
    const socket = new SocketClass(`${base}/v1/rooms/${encodeURIComponent(this.id)}`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket === socket) this.send({ type: "auth", protocol: PROTOCOL_VERSION, token });
    };
    const receive = (bytes: Uint8Array) => {
      if (this.socket !== socket) return;
      try {
        this.handle(decodeServerMessage(bytes));
      } catch {
        // A server we can't understand: drop the connection and try again.
        socket.close(4000, "protocol_error");
      }
    };
    // Some WebSocket implementations ignore binaryType and deliver Blobs, which only convert
    // asynchronously. Frames queue behind any Blob still converting, so their order is kept.
    let converting: Promise<void> | null = null;
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      const data = event.data;
      let bytes: Uint8Array | Promise<Uint8Array>;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (data instanceof Uint8Array) bytes = data;
      else if (typeof Blob !== "undefined" && data instanceof Blob) bytes = data.arrayBuffer().then((b) => new Uint8Array(b));
      else return; // text frames aren't part of the protocol
      if (converting === null && bytes instanceof Uint8Array) {
        receive(bytes);
        return;
      }
      const next: Promise<void> = (converting ?? Promise.resolve()).then(async () => {
        receive(await bytes);
        if (converting === next) converting = null;
      });
      converting = next;
    };
    socket.onclose = (event) => {
      if (this.socket === socket) this.onClose(event.code);
    };
    socket.onerror = () => {
      // A close event always follows; reconnecting happens there.
    };
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case "ready": {
        this.failures = 0;
        this.lastError = null;
        this.self = { connectionId: message.connectionId, user: message.user, access: message.access };
        this.emit("self", this.self);
        this.setStatus("connected");
        const encoder = encoding.createEncoder();
        syncProtocol.writeSyncStep1(encoder, this.doc);
        this.send({ type: "sync", data: encoding.toUint8Array(encoder) });
        if (this.awareness.getLocalState() !== null) {
          this.send({ type: "awareness", data: encodeAwarenessUpdate(this.awareness, [this.doc.clientID]) });
        }
        return;
      }
      case "sync": {
        const encoder = encoding.createEncoder();
        const kind = syncProtocol.readSyncMessage(decoding.createDecoder(message.data), encoder, this.doc, this);
        if (encoding.length(encoder) > 0) this.send({ type: "sync", data: encoding.toUint8Array(encoder) });
        if (kind === syncProtocol.messageYjsSyncStep2 && !this.synced) {
          this.synced = true;
          this.emit("synced", true);
        }
        return;
      }
      case "awareness":
        applyAwarenessUpdate(this.awareness, message.data, this);
        return;
      case "error":
        this.lastError = { code: message.code, message: message.message };
        return;
      case "response": {
        const call = this.pending.get(message.id);
        if (!call) return;
        this.pending.delete(message.id);
        if (message.ok) call.resolve(message.result);
        else call.reject(new RequestError(message.error.code, message.error.message));
        return;
      }
      case "event":
        if (message.name === PRESENCE_RESEND_EVENT) {
          if (this.awareness.getLocalState() !== null) {
            this.send({ type: "awareness", data: encodeAwarenessUpdate(this.awareness, [this.doc.clientID]) });
          }
          return;
        }
        if (message.name.startsWith("towhee.")) return; // reserved for the protocol
        this.emit("event", { name: message.name, data: message.data });
        return;
    }
  }

  private onClose(closeCode: number): void {
    this.socket = null;
    this.afterDisconnect();
    if (this.left) return;
    const code = errorCodeFromClose(closeCode);
    const recovery = code ? recoveryFor(code) : "retry";
    if (code) this.report(this.lastError ?? { code, message: code });
    if (recovery === "fatal") {
      this.stop();
      return;
    }
    // A fresh token fixes an expired one straight away; anything else waits, longer each time.
    if (recovery === "refresh" && this.failures === 0) {
      this.failures++;
      void this.connect();
      return;
    }
    this.retry();
  }

  private retry(): void {
    if (this.left) return;
    this.setStatus("reconnecting");
    const { initialDelayMs = 500, maxDelayMs = 30_000 } = this.client.options.reconnect ?? {};
    const exp = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.min(this.failures, 30));
    const random = this.client.options.random ?? Math.random;
    const delay = Math.round(exp * (0.5 + random() / 2));
    this.failures++;
    this.retryTimer = this.timers.setTimeout(() => void this.connect(), delay);
  }

  /** Stops reconnecting after an error that would just happen again. The doc keeps working offline. */
  private stop(): void {
    this.setStatus("disconnected");
  }

  private afterDisconnect(): void {
    if (this.synced) {
      this.synced = false;
      this.emit("synced", false);
    }
    for (const call of this.pending.values()) call.reject(new RequestError("disconnected", "The connection closed"));
    this.pending.clear();
    // Others' cursors would go stale; the server resends current presence after reconnecting.
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    if (others.length > 0) removeAwarenessStates(this.awareness, others, this);
    // Forget their clocks too. Otherwise the server's resend after reconnecting has the same clock
    // and is ignored as old, and cursors only come back at the next 15 second renewal.
    for (const id of others) this.awareness.meta.delete(id);
    if (this.self) {
      this.self = null;
      this.emit("self", null);
    }
  }

  /* Outgoing ---------------------------------------------------------------------------------- */

  private readonly onDocumentUpdate = (update: Uint8Array, origin: unknown) => {
    // Remote changes come in with this connection as origin; only local edits go out. Offline and
    // read-only edits aren't sent here: the next handshake carries them.
    if (origin === this || this.status !== "connected" || !this.self || !canEdit(this.self.access)) return;
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    this.send({ type: "sync", data: encoding.toUint8Array(encoder) });
  };

  private readonly onPresenceUpdate = ({ added, updated, removed }: Record<"added" | "updated" | "removed", number[]>, origin: unknown) => {
    if (origin === this || this.status !== "connected") return;
    const mine = [...added, ...updated, ...removed].filter((id) => id === this.doc.clientID);
    if (mine.length > 0) this.send({ type: "awareness", data: encodeAwarenessUpdate(this.awareness, mine) });
  };

  private readonly onPresenceChange = () => {
    this.emit("others", this.others());
  };

  private send(message: Parameters<typeof encodeMessage>[0]): void {
    const socket = this.socket;
    if (socket && socket.readyState === OPEN) socket.send(encodeMessage(message));
  }

  /* Events -------------------------------------------------------------------------------------- */

  private setStatus(status: Status): void {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", status);
  }

  private report(error: RoomError): void {
    this.lastError = error;
    this.emit("error", error);
  }

  private emit<K extends keyof Events>(event: K, value: Events[K]): void {
    for (const listener of [...this.listeners[event]]) listener(value);
  }
}
