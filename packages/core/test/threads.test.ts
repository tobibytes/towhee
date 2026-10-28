import { type Comment, COMMENT_LIMITS, type Thread, textBody } from "@towhee/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStorage, Room } from "../src";
import { key, type Setup, setup, type TestClient } from "./harness";

let current: Setup | undefined;
async function start(storage = new MemoryStorage()) {
  current = await setup({ storage });
  return current;
}
afterEach(async () => {
  await current?.teardown();
  current = undefined;
});

type Ok = { ok: true; result: { thread: Thread; comment?: Comment } };
async function ok(client: TestClient, method: string, params?: unknown) {
  const res = await client.request(method, params);
  if (!res.ok) throw new Error(`${method} failed: ${res.error.code} ${res.error.message}`);
  return (res as unknown as Ok).result;
}
async function fails(client: TestClient, method: string, params?: unknown) {
  const res = await client.request(method, params);
  if (res.ok) throw new Error(`${method} should have failed`);
  return res.error.code;
}

describe("threads", () => {
  it("are created, shared live and listed", async () => {
    const s = await start();
    const ada = await s.join({ userId: "ada", user: { name: "Ada" } });
    const bob = await s.join({ userId: "bob" });
    const { thread } = await ok(ada, "threads.create", { body: textBody("Is this right?"), anchor: { type: "app", id: "block-7" } });
    expect(thread).toMatchObject({ anchor: { type: "app", id: "block-7" }, resolved: false, createdBy: "ada" });
    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0]).toMatchObject({ author: { id: "ada", name: "Ada" }, body: textBody("Is this right?"), reactions: {} });
    expect(bob.events("thread.created")).toEqual([{ thread }]);
    expect(ada.events("thread.created")).toEqual([{ thread }]); // the author's other tabs need it too
    const listed = (await bob.request("threads.list")) as unknown as { result: { threads: Thread[] } };
    expect(listed.result.threads).toEqual([thread]);
  });

  it("takes the author from the token, not the params", async () => {
    const s = await start();
    const eve = await s.join({ userId: "eve" });
    const { thread } = await ok(eve, "threads.create", { body: textBody("hi"), author: { id: "ada" }, createdBy: "ada" });
    expect(thread.createdBy).toBe("eve");
    expect(thread.comments[0]!.author.id).toBe("eve");
  });

  it("keeps both of two replies sent at the same moment", async () => {
    const s = await start();
    const [a, b, c] = [await s.join({ userId: "a" }), await s.join({ userId: "b" }), await s.join({ userId: "c" })];
    const { thread } = await ok(a, "threads.create", { body: textBody("start") });
    await Promise.all([
      b.request("threads.reply", { threadId: thread.id, body: textBody("from b") }),
      c.request("threads.reply", { threadId: thread.id, body: textBody("from c") }),
    ]);
    const stored = await s.storage.threads.get(s.room.id, thread.id);
    expect(stored!.comments.map((x) => x.author.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("edits and deletes your own comments", async () => {
    const s = await start();
    const ada = await s.join({ userId: "ada", access: "comment" });
    const { thread } = await ok(ada, "threads.create", { body: textBody("first") });
    const commentId = thread.comments[0]!.id;
    s.time.advance(1000);
    const edited = await ok(ada, "threads.edit", { threadId: thread.id, commentId, body: textBody("first, fixed") });
    expect(edited.comment).toMatchObject({ body: textBody("first, fixed"), editedAt: s.time.current });
    const deleted = await ok(ada, "threads.deleteComment", { threadId: thread.id, commentId });
    expect(deleted.comment).toMatchObject({ body: { version: 1, content: [] }, reactions: {}, deletedAt: s.time.current });
    expect(await fails(ada, "threads.edit", { threadId: thread.id, commentId, body: textBody("again") })).toBe("not_found");
  });

  it("adds and removes reactions once per user", async () => {
    const s = await start();
    const ada = await s.join({ userId: "ada" });
    const bob = await s.join({ userId: "bob", access: "comment" });
    const { thread } = await ok(ada, "threads.create", { body: textBody("ship it?") });
    const ref = { threadId: thread.id, commentId: thread.comments[0]!.id };
    await ok(bob, "threads.react", { ...ref, reaction: "👍", add: true });
    await ok(bob, "threads.react", { ...ref, reaction: "👍", add: true });
    const both = await ok(ada, "threads.react", { ...ref, reaction: "👍", add: true });
    expect(both.comment!.reactions).toEqual({ "👍": ["bob", "ada"] });
    const removed = await ok(bob, "threads.react", { ...ref, reaction: "👍", add: false });
    expect(removed.comment!.reactions).toEqual({ "👍": ["ada"] });
    const gone = await ok(ada, "threads.react", { ...ref, reaction: "👍", add: false });
    expect(gone.comment!.reactions).toEqual({});
    expect(await fails(bob, "threads.react", { ...ref, reaction: "two words", add: true })).toBe("protocol_error");
  });

  it("resolves, reopens, tags and deletes threads", async () => {
    const s = await start();
    const ada = await s.join({ userId: "ada", access: "comment" });
    const bob = await s.join({ userId: "bob" });
    const { thread } = await ok(ada, "threads.create", { body: textBody("typo") });
    const resolved = await ok(ada, "threads.resolve", { threadId: thread.id, resolved: true });
    expect(resolved.thread).toMatchObject({ resolved: true, resolvedBy: "ada", resolvedAt: s.time.current });
    const reopened = await ok(bob, "threads.resolve", { threadId: thread.id, resolved: false });
    expect(reopened.thread.resolved).toBe(false);
    expect(reopened.thread).not.toHaveProperty("resolvedBy");
    const tagged = await ok(ada, "threads.setMetadata", { threadId: thread.id, metadata: { status: "open", priority: 2 } });
    expect(tagged.thread.metadata).toEqual({ status: "open", priority: 2 });
    await ok(ada, "threads.delete", { threadId: thread.id });
    expect(bob.events("thread.deleted")).toEqual([{ threadId: thread.id }]);
    expect(await s.storage.threads.get(s.room.id, thread.id)).toBeNull();
  });

  it("survive the room being unloaded", async () => {
    const storage = new MemoryStorage();
    const s = await start(storage);
    const ada = await s.join();
    const { thread } = await ok(ada, "threads.create", { body: textBody("remember") });
    await s.teardown();
    current = undefined;
    const again = await start(storage);
    const bob = await again.join();
    const listed = (await bob.request("threads.list")) as unknown as { result: { threads: Thread[] } };
    expect(listed.result.threads.map((t) => t.id)).toEqual([thread.id]);
  });
});

describe("thread access", () => {
  it("readers can list but not comment", async () => {
    const s = await start();
    const reader = await s.join({ access: "read" });
    expect((await reader.request("threads.list")).ok).toBe(true);
    expect(await fails(reader, "threads.create", { body: textBody("hi") })).toBe("forbidden");
    expect(reader.closed).toBeUndefined();
  });

  it("commenters change only their own things; writers change anyone's", async () => {
    const s = await start();
    const ada = await s.join({ userId: "ada", access: "comment" });
    const cara = await s.join({ userId: "cara", access: "comment" });
    const wes = await s.join({ userId: "wes", access: "write" });
    const { thread } = await ok(ada, "threads.create", { body: textBody("mine") });
    const ref = { threadId: thread.id, commentId: thread.comments[0]!.id };

    expect(await fails(cara, "threads.edit", { ...ref, body: textBody("hijack") })).toBe("forbidden");
    expect(await fails(cara, "threads.deleteComment", ref)).toBe("forbidden");
    expect(await fails(cara, "threads.resolve", { threadId: thread.id, resolved: true })).toBe("forbidden");
    expect(await fails(cara, "threads.setMetadata", { threadId: thread.id, metadata: { x: 1 } })).toBe("forbidden");
    expect(await fails(cara, "threads.delete", { threadId: thread.id })).toBe("forbidden");
    await ok(cara, "threads.reply", { threadId: thread.id, body: textBody("a reply is fine") });
    await ok(cara, "threads.react", { ...ref, reaction: "🎉", add: true });

    await ok(wes, "threads.edit", { ...ref, body: textBody("moderated") });
    await ok(wes, "threads.resolve", { threadId: thread.id, resolved: true });
    await ok(wes, "threads.delete", { threadId: thread.id });
  });
});

describe("thread validation", () => {
  it("refuses malformed input without closing the connection", async () => {
    const s = await start();
    const c = await s.join();
    const { thread } = await ok(c, "threads.create", { body: textBody("x") });
    const bad: [string, unknown][] = [
      ["threads.create", { body: "plain string" }],
      ["threads.create", { body: { version: 1, content: [{ type: "paragraph", children: [{ type: "html", html: "<img onerror=x>" }] }] } }],
      ["threads.create", { body: { version: 1, content: [{ type: "paragraph", children: [{ type: "link", url: "javascript:alert(1)", children: [{ type: "text", text: "x" }] }] }] } }],
      ["threads.create", { body: textBody("x".repeat(COMMENT_LIMITS.bodyBytes)) }],
      ["threads.create", { body: textBody("   ") }],
      ["threads.create", { body: textBody("x"), anchor: { type: "text", start: "not base64!", end: "AA==" } }],
      ["threads.create", { body: textBody("x"), metadata: { nested: { no: true } } }],
      ["threads.create", "not an object"],
      ["threads.reply", { threadId: "../../etc", body: textBody("x") }],
      ["threads.resolve", { threadId: thread.id, resolved: "yes" }],
    ];
    for (const [method, params] of bad) expect(await fails(c, method, params), `${method} ${JSON.stringify(params).slice(0, 60)}`).toBe("protocol_error");
    expect(await fails(c, "threads.reply", { threadId: "th_missing", body: textBody("x") })).toBe("not_found");
    expect(await fails(c, "threads.archive", {})).toBe("not_found");
    expect(c.closed).toBeUndefined();
  });

  it("caps comments per thread", async () => {
    const s = await start();
    const c = await s.join();
    const { thread } = await ok(c, "threads.create", { body: textBody("x") });
    const full: Thread = {
      ...thread,
      comments: Array.from({ length: COMMENT_LIMITS.commentsPerThread }, (_, i) => ({ ...thread.comments[0]!, id: `cm_${i}` })),
    };
    await s.storage.threads.put(s.room.id, full);
    expect(await fails(c, "threads.reply", { threadId: thread.id, body: textBody("one more") })).toBe("forbidden");
  });

  it("works with the same room id on a fresh Room", async () => {
    // Guards against the thread service holding state outside storage.
    const storage = new MemoryStorage();
    const s = await start(storage);
    const c = await s.join();
    const { thread } = await ok(c, "threads.create", { body: textBody("x") });
    const other = await Room.load({ id: s.room.id, storage, keys: key, timers: "manual" });
    expect(await storage.threads.get(other.id, thread.id)).not.toBeNull();
    await other.close();
  });
});
