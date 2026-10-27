import * as Y from "yjs";
import type { Storage } from "./storage";

/** The parts of a test framework the suite needs. Pass Vitest's (or Jest's) `describe`, `it` and `expect`. */
export interface TestApi {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void> | void): void;
  // biome-ignore lint/suspicious/noExplicitAny: matches any framework's expect
  expect(value: unknown): any;
}

function text(update: Uint8Array | null): string {
  const doc = new Y.Doc();
  if (update) Y.applyUpdate(doc, update);
  return doc.getText("t").toString();
}

/** A document whose text is `value`, plus the updates that built it. */
function build(...edits: string[]): { doc: Y.Doc; updates: Uint8Array[] } {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on("update", (u: Uint8Array) => updates.push(u));
  for (const edit of edits) doc.getText("t").insert(doc.getText("t").length, edit);
  return { doc, updates };
}

/**
 * The behavior every {@link Storage} must have. Each host runs it against its own storage:
 *
 *   storageSuite("SQLite", () => new SqliteStorage(":memory:"), { describe, it, expect });
 */
export function storageSuite(name: string, create: () => Storage | Promise<Storage>, { describe, it, expect }: TestApi): void {
  describe(`${name} storage`, () => {
    it("has nothing for a room that was never saved", async () => {
      const storage = await create();
      expect(await storage.loadDocument("never")).toBeNull();
    });

    it("returns appended updates merged into one", async () => {
      const storage = await create();
      const { updates } = build("hello", " ", "world");
      for (const u of updates) await storage.appendUpdate("r1", u);
      expect(text(await storage.loadDocument("r1"))).toBe("hello world");
    });

    it("replaces the log with a compacted state, and keeps updates appended after it", async () => {
      const storage = await create();
      const { doc, updates } = build("a", "b");
      for (const u of updates) await storage.appendUpdate("r1", u);
      await storage.compact("r1", Y.encodeStateAsUpdate(doc));
      expect(text(await storage.loadDocument("r1"))).toBe("ab");
      const later: Uint8Array[] = [];
      doc.on("update", (u: Uint8Array) => later.push(u));
      doc.getText("t").insert(2, "c");
      for (const u of later) await storage.appendUpdate("r1", u);
      expect(text(await storage.loadDocument("r1"))).toBe("abc");
      await storage.compact("r1", Y.encodeStateAsUpdate(doc));
      expect(text(await storage.loadDocument("r1"))).toBe("abc");
    });

    it("keeps rooms apart", async () => {
      const storage = await create();
      for (const u of build("one").updates) await storage.appendUpdate("room:1", u);
      for (const u of build("two").updates) await storage.appendUpdate("room:2", u);
      expect(text(await storage.loadDocument("room:1"))).toBe("one");
      expect(text(await storage.loadDocument("room:2"))).toBe("two");
      expect(await storage.loadDocument("room:3")).toBeNull();
    });

    it("keeps its own copy of the bytes it was given", async () => {
      const storage = await create();
      const { updates } = build("safe");
      const update = updates[0]!.slice();
      await storage.appendUpdate("r1", update);
      update.fill(0);
      expect(text(await storage.loadDocument("r1"))).toBe("safe");
    });

    it("stores large documents", async () => {
      const storage = await create();
      const { doc } = build("x".repeat(512 * 1024));
      await storage.compact("big", Y.encodeStateAsUpdate(doc));
      expect(text(await storage.loadDocument("big")).length).toBe(512 * 1024);
    });
  });
}
