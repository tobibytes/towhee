import { encodeMessage, ERROR_CODES, MESSAGE_TYPES, PROTOCOL_VERSION } from "@towhee/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { decodePresence, encodePresence, MemoryStorage, MemoryThreadStore, Room, type Storage } from "../src";
import { storageSuite } from "../src/testing";
import { key, type Setup, setup } from "./harness";

let current: Setup | undefined;
async function start(...args: Parameters<typeof setup>) {
  current = await setup(...args);
  return current;
}
afterEach(async () => {
  await current?.teardown();
  current = undefined;
});

const editText = (doc: Y.Doc, index: number, value: string) => doc.getText("t").insert(index, value);

describe("sync", () => {
  it("three clients editing at once converge", async () => {
    const s = await start();
    const [a, b, c] = [await s.join(), await s.join(), await s.join()];
    editText(a!.doc, 0, "alpha ");
    editText(b!.doc, 0, "bravo ");
    editText(c!.doc, 0, "charlie ");
    editText(a!.doc, a!.text.length, "end");
    await s.settle();
    const server = s.room.doc.getText("t").toString();
    expect(server).toHaveLength("alpha bravo charlie end".length);
    for (const client of [a, b, c]) expect(client!.text).toBe(server);
    for (const word of ["alpha", "bravo", "charlie", "end"]) expect(server).toContain(word);
  });

  it("a late joiner catches up", async () => {
    const s = await start();
    const a = await s.join();
    editText(a.doc, 0, "written before you came");
    a.doc.getMap("m").set("k", 1);
    await s.settle();
    const late = await s.join();
    expect(late.text).toBe("written before you came");
    expect(late.doc.getMap("m").get("k")).toBe(1);
  });

  it("sends offline edits made before joining once the client is in", async () => {
    const s = await start();
    const a = await s.join();
    editText(a.doc, 0, "server copy");
    await s.settle();
    // A client with its own unsynced history joins and both sides merge.
    const b = s.open();
    const offline = new Y.Doc();
    editText(offline, 0, "offline ");
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(offline), b); // origin b: not sent before auth
    await b.auth(await s.token());
    await s.settle();
    expect(b.text).toBe(s.room.doc.getText("t").toString());
    expect(a.text).toBe(b.text);
    expect(a.text).toContain("offline ");
    expect(a.text).toContain("server copy");
  });
});

describe("access", () => {
  it("readers get every update, and are disconnected when they edit", async () => {
    const s = await start();
    const writer = await s.join({ access: "write" });
    const reader = await s.join({ access: "read" });
    editText(writer.doc, 0, "for your eyes");
    await s.settle();
    expect(reader.text).toBe("for your eyes");
    expect(reader.closed).toBeUndefined(); // the sync handshake alone is fine

    editText(reader.doc, 0, "vandalism ");
    await s.settle();
    expect(reader.closed?.code).toBe(ERROR_CODES.forbidden);
    expect(reader.errors()).toEqual(["forbidden"]);
    expect(s.room.doc.getText("t").toString()).toBe("for your eyes");
    expect(writer.text).toBe("for your eyes");
  });

  it("readers can't delete either", async () => {
    const s = await start();
    const writer = await s.join();
    editText(writer.doc, 0, "keep me");
    await s.settle();
    const reader = await s.join({ access: "read" });
    reader.doc.getText("t").delete(0, 4);
    await s.settle();
    expect(reader.closed?.code).toBe(ERROR_CODES.forbidden);
    expect(s.room.doc.getText("t").toString()).toBe("keep me");
  });

  it("a reader that saw deletions syncs back without being refused", async () => {
    const s = await start();
    const writer = await s.join();
    editText(writer.doc, 0, "abcdef");
    writer.doc.getText("t").delete(1, 2);
    await s.settle();
    const reader = await s.join({ access: "read" });
    // Reconnect-style handshake: the reader sends everything it has, deletions included.
    expect(Y.decodeUpdate(Y.encodeStateAsUpdate(reader.doc)).ds.clients.size).toBeGreaterThan(0);
    const again = reader.sendRaw(
      encodeMessage({ type: "sync", data: syncStep2(Y.encodeStateAsUpdate(reader.doc)) }),
    );
    await again;
    await s.settle();
    expect(reader.text).toBe("adef");
    expect(reader.closed).toBeUndefined();
  });

  it("comment access can't edit the document", async () => {
    const s = await start();
    const commenter = await s.join({ access: "comment" });
    editText(commenter.doc, 0, "nope");
    await s.settle();
    expect(commenter.closed?.code).toBe(ERROR_CODES.forbidden);
    expect(s.room.doc.getText("t").toString()).toBe("");
  });

  it("tells each connection its access and identity", async () => {
    const s = await start();
    const c = await s.join({ userId: "ada", access: "comment", user: { name: "Ada" } });
    const ready = c.received.find((m) => m.type === "ready");
    expect(ready).toMatchObject({ protocol: PROTOCOL_VERSION, access: "comment", user: { id: "ada", name: "Ada" } });
  });
});

function syncStep2(update: Uint8Array): Uint8Array {
  // y-protocols sync step 2: kind 1, then the update as a var-length byte array.
  const out = new Uint8Array(update.length + 10);
  let pos = 0;
  out[pos++] = 1;
  let len = update.length;
  while (len > 127) {
    out[pos++] = (len & 127) | 128;
    len >>>= 7;
  }
  out[pos++] = len;
  out.set(update, pos);
  return out.subarray(0, pos + update.length);
}

describe("presence", () => {
  it("takes identity from the token, whatever the client claims", async () => {
    const s = await start();
    const ada = await s.join({ userId: "ada", user: { name: "Ada", color: "#0ea5e9" } });
    const bob = await s.join({ userId: "bob" });
    ada.awareness.setLocalState({ cursor: 3, user: { id: "admin", name: "Not Ada" } });
    await s.settle();
    const seen = [...bob.others().values()];
    expect(seen).toEqual([{ cursor: 3, user: { id: "ada", name: "Ada", color: "#0ea5e9" } }]);
  });

  it("disappears when a client leaves", async () => {
    const s = await start();
    const a = await s.join();
    const b = await s.join();
    a.awareness.setLocalState({ cursor: 1 });
    await s.settle();
    expect(b.others().size).toBe(1);
    a.disconnect();
    await s.settle();
    expect(b.others().size).toBe(0);
    expect(s.room.awareness.getStates().size).toBe(0);
  });

  it("shows current presence to someone who joins later", async () => {
    const s = await start();
    const a = await s.join({ userId: "ada" });
    a.awareness.setLocalState({ cursor: 9 });
    await s.settle();
    const late = await s.join();
    expect([...late.others().values()]).toEqual([{ cursor: 9, user: { id: "ada" } }]);
  });

  it("won't let one user change or remove another user's presence", async () => {
    const s = await start();
    const ada = await s.join({ userId: "ada" });
    const eve = await s.join({ userId: "eve" });
    ada.awareness.setLocalState({ cursor: 1 });
    await s.settle();
    const adaId = ada.doc.clientID;
    const clock = s.room.awareness.meta.get(adaId)!.clock;
    await eve.sendRaw(encodeMessage({ type: "awareness", data: encodePresence([{ clientId: adaId, clock: clock + 1, state: { cursor: 666 } }]) }));
    await eve.sendRaw(encodeMessage({ type: "awareness", data: encodePresence([{ clientId: adaId, clock: clock + 2, state: null }]) }));
    await s.settle();
    expect(s.room.awareness.getStates().get(adaId)).toEqual({ cursor: 1, user: { id: "ada" } });
    expect(eve.closed).toBeUndefined();
  });

  it("lets the same user take over their presence after a reconnect", async () => {
    const s = await start();
    const first = await s.join({ userId: "ada" });
    first.awareness.setLocalState({ cursor: 1 });
    await s.settle();
    const second = await s.join({ userId: "ada" });
    const clock = s.room.awareness.meta.get(first.doc.clientID)!.clock;
    await second.sendRaw(
      encodeMessage({ type: "awareness", data: encodePresence([{ clientId: first.doc.clientID, clock: clock + 1, state: { cursor: 2 } }]) }),
    );
    await s.settle();
    first.disconnect(); // the old socket finally closes; the presence now belongs to the new one
    await s.settle();
    expect(s.room.awareness.getStates().get(first.doc.clientID)).toEqual({ cursor: 2, user: { id: "ada" } });
  });

  it("closes on a malformed awareness update", async () => {
    const s = await start();
    const a = await s.join();
    await a.sendRaw(encodeMessage({ type: "awareness", data: new Uint8Array([5, 1]) }));
    expect(a.closed?.code).toBe(ERROR_CODES.protocol_error);
  });

  it("round-trips awareness updates in the y-protocols format", () => {
    const doc = new Y.Doc();
    const encoded = encodePresence([{ clientId: 7, clock: 3, state: { a: 1 } }, { clientId: 8, clock: 1, state: null }]);
    expect(decodePresence(encoded)).toEqual([
      { clientId: 7, clock: 3, state: { a: 1 } },
      { clientId: 8, clock: 1, state: null },
    ]);
    doc.destroy();
    expect(() => decodePresence(new Uint8Array([200]))).toThrow();
    expect(() => decodePresence(new Uint8Array([0, 1]))).toThrow(); // trailing bytes
  });

  it("matches what y-protocols itself encodes", async () => {
    const { Awareness } = await import("y-protocols/awareness");
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalState({ name: "x" });
    const native = encodeAwarenessUpdate(awareness, [doc.clientID]);
    expect(encodePresence(decodePresence(native))).toEqual(native);
    awareness.destroy();
    doc.destroy();
  });
});

describe("auth", () => {
  it("must come first", async () => {
    const s = await start();
    const c = s.open();
    await c.sendRaw(encodeMessage({ type: "sync", data: new Uint8Array([0, 0]) }));
    expect(c.closed?.code).toBe(ERROR_CODES.protocol_error);
  });

  it("refuses bad, foreign and expired tokens", async () => {
    const s = await start();
    const bad = s.open();
    await bad.auth("not.a.token");
    expect(bad.closed?.code).toBe(ERROR_CODES.unauthorized);

    const otherRoom = s.open();
    await otherRoom.auth(await s.token({ room: "doc:2" }));
    expect(otherRoom.closed?.code).toBe(ERROR_CODES.unauthorized);

    const otherKey = s.open();
    const { createRoomToken } = await import("@towhee/auth");
    await otherKey.auth(await createRoomToken({ userId: "u", room: "doc:1", access: "write" }, { id: "test", secret: "x".repeat(32) }, { now: s.time.current }));
    expect(otherKey.closed?.code).toBe(ERROR_CODES.unauthorized);

    const token = await s.token({ expiresIn: 60 });
    s.time.advance(10 * 60_000);
    const expired = s.open();
    await expired.auth(token);
    expect(expired.closed?.code).toBe(ERROR_CODES.token_expired);
    expect(expired.errors()).toEqual(["token_expired"]);
  });

  it("accepts a prefix token for a room inside it", async () => {
    const s = await start();
    const c = s.open();
    await c.auth(await s.token({ room: "doc:*" }));
    expect(c.closed).toBeUndefined();
    expect(c.received[0]?.type).toBe("ready");
  });

  it("refuses other protocol versions and a second auth", async () => {
    const s = await start();
    const old = s.open();
    await old.auth(await s.token(), 2);
    expect(old.closed?.code).toBe(ERROR_CODES.unsupported_protocol);
    const twice = await s.join();
    await twice.auth(await s.token());
    expect(twice.closed?.code).toBe(ERROR_CODES.protocol_error);
  });

  it("closes connections that never authenticate", async () => {
    const s = await start();
    const slow = s.open();
    s.time.advance(9_999);
    expect(slow.closed).toBeUndefined();
    s.time.advance(1);
    expect(slow.closed?.code).toBe(ERROR_CODES.auth_timeout);
    expect(s.room.connectionCount).toBe(0);
  });

  it("closes a connection when its token expires", async () => {
    const s = await start();
    const c = await s.join({ expiresIn: 600 });
    s.time.advance(600_000 + 59_999);
    expect(c.closed).toBeUndefined();
    s.time.advance(1);
    expect(c.closed?.code).toBe(ERROR_CODES.token_expired);
  });

  it("closes on garbage frames and server-only messages", async () => {
    const s = await start();
    const a = await s.join();
    await a.sendRaw(new Uint8Array([99, 1, 2]));
    expect(a.closed?.code).toBe(ERROR_CODES.protocol_error);
    const b = await s.join();
    await b.sendRaw(encodeMessage({ type: "event", name: "x" }));
    expect(b.closed?.code).toBe(ERROR_CODES.protocol_error);
    const c = await s.join();
    await c.sendRaw(encodeMessage({ type: "sync", data: new Uint8Array([2, 50, 1, 2]) }));
    expect(c.closed?.code).toBe(ERROR_CODES.protocol_error);
    const d = await s.join();
    await d.sendRaw(new Uint8Array([MESSAGE_TYPES.sync, 7]));
    expect(d.closed?.code).toBe(ERROR_CODES.protocol_error);
  });

  it("never reads past a frame that is a slice of a larger buffer", async () => {
    // WebSocket libraries can hand out frames that share a buffer with other data. A length
    // prefix pointing past the frame must fail, not read the neighbouring bytes as an update.
    const s = await start();
    const c = await s.join();
    const shared = new Uint8Array(200).fill(7);
    shared.set([MESSAGE_TYPES.sync, 2, 100, 1], 10);
    await c.sendRaw(shared.subarray(10, 14));
    expect(c.closed?.code).toBe(ERROR_CODES.protocol_error);
    expect(s.room.doc.share.size).toBe(0);
  });

  it("answers unknown requests without closing", async () => {
    const s = await start();
    const c = await s.join();
    await c.sendRaw(encodeMessage({ type: "request", id: 5, method: "files.list" }));
    expect(c.received.at(-1)).toEqual({ type: "response", id: 5, ok: false, error: { code: "not_found", message: "Unknown method files.list" } });
    expect(c.closed).toBeUndefined();
  });
});

describe("limits", () => {
  it("closes on frames over the size limit", async () => {
    const s = await start({ limits: { maxMessageBytes: 1000 } });
    const c = await s.join();
    editText(c.doc, 0, "x".repeat(2000));
    await s.settle();
    expect(c.closed?.code).toBe(ERROR_CODES.message_too_large);
    expect(s.room.doc.getText("t").toString()).toBe("");
  });

  it("stops the document growing past its limit", async () => {
    const s = await start({ limits: { maxDocumentBytes: 5000 } });
    const c = await s.join();
    editText(c.doc, 0, "x".repeat(3000));
    await s.settle();
    expect(c.closed).toBeUndefined();
    editText(c.doc, 0, "y".repeat(3000));
    await s.settle();
    expect(c.closed?.code).toBe(ERROR_CODES.document_too_large);
    expect(s.room.doc.getText("t").toString()).toBe("x".repeat(3000));
  });

  it("refuses connections when the room is full", async () => {
    const s = await start({ limits: { maxConnections: 2 } });
    await s.join();
    s.open(); // still authenticating, but it counts
    const third = s.open();
    expect(third.closed?.code).toBe(ERROR_CODES.room_full);
    expect(third.errors()).toEqual(["room_full"]);
  });

  it("rate limits chatty connections, per second", async () => {
    const s = await start({ limits: { maxMessagesPerSecond: 5 } });
    const c = await s.join(); // auth + sync step 1 + step 2 = 3 frames this second
    s.time.advance(1000);
    for (let i = 0; i < 5; i++) await c.sendRaw(encodeMessage({ type: "request", id: i, method: "ping" }));
    expect(c.closed).toBeUndefined();
    s.time.advance(1000);
    for (let i = 0; i < 6; i++) await c.sendRaw(encodeMessage({ type: "request", id: i, method: "ping" }));
    expect(c.closed?.code).toBe(ERROR_CODES.rate_limited);
  });

  it("caps presence entries per connection", async () => {
    const s = await start({ limits: { maxPresencePerConnection: 2 } });
    const c = await s.join();
    const entries = [1, 2, 3].map((clientId) => ({ clientId, clock: 1, state: { n: clientId } }));
    await c.sendRaw(encodeMessage({ type: "awareness", data: encodePresence(entries) }));
    expect([...s.room.awareness.getStates().keys()].sort()).toEqual([1, 2]);
  });

  it("rejects bad limit values", async () => {
    await expect(Room.load({ id: "a", storage: new MemoryStorage(), keys: key, limits: { maxConnections: 0 } })).rejects.toThrow(TypeError);
    await expect(Room.load({ id: "a/b", storage: new MemoryStorage(), keys: key })).rejects.toThrow(TypeError);
    await expect(Room.load({ id: "a", storage: new MemoryStorage(), keys: [] })).rejects.toThrow(TypeError);
  });
});

describe("persistence", () => {
  it("a room unloaded and loaded again has the same document", async () => {
    const storage = new MemoryStorage();
    const s = await start({ storage });
    const a = await s.join();
    editText(a.doc, 0, "remember me");
    a.doc.getMap("settings").set("theme", "dark");
    await s.settle();
    await s.teardown();
    current = undefined;
    expect(a.closed?.code).toBe(ERROR_CODES.server_restarting);

    const again = await start({ storage });
    const b = await again.join();
    expect(b.text).toBe("remember me");
    expect(b.doc.getMap("settings").get("theme")).toBe("dark");
  });

  it("compacts the log as it grows and when the room empties", async () => {
    const storage = new MemoryStorage();
    let emptied = 0;
    const s = await start({ storage, limits: { compactAfterUpdates: 3 }, onEmpty: () => emptied++ });
    const a = await s.join();
    for (let i = 0; i < 7; i++) {
      editText(a.doc, i, String(i));
      await s.settle();
    }
    expect(storage.logLength("doc:1")).toBe(1); // 7 updates: compacted after 3 and 6
    a.disconnect();
    await s.settle();
    expect(emptied).toBe(1);
    expect(storage.logLength("doc:1")).toBe(0);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, (await storage.loadDocument("doc:1"))!);
    expect(doc.getText("t").toString()).toBe("0123456");
  });

  it("closes everyone with internal when storage fails, and reports it", async () => {
    const storage: Storage = {
      loadDocument: async () => null,
      appendUpdate: async () => {
        throw new Error("disk full");
      },
      compact: async () => {},
      threads: new MemoryThreadStore(),
    };
    const errors: unknown[] = [];
    const s = await start({ storage, onError: (e) => errors.push(e) });
    const a = await s.join();
    editText(a.doc, 0, "lost");
    await s.settle();
    await s.room.flush();
    expect((errors[0] as Error).message).toBe("disk full");
    expect(a.closed?.code).toBe(ERROR_CODES.internal);
    const late = s.open();
    expect(late.closed?.code).toBe(ERROR_CODES.server_restarting);
  });

  it("closing the room closes every connection", async () => {
    const s = await start();
    const a = await s.join();
    const pending = s.open();
    await s.room.close();
    expect(a.closed?.code).toBe(ERROR_CODES.server_restarting);
    expect(pending.closed?.code).toBe(ERROR_CODES.server_restarting);
    expect(s.room.connectionCount).toBe(0);
  });
});

storageSuite("memory", () => new MemoryStorage(), { describe, it, expect });
