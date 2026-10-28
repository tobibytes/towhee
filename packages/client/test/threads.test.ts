import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createClient, createTextAnchor, RequestError, type RoomConnection, resolveTextAnchor, type Thread } from "../src";
import { settle, TestServer } from "./server";

let server: TestServer;
const rooms: RoomConnection[] = [];
afterEach(async () => {
  for (const r of rooms.splice(0)) r.leave();
  await settle();
  await server?.close();
});

function join(tag: string, access: "read" | "comment" | "write" = "write"): RoomConnection {
  const room = createClient({
    url: "ws://test",
    authEndpoint: () => server.token({ userId: tag, access }),
    WebSocket: server.socketClass(tag),
    timers: server.time,
    random: () => 1,
  }).enter("doc:1");
  rooms.push(room);
  return room;
}

describe("threads", () => {
  it("are shared live and kept in a list", async () => {
    server = new TestServer();
    const ada = join("ada");
    const bob = join("bob");
    const seen: number[] = [];
    bob.threads.subscribe((list) => seen.push(list.length));
    await settle();
    expect(bob.threads.ready).toBe(true);
    const thread = await ada.threads.create({ body: "Can we ship Friday?", anchor: { type: "app", id: "release" } });
    await settle();
    expect(bob.threads.list().map((t) => t.id)).toEqual([thread.id]);
    const reply = await bob.threads.reply(thread.id, "Yes, if CI is green");
    await settle();
    expect(ada.threads.get(thread.id)!.comments.map((c) => c.id)).toEqual([thread.comments[0]!.id, reply.id]);
    await bob.threads.react(thread.id, reply.id, "🚀");
    await ada.threads.resolve(thread.id);
    await settle();
    expect(bob.threads.get(thread.id)).toMatchObject({ resolved: true, resolvedBy: "ada" });
    expect(bob.threads.get(thread.id)!.comments[1]!.reactions).toEqual({ "🚀": ["bob"] });
    await ada.threads.delete(thread.id);
    await settle();
    expect(bob.threads.list()).toEqual([]);
    expect(seen.at(-1)).toBe(0);
  });

  it("catches up on threads changed while disconnected", async () => {
    server = new TestServer();
    const ada = join("ada");
    const bob = join("bob");
    await settle();
    void bob.threads; // start tracking
    await settle();
    server.drop("bob");
    await settle();
    const thread = await ada.threads.create({ body: "while you were away" });
    await settle();
    expect(bob.threads.list()).toEqual([]);
    await server.time.advance(500); // bob reconnects and refetches
    expect(bob.threads.list().map((t: Thread) => t.id)).toEqual([thread.id]);
  });

  it("rejects with the server's reason", async () => {
    server = new TestServer();
    const reader = join("rex", "read");
    await settle();
    const err = await reader.threads.create({ body: "hi" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).code).toBe("forbidden");
    expect(reader.status).toBe("connected");
  });
});

describe("text anchors", () => {
  it("follow their text through edits, and resolve to null once it's deleted", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "The quick brown fox");
    const anchor = createTextAnchor(text, 4, 5); // "quick"
    expect(resolveTextAnchor(doc, anchor)).toMatchObject({ type: text, index: 4, length: 5 });

    text.insert(0, "Look: ");
    text.insert(text.toString().indexOf("brown"), "very ");
    const moved = resolveTextAnchor(doc, anchor)!;
    expect(text.toString().slice(moved.index, moved.index + moved.length)).toBe("quick");

    // Typing at the edges stays outside the anchor; typing inside grows it.
    text.insert(moved.index, "[");
    text.insert(moved.index + 1 + moved.length, "]");
    const edged = resolveTextAnchor(doc, anchor)!;
    expect(text.toString().slice(edged.index, edged.index + edged.length)).toBe("quick");
    text.insert(edged.index + 2, "ii");
    const grown = resolveTextAnchor(doc, anchor)!;
    expect(text.toString().slice(grown.index, grown.index + grown.length)).toBe("quiiick");

    text.delete(grown.index, grown.length);
    expect(resolveTextAnchor(doc, anchor)).toBeNull();
  });

  it("travel to another client's copy of the document", () => {
    const a = new Y.Doc();
    a.getText("t").insert(0, "hello world");
    const anchor = createTextAnchor(a.getText("t"), 6, 5);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    b.getText("t").insert(0, ">> ");
    const r = resolveTextAnchor(b, anchor)!;
    expect(b.getText("t").toString().slice(r.index, r.index + r.length)).toBe("world");
    expect(resolveTextAnchor(b, { type: "app", id: "x" })).toBeNull();
    expect(resolveTextAnchor(b, { type: "text", start: "AAAA", end: "AAAA" })).toBeNull();
    expect(() => createTextAnchor(a.getText("t"), 0, 0)).toThrow(RangeError);
  });
});
