import { createClient, type TowheeClient } from "@towhee/client";
import { act, cleanup, render } from "@testing-library/react";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { settle, TestServer } from "../../client/test/server";
import {
  RoomProvider,
  TowheeProvider,
  useDoc,
  useHistory,
  useInbox,
  useOthers,
  useRoom,
  useSelf,
  useStatus,
  useSynced,
  useThreads,
  useUpdatePresence,
} from "../src";

let server: TestServer;
afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0)); // deferred leaves
    await settle();
  });
  await server?.close();
});

function client(userId: string): TowheeClient {
  return createClient({
    url: "ws://test",
    authEndpoint: (room) => server.token({ userId, room }),
    WebSocket: server.socketClass(userId),
    timers: server.time,
  });
}

/** Everything the hooks return, from the latest render. */
type Seen = {
  status: ReturnType<typeof useStatus>;
  synced: boolean;
  self: ReturnType<typeof useSelf>;
  others: ReturnType<typeof useOthers>;
  threads: ReturnType<typeof useThreads>;
  history: ReturnType<typeof useHistory>;
  room: ReturnType<typeof useRoom>;
  doc: ReturnType<typeof useDoc>;
  update: ReturnType<typeof useUpdatePresence>;
  renders: number;
};

function Spy({ into }: { into: Partial<Seen> }) {
  into.status = useStatus();
  into.synced = useSynced();
  into.self = useSelf();
  into.others = useOthers();
  into.threads = useThreads();
  into.history = useHistory();
  into.room = useRoom();
  into.doc = useDoc();
  into.update = useUpdatePresence();
  into.renders = (into.renders ?? 0) + 1;
  return null;
}

function mount(userId: string, room = "doc:1", { strict = false, initialPresence }: { strict?: boolean; initialPresence?: Record<string, unknown> } = {}) {
  const seen: Partial<Seen> = {};
  const c = client(userId);
  const tree = (
    <TowheeProvider client={c}>
      <RoomProvider id={room} initialPresence={initialPresence}>
        <Spy into={seen} />
      </RoomProvider>
    </TowheeProvider>
  );
  const result = render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
  return { seen: seen as Seen, client: c, ...result };
}

const flush = () =>
  act(async () => {
    await settle();
  });

describe("rooms and presence", () => {
  it("connects, syncs and shows who else is here", async () => {
    server = new TestServer();
    const ada = mount("ada", "doc:1", { initialPresence: { cursor: 1 } });
    const bob = mount("bob");
    expect(ada.seen.status).toBe("connecting");
    await flush();
    expect(ada.seen.status).toBe("connected");
    expect(ada.seen.synced).toBe(true);
    expect(ada.seen.self?.user.id).toBe("ada");
    expect(bob.seen.others.map((o) => [o.user.id, o.presence.cursor])).toEqual([["ada", 1]]);

    act(() => bob.seen.update({ cursor: 9 }));
    await flush();
    expect(ada.seen.others.map((o) => [o.user.id, o.presence.cursor])).toEqual([["bob", 9]]);
  });

  it("doesn't re-render while nothing changes", async () => {
    server = new TestServer();
    const ada = mount("ada");
    await flush();
    const before = ada.seen.renders;
    await flush();
    await act(() => server.time.advance(10));
    expect(ada.seen.renders).toBe(before);
  });

  it("keeps one connection and one doc through strict mode's double mount", async () => {
    server = new TestServer();
    const ada = mount("ada", "doc:strict", { strict: true });
    await flush();
    expect(ada.seen.status).toBe("connected");
    expect(server.urls.filter((u) => u.endsWith("/v1/rooms/doc%3Astrict"))).toHaveLength(1);
    expect(ada.seen.doc).toBe(ada.seen.room?.doc);
  });

  it("shares a room between providers and leaves when the last one unmounts", async () => {
    server = new TestServer();
    const watcher = mount("bob", "doc:shared");
    const c = client("ada");
    const seenA: Partial<Seen> = {};
    const seenB: Partial<Seen> = {};
    const app = render(
      <TowheeProvider client={c}>
        <RoomProvider id="doc:shared" initialPresence={{ here: true }}>
          <Spy into={seenA} />
        </RoomProvider>
        <RoomProvider id="doc:shared">
          <Spy into={seenB} />
        </RoomProvider>
      </TowheeProvider>,
    );
    await flush();
    expect(seenA.room).toBe(seenB.room);
    expect(watcher.seen.others.map((o) => o.user.id)).toEqual(["ada"]);

    app.unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      await settle();
    });
    expect(watcher.seen.others).toEqual([]);
  });

  it("switches rooms when the id changes", async () => {
    server = new TestServer();
    const c = client("ada");
    const seen: Partial<Seen> = {};
    const view = (id: string) => (
      <TowheeProvider client={c}>
        <RoomProvider id={id}>
          <Spy into={seen} />
        </RoomProvider>
      </TowheeProvider>
    );
    const app = render(view("doc:a"));
    await flush();
    const first = seen.room;
    app.rerender(view("doc:b"));
    await flush();
    expect(seen.room).not.toBe(first);
    expect(seen.status).toBe("connected");
    expect(first?.status).toBe("disconnected");
  });
});

describe("threads, history and the inbox", () => {
  it("keeps threads and versions live", async () => {
    server = new TestServer();
    const ada = mount("ada");
    const bob = mount("bob");
    await flush();
    expect(bob.seen.threads.ready).toBe(true);
    expect(bob.seen.threads.threads).toEqual([]);

    await act(async () => {
      await ada.seen.room!.threads.create({ body: "Ship it?" });
      await settle();
    });
    expect(bob.seen.threads.threads).toHaveLength(1);

    await act(async () => {
      await ada.seen.room!.history.save("v1");
      await settle();
    });
    expect(bob.seen.history.versions.map((v) => v.name)).toEqual(["v1"]);
  });

  it("puts mentions in the inbox", async () => {
    server = new TestServer();
    const ada = mount("ada");
    const bobClient = client("bob");
    const inbox: { current?: ReturnType<typeof useInbox> } = {};
    function Bell() {
      inbox.current = useInbox();
      return null;
    }
    render(
      <TowheeProvider client={bobClient}>
        <Bell />
      </TowheeProvider>,
    );
    await flush();
    expect(inbox.current?.ready).toBe(true);
    expect(inbox.current?.unread).toBe(0);

    await act(async () => {
      await ada.seen.room!.threads.create({
        body: { version: 1, content: [{ type: "paragraph", children: [{ type: "mention", userId: "bob", name: "Bob" }] }] },
      });
      await settle();
    });
    expect(inbox.current?.unread).toBe(1);
    expect(inbox.current?.notifications[0]?.excerpt).toBe("@Bob");

    await act(async () => {
      await inbox.current!.markAllRead();
      await settle();
    });
    expect(inbox.current?.unread).toBe(0);
  });
});

describe("server rendering", () => {
  it("renders empty values and opens nothing", () => {
    server = new TestServer();
    const seen: Partial<Seen> = {};
    const inbox: { current?: ReturnType<typeof useInbox> } = {};
    function Bell() {
      inbox.current = useInbox();
      return null;
    }
    renderToString(
      <TowheeProvider client={client("ada")}>
        <RoomProvider id="doc:ssr">
          <Spy into={seen} />
          <Bell />
        </RoomProvider>
      </TowheeProvider>,
    );
    expect(seen.status).toBe("connecting");
    expect(seen.room).toBeNull();
    expect(seen.others).toEqual([]);
    expect(seen.threads).toEqual({ threads: [], ready: false });
    expect(inbox.current?.unread).toBe(0);
    expect(server.urls).toEqual([]);
  });

  it("explains a missing provider", () => {
    expect(() => renderToString(<RoomProvider id="doc:x" />)).toThrow("<TowheeProvider>");
  });
});
