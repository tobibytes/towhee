import { signWebhook } from "@towhee/auth";
import type { Notification } from "@towhee/protocol";

export interface WebhookTarget {
  url: string;
  /** At least 32 characters; apps check signatures with `verifyWebhook` from `@towhee/auth`. */
  secret: string;
}

/** What Towhee POSTs to the app's webhook URL. */
export interface WebhookPayload {
  type: "notification";
  userId: string;
  /** Room pattern of the key the user's app signs with. */
  scope: string;
  notification: Notification;
}

export interface SendOptions {
  fetch?: typeof fetch;
  /** Waits before each retry. Default 1, 5 and 25 seconds. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * POSTs a signed webhook. Retries on network errors, 5xx, 408 and 429; gives up on other 4xx,
 * which won't get better by retrying. Each attempt is signed with a fresh timestamp. Resolves to
 * whether the app accepted it.
 */
export async function sendWebhook(target: WebhookTarget, payload: WebhookPayload, options: SendOptions = {}): Promise<boolean> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const delays = options.retryDelaysMs ?? [1000, 5000, 25_000];
  const sleep = options.sleep ?? sleepFor;
  const now = options.now ?? Date.now;
  const body = JSON.stringify(payload);
  for (let attempt = 0; ; attempt++) {
    const timestamp = Math.floor(now() / 1000);
    try {
      const res = await doFetch(target.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "towhee",
          "x-towhee-timestamp": String(timestamp),
          "x-towhee-signature": await signWebhook(target.secret, timestamp, body),
        },
        body,
      });
      if (res.ok) return true;
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      if (!retryable) return false;
    } catch {
      // Network error: retry.
    }
    if (attempt >= delays.length) return false;
    await sleep(delays[attempt]!);
  }
}
