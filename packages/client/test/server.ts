import { createInboxToken, createRoomToken, type RoomKey, type RoomTokenInput } from "@towhee/auth";
import { type Connection, Inbox, MemoryStorage, Room } from "@towhee/core";
import { INBOX_ROOM } from "@towhee/protocol";
import type { SocketFactory, SocketLike, Timers } from "../src";

export const key: RoomKey = { id: "test", secret: "c".repeat(32) };

/** One clock for the server and the clients, moved by hand. */
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
  /** Moves the clock, firing timers that come due, then lets the fallout settle. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.pending].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.current = Math.max(this.current, due[1].at);
      due[1].callback();
      await settle();
    }
    this.current = target;
    await settle();
  }
}

/**
 * Work the fake network still has going: frames in transit, frames a room is still handling,
 * tokens being signed, rooms loading. `settle()` waits until it reaches zero, so tests don't
 * depend on how many event loop turns a machine needs.
 */
let inFlight = 0;

function track<T>(work: Promise<T>): Promise<T> {
  inFlight++;
  return work.finally(() => inFlight--);
}

function later(fn: () => void): void {
  inFlight++;
  setTimeout(() => {
    inFlight--;
    fn();
  }, 0);
}

/** Waits until the fake network has nothing left in flight (and stays that way for a few turns). */
export async function settle(): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < 2000 && quiet < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    quiet = inFlight === 0 ? quiet + 1 : 0;
  }
}

/**
 * Real `@towhee/core` rooms behind fake WebSockets, all in one process. Frames cross with a
 * macrotask delay, like a network.
 */
export class TestServer {
  readonly storage = new MemoryStorage();
  readonly time = new ManualTime();
  readonly rooms = new Map<string, Promise<Room>>();
  readonly inboxes = new Map<string, Inbox>();
  readonly sockets = new Set<FakeSocket>();
  readonly urls: string[] = [];
  private users = 0;

  /** A room token, or an inbox token when the client asks for the inbox room. */
  token = (input: Partial<RoomTokenInput> = {}) =>
    input.room === INBOX_ROOM
      ? track(createInboxToken({ userId: input.userId ?? `user-${++this.users}` }, key, { now: this.time.current }))
      : track(createRoomToken({ userId: `user-${++this.users}`, room: "doc:1", access: "write", ...input }, key, { now: this.time.current }));

  inbox(userId: string): Inbox {
    let inbox = this.inboxes.get(userId);
    if (!inbox) {
      inbox = Inbox.create({ userId, store: this.storage.inbox, keys: key, now: this.time.now, timers: this.time });
      this.inboxes.set(userId, inbox);
    }
    return inbox;
  }

  room(id: string): Promise<Room> {
    let room = this.rooms.get(id);
    if (!room) {
      room = track(
        Room.load({
          id,
          storage: this.storage,
          keys: key,
          now: this.time.now,
          timers: this.time,
          onNotify: (scope, deliveries) => {
            for (const d of deliveries) void track(this.inbox(d.userId).deliver(scope, d.notification));
          },
        }),
      );
      this.rooms.set(id, room);
    }
    return room;
  }

  /** A WebSocket class for one client; `tag` lets a test drop just that client's connection. */
  socketClass(tag = "default"): SocketFactory {
    const server = this;
    return class extends FakeSocket {
      constructor(url: string) {
        super(server, url, tag);
      }
    };
  }

  /** Cuts connections (all, or one client's), as a network failure would (close code 1006). */
  drop(tag?: string): void {
    for (const socket of [...this.sockets]) if (tag === undefined || socket.tag === tag) socket.drop();
  }

  async close(): Promise<void> {
    for (const inbox of this.inboxes.values()) inbox.close();
    for (const room of this.rooms.values()) await (await room).close();
  }
}

export class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  private room?: Pick<Room, "connect" | "receive" | "disconnect">;
  private readonly conn: Connection;

  constructor(
    private readonly server: TestServer,
    readonly url: string,
    readonly tag: string,
  ) {
    server.urls.push(url);
    server.sockets.add(this);
    this.conn = {
      send: (frame) => {
        const copy = frame.slice();
        later(() => {
          if (this.readyState === 1) this.onmessage?.({ data: copy.buffer });
        });
      },
      close: (code, reason) => this.finish(code, reason),
    };
    const inbox = /\/v1\/inbox\/([^/]+)$/.exec(url);
    const match = /\/v1\/rooms\/([^/]+)$/.exec(url);
    if (!match && !inbox) throw new Error(`Unexpected URL ${url}`);
    const target: Promise<Pick<Room, "connect" | "receive" | "disconnect">> = inbox
      ? Promise.resolve(server.inbox(decodeURIComponent(inbox[1]!)))
      : server.room(decodeURIComponent(match![1]!));
    void track(target).then((room) => {
      if (this.readyState !== 0) return;
      this.room = room;
      this.readyState = 1;
      room.connect(this.conn);
      this.onopen?.({});
    });
  }

  send(data: Uint8Array): void {
    if (this.readyState !== 1) throw new Error("Socket not open");
    const copy = data.slice();
    later(() => {
      if (this.readyState === 1 && this.room) void track(this.room.receive(this.conn, copy));
    });
  }

  /** The client closes. */
  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.room?.disconnect(this.conn);
    this.finish(code, reason);
  }

  drop(): void {
    if (this.readyState >= 2) return;
    this.room?.disconnect(this.conn);
    this.finish(1006, "");
  }

  private finish(code: number, reason: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.server.sockets.delete(this);
    later(() => this.onclose?.({ code, reason }));
  }
}
