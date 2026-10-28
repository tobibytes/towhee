import type { Version } from "@towhee/protocol";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { MemoryStorage } from "../src";
import { type Setup, setup, type TestClient } from "./harness";

let current: Setup | undefined;
async function start(options: Parameters<typeof setup>[0] = {}) {
  current = await setup(options);
  return current;
}
afterEach(async () => {
  await current?.teardown();
  current = undefined;
});

const write = (c: TestClient, value: string) => c.doc.getText("t").insert(c.doc.getText("t").length, value);
async function versions(c: TestClient): Promise<Version[]> {
  const res = await c.request("history.list");
  if (!res.ok) throw new Error(res.error.message);
  return (res.result as { versions: Version[] }).versions;
}
function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

describe("versions", () => {
  it("are saved by hand with write access, and shared as events", async () => {
    const s = await start();
    const ada = await s.join({ userId: "ada", user: { name: "Ada" } });
    const bob = await s.join({ userId: "bob", access: "comment" });
    write(ada, "draft one");
    await s.settle();
    const res = await ada.request("history.save", { name: "First draft" });
    expect(res.ok).toBe(true);
    const version = (res as unknown as { result: { version: Version } }).result.version;
    expect(version).toMatchObject({ kind: "manual", name: "First draft", createdBy: { id: "ada", name: "Ada" }, createdAt: s.time.current });
    expect(bob.events("version.saved")).toEqual([{ version }]);
    expect(await versions(bob)).toEqual([version]);

    const saved = await bob.request("history.get", { versionId: version.id });
    if (!saved.ok) throw new Error(saved.error.message);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, decode((saved.result as { state: string }).state));
    expect(doc.getText("t").toString()).toBe("draft one");

    const refused = await bob.request("history.save", {});
    expect(refused.ok ? null : refused.error.code).toBe("forbidden");
  });

  it("are saved automatically after a stretch of editing, and when everyone leaves", async () => {
    const s = await start({ limits: { autoVersionEveryMs: 60_000 } });
    const a = await s.join();
    write(a, "a");
    await s.settle();
    expect(await versions(a)).toEqual([]);
    s.time.advance(60_000);
    write(a, "b");
    await s.settle();
    const first = await versions(a);
    expect(first.map((v) => v.kind)).toEqual(["auto"]);
    expect(a.events("version.saved")).toHaveLength(1);

    s.time.advance(10_000);
    write(a, "c"); // within the interval: no new version yet
    await s.settle();
    expect(await versions(a)).toHaveLength(1);
    a.disconnect(); // the room empties with unsaved changes
    await s.settle();
    const all = await s.storage.versions.list(s.room.id);
    expect(all.map((v) => v.kind)).toEqual(["auto", "auto"]);
    const latest = await s.storage.versions.get(s.room.id, all[0]!.id);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, latest!.state);
    expect(doc.getText("t").toString()).toBe("abc");
  });

  it("don't pile up: old automatic versions are deleted, saved ones kept", async () => {
    const s = await start({ limits: { autoVersionEveryMs: 1000, keepAutoVersions: 2 } });
    const a = await s.join();
    write(a, "x");
    await s.settle();
    await a.request("history.save", { name: "keep me" });
    for (let i = 0; i < 4; i++) {
      s.time.advance(1000);
      write(a, String(i));
      await s.settle();
    }
    const kinds = (await versions(a)).map((v) => v.kind);
    expect(kinds.filter((k) => k === "auto")).toHaveLength(2);
    expect(kinds).toContain("manual");
  });

  it("record restores and check their arguments", async () => {
    const s = await start();
    const a = await s.join();
    write(a, "v1");
    await s.settle();
    const v1 = ((await a.request("history.save", {})) as unknown as { result: { version: Version } }).result.version;
    const restore = await a.request("history.save", { restoredFrom: v1.id, name: "Back to v1" });
    expect(restore.ok && (restore.result as { version: Version }).version).toMatchObject({ kind: "restore", restoredFrom: v1.id });
    const bad: [string, unknown][] = [
      ["history.save", { name: "" }],
      ["history.save", { name: "x".repeat(201) }],
      ["history.save", { restoredFrom: "../x" }],
      ["history.get", { versionId: 5 }],
      ["history.get", "nope"],
    ];
    for (const [method, params] of bad) {
      const res = await a.request(method, params);
      expect(res.ok ? null : res.error.code, JSON.stringify(params)).toBe("protocol_error");
    }
    const missing = await a.request("history.get", { versionId: "v_missing" });
    expect(missing.ok ? null : missing.error.code).toBe("not_found");
    const gone = await a.request("history.save", { restoredFrom: "v_missing" });
    expect(gone.ok ? null : gone.error.code).toBe("not_found");
    expect(a.closed).toBeUndefined();
  });

  it("start the automatic clock from the last saved version after a reload", async () => {
    const storage = new MemoryStorage();
    const s = await start({ storage, limits: { autoVersionEveryMs: 60_000 } });
    const a = await s.join();
    write(a, "a");
    await s.settle();
    await a.request("history.save", {});
    await s.teardown();
    current = undefined;
    const again = await start({ storage, limits: { autoVersionEveryMs: 60_000 } });
    const b = await again.join();
    write(b, "b"); // the reloaded room's clock starts at the saved version, not at load
    await again.settle();
    expect((await versions(b)).map((v) => v.kind)).toEqual(["manual"]);
  });
});
