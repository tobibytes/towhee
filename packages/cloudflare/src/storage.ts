import type { ConnectionState, Storage, ThreadStore } from "@towhee/core";
import type { Thread } from "@towhee/protocol";
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

  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS towhee_state (room TEXT NOT NULL, chunk INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (room, chunk));
      CREATE TABLE IF NOT EXISTS towhee_updates (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, data BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS towhee_updates_by_room ON towhee_updates (room, id);
      CREATE TABLE IF NOT EXISTS towhee_connections (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS towhee_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS towhee_threads (room TEXT NOT NULL, id TEXT NOT NULL, created_at REAL NOT NULL, data TEXT NOT NULL, PRIMARY KEY (room, id));
    `);
    this.threads = new SqlThreadStore(this.sql);
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

/** Threads as JSON rows. Comment limits keep a thread well under the 2 MB row cap. */
class SqlThreadStore implements ThreadStore {
  constructor(private readonly sql: SqlStorage) {}

  async list(room: string): Promise<Thread[]> {
    return this.sql
      .exec("SELECT data FROM towhee_threads WHERE room = ? ORDER BY created_at, id", room)
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
