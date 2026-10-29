import { createClient, type Other, type RoomConnection, type Status, type Thread, type TowheeClient, type Version } from "@towhee/client";
import * as React from "react";
import * as Y from "yjs";

/**
 * The first token request sets the visitor cookie, so the others wait for it. Otherwise a new
 * visitor's room and inbox tokens are minted at once, each for a different visitor id, and
 * mentions land in an inbox nobody has open.
 */
let first: Promise<unknown> | undefined;
const oneVisitorFetch: typeof fetch = async (input, init) => {
  if (first) {
    await first;
    return fetch(input, init);
  }
  const response = fetch(input, init);
  first = response.catch(() => {
    first = undefined;
  });
  return response;
};

/** The demo server is this site's own Worker: /v1 for rooms, /demo/token for anonymous demo tokens. */
let client: TowheeClient | undefined;
export function demoClient(): TowheeClient {
  if (!client) {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
    client = createClient({ url, authEndpoint: "/demo/token", fetch: oneVisitorFetch });
  }
  return client;
}

/** A short random room id for a new board. */
export function newBoardId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
}

export interface Card {
  id: string;
  title: string;
  note: string;
  column: Column;
  order: number;
}
export type Column = "todo" | "doing" | "done";
export const COLUMNS: { id: Column; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "doing", label: "Doing" },
  { id: "done", label: "Done" },
];

/** Presence each person shares: where their pointer is on the board, and which card they have open. */
export interface BoardPresence {
  cursor?: { x: number; y: number } | null;
  card?: string | null;
}

/** Joins a board's room for as long as the component is mounted. */
export function useBoardRoom(boardId: string): RoomConnection | undefined {
  const [room, setRoom] = React.useState<RoomConnection>();
  React.useEffect(() => {
    const r = demoClient().enter(`demo:${boardId}`);
    void r.threads; // start tracking threads and versions from the first connect
    void r.history;
    setRoom(r);
    return () => r.leave();
  }, [boardId]);
  return room;
}

function useSubscribe<T>(subscribe: ((fn: () => void) => () => void) | undefined, read: () => T, fallback: T): T {
  const cache = React.useRef<{ value: T } | undefined>(undefined);
  const get = React.useCallback(() => {
    if (!subscribe) return fallback;
    cache.current ??= { value: read() };
    return cache.current.value;
  }, [subscribe, read, fallback]);
  const sub = React.useCallback(
    (onChange: () => void) => {
      if (!subscribe) return () => {};
      return subscribe(() => {
        cache.current = { value: read() };
        onChange();
      });
    },
    [subscribe, read],
  );
  return React.useSyncExternalStore(sub, get, get);
}

const NO_OTHERS: Other[] = [];
const NO_THREADS: Thread[] = [];
const NO_VERSIONS: Version[] = [];

export function useStatus(room?: RoomConnection): { status: Status; synced: boolean } {
  const [state, setState] = React.useState({ status: room?.status ?? "connecting", synced: room?.synced ?? false });
  React.useEffect(() => {
    if (!room) return;
    const update = () => setState({ status: room.status, synced: room.synced });
    update();
    const a = room.on("status", update);
    const b = room.on("synced", update);
    return () => {
      a();
      b();
    };
  }, [room]);
  return state;
}

export function useOthers(room?: RoomConnection): Other[] {
  const subscribe = React.useMemo(() => (room ? (fn: () => void) => room.on("others", fn) : undefined), [room]);
  const read = React.useCallback(() => room?.others() ?? NO_OTHERS, [room]);
  return useSubscribe(subscribe, read, NO_OTHERS);
}

export function useThreads(room?: RoomConnection): Thread[] {
  const subscribe = React.useMemo(() => (room ? (fn: () => void) => room.threads.subscribe(fn) : undefined), [room]);
  const read = React.useCallback(() => room?.threads.list() ?? NO_THREADS, [room]);
  return useSubscribe(subscribe, read, NO_THREADS);
}

export function useVersions(room?: RoomConnection): Version[] {
  const subscribe = React.useMemo(() => (room ? (fn: () => void) => room.history.subscribe(fn) : undefined), [room]);
  const read = React.useCallback(() => room?.history.list() ?? NO_VERSIONS, [room]);
  return useSubscribe(subscribe, read, NO_VERSIONS);
}

/** The cards, re-read whenever the shared map changes (deeply). */
export function useCards(room?: RoomConnection): Card[] {
  const [cards, setCards] = React.useState<Card[]>([]);
  React.useEffect(() => {
    if (!room) return;
    const map = cardsMap(room.doc);
    const read = () =>
      setCards(
        [...map.entries()]
          .map(([id, m]) => ({
            id,
            title: String(m.get("title") ?? ""),
            note: String(m.get("note") ?? ""),
            column: (m.get("column") as Column) ?? "todo",
            order: Number(m.get("order") ?? 0),
          }))
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
      );
    read();
    map.observeDeep(read);
    return () => map.unobserveDeep(read);
  }, [room]);
  return cards;
}

export const cardsMap = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>("cards");

export function addCard(doc: Y.Doc, fields: Omit<Card, "id" | "order"> & { id?: string; order?: number }): string {
  const id = fields.id ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const card = new Y.Map<unknown>();
  card.set("title", fields.title);
  card.set("note", fields.note);
  card.set("column", fields.column);
  card.set("order", fields.order ?? Date.now());
  cardsMap(doc).set(id, card);
  return id;
}

export function updateCard(doc: Y.Doc, id: string, fields: Partial<Omit<Card, "id">>): void {
  const card = cardsMap(doc).get(id);
  if (!card) return;
  doc.transact(() => {
    for (const [k, v] of Object.entries(fields)) card.set(k, v);
  });
}

/** A new board starts with a few cards. Fixed ids, so two first visitors don't both add them. */
export function seedBoard(doc: Y.Doc): void {
  if (cardsMap(doc).size > 0) return;
  doc.transact(() => {
    addCard(doc, { id: "welcome", title: "Open this board in a second window", note: "Or send the link to a friend. You'll see each other's cursors.", column: "todo", order: 1 });
    addCard(doc, { id: "comment", title: "Leave a comment and @mention someone", note: "Click the speech bubble on a card. Mentions land in their inbox (the bell).", column: "todo", order: 2 });
    addCard(doc, { id: "history", title: "Save a version, change things, restore it", note: "History is top right. Restores sync to everyone and can be undone.", column: "doing", order: 3 });
    addCard(doc, { id: "offline", title: "Go offline, edit, come back", note: "Edits made offline sync when you reconnect.", column: "done", order: 4 });
  });
}
