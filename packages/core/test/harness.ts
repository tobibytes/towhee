import { createRoomToken, type RoomKey, type RoomTokenInput } from "@towhee/auth";
import { decodeServerMessage, encodeMessage, errorCodeFromClose, PRESENCE_RESEND_EVENT, PROTOCOL_VERSION, type ServerMessage } from "@towhee/protocol";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { type Connection, MemoryStorage, Room, type RoomOptions, type Timers } from "../src";

export const key: RoomKey = { id: "test", secret: "k".repeat(32) };

/** A clock and timers the test moves by hand, so timeouts are exact in every runtime. */
export class ManualTime implements Timers {
  current = Date.UTC(2027, 0, 1);
  private nextId = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();
  now = () => this.current;
  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { at: this.current + ms, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  advance(ms: number): void {
    this.current += ms;
    for (const [id, t] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= this.current && this.pending.delete(id)) t.callback();
    }
  }
}

export interface Setup {
  room: Room;
  storage: MemoryStorage;
  time: ManualTime;
  clients: TestClient[];
  token(input?: Partial<RoomTokenInput>): Promise<string>;
  /** A connected, authenticated client that has finished the sync handshake. */
  join(input?: Partial<RoomTokenInput>): Promise<TestClient>;
  /** A connected client that hasn't sent anything. */
  open(): TestClient;
  settle(): Promise<void>;
  /** Destroys clients' timers and closes the room. */
  teardown(): Promise<void>;
}

export async function setup(options: Partial<RoomOptions> = {}): Promise<Setup> {
  const storage = (options.storage as MemoryStorage | undefined) ?? new MemoryStorage();
  const time = new ManualTime();
  const room = await Room.load({ id: "doc:1", storage, keys: key, now: time.now, timers: time, ...options });
  const clients: TestClient[] = [];
  let users = 0;
  const s: Setup = {
    room,
    storage,
    time,
    clients,
    token: (input = {}) =>
      createRoomToken({ userId: `user-${++users}`, room: room.id, access: "write", ...input }, key, { now: time.current }),
    open() {
      const client = new TestClient(room);
      clients.push(client);
      room.connect(client.conn);
      return client;
    },
    async join(input = {}) {
      const client = s.open();
      await client.auth(await s.token(input));
      await s.settle();
      return client;
    },
    async settle() {
      // Replies can trigger more replies; loop until every client is quiet.
      for (let i = 0; i < 20; i++) {
        const pending = clients.flatMap((c) => c.takePending());
        if (pending.length === 0) break;
        await Promise.all(pending);
      }
      await room.flush();
    },
    async teardown() {
      for (const c of clients) c.destroy();
      await room.close();
    },
  };
  return s;
}

/** A minimal client speaking the protocol with stock Yjs and y-protocols, like any Yjs app would. */
export class TestClient {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly received: ServerMessage[] = [];
  closed?: { code: number; reason: string; error?: string };
  private pending: Promise<void>[] = [];
  readonly conn: Connection;

  constructor(private room: Room) {
    this.conn = {
      send: (frame) => this.onFrame(frame),
      close: (code, reason) => {
        this.closed = { code, reason, error: errorCodeFromClose(code) };
      },
    };
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const encoder = encoding.createEncoder();
      syncProtocol.writeUpdate(encoder, update);
      this.sendRaw(encodeMessage({ type: "sync", data: encoding.toUint8Array(encoder) }));
    });
    this.awareness.on("update", ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
      if (origin === this) return;
      const changed = [...added!, ...updated!, ...removed!].filter((id) => id === this.doc.clientID);
      if (changed.length) this.sendRaw(encodeMessage({ type: "awareness", data: encodeAwarenessUpdate(this.awareness, changed) }));
    });
  }

  get text(): string {
    return this.doc.getText("t").toString();
  }

  auth(token: string, protocol = PROTOCOL_VERSION): Promise<void> {
    return this.room.receive(this.conn, encodeMessage({ type: "auth", protocol, token }));
  }

  /** Sends any frame. The promise is also tracked, so `settle()` waits for it. */
  sendRaw(frame: Uint8Array): Promise<void> {
    const p = this.room.receive(this.conn, frame);
    this.pending.push(p);
    return p;
  }

  takePending(): Promise<void>[] {
    const p = this.pending;
    this.pending = [];
    return p;
  }

  /** Presence states others see, by client id. */
  others(): Map<number, Record<string, unknown>> {
    const states = new Map(this.awareness.getStates() as Map<number, Record<string, unknown>>);
    states.delete(this.doc.clientID);
    return states;
  }

  errors(): string[] {
    return this.received.flatMap((m) => (m.type === "error" ? [m.code] : []));
  }

  private nextRequest = 1;

  /** Sends a request and returns the server's response (it arrives before the promise resolves). */
  async request(method: string, params?: unknown): Promise<Extract<ServerMessage, { type: "response" }>> {
    const id = this.nextRequest++;
    await this.sendRaw(encodeMessage({ type: "request", id, method, ...(params === undefined ? {} : { params }) }));
    const response = this.received.find((m) => m.type === "response" && m.id === id);
    if (response?.type !== "response") throw new Error(`No response to ${method}`);
    return response;
  }

  /** Data of every event received with this name. */
  events(name: string): unknown[] {
    return this.received.flatMap((m) => (m.type === "event" && m.name === name ? [m.data] : []));
  }

  /** Points this client's socket at another Room instance, as if the server reloaded the room. */
  rebind(room: Room): void {
    this.room = room;
  }

  disconnect(): void {
    this.room.disconnect(this.conn);
  }

  destroy(): void {
    this.awareness.destroy();
    this.doc.destroy();
  }

  private onFrame(frame: Uint8Array): void {
    const message = decodeServerMessage(frame);
    this.received.push(message);
    if (message.type === "ready") {
      // Like y-websocket: ask the server for what we're missing.
      const encoder = encoding.createEncoder();
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.sendRaw(encodeMessage({ type: "sync", data: encoding.toUint8Array(encoder) }));
    } else if (message.type === "sync") {
      const encoder = encoding.createEncoder();
      syncProtocol.readSyncMessage(decoding.createDecoder(message.data), encoder, this.doc, this);
      if (encoding.length(encoder) > 0) this.sendRaw(encodeMessage({ type: "sync", data: encoding.toUint8Array(encoder) }));
    } else if (message.type === "awareness") {
      applyAwarenessUpdate(this.awareness, message.data, this);
    } else if (message.type === "event" && message.name === PRESENCE_RESEND_EVENT && this.awareness.getLocalState() !== null) {
      this.sendRaw(encodeMessage({ type: "awareness", data: encodeAwarenessUpdate(this.awareness, [this.doc.clientID]) }));
    }
  }
}
