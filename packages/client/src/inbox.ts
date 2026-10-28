import { isNotification, type Notification } from "@towhee/protocol";
import type { RoomConnection } from "./client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface InboxState {
  /** Newest first. */
  notifications: Notification[];
  unread: number;
}

/**
 * The signed-in user's notifications (`client.inbox`). Kept current from the server's events and
 * refetched after every (re)connect; `subscribe` to show them. Read state follows across tabs.
 */
export class Inbox {
  private notifications: Notification[] = [];
  private unreadCount = 0;
  private loaded = false;
  private limit = 50;
  private readonly listeners = new Set<(state: InboxState) => void>();

  /** The inbox's own connection: `status`, `lastError`, and `on("status")` work as for rooms. */
  constructor(readonly connection: RoomConnection) {
    connection.on("event", (event) => {
      if (!isRecord(event.data)) return;
      if (event.name === "notification.created" && isNotification(event.data.notification)) {
        const n = event.data.notification;
        if (this.notifications.some((x) => x.id === n.id)) return;
        this.notifications = [n, ...this.notifications].slice(0, this.limit);
        if (n.readAt === undefined) this.unreadCount++;
        this.changed();
      } else if (event.name === "notification.read" && Array.isArray(event.data.ids) && typeof event.data.readAt === "number") {
        const ids = new Set(event.data.ids);
        const readAt = event.data.readAt;
        this.notifications = this.notifications.map((n) => (ids.has(n.id) && n.readAt === undefined ? { ...n, readAt } : n));
        this.unreadCount = Math.max(0, this.unreadCount - ids.size);
        this.changed();
      }
    });
    connection.on("status", (status) => status === "connected" && void this.refresh().catch(() => {}));
  }

  get ready(): boolean {
    return this.loaded;
  }

  list(): Notification[] {
    return [...this.notifications];
  }

  /** Unread notifications, counting ones older than the loaded list. */
  get unread(): number {
    return this.unreadCount;
  }

  subscribe(listener: (state: InboxState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fetches the newest `limit` (default 50, at most 200) notifications. Runs on its own after each connect. */
  async refresh(limit = this.limit): Promise<InboxState> {
    const result = (await this.connection.request("inbox.list", { limit })) as { notifications?: unknown; unread?: unknown };
    this.limit = limit;
    this.notifications = Array.isArray(result?.notifications) ? result.notifications.filter(isNotification) : [];
    this.unreadCount = typeof result?.unread === "number" ? result.unread : 0;
    this.loaded = true;
    this.changed();
    return this.state();
  }

  async markRead(ids: readonly string[]): Promise<void> {
    await this.connection.request("inbox.markRead", { ids });
  }

  async markAllRead(): Promise<void> {
    await this.connection.request("inbox.markRead", { all: true });
  }

  /** Disconnects the inbox. `client.inbox` opens a new one. */
  close(): void {
    this.connection.leave();
  }

  private state(): InboxState {
    return { notifications: this.list(), unread: this.unreadCount };
  }

  private changed(): void {
    const state = this.state();
    for (const listener of [...this.listeners]) listener(state);
  }
}
