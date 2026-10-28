import { createInboxToken, createRoomToken, type RoomKey } from "@towhee/auth";
import { decodeServerMessage, ERROR_CODES, encodeMessage, errorCodeFromClose, type Notification, type ServerMessage, textBody } from "@towhee/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Connection, Inbox, MemoryInboxStore, MemoryStorage, Room } from "../src";
import { key, ManualTime, type Setup, setup } from "./harness";

let current: Setup | undefined;
afterEach(async () => {
  await current?.teardown();
  current = undefined;
});

/** Rooms report notifications through onNotify; collect them per user. */
async function roomWithInbox() {
  const deliveries: { scope: string; userId: string; notification: Notification }[] = [];
  const s = await setup({ onNotify: (scope, list) => deliveries.push(...list.map((d) => ({ scope, ...d }))) });
  current = s;
  return { s, deliveries };
}

async function ok(c: Awaited<ReturnType<Setup["join"]>>, method: string, params: unknown) {
  const res = await c.request(method, params);
  if (!res.ok) throw new Error(`${method}: ${res.error.message}`);
  return res.result as { thread: { id: string; comments: { id: string }[] }; comment?: { id: string } };
}

const mention = (userId: string, text: string) => ({
  version: 1,
  content: [{ type: "paragraph", children: [{ type: "mention", userId }, { type: "text", text }] }],
});

describe("notifications from threads", () => {
  it("notify mentioned users and thread participants, once each, never the author", async () => {
    const { s, deliveries } = await roomWithInbox();
    const ada = await s.join({ userId: "ada", user: { name: "Ada" } });
    const bob = await s.join({ userId: "bob" });
    const cy = await s.join({ userId: "cy" });

    const { thread } = await ok(ada, "threads.create", { body: mention("bob", " can you check this?") });
    expect(deliveries.map((d) => [d.userId, d.notification.kind])).toEqual([["bob", "mention"]]);
    expect(deliveries[0]).toMatchObject({
      scope: "*",
      notification: { room: s.room.id, threadId: thread.id, actor: { id: "ada", name: "Ada" }, excerpt: "@bob can you check this?" },
    });

    deliveries.length = 0;
    await ok(bob, "threads.reply", { threadId: thread.id, body: textBody("Looks fine") });
    expect(deliveries.map((d) => [d.userId, d.notification.kind])).toEqual([["ada", "reply"]]);

    deliveries.length = 0;
    // cy replies mentioning ada: ada gets one notification (mention wins), bob gets a reply one.
    await ok(cy, "threads.reply", { threadId: thread.id, body: mention("ada", " agreed?") });
    expect(deliveries.map((d) => [d.userId, d.notification.kind]).sort()).toEqual([
      ["ada", "mention"],
      ["bob", "reply"],
    ]);

    deliveries.length = 0;
    await ok(cy, "threads.create", { body: mention("cy", " note to self") });
    expect(deliveries).toEqual([]);
  });

  it("notify only people newly mentioned by an edit", async () => {
    const { s, deliveries } = await roomWithInbox();
    const ada = await s.join({ userId: "ada" });
    const { thread } = await ok(ada, "threads.create", { body: mention("bob", " hi") });
    deliveries.length = 0;
    const both = { version: 1, content: [{ type: "paragraph", children: [{ type: "mention", userId: "bob" }, { type: "mention", userId: "cy" }] }] };
    await ok(ada, "threads.edit", { threadId: thread.id, commentId: thread.comments[0]!.id, body: both });
    expect(deliveries.map((d) => d.userId)).toEqual(["cy"]);
  });

  it("carry the scope of the key that signed the actor's token", async () => {
    const talvra: RoomKey = { id: "talvra", secret: "t".repeat(32), rooms: "talvra:*" };
    const deliveries: string[] = [];
    const room = await Room.load({ id: "talvra:doc:1", storage: new MemoryStorage(), keys: [key, talvra], timers: "manual", onNotify: (scope) => deliveries.push(scope) });
    const frames: ServerMessage[] = [];
    const conn: Connection = { send: (f) => frames.push(decodeServerMessage(f)), close: () => {} };
    room.connect(conn);
    await room.receive(conn, encodeMessage({ type: "auth", protocol: 1, token: await createRoomToken({ userId: "ada", room: "talvra:doc:1", access: "write" }, talvra) }));
    await room.receive(conn, encodeMessage({ type: "request", id: 1, method: "threads.create", params: { body: mention("bob", " x") } }));
    expect(deliveries).toEqual(["talvra:*"]);
    await room.close();
  });

  it("refuse to open a reserved inbox room as a document", async () => {
    await expect(Room.load({ id: "towhee.inbox", storage: new MemoryStorage(), keys: key })).rejects.toThrow(TypeError);
    await expect(Room.load({ id: "talvra:towhee.inbox", storage: new MemoryStorage(), keys: key })).rejects.toThrow(TypeError);
  });
});

/** A raw inbox client: just frames in and out. */
function inboxClient(inbox: Inbox) {
  const frames: ServerMessage[] = [];
  let closed: string | undefined;
  let nextId = 1;
  const conn: Connection = { send: (f) => frames.push(decodeServerMessage(f)), close: (code) => (closed = errorCodeFromClose(code)) };
  inbox.connect(conn);
  return {
    conn,
    frames,
    closed: () => closed,
    auth: (token: string) => inbox.receive(conn, encodeMessage({ type: "auth", protocol: 1, token })),
    async request(method: string, params?: unknown) {
      const id = nextId++;
      await inbox.receive(conn, encodeMessage({ type: "request", id, method, ...(params === undefined ? {} : { params }) }));
      const res = frames.find((m) => m.type === "response" && m.id === id);
      if (res?.type !== "response") throw new Error("no response");
      return res;
    },
    events: (name: string) => frames.flatMap((m) => (m.type === "event" && m.name === name ? [m.data] : [])),
  };
}

const note = (id: string, createdAt: number): Notification => ({
  id,
  kind: "mention",
  room: "doc:1",
  threadId: "th_1",
  commentId: "cm_1",
  actor: { id: "bob" },
  excerpt: "hi",
  createdAt,
});

describe("inbox", () => {
  it("delivers live to the user's open inboxes and lists with an unread count", async () => {
    const time = new ManualTime();
    const store = new MemoryInboxStore();
    const delivered: string[] = [];
    const inbox = Inbox.create({ userId: "ada", store, keys: key, now: time.now, timers: time, onDelivered: (_s, n) => delivered.push(n.id) });
    const tab1 = inboxClient(inbox);
    const tab2 = inboxClient(inbox);
    await tab1.auth(await createInboxToken({ userId: "ada" }, key, { now: time.current }));
    await tab2.auth(await createInboxToken({ userId: "ada" }, key, { now: time.current }));
    expect(tab1.frames[0]).toMatchObject({ type: "ready", user: { id: "ada" }, access: "read" });

    await inbox.deliver("*", note("n1", 1));
    await inbox.deliver("*", note("n2", 2));
    expect(tab2.events("notification.created")).toEqual([{ notification: note("n1", 1) }, { notification: note("n2", 2) }]);
    expect(delivered).toEqual(["n1", "n2"]);
    const list = await tab1.request("inbox.list");
    expect(list.ok && list.result).toEqual({ notifications: [note("n2", 2), note("n1", 1)], unread: 2 });

    time.advance(1000);
    const marked = await tab1.request("inbox.markRead", { ids: ["n1"] });
    expect(marked.ok && marked.result).toEqual({ ids: ["n1"], readAt: time.current });
    expect(tab2.events("notification.read")).toEqual([{ ids: ["n1"], readAt: time.current }]); // the other tab follows
    const all = await tab2.request("inbox.markRead", { all: true });
    expect(all.ok && (all.result as { ids: string[] }).ids).toEqual(["n2"]);
    const after = await tab1.request("inbox.list", { limit: 1 });
    expect(after.ok && after.result).toMatchObject({ unread: 0, notifications: [{ id: "n2", readAt: time.current }] });
    inbox.close();
  });

  it("only opens with the right user's inbox token", async () => {
    const time = new ManualTime();
    const inbox = Inbox.create({ userId: "ada", store: new MemoryInboxStore(), keys: key, now: time.now, timers: time });
    const roomToken = inboxClient(inbox);
    await roomToken.auth(await createRoomToken({ userId: "ada", room: "doc:1", access: "write" }, key, { now: time.current }));
    expect(roomToken.closed()).toBe("unauthorized");
    const otherUser = inboxClient(inbox);
    await otherUser.auth(await createInboxToken({ userId: "eve" }, key, { now: time.current }));
    expect(otherUser.closed()).toBe("unauthorized");
    const silent = inboxClient(inbox);
    time.advance(10_000);
    expect(silent.closed()).toBe("auth_timeout");
    inbox.close();
  });

  it("keeps apps apart: each connection sees its own key's scope", async () => {
    const time = new ManualTime();
    const talvra: RoomKey = { id: "talvra", secret: "t".repeat(32), rooms: "talvra:*" };
    const inbox = Inbox.create({ userId: "ada", store: new MemoryInboxStore(), keys: [key, talvra], now: time.now, timers: time });
    const everywhere = inboxClient(inbox);
    const talvraAda = inboxClient(inbox);
    await everywhere.auth(await createInboxToken({ userId: "ada" }, key, { now: time.current }));
    await talvraAda.auth(await createInboxToken({ userId: "ada" }, talvra, { now: time.current }));
    await inbox.deliver("talvra:*", note("t1", 1));
    expect(talvraAda.events("notification.created")).toHaveLength(1);
    expect(everywhere.events("notification.created")).toHaveLength(0);
    const list = await everywhere.request("inbox.list");
    expect(list.ok && (list.result as { notifications: unknown[] }).notifications).toEqual([]);
    inbox.close();
  });

  it("refuses documents, presence and bad requests", async () => {
    const time = new ManualTime();
    const inbox = Inbox.create({ userId: "ada", store: new MemoryInboxStore(), keys: key, now: time.now, timers: time });
    const c = inboxClient(inbox);
    await c.auth(await createInboxToken({ userId: "ada" }, key, { now: time.current }));
    for (const [method, params] of [
      ["inbox.list", { limit: 0 }],
      ["inbox.list", { limit: 500 }],
      ["inbox.markRead", {}],
      ["inbox.markRead", { ids: "n1" }],
    ] as const) {
      const res = await c.request(method, params);
      expect(res.ok ? null : res.error.code).toBe("protocol_error");
    }
    const unknown = await c.request("inbox.delete", {});
    expect(unknown.ok ? null : unknown.error.code).toBe("not_found");
    expect(c.closed()).toBeUndefined();
    await inbox.receive(c.conn, encodeMessage({ type: "sync", data: new Uint8Array([0, 0]) }));
    expect(c.closed()).toBe("protocol_error");
    expect(ERROR_CODES.protocol_error).toBe(4000);
    expect(() => Inbox.create({ userId: "", store: new MemoryInboxStore(), keys: key })).toThrow(TypeError);
    inbox.close();
  });

  it("keeps only the newest notifications", async () => {
    const store = new MemoryInboxStore();
    const inbox = Inbox.create({ userId: "ada", store, keys: key, timers: "manual" });
    for (let i = 0; i < 505; i++) await inbox.deliver("*", note(`n${i}`, i));
    const kept = await store.list("*", "ada", 1000);
    expect(kept).toHaveLength(500);
    expect(kept.at(-1)!.id).toBe("n5");
  });
});
