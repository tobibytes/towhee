import type { Storage } from "@towhee/core";
import { storageSuite } from "@towhee/core/testing";
import { ERROR_CODES } from "@towhee/protocol";
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DurableObjectSqlStorage, STATE_CHUNK_BYTES, type TowheeRoom } from "../src";
import { enter, text, until } from "./helpers";

const left: { leave(): void }[] = [];
afterEach(() => {
  for (const c of left.splice(0)) c.leave();
});
function join(...args: Parameters<typeof enter>) {
  const c = enter(...args);
  left.push(c);
  return c;
}

/** Runs storage calls inside a fresh Durable Object, so the suite tests the real SQLite storage. */
function durableStorage(): Storage {
  const stub = env.TOWHEE_ROOMS.getByName(`storage-${crypto.randomUUID()}`);
  const call = <T>(fn: (s: DurableObjectSqlStorage) => Promise<T>) =>
    runInDurableObject(stub, (_instance: TowheeRoom, state) => fn(new DurableObjectSqlStorage(state.storage)));
  return {
    loadDocument: (room) => call((s) => s.loadDocument(room)),
    appendUpdate: (room, update) => call((s) => s.appendUpdate(room, update)),
    compact: (room, state) => call((s) => s.compact(room, state)),
    threads: {
      list: (room) => call((s) => s.threads.list(room)),
      get: (room, id) => call((s) => s.threads.get(room, id)),
      put: (room, thread) => call((s) => s.threads.put(room, thread)),
      delete: (room, id) => call((s) => s.threads.delete(room, id)),
      count: (room) => call((s) => s.threads.count(room)),
    },
  };
}

storageSuite("Durable Object SQLite", durableStorage, { describe, it, expect });

describe("Durable Object SQLite", () => {
  it("splits big documents into chunks under the 2 MB row limit", async () => {
    const storage = durableStorage();
    const doc = new Y.Doc();
    // Pseudo-random text barely compresses, so the state really is several chunks.
    let seed = 42;
    const random = Array.from({ length: 2_500_000 }, () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return String.fromCharCode(97 + (seed % 26));
    }).join("");
    doc.getText("t").insert(0, random);
    const state = Y.encodeStateAsUpdate(doc);
    expect(state.length).toBeGreaterThan(2 * STATE_CHUNK_BYTES);
    await storage.compact("big", state);
    const loaded = new Y.Doc();
    Y.applyUpdate(loaded, (await storage.loadDocument("big"))!);
    expect(loaded.getText("t").toString()).toBe(random);
  });
});

describe("Worker", () => {
  it("answers health checks and refuses bad requests", async () => {
    const health = await exports.default.fetch("http://towhee.test/health");
    expect(await health.json()).toEqual({ ok: true });
    expect((await exports.default.fetch("http://towhee.test/elsewhere")).status).toBe(404);
    expect((await exports.default.fetch("http://towhee.test/v1/rooms/doc:1")).status).toBe(426);
    const upgrade = { headers: { Upgrade: "websocket" } };
    expect((await exports.default.fetch("http://towhee.test/v1/rooms/a%2Fb", upgrade)).status).toBe(400);
    expect((await exports.default.fetch("http://towhee.test/v1/rooms/%E0%A4%A", upgrade)).status).toBe(400);
  });
});

describe("rooms on Durable Objects", () => {
  it("two clients converge, with presence", async () => {
    const a = join({ userId: "ada", user: { name: "Ada" } }, "cf:converge");
    const b = join({ userId: "bob" }, "cf:converge");
    await until(() => a.synced && b.synced, "sync");
    a.doc.getText("t").insert(0, "hello ");
    b.doc.getText("t").insert(0, "world ");
    await until(() => text(a).length === 12 && text(a) === text(b), "convergence");
    a.setPresence({ cursor: 2 });
    await until(() => b.others().length === 1, "presence");
    expect(b.others()[0]).toMatchObject({ user: { id: "ada", name: "Ada" }, presence: { cursor: 2 } });
  });

  it("a hibernated room wakes with its document and presence intact", async () => {
    const a = join({ userId: "ada" }, "cf:sleepy");
    const b = join({ userId: "bob" }, "cf:sleepy");
    await until(() => a.synced && b.synced, "sync");
    a.doc.getText("t").insert(0, "before sleep");
    a.setPresence({ cursor: 7 });
    b.setPresence({ cursor: 1 });
    await until(() => text(b) === "before sleep" && b.others().length === 1 && a.others().length === 1, "initial state");

    // Evict the object; the sockets hibernate instead of closing.
    await evictDurableObject(env.TOWHEE_ROOMS.getByName("cf:sleepy"));
    expect(a.status).toBe("connected");

    // The next message wakes it. No reconnect, no new auth.
    b.doc.getText("t").insert(0, "after waking, ");
    await until(() => text(a) === "after waking, before sleep", "edit after waking");
    expect(a.status).toBe("connected");
    expect(b.status).toBe("connected");

    // Presence came back on the server: the woken room asked everyone to resend it. Nobody changed
    // their cursor, so a newcomer only sees these if the resend worked.
    const c = join({ userId: "cy" }, "cf:sleepy");
    await until(() => c.synced && c.others().length === 2, "newcomer sees both cursors");
    const cursors = Object.fromEntries(c.others().map((o) => [o.user.id, o.presence.cursor]));
    expect(cursors).toEqual({ ada: 7, bob: 1 });
    expect(text(c)).toBe("after waking, before sleep");
  });

  it("keeps the document after every socket closes and the object is evicted", async () => {
    const a = join({}, "cf:durable");
    await until(() => a.synced, "sync");
    a.doc.getText("t").insert(0, "kept in sqlite");
    await new Promise((r) => setTimeout(r, 50));
    a.leave();
    await new Promise((r) => setTimeout(r, 50));
    await evictDurableObject(env.TOWHEE_ROOMS.getByName("cf:durable"), { webSockets: "close" });
    const b = join({}, "cf:durable");
    await until(() => b.synced, "sync after eviction");
    expect(text(b)).toBe("kept in sqlite");
  });

  it("shares threads live and keeps them through an eviction", async () => {
    const a = join({ userId: "ada" }, "cf:threads");
    const b = join({ userId: "bob", access: "comment" }, "cf:threads");
    await until(() => a.synced && b.synced && b.threads.ready, "sync");
    const thread = await a.threads.create({ body: "Looks good?", anchor: { type: "app", id: "p1" } });
    await until(() => b.threads.list().length === 1, "thread to arrive");
    await b.threads.reply(thread.id, "Yes");
    await until(() => a.threads.get(thread.id)?.comments.length === 2, "reply to arrive");
    await evictDurableObject(env.TOWHEE_ROOMS.getByName("cf:threads"));
    const c = join({ userId: "cy" }, "cf:threads");
    await until(() => c.threads.ready, "threads after eviction");
    expect(c.threads.list().map((t) => t.comments.length)).toEqual([2]);
  });

  it("closes connections that never authenticate, from the alarm", async () => {
    const res = await exports.default.fetch("http://towhee.test/v1/rooms/cf:silent", { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;
    ws.accept();
    const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
    // The room set an alarm for the auth deadline (TOWHEE_AUTH_TIMEOUT_MS is 300 in the test config)...
    const alarm = await runInDurableObject(env.TOWHEE_ROOMS.getByName("cf:silent"), (_room: TowheeRoom, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    // ...and when it fires, the silent socket is closed. No timers were left running in between.
    expect(await closed).toBe(ERROR_CODES.auth_timeout);
    expect(await runDurableObjectAlarm(env.TOWHEE_ROOMS.getByName("cf:silent"))).toBe(false); // nothing left to do
  });

  it("refuses bad tokens", async () => {
    const { createClient } = await import("@towhee/client");
    const { WorkerSocket } = await import("./helpers");
    const c = createClient({ url: "ws://towhee.test", authEndpoint: async () => "bad.token.value", WebSocket: WorkerSocket }).enter("cf:locked");
    left.push(c);
    await until(() => c.status === "disconnected", "refusal");
    expect(c.lastError?.code).toBe("unauthorized");
  });
});
