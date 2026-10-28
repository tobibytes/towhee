import { afterEach, describe, expect, it } from "vitest";
import { createClient, INBOX_ROOM, type InboxState, type RoomConnection, type TowheeClient } from "../src";
import { settle, TestServer } from "./server";

let server: TestServer;
const cleanup: (() => void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) fn();
  await settle();
  await server?.close();
});

/** A client signed in as `userId`; its token endpoint answers rooms and the inbox. */
function signIn(userId: string): TowheeClient {
  return createClient({
    url: "ws://test",
    authEndpoint: (room) => server.token({ userId, room }),
    WebSocket: server.socketClass(userId),
    timers: server.time,
    random: () => 1,
  });
}

function enter(client: TowheeClient): RoomConnection {
  const room = client.enter("doc:1");
  cleanup.push(() => room.leave());
  return room;
}

const mention = (userId: string, text: string) => ({
  version: 1 as const,
  content: [{ type: "paragraph" as const, children: [{ type: "mention" as const, userId }, { type: "text" as const, text }] }],
});

describe("client.inbox", () => {
  it("gets mentions and replies live, with an unread count that follows every tab", async () => {
    server = new TestServer();
    const ada = signIn("ada");
    const bob = signIn("bob");
    const adaRoom = enter(ada);
    const bobRoom = enter(bob);
    const inbox = bob.inbox;
    const secondTab = signIn("bob").inbox;
    cleanup.push(() => inbox.close(), () => secondTab.close());
    const states: InboxState[] = [];
    inbox.subscribe((s) => states.push(s));
    await settle();
    expect(inbox.connection.status).toBe("connected");
    expect(inbox.ready).toBe(true);
    expect(server.urls.filter((u) => u.includes("/v1/inbox/"))).toEqual(["ws://test/v1/inbox/bob", "ws://test/v1/inbox/bob"]);

    const thread = await adaRoom.threads.create({ body: mention("bob", " please review") });
    await settle();
    expect(inbox.unread).toBe(1);
    expect(inbox.list()[0]).toMatchObject({ kind: "mention", room: "doc:1", threadId: thread.id, actor: { id: "ada" }, excerpt: "@bob please review" });
    expect(secondTab.unread).toBe(1);

    await bobRoom.threads.reply(thread.id, "On it"); // ada gets a reply notification, not bob
    await settle();
    expect(inbox.unread).toBe(1);

    await inbox.markRead([inbox.list()[0]!.id]);
    await settle();
    expect(inbox.unread).toBe(0);
    expect(secondTab.unread).toBe(0); // read state follows to the other tab
    expect(secondTab.list()[0]!.readAt).toBe(server.time.current);
    expect(states.at(-1)?.unread).toBe(0);
  });

  it("catches up on notifications that arrived while it was closed", async () => {
    server = new TestServer();
    const ada = signIn("ada");
    const adaRoom = enter(ada);
    await settle();
    await adaRoom.threads.create({ body: mention("bob", " one") });
    await adaRoom.threads.create({ body: mention("bob", " two") });
    const inbox = signIn("bob").inbox;
    cleanup.push(() => inbox.close());
    await settle();
    expect(inbox.list().map((n) => n.excerpt)).toEqual(["@bob two", "@bob one"]);
    expect(inbox.unread).toBe(2);
    await inbox.markAllRead();
    await settle();
    expect(inbox.unread).toBe(0);
  });

  it("asks the token endpoint for the inbox room and opens the URL of the user in its token", async () => {
    server = new TestServer();
    const asked: string[] = [];
    const client = createClient({
      url: "ws://test",
      authEndpoint: (room) => {
        asked.push(room);
        return server.token({ userId: "zoë@example.com", room });
      },
      WebSocket: server.socketClass(),
      timers: server.time,
    });
    const inbox = client.inbox;
    cleanup.push(() => inbox.close());
    expect(client.inbox).toBe(inbox);
    await settle();
    expect(asked).toEqual([INBOX_ROOM]);
    expect(server.urls).toEqual(["ws://test/v1/inbox/zo%C3%AB%40example.com"]);
    expect(inbox.connection.self?.user.id).toBe("zoë@example.com");
  });

  it("is refused when the endpoint returns a room token", async () => {
    server = new TestServer();
    const client = createClient({
      url: "ws://test",
      authEndpoint: () => server.token({ userId: "bob", room: "doc:1" }),
      WebSocket: server.socketClass(),
      timers: server.time,
    });
    const inbox = client.inbox;
    cleanup.push(() => inbox.close());
    await settle();
    expect(inbox.connection.status).toBe("disconnected");
    expect(inbox.connection.lastError?.code).toBe("unauthorized");
  });
});
