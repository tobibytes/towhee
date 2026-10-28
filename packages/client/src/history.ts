import { type Access, canModerate, isVersion, type Version } from "@towhee/protocol";
import * as Y from "yjs";
import { RequestError } from "./errors";
import { type RestoreOptions, restoreDocument } from "./restore";
import type { ThreadTransport } from "./threads";

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Saved versions of the room's document, newest first. The list is kept current from the server's
 * events and refetched after every (re)connect. It starts empty and fills in once fetched: use
 * `subscribe`, or `await refresh()`, rather than reading `list()` right after first use.
 */
export class History {
  private versions: Version[] = [];
  private readonly listeners = new Set<(versions: Version[]) => void>();
  private loaded = false;

  constructor(
    private readonly transport: ThreadTransport,
    private readonly doc: Y.Doc,
    private readonly access: () => Access | undefined,
  ) {
    // Automatic versions can push old ones out on the server, so refetch rather than patch.
    transport.onEvent((event) => {
      if (event.name === "version.saved") void this.refresh().catch(() => {});
    });
    transport.onConnected(() => void this.refresh().catch(() => {}));
    if (transport.isConnected()) void this.refresh().catch(() => {});
  }

  get ready(): boolean {
    return this.loaded;
  }

  list(): Version[] {
    return [...this.versions];
  }

  subscribe(listener: (versions: Version[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<Version[]> {
    const result = (await this.transport.request("history.list")) as { versions?: unknown };
    this.versions = Array.isArray(result?.versions) ? result.versions.filter(isVersion) : [];
    this.loaded = true;
    for (const listener of [...this.listeners]) listener(this.list());
    return this.list();
  }

  /** A version's description and full document state. */
  async get(versionId: string): Promise<{ version: Version; state: Uint8Array }> {
    const result = (await this.transport.request("history.get", { versionId })) as { version: Version; state: string };
    return { version: result.version, state: fromBase64(result.state) };
  }

  /** A separate copy of the document as it was, to show without touching the live one. */
  async preview(versionId: string): Promise<Y.Doc> {
    const { state } = await this.get(versionId);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    return doc;
  }

  /** Saves the document as it is now. Needs write access. */
  async save(name?: string): Promise<Version> {
    const result = (await this.transport.request("history.save", name === undefined ? {} : { name })) as { version: Version };
    return result.version;
  }

  /**
   * Brings the live document back to a version, for everyone, then saves a `restore` version.
   * The restore is an ordinary change: pass your undo manager's tracked origin as `origin` to
   * make it undoable. Needs write access.
   */
  async restore(versionId: string, options: RestoreOptions & { name?: string } = {}): Promise<Version> {
    const access = this.access();
    if (!access || !canModerate(access)) throw new RequestError("forbidden", "Restoring needs write access");
    const { state } = await this.get(versionId);
    restoreDocument(this.doc, state, options);
    const result = (await this.transport.request("history.save", { restoredFrom: versionId, ...(options.name ? { name: options.name } : {}) })) as {
      version: Version;
    };
    return result.version;
  }
}
