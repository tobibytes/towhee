import { createRoomToken, type RoomKey, type RoomTokenInput } from "@towhee/auth";
import { createClient, type RoomConnection, type SocketLike } from "@towhee/client";
import { exports } from "cloudflare:workers";

export const key: RoomKey = { id: "default", secret: "cloudflare-test-key-not-a-secret-0000" };

/** Opens a WebSocket on the Worker under test, shaped like the browser WebSocket the client expects. */
export class WorkerSocket implements SocketLike {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  private ws?: WebSocket;

  constructor(url: string) {
    void exports.default.fetch(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } }).then((res) => {
      const ws = res.webSocket;
      if (!ws) {
        this.readyState = 3;
        this.onclose?.({ code: 1006 });
        return;
      }
      ws.accept();
      this.ws = ws;
      ws.addEventListener("message", (event) => this.onmessage?.({ data: event.data }));
      ws.addEventListener("close", (event) => {
        this.readyState = 3;
        this.onclose?.({ code: event.code, reason: event.reason });
      });
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: Uint8Array): void {
    this.ws?.send(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.ws?.close(code, reason);
  }
}

export function enter(input: Partial<RoomTokenInput> = {}, room = "doc:1"): RoomConnection {
  const client = createClient({
    url: "ws://towhee.test",
    authEndpoint: (r) => createRoomToken({ userId: "u", room: r, access: "write", ...input }, key),
    WebSocket: WorkerSocket,
    reconnect: { initialDelayMs: 20, maxDelayMs: 100 },
  });
  return client.enter(room);
}

export async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const text = (c: RoomConnection) => c.doc.getText("t").toString();
