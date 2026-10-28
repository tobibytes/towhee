import { describe, expect, it } from "vitest";
import { createInboxToken, type RoomKey, signWebhook, verifyRoomToken, verifyWebhook } from "../src";

const NOW = Date.UTC(2027, 0, 1);

describe("createInboxToken", () => {
  it("is a read token for the key's reserved inbox room", async () => {
    const all: RoomKey = { id: "all", secret: "a".repeat(32) };
    const talvra: RoomKey = { id: "talvra", secret: "t".repeat(32), rooms: "talvra:*" };
    expect(await verifyRoomToken(await createInboxToken({ userId: "u1" }, all, { now: NOW }), all, { now: NOW })).toMatchObject({
      room: "towhee.inbox",
      access: "read",
      userId: "u1",
    });
    expect((await verifyRoomToken(await createInboxToken({ userId: "u1" }, talvra, { now: NOW }), talvra, { now: NOW })).room).toBe(
      "talvra:towhee.inbox",
    );
    expect(() => createInboxToken({ userId: "u1" }, { id: "one", secret: "o".repeat(32), rooms: "doc:1" })).toThrow(TypeError);
  });
});

describe("webhooks", () => {
  const secret = "w".repeat(32);
  const body = JSON.stringify({ type: "notification", note: "héllo" });

  it("verify what was signed, within the time window", async () => {
    const ts = Math.floor(NOW / 1000);
    const signature = await signWebhook(secret, ts, body);
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(await verifyWebhook(secret, { body, timestamp: String(ts), signature }, { now: NOW })).toBe(true);
    expect(await verifyWebhook(secret, { body, timestamp: String(ts), signature }, { now: NOW + 299_000 })).toBe(true);
    expect(await verifyWebhook(secret, { body, timestamp: String(ts), signature }, { now: NOW + 301_000 })).toBe(false);
  });

  it("reject anything altered or malformed", async () => {
    const ts = String(Math.floor(NOW / 1000));
    const signature = await signWebhook(secret, Number(ts), body);
    const opts = { now: NOW };
    expect(await verifyWebhook(secret, { body: `${body} `, timestamp: ts, signature }, opts)).toBe(false);
    expect(await verifyWebhook(secret, { body, timestamp: String(Number(ts) + 1), signature }, opts)).toBe(false);
    expect(await verifyWebhook("x".repeat(32), { body, timestamp: ts, signature }, opts)).toBe(false);
    expect(await verifyWebhook(secret, { body, timestamp: ts, signature: signature.replace("v1=", "v2=") }, opts)).toBe(false);
    expect(await verifyWebhook(secret, { body, timestamp: ts, signature: "v1=zz" }, opts)).toBe(false);
    expect(await verifyWebhook(secret, { body, timestamp: null, signature }, opts)).toBe(false);
    expect(await verifyWebhook(secret, { body, timestamp: "12abc", signature }, opts)).toBe(false);
    await expect(signWebhook("short", 1, body)).rejects.toThrow(TypeError);
  });
});
