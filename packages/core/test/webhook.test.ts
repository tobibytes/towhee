import { verifyWebhook } from "@towhee/auth";
import { describe, expect, it } from "vitest";
import { sendWebhook, type WebhookPayload } from "../src";

const target = { url: "https://app.example/hooks/towhee", secret: "s".repeat(32) };
const payload: WebhookPayload = {
  type: "notification",
  userId: "ada",
  scope: "*",
  notification: { id: "n1", kind: "mention", room: "doc:1", threadId: "t", commentId: "c", actor: { id: "bob" }, excerpt: "hi", createdAt: 1 },
};

function fakeFetch(statuses: (number | "network")[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const status = statuses[calls.length - 1] ?? 200;
    if (status === "network") throw new TypeError("fetch failed");
    return new Response(null, { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("sendWebhook", () => {
  it("POSTs a body the app can verify", async () => {
    const { fetch, calls } = fakeFetch([200]);
    expect(await sendWebhook(target, payload, { fetch })).toBe(true);
    const { url, init } = calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(url).toBe(target.url);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(payload);
    expect(
      await verifyWebhook(target.secret, { body: init.body as string, timestamp: headers["x-towhee-timestamp"]!, signature: headers["x-towhee-signature"]! }),
    ).toBe(true);
  });

  it("retries server errors and network failures, then gives up", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const flaky = fakeFetch(["network", 503, 200]);
    expect(await sendWebhook(target, payload, { fetch: flaky.fetch, sleep })).toBe(true);
    expect(waits).toEqual([1000, 5000]);
    const down = fakeFetch([500, 502, 503, 504, 500]);
    waits.length = 0;
    expect(await sendWebhook(target, payload, { fetch: down.fetch, sleep })).toBe(false);
    expect(down.calls).toHaveLength(4);
    expect(waits).toEqual([1000, 5000, 25_000]);
  });

  it("doesn't retry requests the app rejected", async () => {
    const rejected = fakeFetch([401]);
    expect(await sendWebhook(target, payload, { fetch: rejected.fetch, sleep: async () => {} })).toBe(false);
    expect(rejected.calls).toHaveLength(1);
    const busy = fakeFetch([429, 200]);
    expect(await sendWebhook(target, payload, { fetch: busy.fetch, sleep: async () => {} })).toBe(true);
  });
});
