import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { restoreDocument, rootKind } from "../src/restore";

/** Two docs kept in sync, like two clients through a server. */
function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array, origin: unknown) => origin !== "remote" && Y.applyUpdate(b, u, "remote"));
  b.on("update", (u: Uint8Array, origin: unknown) => origin !== "remote" && Y.applyUpdate(a, u, "remote"));
  return { a, b };
}

const snapshot = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc);

describe("restoreDocument", () => {
  it("restores formatted text, embeds included, for everyone", () => {
    const { a, b } = pair();
    const text = a.getText("body");
    text.insert(0, "Hello ");
    text.insert(6, "world", { bold: true });
    text.insertEmbed(11, { image: "cat.png" });
    const version = snapshot(a);
    const before = text.toDelta();

    text.delete(0, 6);
    text.format(0, 5, { bold: null, italic: true });
    b.getText("body").insert(0, "Rewritten: ");
    restoreDocument(a, version);

    expect(a.getText("body").toDelta()).toEqual(before);
    expect(b.getText("body").toDelta()).toEqual(before);
  });

  it("restores maps, nested types included, and removes keys added since", () => {
    const { a, b } = pair();
    const settings = a.getMap<unknown>("settings");
    settings.set("theme", "dark");
    settings.set("count", 3);
    const nested = new Y.Map<unknown>();
    nested.set("x", 1);
    settings.set("position", nested);
    const tags = new Y.Array<string>();
    tags.push(["a", "b"]);
    settings.set("tags", tags);
    const version = snapshot(a);
    const before = settings.toJSON();

    settings.set("theme", "light");
    settings.set("added", true);
    (settings.get("position") as Y.Map<unknown>).set("x", 99);
    settings.delete("count");
    restoreDocument(a, version);

    expect(a.getMap("settings").toJSON()).toEqual(before);
    expect(b.getMap("settings").toJSON()).toEqual(before);
  });

  it("restores arrays of mixed values", () => {
    const { a, b } = pair();
    const list = a.getArray<unknown>("items");
    const card = new Y.Map<unknown>();
    card.set("title", "first");
    list.push([1, "two", { three: 3 }, card, new Uint8Array([4])]);
    const version = snapshot(a);
    const before = list.toJSON();
    list.delete(0, 2);
    list.push(["late"]);
    restoreDocument(a, version);
    expect(a.getArray("items").toJSON()).toEqual(before);
    expect(b.getArray("items").toJSON()).toEqual(before);
  });

  it("restores an XML document shaped like TipTap's", () => {
    const { a, b } = pair();
    const fragment = a.getXmlFragment("default");
    const heading = new Y.XmlElement("heading");
    heading.setAttribute("level", "1");
    heading.insert(0, [new Y.XmlText("Plan")]);
    const paragraph = new Y.XmlElement("paragraph");
    const run = new Y.XmlText();
    paragraph.insert(0, [run]);
    fragment.insert(0, [heading, paragraph]);
    run.insert(0, "Ship ");
    run.insert(5, "Friday", { bold: {} });
    const version = snapshot(a);
    const before = fragment.toString();
    expect(before).toBe('<heading level="1">Plan</heading><paragraph>Ship <bold>Friday</bold></paragraph>');

    fragment.delete(0, 1);
    (fragment.get(0) as Y.XmlElement).insert(1, [new Y.XmlText(" later")]);
    restoreDocument(a, version);

    expect(a.getXmlFragment("default").toString()).toBe(before);
    expect(b.getXmlFragment("default").toString()).toBe(before);
  });

  it("can be undone with the app's undo manager", () => {
    const doc = new Y.Doc();
    const text = doc.getText("body");
    const map = doc.getMap("meta");
    text.insert(0, "version one");
    map.set("title", "One");
    const version = snapshot(doc);
    text.delete(0, text.length);
    text.insert(0, "version two");
    map.set("title", "Two");

    const restoring = Symbol("restore");
    const undo = new Y.UndoManager([text, map], { trackedOrigins: new Set([restoring]) });
    restoreDocument(doc, version, { origin: restoring });
    expect([text.toString(), map.get("title")]).toEqual(["version one", "One"]);
    undo.undo();
    expect([text.toString(), map.get("title")]).toEqual(["version two", "Two"]);
    undo.redo();
    expect([text.toString(), map.get("title")]).toEqual(["version one", "One"]);
  });

  it("works on a doc that never declared its types, by reading their content", () => {
    const source = new Y.Doc();
    source.getText("t").insert(0, "text");
    source.getMap("m").set("k", "v");
    source.getArray("a").push([1, 2]);
    source.getXmlFragment("x").insert(0, [new Y.XmlElement("p")]);
    const version = snapshot(source);
    source.getText("t").insert(4, " changed");
    source.getMap("m").set("k", "changed");
    source.getArray("a").push([3]);
    source.getXmlFragment("x").insert(1, [new Y.XmlElement("h1")]);

    // A doc that only received updates (like a server or a fresh client) holds placeholders.
    const plain = new Y.Doc();
    Y.applyUpdate(plain, snapshot(source));
    expect([...plain.share.keys()].sort()).toEqual(["a", "m", "t", "x"]);
    expect(["t", "m", "a", "x"].map((n) => rootKind(plain.share.get(n)!))).toEqual(["text", "map", "array", "xml"]);

    restoreDocument(plain, version);
    expect(plain.getText("t").toString()).toBe("text");
    expect(plain.getMap("m").get("k")).toBe("v");
    expect(plain.getArray("a").toArray()).toEqual([1, 2]);
    expect(plain.getXmlFragment("x").toString()).toBe("<p></p>");
  });

  it("clears types that were empty in the version, and leaves concurrent edits mergeable", () => {
    const { a, b } = pair();
    const version = snapshot(a); // empty
    a.getText("t").insert(0, "added later");
    restoreDocument(a, version, { types: { t: "text" } });
    expect(a.getText("t").toString()).toBe("");
    // After the restore both sides keep editing and still converge.
    a.getText("t").insert(0, "A");
    b.getText("t").insert(0, "B");
    expect(a.getText("t").toString()).toBe(b.getText("t").toString());
    expect(a.getText("t").length).toBe(2);
  });
});
