import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Storage } from "@towhee/core";
import * as Y from "yjs";

/**
 * Room documents in a SQLite file, through Node's built-in `node:sqlite`. One compacted state per
 * room plus a log of updates since. WAL mode, so a crash loses at most the write in flight.
 */
export class SqliteStorage implements Storage {
  readonly db: DatabaseSync;
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
    `);
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
