import { canModerate, MAX_VERSION_NAME_LENGTH, type Version } from "@towhee/protocol";
import type { VersionStore } from "./storage";
import { type Caller, type Outcome, RequestFailure } from "./threads";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function newId(): string {
  return `v_${Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Base64 with btoa, which every target runtime has. Chunked so big states don't overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Saved versions of a room's document. Restoring happens on the client (it writes the old
 * content back as an ordinary, undoable change); the server stores versions, saves automatic
 * ones and records restores.
 */
export class History {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly room: string,
    private readonly store: VersionStore,
    private readonly now: () => number,
    private readonly keepAuto: number,
    /** The document's current full state. */
    private readonly currentState: () => Uint8Array,
  ) {}

  static handles(method: string): boolean {
    return method.startsWith("history.");
  }

  handle(method: string, params: unknown, caller: Caller): Promise<Outcome> {
    return this.enqueue(() => this.dispatch(method, isRecord(params) ? params : params === undefined ? {} : null, caller));
  }

  /** Saves an automatic version of `state`, then deletes automatic versions past the limit. */
  saveAuto(state: Uint8Array): Promise<Version> {
    return this.enqueue(async () => {
      const version: Version = { id: newId(), kind: "auto", createdAt: this.now(), size: state.length };
      await this.store.save(this.room, version, state);
      const autos = (await this.store.list(this.room)).filter((v) => v.kind === "auto");
      for (const old of autos.slice(this.keepAuto)) await this.store.delete(this.room, old.id);
      return version;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  private async dispatch(method: string, p: Record<string, unknown> | null, caller: Caller): Promise<Outcome> {
    if (p === null) throw new RequestFailure("protocol_error", "params must be an object");
    switch (method) {
      case "history.list":
        return { result: { versions: await this.store.list(this.room) }, events: [] };
      case "history.get": {
        if (typeof p.versionId !== "string" || !ID.test(p.versionId)) throw new RequestFailure("protocol_error", "versionId must be an id");
        const saved = await this.store.get(this.room, p.versionId);
        if (!saved) throw new RequestFailure("not_found", "No such version");
        return { result: { version: saved.version, state: toBase64(saved.state) }, events: [] };
      }
      case "history.save":
        return this.save(p, caller);
      default:
        throw new RequestFailure("not_found", `Unknown method ${method}`);
    }
  }

  private async save(p: Record<string, unknown>, caller: Caller): Promise<Outcome> {
    if (!canModerate(caller.access)) throw new RequestFailure("forbidden", "Only write access can save versions");
    if (p.name !== undefined && (typeof p.name !== "string" || p.name.length === 0 || p.name.length > MAX_VERSION_NAME_LENGTH)) {
      throw new RequestFailure("protocol_error", `name must be 1-${MAX_VERSION_NAME_LENGTH} characters`);
    }
    let restoredFrom: string | undefined;
    if (p.restoredFrom !== undefined) {
      if (typeof p.restoredFrom !== "string" || !ID.test(p.restoredFrom)) throw new RequestFailure("protocol_error", "restoredFrom must be an id");
      if (!(await this.store.get(this.room, p.restoredFrom))) throw new RequestFailure("not_found", "No such version to have restored");
      restoredFrom = p.restoredFrom;
    }
    const state = this.currentState();
    const version: Version = {
      id: newId(),
      kind: restoredFrom ? "restore" : "manual",
      createdAt: this.now(),
      createdBy: caller.user,
      ...(p.name !== undefined ? { name: p.name as string } : {}),
      ...(restoredFrom ? { restoredFrom } : {}),
      size: state.length,
    };
    await this.store.save(this.room, version, state);
    return { result: { version }, events: [{ name: "version.saved", data: { version } }] };
  }
}
