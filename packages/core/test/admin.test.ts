import { describe, expect, it, vi } from "vitest";
import { type AdminOps, handleAdmin } from "../src";

const secret = "a".repeat(32);
const ops = (over: Partial<AdminOps> = {}): AdminOps => ({
  info: vi.fn(async (room) => (room === "doc:1" ? { room, connections: 2, users: [], documentBytes: 10, threads: 1, versions: 0 } : null)),
  export: vi.fn(async (room) => (room === "doc:1" ? { room, exportedAt: 1, document: new Uint8Array([1, 2, 255]), threads: [], versions: [] } : null)),
  delete: vi.fn(async (room) => room === "doc:1"),
  kick: vi.fn(async () => 2),
  ...over,
});
const call = (path: string, init: RequestInit & { auth?: string | null } = {}, o = ops(), s: string | undefined = secret) => {
  const headers = new Headers(init.headers);
  if (init.auth !== null) headers.set("authorization", `Bearer ${init.auth ?? secret}`);
  return handleAdmin(new Request(`http://t${path}`, { ...init, headers }), s, o);
};

describe("admin API", () => {
  it("doesn't exist without a secret, and refuses short ones", async () => {
    expect((await call("/v1/admin/rooms/doc:1", {}, ops(), "")).status).toBe(404);
    expect((await call("/v1/admin/rooms/doc:1", {}, ops(), "short")).status).toBe(500);
  });

  it("needs the bearer secret", async () => {
    expect((await call("/v1/admin/rooms/doc:1", { auth: null })).status).toBe(401);
    expect((await call("/v1/admin/rooms/doc:1", { auth: "b".repeat(32) })).status).toBe(401);
    expect((await call("/v1/admin/rooms/doc:1", { auth: secret.slice(1) })).status).toBe(401);
  });

  it("reports, exports, deletes and kicks", async () => {
    const o = ops();
    expect(await (await call("/v1/admin/rooms/doc%3A1", {}, o)).json()).toMatchObject({ room: "doc:1", connections: 2 });
    expect(await (await call("/v1/admin/rooms/doc:1/export", {}, o)).json()).toMatchObject({ document: "AQL/" });
    expect(await (await call("/v1/admin/rooms/doc:1", { method: "DELETE" }, o)).json()).toEqual({ deleted: true });
    const kicked = await call("/v1/admin/rooms/doc:1/kick", { method: "POST", body: JSON.stringify({ userId: "bob" }) }, o);
    expect(await kicked.json()).toEqual({ closed: 2 });
    expect(o.kick).toHaveBeenCalledWith("doc:1", "bob");
  });

  it("lists rooms a page at a time, and says when a host can't", async () => {
    const all = ["a:1", "a:2", "b:1"];
    const o = ops({ list: vi.fn(async ({ prefix, after, limit }) => all.filter((r) => r.startsWith(prefix) && r > after).slice(0, limit)) });
    expect(await (await call("/v1/admin/rooms?limit=2", {}, o)).json()).toEqual({ rooms: ["a:1", "a:2"], cursor: "a:2" });
    expect(await (await call("/v1/admin/rooms?limit=2&cursor=a:2", {}, o)).json()).toEqual({ rooms: ["b:1"] });
    expect(await (await call("/v1/admin/rooms?prefix=a:", {}, o)).json()).toEqual({ rooms: ["a:1", "a:2"] });
    expect((await call("/v1/admin/rooms?limit=0", {}, o)).status).toBe(400);
    expect((await call("/v1/admin/rooms", {}, ops())).status).toBe(501);
    expect((await call("/v1/admin/rooms", { auth: null }, o)).status).toBe(401);
  });

  it("404s missing rooms and refuses bad input", async () => {
    expect((await call("/v1/admin/rooms/doc:2")).status).toBe(404);
    expect((await call("/v1/admin/rooms/doc:2/export")).status).toBe(404);
    expect((await call("/v1/admin/rooms/doc:2", { method: "DELETE" })).status).toBe(404);
    expect((await call("/v1/admin/rooms/towhee.inbox")).status).toBe(400);
    expect((await call("/v1/admin/rooms/%E0%A4%A")).status).toBe(400);
    expect((await call("/v1/admin/rooms/doc:1/kick", { method: "POST", body: "nope" })).status).toBe(400);
    expect((await call("/v1/admin/rooms/doc:1/kick", { method: "POST", body: "{}" })).status).toBe(400);
    expect((await call("/v1/admin/rooms/doc:1", { method: "PUT" })).status).toBe(405);
    expect((await call("/v1/admin/other")).status).toBe(404);
  });
});
