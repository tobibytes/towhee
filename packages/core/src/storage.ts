import type { Notification, Thread, Version } from "@towhee/protocol";
import * as Y from "yjs";

/**
 * Where rooms keep their documents. A document is stored as a compacted state plus a log of
 * updates appended since. Every implementation must pass the shared suite in `@towhee/core/testing`.
 *
 * Calls for one room never overlap: a room waits for each call to finish before making the next.
 */
export interface Storage {
  /** The document as one Yjs update (state and log merged), or null if the room has never been saved. */
  loadDocument(room: string): Promise<Uint8Array | null>;
  /** Adds one update to the room's log. */
  appendUpdate(room: string, update: Uint8Array): Promise<void>;
  /** Replaces the stored state with `state` and drops every update appended before this call. */
  compact(room: string, state: Uint8Array): Promise<void>;
  /** Comment threads. Each thread is stored whole, comments included. */
  threads: ThreadStore;
  /** Saved versions of documents. */
  versions: VersionStore;
  /** Users' notifications. */
  inbox: InboxStore;
}

/**
 * Notifications per user. `scope` is the room pattern of the key the user's app signs with, so two
 * apps sharing a deployment keep their users apart even if ids collide.
 */
export interface InboxStore {
  add(scope: string, userId: string, notification: Notification): Promise<void>;
  /** Newest first, at most `limit`. */
  list(scope: string, userId: string, limit: number): Promise<Notification[]>;
  unreadCount(scope: string, userId: string): Promise<number>;
  /** Marks notifications read at `at`; returns the ids that were unread. */
  markRead(scope: string, userId: string, ids: readonly string[] | "all", at: number): Promise<string[]>;
  /** Keeps only the newest `keep` notifications. */
  prune(scope: string, userId: string, keep: number): Promise<void>;
}

export class MemoryInboxStore implements InboxStore {
  private readonly inboxes = new Map<string, Notification[]>();

  private inbox(scope: string, userId: string): Notification[] {
    const key = `${scope}\u0000${userId}`;
    let list = this.inboxes.get(key);
    if (!list) {
      list = [];
      this.inboxes.set(key, list);
    }
    return list;
  }

  async add(scope: string, userId: string, notification: Notification): Promise<void> {
    this.inbox(scope, userId).push(structuredClone(notification));
  }

  async list(scope: string, userId: string, limit: number): Promise<Notification[]> {
    return [...this.inbox(scope, userId)]
      .reverse()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((n) => structuredClone(n));
  }

  async unreadCount(scope: string, userId: string): Promise<number> {
    return this.inbox(scope, userId).filter((n) => n.readAt === undefined).length;
  }

  async markRead(scope: string, userId: string, ids: readonly string[] | "all", at: number): Promise<string[]> {
    const changed: string[] = [];
    for (const n of this.inbox(scope, userId)) {
      if (n.readAt === undefined && (ids === "all" || ids.includes(n.id))) {
        n.readAt = at;
        changed.push(n.id);
      }
    }
    return changed;
  }

  async prune(scope: string, userId: string, keep: number): Promise<void> {
    const list = this.inbox(scope, userId);
    const newest = new Set((await this.list(scope, userId, keep)).map((n) => n.id));
    const kept = list.filter((n) => newest.has(n.id));
    list.splice(0, list.length, ...kept);
  }
}

/** Versions of a room's document: a description plus the full state. */
export interface VersionStore {
  save(room: string, version: Version, state: Uint8Array): Promise<void>;
  /** Descriptions only, newest first (ties: last saved first). */
  list(room: string): Promise<Version[]>;
  get(room: string, id: string): Promise<{ version: Version; state: Uint8Array } | null>;
  delete(room: string, id: string): Promise<void>;
}

export class MemoryVersionStore implements VersionStore {
  private readonly rooms = new Map<string, Map<string, { version: Version; state: Uint8Array }>>();

  async save(room: string, version: Version, state: Uint8Array): Promise<void> {
    let versions = this.rooms.get(room);
    if (!versions) {
      versions = new Map();
      this.rooms.set(room, versions);
    }
    versions.set(version.id, { version: structuredClone(version), state: state.slice() });
  }

  async list(room: string): Promise<Version[]> {
    // Newest first; versions saved in the same millisecond, last saved first.
    return [...(this.rooms.get(room)?.values() ?? [])]
      .reverse()
      .map((v) => structuredClone(v.version))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(room: string, id: string): Promise<{ version: Version; state: Uint8Array } | null> {
    const saved = this.rooms.get(room)?.get(id);
    return saved ? { version: structuredClone(saved.version), state: saved.state.slice() } : null;
  }

  async delete(room: string, id: string): Promise<void> {
    this.rooms.get(room)?.delete(id);
  }
}

/** Calls for one room's threads never overlap: the room makes one thread change at a time. */
export interface ThreadStore {
  /** Every thread in the room, oldest first (ties in creation order). */
  list(room: string): Promise<Thread[]>;
  get(room: string, id: string): Promise<Thread | null>;
  /** Creates or replaces a thread. */
  put(room: string, thread: Thread): Promise<void>;
  delete(room: string, id: string): Promise<void>;
  count(room: string): Promise<number>;
}

/** Threads in memory. Stores copies, so callers can't change stored threads by accident. */
export class MemoryThreadStore implements ThreadStore {
  private readonly rooms = new Map<string, Map<string, Thread>>();

  async list(room: string): Promise<Thread[]> {
    // Stable sort over insertion order: threads created in the same millisecond stay in creation order.
    return [...(this.rooms.get(room)?.values() ?? [])].map((t) => structuredClone(t)).sort((a, b) => a.createdAt - b.createdAt);
  }

  async get(room: string, id: string): Promise<Thread | null> {
    const thread = this.rooms.get(room)?.get(id);
    return thread ? structuredClone(thread) : null;
  }

  async put(room: string, thread: Thread): Promise<void> {
    let threads = this.rooms.get(room);
    if (!threads) {
      threads = new Map();
      this.rooms.set(room, threads);
    }
    threads.set(thread.id, structuredClone(thread));
  }

  async delete(room: string, id: string): Promise<void> {
    this.rooms.get(room)?.delete(id);
  }

  async count(room: string): Promise<number> {
    return this.rooms.get(room)?.size ?? 0;
  }
}

/** Keeps documents in memory. For tests, and for trying Towhee without a database. */
export class MemoryStorage implements Storage {
  private readonly rooms = new Map<string, { state: Uint8Array | null; log: Uint8Array[] }>();
  readonly threads: ThreadStore = new MemoryThreadStore();
  readonly versions: VersionStore = new MemoryVersionStore();
  readonly inbox: InboxStore = new MemoryInboxStore();

  async loadDocument(room: string): Promise<Uint8Array | null> {
    const saved = this.rooms.get(room);
    if (!saved) return null;
    const parts = saved.state ? [saved.state, ...saved.log] : saved.log;
    return parts.length === 0 ? null : Y.mergeUpdates(parts);
  }

  async appendUpdate(room: string, update: Uint8Array): Promise<void> {
    const saved = this.rooms.get(room) ?? { state: null, log: [] };
    saved.log.push(update.slice());
    this.rooms.set(room, saved);
  }

  async compact(room: string, state: Uint8Array): Promise<void> {
    this.rooms.set(room, { state: state.slice(), log: [] });
  }

  /** Number of log entries since the last compaction, for tests. */
  logLength(room: string): number {
    return this.rooms.get(room)?.log.length ?? 0;
  }
}
