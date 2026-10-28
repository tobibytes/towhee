import {
  type Anchor,
  type Comment,
  type CommentBody,
  isThread,
  type Thread,
  type ThreadMetadata,
  textBody,
} from "@towhee/protocol";
import * as Y from "yjs";

/** What the threads API needs from a room connection. */
export interface ThreadTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  onEvent(listener: (event: { name: string; data?: unknown }) => void): () => void;
  onConnected(listener: () => void): () => void;
  isConnected(): boolean;
}

type Body = CommentBody | string;
const toBody = (body: Body): CommentBody => (typeof body === "string" ? textBody(body) : body);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The room's comment threads. `list()` is kept current from the server's events and refetched
 * after every (re)connect, so threads changed while offline show up. Changes go to the server
 * and resolve with the result; `change` listeners fire for everyone's changes, yours included.
 */
export class Threads {
  private readonly cache = new Map<string, Thread>();
  private readonly listeners = new Set<(threads: Thread[]) => void>();
  private loaded = false;

  constructor(private readonly transport: ThreadTransport) {
    transport.onEvent((event) => {
      if (!isRecord(event.data)) return;
      if ((event.name === "thread.created" || event.name === "thread.updated") && isThread(event.data.thread)) {
        this.store(event.data.thread);
      } else if (event.name === "thread.deleted" && typeof event.data.threadId === "string") {
        if (this.cache.delete(event.data.threadId)) this.changed();
      }
    });
    transport.onConnected(() => void this.refresh().catch(() => {}));
    if (transport.isConnected()) void this.refresh().catch(() => {});
  }

  /** Whether the list has been fetched at least once. */
  get ready(): boolean {
    return this.loaded;
  }

  /** Every thread, oldest first. */
  list(): Thread[] {
    return [...this.cache.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  get(threadId: string): Thread | undefined {
    return this.cache.get(threadId);
  }

  /** Listens for any change to the list. Returns a function that unsubscribes. */
  subscribe(listener: (threads: Thread[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fetches every thread from the server. Runs on its own after each connect. */
  async refresh(): Promise<Thread[]> {
    const result = (await this.transport.request("threads.list")) as { threads?: unknown };
    const threads = Array.isArray(result?.threads) ? result.threads.filter(isThread) : [];
    this.cache.clear();
    for (const thread of threads) this.cache.set(thread.id, thread);
    this.loaded = true;
    this.changed();
    return this.list();
  }

  /** Starts a thread. `body` can be plain text. */
  async create(input: { body: Body; anchor?: Anchor; metadata?: ThreadMetadata }): Promise<Thread> {
    const params = { body: toBody(input.body), ...(input.anchor ? { anchor: input.anchor } : {}), ...(input.metadata ? { metadata: input.metadata } : {}) };
    return (await this.call("threads.create", params)).thread;
  }

  async reply(threadId: string, body: Body): Promise<Comment> {
    return (await this.call("threads.reply", { threadId, body: toBody(body) })).comment!;
  }

  async edit(threadId: string, commentId: string, body: Body): Promise<Comment> {
    return (await this.call("threads.edit", { threadId, commentId, body: toBody(body) })).comment!;
  }

  async deleteComment(threadId: string, commentId: string): Promise<void> {
    await this.call("threads.deleteComment", { threadId, commentId });
  }

  /** Adds your reaction, or removes it with `add: false`. */
  async react(threadId: string, commentId: string, reaction: string, add = true): Promise<void> {
    await this.call("threads.react", { threadId, commentId, reaction, add });
  }

  async resolve(threadId: string, resolved = true): Promise<void> {
    await this.call("threads.resolve", { threadId, resolved });
  }

  async setMetadata(threadId: string, metadata: ThreadMetadata): Promise<void> {
    await this.call("threads.setMetadata", { threadId, metadata });
  }

  async delete(threadId: string): Promise<void> {
    await this.transport.request("threads.delete", { threadId });
    if (this.cache.delete(threadId)) this.changed();
  }

  private async call(method: string, params: unknown): Promise<{ thread: Thread; comment?: Comment }> {
    const result = (await this.transport.request(method, params)) as { thread: Thread; comment?: Comment };
    if (isThread(result?.thread)) this.store(result.thread);
    return result;
  }

  private store(thread: Thread): void {
    const known = this.cache.get(thread.id);
    // Events and responses can arrive in either order; never go back to an older copy.
    if (known && known.updatedAt > thread.updatedAt) return;
    this.cache.set(thread.id, thread);
    this.changed();
  }

  private changed(): void {
    const list = this.list();
    for (const listener of [...this.listeners]) listener(list);
  }
}

/* Text anchors --------------------------------------------------------------------------------- */

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Anchors a thread to `length` characters of a shared text (a `Y.Text` or `Y.XmlText`) from
 * `index`. The anchor follows that text as people edit around it.
 */
export function createTextAnchor(type: Y.Text | Y.XmlText, index: number, length: number): Anchor {
  if (!Number.isInteger(index) || !Number.isInteger(length) || index < 0 || length < 1) {
    throw new RangeError("index must be 0 or more and length at least 1");
  }
  // Typing right at either edge stays outside the range: the start sticks to the character after
  // it, the end to the character before it.
  const start = Y.createRelativePositionFromTypeIndex(type, index, 0);
  const end = Y.createRelativePositionFromTypeIndex(type, index + length, -1);
  return { type: "text", start: toBase64(Y.encodeRelativePosition(start)), end: toBase64(Y.encodeRelativePosition(end)) };
}

/**
 * Where a text anchor points now: the shared type and the range in it, or null if the anchored
 * text was deleted (or the anchor isn't a text anchor for this doc).
 */
type SharedType = NonNullable<ReturnType<typeof Y.createAbsolutePositionFromRelativePosition>>["type"];

export function resolveTextAnchor(doc: Y.Doc, anchor: Anchor): { type: SharedType; index: number; length: number } | null {
  if (anchor.type !== "text") return null;
  try {
    const start = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(anchor.start)), doc);
    const end = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(anchor.end)), doc);
    if (!start || !end || start.type !== end.type || end.index <= start.index) return null;
    return { type: start.type, index: start.index, length: end.index - start.index };
  } catch {
    return null;
  }
}
