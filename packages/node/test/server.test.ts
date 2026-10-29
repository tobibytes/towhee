import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInboxToken, createRoomToken, type RoomKey, type RoomTokenInput, verifyWebhook } from "@towhee/auth";
import { createClient, type RoomConnection } from "@towhee/client";
import { storageSuite } from "@towhee/core/testing";
import { ERROR_CODES, INBOX_ROOM } from "@towhee/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { configFromEnv, createServer, SqliteStorage } from "../src";

const key: RoomKey = { id: "main", secret: "n".repeat(32) };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "towhee-node-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function start(dataPath: string, port = 0, extra: Partial<Parameters<typeof createServer>[0]> = {}) {
  const server = createServer({ keys: key, dataPath, ...extra });
  const { url, port: actual } = await server.listen(port, "127.0.0.1");
  let closed = false;
  cleanups.push(async () => {
    if (!closed) await server.close();
  });
  return {
    server,
    url,
    port: actual,
    stop: async () => {
      closed = true;
      await server.close();
    },
  };
}

function enter(url: string, input: Partial<RoomTokenInput> = {}, room = "doc:1"): RoomConnection {
  const client = createClient({
    url,
    authEndpoint: (r) => createRoomToken({ userId: "u", room: r, access: "write", ...input }, key),
    reconnect: { initialDelayMs: 20, maxDelayMs: 100 },
  });
  const connection = client.enter(room);
  cleanups.push(() => connection.leave());
  return connection;
}

async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const text = (c: RoomConnection) => c.doc.getText("t").toString();

storageSuite("SQLite", () => new SqliteStorage(":memory:"), { describe, it, expect });

describe("SQLite file", () => {
  it("keeps documents across reopening", async () => {
    const path = join(tempDir(), "nested", "towhee.sqlite");
    const first = new SqliteStorage(path);
    const doc = new Y.Doc();
    doc.on("update", (u: Uint8Array) => void first.appendUpdate("r", u));
    doc.getText("t").insert(0, "durable");
    first.close();
    const second = new SqliteStorage(path);
    const loaded = new Y.Doc();
    Y.applyUpdate(loaded, (await second.loadDocument("r"))!);
    expect(loaded.getText("t").toString()).toBe("durable");
    second.close();
  });
});

describe("server", () => {
  it("two clients converge over real sockets", async () => {
    const { url } = await start(join(tempDir(), "db.sqlite"));
    const a = enter(url, { userId: "ada" });
    const b = enter(url, { userId: "bob" });
    await until(() => a.synced && b.synced, "both to sync");
    a.doc.getText("t").insert(0, "hello ");
    b.doc.getText("t").insert(0, "world ");
    await until(() => text(a).length === 12 && text(a) === text(b), "convergence");
    a.setPresence({ cursor: 1 });
    await until(() => b.others().length === 1, "presence");
    expect(b.others()[0]!.user.id).toBe("ada");
  });

  it("keeps the document through a restart, and clients reconnect on their own", async () => {
    const dir = tempDir();
    const first = await start(join(dir, "db.sqlite"));
    const a = enter(first.url);
    await until(() => a.synced, "sync");
    a.doc.getText("t").insert(0, "survives restarts");
    await new Promise((r) => setTimeout(r, 50)); // let the update reach the server

    const codes: string[] = [];
    a.on("error", (e) => codes.push(e.code));
    await first.stop();
    await until(() => a.status === "reconnecting", "client to notice");
    expect(codes).toContain("server_restarting");

    const second = await start(join(dir, "db.sqlite"), first.port);
    await until(() => a.status === "connected" && a.synced, "automatic reconnect");
    const fresh = enter(second.url);
    await until(() => fresh.synced, "fresh client sync");
    expect(text(fresh)).toBe("survives restarts");
  });

  it("shares threads live and keeps them through a restart", async () => {
    const dir = tempDir();
    const first = await start(join(dir, "db.sqlite"));
    const a = enter(first.url, { userId: "ada" });
    const b = enter(first.url, { userId: "bob", access: "comment" });
    await until(() => a.synced && b.synced && b.threads.ready, "sync");
    const thread = await a.threads.create({ body: "Looks good?", anchor: { type: "app", id: "p1" } });
    await until(() => b.threads.list().length === 1, "thread to arrive");
    await b.threads.reply(thread.id, "Yes");
    await until(() => a.threads.get(thread.id)?.comments.length === 2, "reply to arrive");
    await first.stop();
    const second = await start(join(dir, "db.sqlite"), first.port);
    const c = enter(second.url, { userId: "cy" });
    await until(() => c.threads.ready, "threads after restart");
    expect(c.threads.list().map((t) => t.comments.length)).toEqual([2]);
  });

  it("restores versions for everyone and keeps them through a restart", async () => {
    const dir = tempDir();
    const first = await start(join(dir, "db.sqlite"));
    const a = enter(first.url, { userId: "ada" });
    const b = enter(first.url, { userId: "bob" });
    await until(() => a.synced && b.synced, "sync");
    a.doc.getText("t").insert(0, "version one");
    await until(() => text(b) === "version one", "edit");
    const v1 = await a.history.save("one");
    a.doc.getText("t").delete(0, 11);
    a.doc.getText("t").insert(0, "version two");
    await until(() => text(b) === "version two", "second edit");
    await b.history.restore(v1.id);
    await until(() => text(a) === "version one", "restore to reach the other client");
    await first.stop();
    const second = await start(join(dir, "db.sqlite"), first.port);
    const c = enter(second.url, { userId: "cy" });
    await until(() => c.synced, "sync after restart");
    expect(text(c)).toBe("version one");
    expect((await c.history.refresh()).map((v) => v.kind)).toEqual(expect.arrayContaining(["restore", "manual"]));
  });

  it("delivers notifications to inboxes live, signs webhooks, and keeps them through a restart", async () => {
    // The app's webhook endpoint.
    const hooks: { body: string; timestamp: string; signature: string }[] = [];
    const hookServer = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        hooks.push({ body, timestamp: String(req.headers["x-towhee-timestamp"]), signature: String(req.headers["x-towhee-signature"]) });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => hookServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => hookServer.close(() => resolve())));
    const hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/towhee`;
    const webhook = { url: hookUrl, secret: "h".repeat(32) };

    const dir = tempDir();
    const first = await start(join(dir, "db.sqlite"), 0, { webhook });
    const signIn = (url: string, userId: string) =>
      createClient({
        url,
        authEndpoint: (room) =>
          room === INBOX_ROOM ? createInboxToken({ userId }, key) : createRoomToken({ userId, room, access: "write" }, key),
        reconnect: { initialDelayMs: 20, maxDelayMs: 100 },
      });
    const ada = signIn(first.url, "ada").enter("doc:1");
    const inbox = signIn(first.url, "bob").inbox;
    cleanups.push(() => ada.leave(), () => inbox.close());
    await until(() => ada.synced && inbox.ready, "sync and inbox");
    const mention = { version: 1 as const, content: [{ type: "paragraph" as const, children: [{ type: "mention" as const, userId: "bob" }, { type: "text" as const, text: " look" }] }] };
    const thread = await ada.threads.create({ body: mention });
    await until(() => inbox.unread === 1, "live notification");
    expect(inbox.list()[0]).toMatchObject({ kind: "mention", threadId: thread.id, actor: { id: "ada" } });

    await until(() => hooks.length === 1, "webhook");
    expect(await verifyWebhook(webhook.secret, hooks[0]!)).toBe(true);
    expect(JSON.parse(hooks[0]!.body)).toMatchObject({ type: "notification", userId: "bob", scope: "*", notification: { threadId: thread.id } });

    await first.stop();
    const second = await start(join(dir, "db.sqlite"), first.port, { webhook });
    const again = signIn(second.url, "bob").inbox;
    cleanups.push(() => again.close());
    await until(() => again.ready, "inbox after restart");
    expect(again.unread).toBe(1);
  });

  it("refuses inbox paths without a valid user id, and room ids reserved for inboxes", async () => {
    const { url } = await start(join(tempDir(), "db.sqlite"));
    for (const path of ["/v1/inbox/", "/v1/inbox/%E0%A4%A", "/v1/rooms/towhee.inbox", "/v1/rooms/talvra:towhee.inbox"]) {
      const status = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`${url}${path}`);
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("open", () => resolve(101));
        ws.on("error", () => {});
      });
      expect(status, path).not.toBe(101);
    }
  });

  it("refuses bad tokens", async () => {
    const { url } = await start(join(tempDir(), "db.sqlite"));
    const client = createClient({ url, authEndpoint: async () => "bad.token.here" });
    const c = client.enter("doc:1");
    cleanups.push(() => c.leave());
    await until(() => c.status === "disconnected", "refusal");
    expect(c.lastError?.code).toBe("unauthorized");
  });

  it("answers health checks and refuses other paths", async () => {
    const { url, port } = await start(join(tempDir(), "db.sqlite"));
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, rooms: 0, connections: 0 });
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`ws://127.0.0.1:${port}/v1/rooms/`);

    for (const path of ["/v1/rooms", "/v1/other/doc", "/v1/rooms/a%2Fb", "/v1/rooms/%E0%A4%A"]) {
      const status = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`${url}${path}`);
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("open", () => resolve(101));
        ws.on("error", () => {});
      });
      expect(status, path).not.toBe(101);
    }
  });

  it("closes on text frames and enforces the auth timeout", async () => {
    const { url } = await start(join(tempDir(), "db.sqlite"), 0, { limits: { authTimeoutMs: 100 } });
    const closeCode = (send?: (ws: WebSocket) => void) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`${url}/v1/rooms/doc:1`);
        ws.on("open", () => send?.(ws));
        ws.on("close", (code) => resolve(code));
      });
    expect(await closeCode((ws) => ws.send("hello"))).toBe(ERROR_CODES.protocol_error);
    expect(await closeCode()).toBe(ERROR_CODES.auth_timeout);
  });

  it("frees empty rooms and loads them again from storage", async () => {
    const { url, port } = await start(join(tempDir(), "db.sqlite"), 0, { unloadAfterMs: 50 });
    const rooms = async () => ((await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { rooms: number }).rooms;
    const a = enter(url);
    await until(() => a.synced, "sync");
    a.doc.getText("t").insert(0, "still here");
    await new Promise((r) => setTimeout(r, 50));
    a.leave();
    let count = -1;
    for (let i = 0; i < 100; i++) {
      count = await rooms();
      if (count === 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(count).toBe(0);
    const b = enter(url);
    await until(() => b.synced, "sync again");
    expect(text(b)).toBe("still here");
  });
});

describe("configFromEnv", () => {
  it("reads one secret or several keys", () => {
    const one = configFromEnv({ TOWHEE_SECRET: "s".repeat(32) });
    expect(one.server.keys).toEqual([{ id: "default", secret: "s".repeat(32) }]);
    expect(one.port).toBe(8080);
    expect(one.host).toBe("0.0.0.0");
    expect(one.server.dataPath).toBe("./data/towhee.sqlite");

    const many = configFromEnv({
      TOWHEE_KEYS: JSON.stringify([{ id: "talvra", secret: "t".repeat(32), rooms: "talvra:*" }]),
      PORT: "9000",
      TOWHEE_DATA: "/data/x.sqlite",
      TOWHEE_MAX_CONNECTIONS: "10",
    });
    expect(many.port).toBe(9000);
    expect(many.server.dataPath).toBe("/data/x.sqlite");
    expect(many.server.limits).toEqual({ maxConnections: 10 });
    expect(configFromEnv({ TOWHEE_SECRET: "s".repeat(32), PORT: "9000", TOWHEE_PORT: "7000" }).port).toBe(7000);
  });

  it("reads the webhook settings", () => {
    const config = configFromEnv({ TOWHEE_SECRET: "s".repeat(32), TOWHEE_WEBHOOK_URL: "https://app/hooks", TOWHEE_WEBHOOK_SECRET: "w".repeat(32) });
    expect(config.server.webhook).toEqual({ url: "https://app/hooks", secret: "w".repeat(32) });
    expect(() => configFromEnv({ TOWHEE_SECRET: "s".repeat(32), TOWHEE_WEBHOOK_URL: "https://app/hooks" })).toThrow(/TOWHEE_WEBHOOK_SECRET/);
  });

  it("explains what's wrong", () => {
    expect(() => configFromEnv({})).toThrow(/TOWHEE_SECRET/);
    expect(() => configFromEnv({ TOWHEE_KEYS: "{nope" })).toThrow(/JSON array/);
    expect(() => configFromEnv({ TOWHEE_SECRET: "short" })).toThrow(/at least 32/);
    expect(() => configFromEnv({ TOWHEE_SECRET: "s".repeat(32), PORT: "eighty" })).toThrow(/PORT/);
  });
});

describe("admin API", () => {
  const admin = "s".repeat(32);
  const http = (url: string) => url.replace(/^ws/, "http");

  it("reports, exports, kicks and deletes rooms", async () => {
    const { url } = await start(join(tempDir(), "t.sqlite"), 0, { adminSecret: admin });
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`${http(url)}/v1/admin/rooms/${path}`, { ...init, headers: { authorization: `Bearer ${admin}`, ...init.headers } });

    expect((await fetch(`${http(url)}/v1/admin/rooms/doc:1`)).status).toBe(401);
    expect((await call("doc:none")).status).toBe(404);

    const ada = enter(url, { userId: "ada", user: { name: "Ada" } });
    const bob = enter(url, { userId: "bob" });
    await until(() => ada.synced && bob.synced, "sync");
    ada.doc.getText("t").insert(0, "kept for export");
    await until(() => bob.doc.getText("t").toString() === "kept for export", "edit");

    const info = (await (await call("doc:1")).json()) as { users: unknown[] };
    expect(info).toMatchObject({ room: "doc:1", connections: 2, threads: 0 });
    expect(info.users).toEqual(expect.arrayContaining([{ id: "ada", name: "Ada", connections: 1 }, { id: "bob", connections: 1 }]));

    const exported = (await (await call("doc:1/export")).json()) as { document: string };
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Buffer.from(exported.document, "base64"));
    expect(copy.getText("t").toString()).toBe("kept for export");

    expect(await (await call("doc:1/kick", { method: "POST", body: JSON.stringify({ userId: "bob" }) })).json()).toEqual({ closed: 1 });
    await until(() => bob.status === "disconnected", "bob removed");
    expect(bob.lastError?.code).toBe("removed");
    expect(ada.status).toBe("connected");

    const listed = (await (await fetch(`${http(url)}/v1/admin/rooms?prefix=doc:`, { headers: { authorization: `Bearer ${admin}` } })).json()) as { rooms: string[] };
    expect(listed.rooms).toContain("doc:1");

    expect(await (await call("doc:1", { method: "DELETE" })).json()).toEqual({ deleted: true });
    const after = (await (await fetch(`${http(url)}/v1/admin/rooms?prefix=doc:`, { headers: { authorization: `Bearer ${admin}` } })).json()) as { rooms: string[] };
    expect(after.rooms).not.toContain("doc:1");
    await until(() => ada.status === "disconnected", "ada closed");
    expect(ada.lastError?.code).toBe("room_deleted");
    expect((await call("doc:1")).status).toBe(404);

    const fresh = enter(url, { userId: "cy" });
    await until(() => fresh.synced, "sync after delete");
    expect(fresh.doc.getText("t").toString()).toBe("");
  });

  it("isn't served without a secret", async () => {
    const { url } = await start(join(tempDir(), "t.sqlite"));
    expect((await fetch(`${http(url)}/v1/admin/rooms/doc:1`, { headers: { authorization: `Bearer ${admin}` } })).status).toBe(404);
  });
});

