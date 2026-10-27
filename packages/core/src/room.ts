import { type RoomKey, TokenError, validateRoomKeys, verifyRoomToken } from "@towhee/auth";
import {
  type Access,
  type AuthMessage,
  canEdit,
  closeCodeFor,
  decodeClientMessage,
  type ErrorCode,
  encodeMessage,
  isValidRoomId,
  PRESENCE_RESEND_EVENT,
  PROTOCOL_VERSION,
  ProtocolError,
  type RoomUser,
  type ServerMessage,
} from "@towhee/protocol";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, outdatedTimeout, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import { type Limits, resolveLimits } from "./limits";
import { decodePresence, encodePresence, type PresenceEntry } from "./presence";
import type { Storage } from "./storage";

/** One client's socket, as the host sees it. The host calls the room's `connect`, `receive` and `disconnect`. */
export interface Connection {
  send(frame: Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RoomOptions {
  id: string;
  storage: Storage;
  /** Keys that sign this deployment's tokens. */
  keys: RoomKey | readonly RoomKey[];
  limits?: Partial<Limits>;
  /** Milliseconds since the epoch. Default `Date.now`. */
  now?: () => number;
  /**
   * For auth timeouts, token expiry and stale presence. Default the global timers. `"manual"` sets
   * no timers at all (a Durable Object can't hibernate with one pending): the host calls `sweep()`
   * at `nextDeadline()` instead.
   */
  timers?: Timers | "manual";
  /**
   * A connection was added, authenticated, claimed presence or closed (`null`). Hosts that unload
   * rooms while sockets stay open (Durable Object hibernation) store this and pass it to `restore()`.
   */
  onConnectionChange?: (conn: Connection, state: ConnectionState | null) => void;
  /** Called when the last connection leaves. Hosts usually unload the room after a while. */
  onEmpty?: (room: Room) => void;
  /** Unexpected errors: storage failures and bugs. The affected connections are closed with `internal`. */
  onError?: (error: unknown, room: Room) => void;
}

/** What a host keeps to restore a connection after the room was unloaded. Plain JSON. */
export interface ConnectionState {
  id: string;
  phase: "pending" | "ready";
  connectedAt: number;
  user?: RoomUser;
  access?: Access;
  expiresAt?: number;
  /** Awareness client ids the connection owns. */
  presence: number[];
}

interface ConnectionData {
  id: string;
  phase: "pending" | "ready" | "closed";
  connectedAt: number;
  user?: RoomUser;
  access?: Access;
  expiresAt?: number;
  /** Awareness client ids this connection owns. */
  presence: Set<number>;
  /** Frames are handled one at a time, in order, per connection. */
  queue: Promise<void>;
  windowStart: number;
  windowCount: number;
  authTimer?: unknown;
  expiryTimer?: unknown;
}

// y-protocols sync message kinds.
const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;
/** Same allowance `verifyRoomToken` gives, so a token it accepts isn't closed straight away. */
const CLOCK_SKEW_MS = 60_000;

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

function syncFrame(kind: number, payload: Uint8Array): ServerMessage {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, kind);
  encoding.writeVarUint8Array(encoder, payload);
  return { type: "sync", data: encoding.toUint8Array(encoder) };
}

/** Parsing errors from lib0 and Yjs become protocol errors: the client sent something malformed. */
function parse<T>(what: string, read: () => T): T {
  try {
    return read();
  } catch {
    throw new ProtocolError(`Malformed ${what}`);
  }
}

/**
 * One shared document and everyone connected to it. Host-agnostic: the host passes frames in and
 * gets frames out through {@link Connection}, and the document is kept in a {@link Storage}.
 */
export class Room {
  readonly id: string;
  readonly doc: Y.Doc;
  /** Presence of everyone in the room, with identities taken from their tokens. */
  readonly awareness: Awareness;
  readonly limits: Limits;

  private readonly storage: Storage;
  private readonly keys: RoomKey | readonly RoomKey[];
  private readonly now: () => number;
  /** Undefined in manual mode. */
  private readonly timers: Timers | undefined;
  private readonly onEmpty?: (room: Room) => void;
  private readonly onConnectionChange?: (conn: Connection, state: ConnectionState | null) => void;
  private readonly onError?: (error: unknown, room: Room) => void;
  private readonly connections = new Map<Connection, ConnectionData>();
  private readonly presenceOwners = new Map<number, Connection>();
  private persisting: Promise<void> = Promise.resolve();
  private storageFailed = false;
  private loggedUpdates = 0;
  private loggedBytes = 0;
  /** Upper bound of the document's encoded size: exact after load and compaction, plus updates since. */
  private size: number;
  private state: "open" | "closing" | "closed" = "open";

  /** Loads the room's document from storage. Throws a TypeError for an invalid room id or keys. */
  static async load(options: RoomOptions): Promise<Room> {
    if (!isValidRoomId(options.id)) throw new TypeError(`"${String(options.id)}" isn't a valid room id`);
    validateRoomKeys(options.keys);
    const limits = resolveLimits(options.limits);
    const saved = await options.storage.loadDocument(options.id);
    return new Room(options, limits, saved);
  }

  private constructor(options: RoomOptions, limits: Limits, saved: Uint8Array | null) {
    this.id = options.id;
    this.limits = limits;
    this.storage = options.storage;
    this.keys = options.keys;
    this.now = options.now ?? Date.now;
    this.timers = options.timers === "manual" ? undefined : (options.timers ?? defaultTimers);
    this.onEmpty = options.onEmpty;
    this.onConnectionChange = options.onConnectionChange;
    this.onError = options.onError;

    this.doc = new Y.Doc();
    if (saved) Y.applyUpdate(this.doc, saved);
    this.size = Y.encodeStateAsUpdate(this.doc).length;
    this.awareness = new Awareness(this.doc);
    // The server has no presence of its own.
    this.awareness.setLocalState(null);
    // y-protocols starts an interval to expire stale presence. Manual mode does that in sweep().
    if (!this.timers) clearInterval((this.awareness as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => this.onDocumentUpdate(update, origin));
    this.awareness.on("update", ({ added, updated, removed }: Record<"added" | "updated" | "removed", number[]>, origin: unknown) =>
      this.onPresenceUpdate([...added, ...updated, ...removed], origin),
    );
  }

  /** Connections that are open, including ones still authenticating. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** A new socket. It must send `auth` within `limits.authTimeoutMs`. */
  connect(conn: Connection): void {
    if (this.state !== "open") {
      this.reject(conn, "server_restarting", "The room is closing");
      return;
    }
    if (this.connections.size >= this.limits.maxConnections) {
      this.reject(conn, "room_full", "The room is full");
      return;
    }
    const now = this.now();
    const data: ConnectionData = {
      id: randomId(),
      phase: "pending",
      connectedAt: now,
      presence: new Set(),
      queue: Promise.resolve(),
      windowStart: now,
      windowCount: 0,
    };
    data.authTimer = this.timers?.setTimeout(() => {
      if (data.phase === "pending") this.fail(conn, "auth_timeout", "No auth message arrived in time");
    }, this.limits.authTimeoutMs);
    this.connections.set(conn, data);
    this.notify(conn, data);
  }

  /**
   * Puts back a connection whose socket stayed open while the room was unloaded (Durable Object
   * hibernation), from what `onConnectionChange` gave the host. Its presence comes back when the
   * clients resend it: call `requestPresence()` once every connection is restored.
   */
  restore(conn: Connection, state: ConnectionState): void {
    if (this.state !== "open" || this.connections.has(conn)) return;
    const now = this.now();
    const data: ConnectionData = {
      id: state.id,
      phase: state.phase,
      connectedAt: state.connectedAt,
      user: state.user,
      access: state.access,
      expiresAt: state.expiresAt,
      presence: new Set(state.presence),
      queue: Promise.resolve(),
      windowStart: now,
      windowCount: 0,
    };
    this.connections.set(conn, data);
    for (const id of data.presence) this.presenceOwners.set(id, conn);
    if (data.phase === "pending") {
      data.authTimer = this.timers?.setTimeout(
        () => {
          if (data.phase === "pending") this.fail(conn, "auth_timeout", "No auth message arrived in time");
        },
        Math.max(0, state.connectedAt + this.limits.authTimeoutMs - now),
      );
    } else if (data.expiresAt !== undefined) {
      data.expiryTimer = this.timers?.setTimeout(
        () => this.fail(conn, "token_expired", "The token has expired"),
        Math.max(0, data.expiresAt + CLOCK_SKEW_MS - now),
      );
    }
  }

  /** Asks every client to send its presence again, after the room lost it. */
  requestPresence(): void {
    for (const [conn, data] of this.connections) {
      if (data.phase === "ready") this.send(conn, data, { type: "event", name: PRESENCE_RESEND_EVENT });
    }
  }

  /**
   * Manual mode: closes connections that didn't authenticate in time or whose token expired, and
   * drops presence nobody renewed for 30 seconds. Safe to call any time.
   */
  sweep(now: number = this.now()): void {
    for (const [conn, data] of [...this.connections]) {
      if (data.phase === "pending" && now >= data.connectedAt + this.limits.authTimeoutMs) {
        this.fail(conn, "auth_timeout", "No auth message arrived in time");
      } else if (data.phase === "ready" && data.expiresAt !== undefined && now > data.expiresAt + CLOCK_SKEW_MS) {
        this.fail(conn, "token_expired", "The token has expired");
      }
    }
    const stale: number[] = [];
    for (const [clientId, meta] of this.awareness.meta) {
      if (this.awareness.states.has(clientId) && now - meta.lastUpdated >= outdatedTimeout) stale.push(clientId);
    }
    if (stale.length > 0) removeAwarenessStates(this.awareness, stale, "timeout");
  }

  /** Manual mode: when `sweep()` next has work to do, in epoch milliseconds, or undefined. */
  nextDeadline(): number | undefined {
    let next = Number.POSITIVE_INFINITY;
    for (const data of this.connections.values()) {
      if (data.phase === "pending") next = Math.min(next, data.connectedAt + this.limits.authTimeoutMs);
      else if (data.expiresAt !== undefined) next = Math.min(next, data.expiresAt + CLOCK_SKEW_MS + 1);
    }
    for (const [clientId, meta] of this.awareness.meta) {
      if (this.awareness.states.has(clientId)) next = Math.min(next, meta.lastUpdated + outdatedTimeout);
    }
    return Number.isFinite(next) ? next : undefined;
  }

  /** A frame from a socket. Frames from one connection are handled in order; await to know it's done. */
  receive(conn: Connection, frame: Uint8Array): Promise<void> {
    const data = this.connections.get(conn);
    if (!data) return Promise.resolve();
    data.queue = data.queue.then(() => this.handle(conn, data, frame));
    return data.queue;
  }

  /** The socket closed on the client's side. */
  disconnect(conn: Connection): void {
    const data = this.connections.get(conn);
    if (data) this.cleanup(conn, data);
  }

  /** Resolves when everything so far has been written to storage. */
  async flush(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.persisting;
      await current;
    } while (current !== this.persisting);
  }

  /** Closes every connection (default `server_restarting`), saves a compacted document and frees the room. */
  async close(code: ErrorCode = "server_restarting"): Promise<void> {
    if (this.state !== "open") {
      await this.flush();
      return;
    }
    this.state = "closing";
    for (const conn of [...this.connections.keys()]) this.fail(conn, code, "The room is closing");
    if (this.loggedUpdates > 0) this.compact();
    await this.flush();
    this.awareness.destroy();
    this.doc.destroy();
    this.state = "closed";
  }

  /* Frames ---------------------------------------------------------------------------------- */

  private async handle(conn: Connection, data: ConnectionData, frame: Uint8Array): Promise<void> {
    if (data.phase === "closed") return;
    try {
      if (frame.length > this.limits.maxMessageBytes) {
        this.fail(conn, "message_too_large", `Frames may be at most ${this.limits.maxMessageBytes} bytes`);
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
      switch (message.type) {
        case "auth":
          throw new ProtocolError("Already authenticated");
        case "sync":
          this.handleSync(conn, data, message.data);
          return;
        case "awareness":
          this.handlePresence(conn, data, message.data);
          return;
        case "request":
          this.send(conn, data, {
            type: "response",
            id: message.id,
            ok: false,
            error: { code: "not_found", message: `Unknown method ${message.method}` },
          });
          return;
      }
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.fail(conn, "protocol_error", error.message);
      } else {
        this.onError?.(error, this);
        this.fail(conn, "internal", "Something went wrong on the server");
      }
    }
  }

  private async authenticate(conn: Connection, data: ConnectionData, message: AuthMessage): Promise<void> {
    if (message.protocol !== PROTOCOL_VERSION) {
      this.fail(conn, "unsupported_protocol", `This server speaks protocol ${PROTOCOL_VERSION}`);
      return;
    }
    let token: Awaited<ReturnType<typeof verifyRoomToken>>;
    try {
      token = await verifyRoomToken(message.token, this.keys, { room: this.id, now: this.now() });
    } catch (error) {
      if (!(error instanceof TokenError)) throw error;
      this.fail(conn, error.code === "expired" ? "token_expired" : "unauthorized", error.message);
      return;
    }
    // The socket may have closed, or the room started closing, while the token was checked.
    if (data.phase !== "pending") return;
    if (this.state !== "open") {
      this.fail(conn, "server_restarting", "The room is closing");
      return;
    }

    this.timers?.clearTimeout(data.authTimer);
    data.phase = "ready";
    data.user = token.user;
    data.access = token.access;
    data.expiresAt = token.expiresAt;
    data.expiryTimer = this.timers?.setTimeout(
      () => this.fail(conn, "token_expired", "The token has expired"),
      Math.max(0, token.expiresAt + CLOCK_SKEW_MS - this.now()),
    );
    this.notify(conn, data);

    this.send(conn, data, { type: "ready", protocol: PROTOCOL_VERSION, connectionId: data.id, access: token.access, user: token.user });
    this.send(conn, data, syncFrame(SYNC_STEP1, Y.encodeStateVector(this.doc)));
    const present = [...this.awareness.getStates().keys()];
    if (present.length > 0) this.send(conn, data, { type: "awareness", data: encodeAwarenessUpdate(this.awareness, present) });
  }

  private handleSync(conn: Connection, data: ConnectionData, bytes: Uint8Array): void {
    const decoder = decoding.createDecoder(bytes);
    const kind = parse("sync message", () => decoding.readVarUint(decoder));

    if (kind === SYNC_STEP1) {
      const stateVector = parse("state vector", () => decoding.readVarUint8Array(decoder));
      const missing = parse("state vector", () => Y.encodeStateAsUpdate(this.doc, stateVector));
      this.send(conn, data, syncFrame(SYNC_STEP2, missing));
      return;
    }
    if (kind !== SYNC_STEP2 && kind !== SYNC_UPDATE) throw new ProtocolError("Unknown sync message");

    const update = parse("update", () => decoding.readVarUint8Array(decoder));
    const decoded = parse("update", () => Y.decodeUpdate(update));
    if (!canEdit(data.access!)) {
      // Readers still answer the sync handshake with what they have. That's fine as long as it
      // tells the server nothing new; any real change is a write they aren't allowed.
      if (this.isNew(decoded)) this.fail(conn, "forbidden", "This connection can't edit the document");
      return;
    }
    if (this.size + update.length > this.limits.maxDocumentBytes) {
      this.fail(conn, "document_too_large", `Documents may be at most ${this.limits.maxDocumentBytes} bytes`);
      return;
    }
    parse("update", () => Y.applyUpdate(this.doc, update, conn));
  }

  /** Whether an update holds anything the document doesn't already have. */
  private isNew(update: ReturnType<typeof Y.decodeUpdate>): boolean {
    const known = Y.decodeStateVector(Y.encodeStateVector(this.doc));
    for (const struct of update.structs) {
      if (struct instanceof Y.Skip) continue;
      if (struct.id.clock + struct.length > (known.get(struct.id.client) ?? 0)) return true;
    }
    if (update.ds.clients.size === 0) return false;
    const deleted = Y.createDeleteSetFromStructStore(this.doc.store).clients;
    for (const [client, items] of update.ds.clients) {
      const ranges = deleted.get(client) ?? [];
      for (const { clock, len } of items) {
        if (!ranges.some((r) => r.clock <= clock && clock + len <= r.clock + r.len)) return true;
      }
    }
    return false;
  }

  private handlePresence(conn: Connection, data: ConnectionData, bytes: Uint8Array): void {
    const entries = parse("awareness update", () => decodePresence(bytes));
    const kept: PresenceEntry[] = [];
    const claimed = new Set<Connection>();
    for (const entry of entries) {
      const owner = this.presenceOwners.get(entry.clientId);
      if (owner !== undefined && owner !== conn) {
        // Another connection owns this presence. Only the same user may take it over (a reconnect
        // that arrived before the old socket closed); anyone else's entry is dropped.
        const ownerData = this.connections.get(owner);
        if (ownerData?.user?.id !== data.user!.id) continue;
        ownerData.presence.delete(entry.clientId);
        this.presenceOwners.delete(entry.clientId);
        claimed.add(owner);
      }
      if (!data.presence.has(entry.clientId)) {
        if (data.presence.size >= this.limits.maxPresencePerConnection) continue;
        data.presence.add(entry.clientId);
        this.presenceOwners.set(entry.clientId, conn);
        claimed.add(conn);
      }
      // Identity always comes from the token, whatever the client put in its state.
      const state = entry.state === null ? null : { ...(isRecord(entry.state) ? entry.state : {}), user: data.user };
      kept.push({ ...entry, state });
    }
    if (kept.length > 0) {
      applyAwarenessUpdate(this.awareness, encodePresence(kept), conn);
      // y-protocols stamps the wall clock; use the room's clock so sweep() and tests agree.
      const now = this.now();
      for (const { clientId } of kept) {
        const meta = this.awareness.meta.get(clientId);
        if (meta) meta.lastUpdated = now;
      }
    }
    for (const changed of claimed) {
      const changedData = this.connections.get(changed);
      if (changedData) this.notify(changed, changedData);
    }
  }

  /* Document and presence changes ------------------------------------------------------------- */

  private onDocumentUpdate(update: Uint8Array, origin: unknown): void {
    this.size += update.length;
    const frame = encodeMessage(syncFrame(SYNC_UPDATE, update));
    for (const [conn, data] of this.connections) {
      if (data.phase === "ready" && conn !== origin) this.sendFrame(conn, data, frame);
    }
    this.persist(() => this.storage.appendUpdate(this.id, update));
    this.loggedUpdates++;
    this.loggedBytes += update.length;
    if (this.loggedUpdates >= this.limits.compactAfterUpdates || this.loggedBytes >= this.limits.compactAfterBytes) this.compact();
  }

  private onPresenceUpdate(clientIds: number[], origin: unknown): void {
    if (clientIds.length === 0) return;
    const frame = encodeMessage({ type: "awareness", data: encodeAwarenessUpdate(this.awareness, clientIds) });
    for (const [conn, data] of this.connections) {
      if (data.phase === "ready" && conn !== origin) this.sendFrame(conn, data, frame);
    }
  }

  /* Storage --------------------------------------------------------------------------------- */

  private compact(): void {
    const state = Y.encodeStateAsUpdate(this.doc);
    this.size = state.length;
    this.loggedUpdates = 0;
    this.loggedBytes = 0;
    this.persist(() => this.storage.compact(this.id, state));
  }

  /** Storage calls run one after another. After a failure nothing more is written and the room closes. */
  private persist(task: () => Promise<void>): void {
    this.persisting = this.persisting.then(async () => {
      if (this.storageFailed) return;
      try {
        await task();
      } catch (error) {
        this.storageFailed = true;
        this.onError?.(error, this);
        void this.close("internal");
      }
    });
  }

  /* Connections ----------------------------------------------------------------------------- */

  private send(conn: Connection, data: ConnectionData, message: ServerMessage): void {
    this.sendFrame(conn, data, encodeMessage(message));
  }

  private sendFrame(conn: Connection, data: ConnectionData, frame: Uint8Array): void {
    if (data.phase === "closed") return;
    try {
      conn.send(frame);
    } catch {
      // The socket is gone; treat it as a disconnect.
      this.cleanup(conn, data);
    }
  }

  /** Refuses a socket that was never added to the room. */
  private reject(conn: Connection, code: ErrorCode, message: string): void {
    try {
      conn.send(encodeMessage({ type: "error", code, message }));
      conn.close(closeCodeFor(code), code);
    } catch {
      // Already closed.
    }
  }

  /** Sends an error, closes the socket with its code and removes the connection. */
  private fail(conn: Connection, code: ErrorCode, message: string): void {
    const data = this.connections.get(conn);
    if (!data || data.phase === "closed") return;
    try {
      conn.send(encodeMessage({ type: "error", code, message }));
      conn.close(closeCodeFor(code), code);
    } catch {
      // Already closed.
    }
    this.cleanup(conn, data);
  }

  private notify(conn: Connection, data: ConnectionData): void {
    if (!this.onConnectionChange) return;
    if (data.phase === "closed") {
      this.onConnectionChange(conn, null);
      return;
    }
    this.onConnectionChange(conn, {
      id: data.id,
      phase: data.phase,
      connectedAt: data.connectedAt,
      ...(data.user ? { user: data.user } : {}),
      ...(data.access ? { access: data.access } : {}),
      ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
      presence: [...data.presence],
    });
  }

  private cleanup(conn: Connection, data: ConnectionData): void {
    if (data.phase === "closed") return;
    data.phase = "closed";
    this.timers?.clearTimeout(data.authTimer);
    this.timers?.clearTimeout(data.expiryTimer);
    this.connections.delete(conn);
    this.notify(conn, data);

    const owned = [...data.presence].filter((id) => this.presenceOwners.get(id) === conn);
    for (const id of owned) this.presenceOwners.delete(id);
    if (owned.length > 0) removeAwarenessStates(this.awareness, owned, null);

    if (this.connections.size === 0 && this.state === "open") {
      if (this.loggedUpdates > 0) this.compact();
      this.onEmpty?.(this);
    }
  }
}
