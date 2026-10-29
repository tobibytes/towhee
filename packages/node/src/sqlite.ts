import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { InboxStore, Storage, ThreadStore, VersionStore } from "@towhee/core";
import type { Notification, Thread, Version } from "@towhee/protocol";
import * as Y from "yjs";

/**
 * Room documents in a SQLite file, through Node's built-in `node:sqlite`. One compacted state per
 * room plus a log of updates since. WAL mode, so a crash loses at most the write in flight.
 */
export class SqliteStorage implements Storage {
  readonly db: DatabaseSync;
  readonly threads: ThreadStore;
  readonly versions: VersionStore;
  readonly inbox: InboxStore;
  private readonly statements: {
    state: StatementSync;
    log: StatementSync;
    append: StatementSync;
    upsertState: StatementSync;
    clearLog: StatementSync;
  };

  /** `path` is a file (its folder is created) or `:memory:`. */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS documents (room TEXT PRIMARY KEY, state BLOB NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, data BLOB NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS updates_by_room ON updates (room, id);
      CREATE TABLE IF NOT EXISTS threads (room TEXT NOT NULL, id TEXT NOT NULL, created_at REAL NOT NULL, data TEXT NOT NULL, PRIMARY KEY (room, id)) STRICT;
      CREATE TABLE IF NOT EXISTS versions (room TEXT NOT NULL, id TEXT NOT NULL, created_at REAL NOT NULL, info TEXT NOT NULL, state BLOB NOT NULL, PRIMARY KEY (room, id)) STRICT;
      CREATE TABLE IF NOT EXISTS notifications (scope TEXT NOT NULL, user_id TEXT NOT NULL, id TEXT NOT NULL, created_at REAL NOT NULL, read_at REAL, data TEXT NOT NULL, PRIMARY KEY (scope, user_id, id)) STRICT;
      CREATE INDEX IF NOT EXISTS notifications_by_user ON notifications (scope, user_id, created_at);
    `);
    this.inbox = new SqliteInboxStore(this.db);
    this.threads = new SqliteThreadStore(this.db);
    this.versions = new SqliteVersionStore(this.db);
    this.statements = {
      state: this.db.prepare("SELECT state FROM documents WHERE room = ?"),
      log: this.db.prepare("SELECT data FROM updates WHERE room = ? ORDER BY id"),
      append: this.db.prepare("INSERT INTO updates (room, data) VALUES (?, ?)"),
      upsertState: this.db.prepare("INSERT INTO documents (room, state) VALUES (?, ?) ON CONFLICT (room) DO UPDATE SET state = excluded.state"),
      clearLog: this.db.prepare("DELETE FROM updates WHERE room = ?"),
    };
  }

  async loadDocument(room: string): Promise<Uint8Array | null> {
    const state = this.statements.state.get(room) as { state: Uint8Array } | undefined;
    const log = (this.statements.log.all(room) as { data: Uint8Array }[]).map((row) => row.data);
    const parts = state ? [state.state, ...log] : log;
    return parts.length === 0 ? null : Y.mergeUpdates(parts);
  }

  async appendUpdate(room: string, update: Uint8Array): Promise<void> {
    this.statements.append.run(room, update);
  }

  async listRooms({ prefix = "", after = "", limit }: { prefix?: string; after?: string; limit: number }): Promise<string[]> {
    const rows = this.db
      .prepare(
        `SELECT room FROM (SELECT room FROM documents UNION SELECT room FROM updates UNION SELECT room FROM threads UNION SELECT room FROM versions)
         WHERE substr(room, 1, ?) = ? AND room > ? ORDER BY room LIMIT ?`,
      )
      .all(prefix.length, prefix, after, limit) as { room: string }[];
    return rows.map((r) => r.room);
  }

  async deleteRoom(room: string): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["documents", "updates", "threads", "versions"]) this.db.prepare(`DELETE FROM ${table} WHERE room = ?`).run(room);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async compact(room: string, state: Uint8Array): Promise<void> {
    // One transaction: a crash leaves either the old state and log or the new state, never neither.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.statements.upsertState.run(room, state);
      this.statements.clearLog.run(room);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Notifications as JSON, with the read time in its own column. */
class SqliteInboxStore implements InboxStore {
  constructor(private readonly db: DatabaseSync) {}

  async add(scope: string, userId: string, n: Notification): Promise<void> {
    const { readAt, ...rest } = n;
    this.db
      .prepare("INSERT OR IGNORE INTO notifications (scope, user_id, id, created_at, read_at, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(scope, userId, n.id, n.createdAt, readAt ?? null, JSON.stringify(rest));
  }

  async list(scope: string, userId: string, limit: number): Promise<Notification[]> {
    const rows = this.db
      .prepare("SELECT data, read_at FROM notifications WHERE scope = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(scope, userId, limit) as { data: string; read_at: number | null }[];
    return rows.map((r) => ({ ...(JSON.parse(r.data) as Notification), ...(r.read_at === null ? {} : { readAt: r.read_at }) }));
  }

  async unreadCount(scope: string, userId: string): Promise<number> {
    const row = this.db.prepare("SELECT count(*) AS n FROM notifications WHERE scope = ? AND user_id = ? AND read_at IS NULL").get(scope, userId) as {
      n: number | bigint;
    };
    return Number(row.n);
  }

  async markRead(scope: string, userId: string, ids: readonly string[] | "all", at: number): Promise<string[]> {
    const unread = (
      this.db.prepare("SELECT id FROM notifications WHERE scope = ? AND user_id = ? AND read_at IS NULL").all(scope, userId) as { id: string }[]
    ).map((r) => r.id);
    const changed = ids === "all" ? unread : unread.filter((id) => ids.includes(id));
    const mark = this.db.prepare("UPDATE notifications SET read_at = ? WHERE scope = ? AND user_id = ? AND id = ?");
    for (const id of changed) mark.run(at, scope, userId, id);
    return changed;
  }

  async prune(scope: string, userId: string, keep: number): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM notifications WHERE scope = ? AND user_id = ? AND rowid NOT IN (
           SELECT rowid FROM notifications WHERE scope = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      )
      .run(scope, userId, scope, userId, keep);
  }
}

/** Versions: the description as JSON, the state as a blob. */
class SqliteVersionStore implements VersionStore {
  private readonly saveStatement: StatementSync;
  private readonly listStatement: StatementSync;
  private readonly getStatement: StatementSync;
  private readonly deleteStatement: StatementSync;

  constructor(db: DatabaseSync) {
    this.saveStatement = db.prepare(
      "INSERT INTO versions (room, id, created_at, info, state) VALUES (?, ?, ?, ?, ?) ON CONFLICT (room, id) DO UPDATE SET info = excluded.info, state = excluded.state",
    );
    this.listStatement = db.prepare("SELECT info FROM versions WHERE room = ? ORDER BY created_at DESC, rowid DESC");
    this.getStatement = db.prepare("SELECT info, state FROM versions WHERE room = ? AND id = ?");
    this.deleteStatement = db.prepare("DELETE FROM versions WHERE room = ? AND id = ?");
  }

  async save(room: string, version: Version, state: Uint8Array): Promise<void> {
    this.saveStatement.run(room, version.id, version.createdAt, JSON.stringify(version), state);
  }

  async list(room: string): Promise<Version[]> {
    return (this.listStatement.all(room) as { info: string }[]).map((r) => JSON.parse(r.info) as Version);
  }

  async get(room: string, id: string): Promise<{ version: Version; state: Uint8Array } | null> {
    const row = this.getStatement.get(room, id) as { info: string; state: Uint8Array } | undefined;
    return row ? { version: JSON.parse(row.info) as Version, state: row.state } : null;
  }

  async delete(room: string, id: string): Promise<void> {
    this.deleteStatement.run(room, id);
  }
}

/** Threads as JSON rows, one per thread. */
class SqliteThreadStore implements ThreadStore {
  private readonly listStatement: StatementSync;
  private readonly getStatement: StatementSync;
  private readonly putStatement: StatementSync;
  private readonly deleteStatement: StatementSync;
  private readonly countStatement: StatementSync;

  constructor(db: DatabaseSync) {
    this.listStatement = db.prepare("SELECT data FROM threads WHERE room = ? ORDER BY created_at, rowid");
    this.getStatement = db.prepare("SELECT data FROM threads WHERE room = ? AND id = ?");
    this.putStatement = db.prepare(
      "INSERT INTO threads (room, id, created_at, data) VALUES (?, ?, ?, ?) ON CONFLICT (room, id) DO UPDATE SET data = excluded.data",
    );
    this.deleteStatement = db.prepare("DELETE FROM threads WHERE room = ? AND id = ?");
    this.countStatement = db.prepare("SELECT count(*) AS n FROM threads WHERE room = ?");
  }

  async list(room: string): Promise<Thread[]> {
    return (this.listStatement.all(room) as { data: string }[]).map((r) => JSON.parse(r.data) as Thread);
  }

  async get(room: string, id: string): Promise<Thread | null> {
    const row = this.getStatement.get(room, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Thread) : null;
  }

  async put(room: string, thread: Thread): Promise<void> {
    this.putStatement.run(room, thread.id, thread.createdAt, JSON.stringify(thread));
  }

  async delete(room: string, id: string): Promise<void> {
    this.deleteStatement.run(room, id);
  }

  async count(room: string): Promise<number> {
    return Number((this.countStatement.get(room) as { n: number | bigint }).n);
  }
}
