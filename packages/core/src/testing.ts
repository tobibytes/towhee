import type { Thread, Version } from "@towhee/protocol";
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

    it("stores, lists, replaces and deletes threads per room", async () => {
      const storage = await create();
      const thread = (id: string, createdAt: number): Thread => ({
        id,
        resolved: false,
        createdBy: "u1",
        createdAt,
        updatedAt: createdAt,
        comments: [
          {
            id: `c-${id}`,
            threadId: id,
            author: { id: "u1", name: "Zoë" },
            body: { version: 1, content: [{ type: "paragraph", children: [{ type: "text", text: "héllo 👋" }] }] },
            reactions: { "👍": ["u2"] },
            createdAt,
          },
        ],
      });
      expect(await storage.threads.list("r1")).toEqual([]);
      expect(await storage.threads.get("r1", "t1")).toBeNull();
      await storage.threads.put("r1", thread("t2", 2));
      await storage.threads.put("r1", thread("t1", 1));
      await storage.threads.put("r2", thread("t3", 3));
      expect((await storage.threads.list("r1")).map((t) => t.id)).toEqual(["t1", "t2"]); // oldest first
      expect(await storage.threads.count("r1")).toBe(2);
      expect(await storage.threads.get("r1", "t1")).toEqual(thread("t1", 1));
      expect(await storage.threads.get("r1", "t3")).toBeNull(); // other room

      const changed = { ...thread("t1", 1), resolved: true, updatedAt: 9 };
      await storage.threads.put("r1", changed);
      expect(await storage.threads.get("r1", "t1")).toEqual(changed);
      expect(await storage.threads.count("r1")).toBe(2);

      await storage.threads.delete("r1", "t1");
      expect(await storage.threads.get("r1", "t1")).toBeNull();
      expect((await storage.threads.list("r1")).map((t) => t.id)).toEqual(["t2"]);
      expect(await storage.threads.count("r2")).toBe(1);
    });

    it("stores versions with their state, newest first, per room", async () => {
      const storage = await create();
      const { doc } = build("version one");
      const state = Y.encodeStateAsUpdate(doc);
      const v = (id: string, createdAt: number, extra: Partial<Version> = {}): Version => ({ id, kind: "auto", createdAt, size: state.length, ...extra });
      expect(await storage.versions.list("r1")).toEqual([]);
      expect(await storage.versions.get("r1", "v1")).toBeNull();
      await storage.versions.save("r1", v("v1", 1), state);
      await storage.versions.save("r1", v("v2", 2, { kind: "manual", name: "Draft ✓", createdBy: { id: "u1", name: "Zoë" } }), state);
      await storage.versions.save("r2", v("v3", 3), state);
      expect((await storage.versions.list("r1")).map((x) => x.id)).toEqual(["v2", "v1"]);
      const got = await storage.versions.get("r1", "v2");
      expect(got?.version).toEqual(v("v2", 2, { kind: "manual", name: "Draft ✓", createdBy: { id: "u1", name: "Zoë" } }));
      expect(text(got!.state)).toBe("version one");
      expect(await storage.versions.get("r1", "v3")).toBeNull();
      await storage.versions.delete("r1", "v1");
      expect((await storage.versions.list("r1")).map((x) => x.id)).toEqual(["v2"]);
      expect((await storage.versions.list("r2")).map((x) => x.id)).toEqual(["v3"]);
    });

    it("keeps save order for versions and threads made in the same millisecond", async () => {
      const storage = await create();
      const state = Y.encodeStateAsUpdate(build("x").doc);
      for (const id of ["v_b", "v_a", "v_c"]) await storage.versions.save("r", { id, kind: "manual", createdAt: 5, size: state.length }, state);
      expect((await storage.versions.list("r")).map((v) => v.id)).toEqual(["v_c", "v_a", "v_b"]);
      const thread = (id: string): Thread => ({ id, resolved: false, createdBy: "u", createdAt: 5, updatedAt: 5, comments: [] });
      for (const id of ["t_b", "t_a", "t_c"]) await storage.threads.put("r", thread(id));
      await storage.threads.put("r", { ...thread("t_b"), resolved: true }); // an update keeps its place
      expect((await storage.threads.list("r")).map((t) => t.id)).toEqual(["t_b", "t_a", "t_c"]);
    });

    it("stores large versions", async () => {
      const storage = await create();
      const { doc } = build("y".repeat(300 * 1024));
      const state = Y.encodeStateAsUpdate(doc);
      await storage.versions.save("big", { id: "v1", kind: "auto", createdAt: 1, size: state.length }, state);
      expect(text((await storage.versions.get("big", "v1"))!.state).length).toBe(300 * 1024);
    });

    it("stores large documents", async () => {
      const storage = await create();
      const { doc } = build("x".repeat(512 * 1024));
      await storage.compact("big", Y.encodeStateAsUpdate(doc));
      expect(text(await storage.loadDocument("big")).length).toBe(512 * 1024);
    });
  });
}
