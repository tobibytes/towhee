import type { Thread } from "@towhee/protocol";
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
}

/** Calls for one room's threads never overlap: the room makes one thread change at a time. */
export interface ThreadStore {
  /** Every thread in the room, oldest first. */
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
    return [...(this.rooms.get(room)?.values() ?? [])].map((t) => structuredClone(t)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
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
