import { ERROR_CODES, encodeMessage, PRESENCE_RESEND_EVENT } from "@towhee/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Connection, type ConnectionState, encodePresence, MemoryStorage, Room } from "../src";
import { key, type Setup, setup } from "./harness";

let current: Setup | undefined;
afterEach(async () => {
  await current?.teardown();
  current = undefined;
});

/** A room in manual mode that records what it reports about each connection. */
async function manual(storage = new MemoryStorage()) {
  const states = new Map<Connection, ConnectionState | null>();
  const s = await setup({ storage, timers: "manual", onConnectionChange: (conn, state) => states.set(conn, state) });
  current = s;
  return { s, states };
}

describe("manual mode", () => {
  it("relies on y-protocols' interval field, so an upgrade that renames it fails here", async () => {
    const { s } = await manual();
    expect("_checkInterval" in s.room.awareness).toBe(true);
  });

  it("sets no timers and closes late authenticators on sweep", async () => {
    const { s } = await manual();
    const slow = s.open();
    expect(s.room.nextDeadline()).toBe(s.time.current + 10_000);
    s.time.advance(10_000);
    expect(slow.closed).toBeUndefined(); // no timer fired: nothing is scheduled in manual mode
    s.room.sweep();
    expect(slow.closed?.code).toBe(ERROR_CODES.auth_timeout);
    expect(s.room.nextDeadline()).toBeUndefined();
  });

  it("refuses a late auth even before a sweep", async () => {
    const { s } = await manual();
    const slow = s.open();
    const token = await s.token();
    s.time.advance(10_000);
    await slow.auth(token);
    expect(slow.closed?.code).toBe(ERROR_CODES.auth_timeout);
  });

  it("closes expired tokens and drops stale presence on sweep", async () => {
    const { s } = await manual();
    const a = await s.join({ expiresIn: 3600 });
    const b = await s.join({ expiresIn: 7200 });
    a.awareness.setLocalState({ cursor: 1 });
    await s.settle();
    expect(s.room.nextDeadline()).toBe(s.time.current + 30_000); // presence goes stale first
    s.time.advance(30_000);
    s.room.sweep();
    expect(s.room.awareness.getStates().size).toBe(0);
    expect(b.others().size).toBe(0);
    expect(s.room.nextDeadline()).toBe(Date.UTC(2027, 0, 1) + 3_600_000 + 60_000 + 1);
    s.time.advance(3_600_000 + 60_000 - 30_000 + 1);
    s.room.sweep();
    expect(a.closed?.code).toBe(ERROR_CODES.token_expired);
    expect(b.closed).toBeUndefined();
  });
});

describe("connection state", () => {
  it("reports connect, auth, presence claims and close", async () => {
    const { s, states } = await manual();
    const c = s.open();
    expect(states.get(c.conn)).toMatchObject({ phase: "pending", presence: [] });
    await c.auth(await s.token({ userId: "ada", access: "comment", user: { name: "Ada" } }));
    await s.settle();
    const ready = states.get(c.conn)!;
    expect(ready).toMatchObject({ phase: "ready", access: "comment", user: { id: "ada", name: "Ada" }, presence: [] });
    expect(typeof ready.expiresAt).toBe("number");
    expect(JSON.parse(JSON.stringify(ready))).toEqual(ready); // plain JSON
    c.awareness.setLocalState({ cursor: 1 });
    await s.settle();
    expect(states.get(c.conn)!.presence).toEqual([c.doc.clientID]);
    c.disconnect();
    expect(states.get(c.conn)).toBeNull();
  });
});

describe("hibernation", () => {
  it("a room loaded again with its sockets restored keeps the document and presence", async () => {
    const storage = new MemoryStorage();
    const { s, states } = await manual(storage);
    const ada = await s.join({ userId: "ada", user: { name: "Ada" } });
    const bob = await s.join({ userId: "bob" });
    ada.doc.getText("t").insert(0, "before sleep");
    ada.awareness.setLocalState({ cursor: 5 });
    bob.awareness.setLocalState({ cursor: 1 });
    await s.settle();
    const saved = new Map(states);

    // The host is evicted: the Room object is gone, the sockets stay open. A new Room loads.
    const woke = await Room.load({ id: s.room.id, storage, keys: key, now: s.time.now, timers: "manual" });
    for (const client of [ada, bob]) {
      client.rebind(woke);
      woke.restore(client.conn, saved.get(client.conn)!);
    }
    expect(woke.doc.getText("t").toString()).toBe("before sleep");
    expect(woke.awareness.getStates().size).toBe(0);
    woke.requestPresence();
    await s.settle();
    await Promise.all([ada, bob].flatMap((c) => c.takePending()));
    expect(ada.received.some((m) => m.type === "event" && m.name === PRESENCE_RESEND_EVENT)).toBe(true);
    expect([...woke.awareness.getStates().values()]).toEqual(
      expect.arrayContaining([
        { cursor: 5, user: { id: "ada", name: "Ada" } },
        { cursor: 1, user: { id: "bob" } },
      ]),
    );

    // No new auth needed: edits flow straight away, with the same access as before.
    bob.doc.getText("t").insert(0, "after waking, ");
    await Promise.all(bob.takePending());
    await Promise.all(ada.takePending());
    await woke.flush();
    expect(woke.doc.getText("t").toString()).toBe("after waking, before sleep");
    expect(ada.text).toBe("after waking, before sleep");

    // Presence ownership survived too: bob can't take ada's cursor.
    const adaClock = woke.awareness.meta.get(ada.doc.clientID)!.clock;
    await bob.sendRaw(
      encodeMessage({ type: "awareness", data: encodePresence([{ clientId: ada.doc.clientID, clock: adaClock + 1, state: { cursor: 666 } }]) }),
    );
    expect(woke.awareness.getStates().get(ada.doc.clientID)).toEqual({ cursor: 5, user: { id: "ada", name: "Ada" } });
    for (const client of [ada, bob]) client.destroy();
    await woke.close();
  });

  it("a restored connection that never authenticated still times out", async () => {
    const storage = new MemoryStorage();
    const { s, states } = await manual(storage);
    const slow = s.open();
    const state = states.get(slow.conn)!;
    const woke = await Room.load({ id: s.room.id, storage, keys: key, now: s.time.now, timers: "manual" });
    slow.rebind(woke);
    woke.restore(slow.conn, state);
    expect(woke.nextDeadline()).toBe(state.connectedAt + 10_000);
    s.time.advance(10_000);
    woke.sweep();
    expect(slow.closed?.code).toBe(ERROR_CODES.auth_timeout);
    await woke.close();
  });
});
