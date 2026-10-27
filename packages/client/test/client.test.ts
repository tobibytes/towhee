import type { RoomTokenInput } from "@towhee/auth";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { type ClientOptions, createClient, RequestError, type RoomConnection, type Status } from "../src";
import { settle, TestServer } from "./server";

let server: TestServer;
const rooms: RoomConnection[] = [];
afterEach(async () => {
  for (const r of rooms.splice(0)) r.leave();
  await settle();
  await server?.close();
});

function join(tag: string, input: Partial<RoomTokenInput> = {}, extra: Partial<ClientOptions> = {}, roomId = "doc:1"): RoomConnection {
  const client = createClient({
    url: "ws://test",
    authEndpoint: () => server.token({ userId: tag, room: roomId, ...input }),
    WebSocket: server.socketClass(tag),
    timers: server.time,
    random: () => 1, // no jitter: delays are exactly 500, 1000, 2000 ms...
    ...extra,
  });
  const room = client.enter(roomId);
  rooms.push(room);
  return room;
}

const text = (room: RoomConnection) => room.doc.getText("t").toString();
const write = (room: RoomConnection, value: string) => room.doc.getText("t").insert(room.doc.getText("t").length, value);

describe("syncing", () => {
  it("two clients converge through a real core room", async () => {
    server = new TestServer();
    const a = join("ada");
    const b = join("bob");
    await settle();
    expect([a.status, b.status]).toEqual(["connected", "connected"]);
    expect([a.synced, b.synced]).toEqual([true, true]);
    write(a, "hello ");
    write(b, "world");
    await settle();
    expect(text(a)).toBe(text(b));
    expect(text(a)).toHaveLength(11);
    const room = await server.room("doc:1");
    expect(room.doc.getText("t").toString()).toBe(text(a));
  });

  it("puts the room id in the URL path, encoded", async () => {
    server = new TestServer();
    join("ada", {}, {}, "team:7:notes");
    await settle();
    expect(server.urls).toEqual(["ws://test/v1/rooms/team%3A7%3Anotes"]);
  });

  it("syncs a doc the app already had", async () => {
    server = new TestServer();
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "draft");
    const client = createClient({ url: "ws://test/", authEndpoint: () => server.token(), WebSocket: server.socketClass(), timers: server.time });
    const room = client.enter("doc:1", { doc });
    rooms.push(room);
    expect(room.doc).toBe(doc);
    expect(client.enter("doc:1")).toBe(room);
    await settle();
    expect((await server.room("doc:1")).doc.getText("t").toString()).toBe("draft");
  });

  it("checks its arguments", () => {
    expect(() => createClient({ url: "https://x", authEndpoint: async () => "" })).toThrow(TypeError);
    server = new TestServer();
    const client = createClient({ url: "ws://x", authEndpoint: async () => "", WebSocket: server.socketClass() });
    expect(() => client.enter("a/b")).toThrow(TypeError);
  });
});

describe("reconnecting", () => {
  it("fires status events in order", async () => {
    server = new TestServer();
    const a = join("ada");
    const seen: Status[] = [];
    a.on("status", (s) => seen.push(s));
    expect(a.status).toBe("connecting");
    await settle();
    server.drop("ada");
    await settle();
    await server.time.advance(500);
    a.leave();
    expect(seen).toEqual(["connected", "reconnecting", "connected", "disconnected"]);
  });

  it("a dropped connection reconnects and catches up", async () => {
    server = new TestServer();
    const a = join("ada");
    const b = join("bob");
    await settle();
    server.drop("ada");
    await settle();
    expect(a.status).toBe("reconnecting");
    expect(a.synced).toBe(false);
    write(b, "while you were out. ");
    write(a, "offline edit. ");
    await settle();
    expect(text(b)).not.toContain("offline");
    await server.time.advance(500);
    expect(a.status).toBe("connected");
    expect(text(a)).toBe(text(b));
    expect(text(a)).toContain("while you were out");
    expect(text(a)).toContain("offline edit");
  });

  it("backs off longer after each failure, and resets once connected", async () => {
    server = new TestServer();
    let fail = 3;
    const a = join("ada", {}, {
      authEndpoint: async () => {
        if (fail-- > 0) throw new Error("network down");
        return server.token({ userId: "ada" });
      },
    });
    await settle();
    expect(a.status).toBe("reconnecting");
    await server.time.advance(499);
    expect(fail).toBe(2); // first retry at 500 ms
    await server.time.advance(1);
    expect(fail).toBe(1);
    await server.time.advance(999);
    expect(fail).toBe(1); // second retry at 1000 ms
    await server.time.advance(1);
    expect(fail).toBe(0);
    await server.time.advance(2000);
    expect(a.status).toBe("connected");
    expect(a.lastError).toBeNull();
  });

  it("refreshes an expired token without losing edits made offline", async () => {
    server = new TestServer();
    let release: (() => void) | undefined;
    let calls = 0;
    const a = join("ada", {}, {
      authEndpoint: async () => {
        calls++;
        if (calls === 2) await new Promise<void>((resolve) => (release = resolve));
        return server.token({ userId: "ada", expiresIn: 60 });
      },
    });
    const b = join("bob");
    const errors: string[] = [];
    a.on("error", (e) => errors.push(e.code));
    await settle();
    await server.time.advance(60_000 + 60_000 + 1); // expiry plus the server's clock skew
    expect(a.status).toBe("reconnecting");
    expect(errors).toEqual(["token_expired"]);
    write(a, "typed while the token refreshed");
    await settle();
    expect(text(b)).toBe("");
    release!();
    await settle();
    expect(calls).toBe(2);
    expect(a.status).toBe("connected");
    expect(text(b)).toBe("typed while the token refreshed");
  });

  it("stops on errors that would just repeat", async () => {
    server = new TestServer();
    const a = join("ada", {}, { authEndpoint: async () => "not.a.token" });
    await settle();
    expect(a.status).toBe("disconnected");
    expect(a.lastError?.code).toBe("unauthorized");
    await server.time.advance(60_000);
    expect(server.urls).toHaveLength(1);
  });
});

describe("auth endpoint URL", () => {
  it("posts the room id with cookies and reads { token }", async () => {
    server = new TestServer();
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ token: await server.token({ userId: "ada" }) }), { status: 200 });
    }) as unknown as typeof fetch;
    const a = join("ada", {}, { authEndpoint: "https://app.example/api/towhee-token", fetch: fakeFetch });
    await settle();
    expect(a.status).toBe("connected");
    expect(calls[0]!.url).toBe("https://app.example/api/towhee-token");
    expect(calls[0]!.init).toMatchObject({ method: "POST", credentials: "include", body: JSON.stringify({ room: "doc:1" }) });
  });

  it("stops when the app refuses, and retries when it's down", async () => {
    server = new TestServer();
    const refused = join("ada", {}, { authEndpoint: "https://app/t", fetch: (async () => new Response("no", { status: 403 })) as unknown as typeof fetch });
    let down = true;
    const flaky = join("bob", {}, {
      authEndpoint: "https://app/t",
      fetch: (async () =>
        down ? new Response("oops", { status: 502 }) : new Response(JSON.stringify({ token: await server.token({ userId: "bob" }) }))) as unknown as typeof fetch,
    });
    await settle();
    expect(refused.status).toBe("disconnected");
    expect(refused.lastError?.code).toBe("auth_failed");
    expect(flaky.status).toBe("reconnecting");
    down = false;
    await server.time.advance(500);
    expect(flaky.status).toBe("connected");
  });
});

describe("presence", () => {
  it("shows others with identities from their tokens, and clears them when they leave", async () => {
    server = new TestServer();
    const a = join("ada", { user: { name: "Ada", color: "#0ea5e9" } });
    const b = join("bob");
    const updates: number[] = [];
    b.on("others", (others) => updates.push(others.length));
    await settle();
    a.setPresence({ cursor: 4 });
    await settle();
    expect(b.others()).toEqual([{ clientId: a.doc.clientID, user: { id: "ada", name: "Ada", color: "#0ea5e9" }, presence: { cursor: 4 } }]);
    a.updatePresence({ selection: [1, 2] });
    await settle();
    expect(b.others()[0]!.presence).toEqual({ cursor: 4, selection: [1, 2] });
    a.leave();
    await settle();
    expect(b.others()).toEqual([]);
    expect(updates.at(-1)).toBe(0);
  });

  it("forgets others while disconnected and gets them back after", async () => {
    server = new TestServer();
    const a = join("ada");
    const b = join("bob");
    await settle();
    a.setPresence({ cursor: 1 });
    await settle();
    server.drop("bob");
    await settle();
    expect(b.others()).toEqual([]);
    await server.time.advance(500);
    expect(b.others().map((o) => o.user.id)).toEqual(["ada"]);
  });

  it("tells you who you are", async () => {
    server = new TestServer();
    const a = join("ada", { access: "comment", user: { name: "Ada" } });
    const selves: unknown[] = [];
    a.on("self", (s) => selves.push(s));
    await settle();
    expect(a.self).toMatchObject({ user: { id: "ada", name: "Ada" }, access: "comment" });
    expect(selves).toHaveLength(1);
  });
});

describe("requests", () => {
  it("resolves server answers and rejects when disconnected", async () => {
    server = new TestServer();
    const a = join("ada");
    await expect(a.request("threads.list")).rejects.toMatchObject({ code: "disconnected" });
    await settle();
    const err = await a.request("threads.list").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).code).toBe("not_found");
  });
});

describe("read-only access", () => {
  it("receives edits, sends none, and is refused if it edits and reconnects", async () => {
    server = new TestServer();
    const writer = join("ada");
    const reader = join("bob", { access: "read" });
    await settle();
    write(writer, "published");
    await settle();
    expect(text(reader)).toBe("published");

    write(reader, " defaced");
    await settle();
    expect(reader.status).toBe("connected"); // nothing was sent
    expect(text(writer)).toBe("published");

    server.drop("bob");
    await settle();
    await server.time.advance(500);
    expect(reader.status).toBe("disconnected"); // the handshake carried the local edit
    expect(reader.lastError?.code).toBe("forbidden");
    expect(text(writer)).toBe("published");
  });
});
