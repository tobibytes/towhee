import type { ConnectionState, InboxStore, Storage, ThreadStore, VersionStore } from "@towhee/core";
import type { Notification, Thread, Version } from "@towhee/protocol";
import * as Y from "yjs";

/**
 * Durable Object SQLite caps a row at 2 MB, and documents can be bigger (the default limit is 50 MB),
 * so the compacted state is stored in chunks.
 */
export const STATE_CHUNK_BYTES = 1024 * 1024;

const toBytes = (value: unknown) => new Uint8Array(value as ArrayBuffer);
/** SQL binds blobs as ArrayBuffers; slice() gives an exact-length copy with its own buffer. */
const toBlob = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

/**
 * Room storage in a Durable Object's SQLite database. Each room is its own Durable Object, but the
 * tables still key by room so the shared storage suite (and any later sharing) works unchanged.
 * Tables are prefixed `towhee_` so they don't clash with anything else in the object.
 */
export class DurableObjectSqlStorage implements Storage {
  private readonly sql: SqlStorage;
  readonly threads: ThreadStore;
  readonly versions: VersionStore;
  readonly inbox: InboxStore;

  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS towhee_state (room TEXT NOT NULL, chunk INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (room, chunk));
      CREATE TABLE IF NOT EXISTS towhee_updates (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, data BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS towhee_updates_by_room ON towhee_updates (room, id);
      CREATE TABLE IF NOT EXISTS towhee_connections (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS towhee_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS towhee_threads (room TEXT NOT NULL, id TEXT NOT NULL, created_at REAL NOT NULL, data TEXT NOT NULL, PRIMARY KEY (room, id));
      CREATE TABLE IF NOT EXISTS towhee_versions (room TEXT NOT NULL, id TEXT NOT NULL, created_at REAL NOT NULL, info TEXT NOT NULL, PRIMARY KEY (room, id));
      CREATE TABLE IF NOT EXISTS towhee_version_chunks (room TEXT NOT NULL, id TEXT NOT NULL, chunk INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (room, id, chunk));
      CREATE TABLE IF NOT EXISTS towhee_notifications (scope TEXT NOT NULL, user_id TEXT NOT NULL, id TEXT NOT NULL, created_at REAL NOT NULL, read_at REAL, data TEXT NOT NULL, PRIMARY KEY (scope, user_id, id));
      CREATE INDEX IF NOT EXISTS towhee_notifications_by_user ON towhee_notifications (scope, user_id, created_at);
    `);
    this.inbox = new SqlInboxStore(this.sql);
    this.threads = new SqlThreadStore(this.sql);
    this.versions = new SqlVersionStore(this.sql, storage);
  }

  async loadDocument(room: string): Promise<Uint8Array | null> {
    const chunks = this.sql.exec("SELECT data FROM towhee_state WHERE room = ? ORDER BY chunk", room).toArray().map((r) => toBytes(r.data));
    const log = this.sql.exec("SELECT data FROM towhee_updates WHERE room = ? ORDER BY id", room).toArray().map((r) => toBytes(r.data));
    const parts = chunks.length > 0 ? [concat(chunks), ...log] : log;
    return parts.length === 0 ? null : Y.mergeUpdates(parts);
  }

  async appendUpdate(room: string, update: Uint8Array): Promise<void> {
    this.sql.exec("INSERT INTO towhee_updates (room, data) VALUES (?, ?)", room, toBlob(update));
  }

  async compact(room: string, state: Uint8Array): Promise<void> {
    this.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM towhee_state WHERE room = ?", room);
      for (let offset = 0, chunk = 0; offset < state.length || chunk === 0; offset += STATE_CHUNK_BYTES, chunk++) {
        this.sql.exec("INSERT INTO towhee_state (room, chunk, data) VALUES (?, ?, ?)", room, chunk, toBlob(state.subarray(offset, offset + STATE_CHUNK_BYTES)));
      }
      this.sql.exec("DELETE FROM towhee_updates WHERE room = ?", room);
    });
  }

  /* Hibernation: connection states and the room id ------------------------------------------- */

  getConnection(id: string): ConnectionState | undefined {
    const row = this.sql.exec("SELECT state FROM towhee_connections WHERE id = ?", id).toArray()[0];
    return row ? (JSON.parse(row.state as string) as ConnectionState) : undefined;
  }

  putConnection(state: ConnectionState): void {
    this.sql.exec(
      "INSERT INTO towhee_connections (id, state) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state",
      state.id,
      JSON.stringify(state),
    );
  }

  deleteConnection(id: string): void {
    this.sql.exec("DELETE FROM towhee_connections WHERE id = ?", id);
  }

  /** Drops connection states whose sockets are gone (closed while nothing was listening). */
  pruneConnections(keep: ReadonlySet<string>): void {
    for (const row of this.sql.exec("SELECT id FROM towhee_connections").toArray()) {
      if (!keep.has(row.id as string)) this.deleteConnection(row.id as string);
    }
  }

  getMeta(key: string): string | undefined {
    return this.sql.exec("SELECT value FROM towhee_meta WHERE key = ?", key).toArray()[0]?.value as string | undefined;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec("INSERT INTO towhee_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }
}

/** Notifications as JSON, with the read time in its own column. */
class SqlInboxStore implements InboxStore {
  constructor(private readonly sql: SqlStorage) {}

  async add(scope: string, userId: string, n: Notification): Promise<void> {
    const { readAt, ...rest } = n;
    this.sql.exec(
      "INSERT OR IGNORE INTO towhee_notifications (scope, user_id, id, created_at, read_at, data) VALUES (?, ?, ?, ?, ?, ?)",
      scope,
      userId,
      n.id,
      n.createdAt,
      readAt ?? null,
      JSON.stringify(rest),
    );
  }

  async list(scope: string, userId: string, limit: number): Promise<Notification[]> {
    return this.sql
      .exec("SELECT data, read_at FROM towhee_notifications WHERE scope = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?", scope, userId, limit)
      .toArray()
      .map((r) => ({ ...(JSON.parse(r.data as string) as Notification), ...(r.read_at === null ? {} : { readAt: r.read_at as number }) }));
  }

  async unreadCount(scope: string, userId: string): Promise<number> {
    return Number(this.sql.exec("SELECT count(*) AS n FROM towhee_notifications WHERE scope = ? AND user_id = ? AND read_at IS NULL", scope, userId).one().n);
  }

  async markRead(scope: string, userId: string, ids: readonly string[] | "all", at: number): Promise<string[]> {
    const unread = this.sql
      .exec("SELECT id FROM towhee_notifications WHERE scope = ? AND user_id = ? AND read_at IS NULL", scope, userId)
      .toArray()
      .map((r) => r.id as string);
    const changed = ids === "all" ? unread : unread.filter((id) => ids.includes(id));
    for (const id of changed) this.sql.exec("UPDATE towhee_notifications SET read_at = ? WHERE scope = ? AND user_id = ? AND id = ?", at, scope, userId, id);
    return changed;
  }

  async prune(scope: string, userId: string, keep: number): Promise<void> {
    this.sql.exec(
      `DELETE FROM towhee_notifications WHERE scope = ? AND user_id = ? AND rowid NOT IN (
         SELECT rowid FROM towhee_notifications WHERE scope = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      scope,
      userId,
      scope,
      userId,
      keep,
    );
  }
}

/** Versions: the description in one table, the state in 1 MB chunks in another. */
class SqlVersionStore implements VersionStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly storage: DurableObjectStorage,
  ) {}

  async save(room: string, version: Version, state: Uint8Array): Promise<void> {
    this.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM towhee_version_chunks WHERE room = ? AND id = ?", room, version.id);
      this.sql.exec(
        "INSERT INTO towhee_versions (room, id, created_at, info) VALUES (?, ?, ?, ?) ON CONFLICT (room, id) DO UPDATE SET info = excluded.info",
        room,
        version.id,
        version.createdAt,
        JSON.stringify(version),
      );
      for (let offset = 0, chunk = 0; offset < state.length || chunk === 0; offset += STATE_CHUNK_BYTES, chunk++) {
        this.sql.exec(
          "INSERT INTO towhee_version_chunks (room, id, chunk, data) VALUES (?, ?, ?, ?)",
          room,
          version.id,
          chunk,
          toBlob(state.subarray(offset, offset + STATE_CHUNK_BYTES)),
        );
      }
    });
  }

  async list(room: string): Promise<Version[]> {
    return this.sql
      .exec("SELECT info FROM towhee_versions WHERE room = ? ORDER BY created_at DESC, rowid DESC", room)
      .toArray()
      .map((r) => JSON.parse(r.info as string) as Version);
  }

  async get(room: string, id: string): Promise<{ version: Version; state: Uint8Array } | null> {
    const row = this.sql.exec("SELECT info FROM towhee_versions WHERE room = ? AND id = ?", room, id).toArray()[0];
    if (!row) return null;
    const chunks = this.sql
      .exec("SELECT data FROM towhee_version_chunks WHERE room = ? AND id = ? ORDER BY chunk", room, id)
      .toArray()
      .map((r) => toBytes(r.data));
    return { version: JSON.parse(row.info as string) as Version, state: concat(chunks) };
  }

  async delete(room: string, id: string): Promise<void> {
    this.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM towhee_versions WHERE room = ? AND id = ?", room, id);
      this.sql.exec("DELETE FROM towhee_version_chunks WHERE room = ? AND id = ?", room, id);
    });
  }
}

/** Threads as JSON rows. Comment limits keep a thread well under the 2 MB row cap. */
class SqlThreadStore implements ThreadStore {
  constructor(private readonly sql: SqlStorage) {}

  async list(room: string): Promise<Thread[]> {
    return this.sql
      .exec("SELECT data FROM towhee_threads WHERE room = ? ORDER BY created_at, rowid", room)
      .toArray()
      .map((r) => JSON.parse(r.data as string) as Thread);
  }

  async get(room: string, id: string): Promise<Thread | null> {
    const row = this.sql.exec("SELECT data FROM towhee_threads WHERE room = ? AND id = ?", room, id).toArray()[0];
    return row ? (JSON.parse(row.data as string) as Thread) : null;
  }

  async put(room: string, thread: Thread): Promise<void> {
    this.sql.exec(
      "INSERT INTO towhee_threads (room, id, created_at, data) VALUES (?, ?, ?, ?) ON CONFLICT (room, id) DO UPDATE SET data = excluded.data",
      room,
      thread.id,
      thread.createdAt,
      JSON.stringify(thread),
    );
  }

  async delete(room: string, id: string): Promise<void> {
    this.sql.exec("DELETE FROM towhee_threads WHERE room = ? AND id = ?", room, id);
  }

  async count(room: string): Promise<number> {
    return Number(this.sql.exec("SELECT count(*) AS n FROM towhee_threads WHERE room = ?", room).one().n);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
