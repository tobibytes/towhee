import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createClient, RequestError, type RoomConnection } from "../src";
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
  void room.history; // start tracking versions from the first connect, as an app showing them would
  rooms.push(room);
  return room;
}

function paragraph(fragment: Y.XmlFragment, text: string) {
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [p]);
}

describe("history", () => {
  it("restores a version for every client, and the restore can be undone", async () => {
    server = new TestServer();
    const ada = join("ada");
    const bob = join("bob");
    await settle();
    const doc = ada.doc.getXmlFragment("default");
    paragraph(doc, "First draft");
    await settle();
    const v1 = await ada.history.save("Draft 1");
    paragraph(doc, "Second thoughts");
    bob.doc.getXmlFragment("default").delete(0, 1);
    await settle();
    expect(ada.doc.getXmlFragment("default").toString()).toBe("<paragraph>Second thoughts</paragraph>");

    const origin = Symbol("restore");
    const undo = new Y.UndoManager(ada.doc.getXmlFragment("default"), { trackedOrigins: new Set([origin]) });
    const restored = await ada.history.restore(v1.id, { origin });
    await settle();
    expect(restored).toMatchObject({ kind: "restore", restoredFrom: v1.id });
    expect(bob.doc.getXmlFragment("default").toString()).toBe("<paragraph>First draft</paragraph>");

    undo.undo();
    await settle();
    expect(bob.doc.getXmlFragment("default").toString()).toBe("<paragraph>Second thoughts</paragraph>");
    expect(bob.history.list().map((v) => v.kind)).toEqual(["restore", "manual"]);
  });

  it("previews a version without touching the live document", async () => {
    server = new TestServer();
    const ada = join("ada");
    await settle();
    ada.doc.getText("t").insert(0, "then");
    await settle();
    const v = await ada.history.save();
    ada.doc.getText("t").insert(4, " and now");
    const preview = await ada.history.preview(v.id);
    expect(preview.getText("t").toString()).toBe("then");
    expect(ada.doc.getText("t").toString()).toBe("then and now");
  });

  it("refuses to save or restore without write access", async () => {
    server = new TestServer();
    const ada = join("ada");
    const cara = join("cara", "comment");
    await settle();
    ada.doc.getText("t").insert(0, "x");
    await settle();
    const v = await ada.history.save();
    await settle();
    expect(cara.history.list().map((x) => x.id)).toEqual([v.id]); // can see
    await expect(cara.history.save()).rejects.toMatchObject({ code: "forbidden" });
    const err = await cara.history.restore(v.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect(cara.doc.getText("t").toString()).toBe("x");
    expect(cara.status).toBe("connected");
  });
});
