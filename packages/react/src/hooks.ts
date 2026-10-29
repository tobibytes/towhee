import type { Notification } from "@towhee/protocol";
import type { Inbox, Other, Self, Status, Thread, Version } from "@towhee/client";
import * as React from "react";
import type * as Y from "yjs";
import { useClient, useRoom } from "./provider";

/**
 * Reads a live value from a source with `useSyncExternalStore`. The value is cached until the
 * source reports a change, so readers that build new arrays don't re-render in a loop. Without a
 * source (not mounted yet, or on the server) it's `fallback`.
 */
function useLive<S, T>(source: S | null, subscribe: (source: S, changed: () => void) => () => void, read: (source: S) => T, fallback: T): T {
  const cache = React.useRef<{ source: S; value: T } | null>(null);
  const readRef = React.useRef(read);
  readRef.current = read;
  const subscribeRef = React.useRef(subscribe);
  subscribeRef.current = subscribe;

  const sub = React.useCallback(
    (onChange: () => void) => {
      if (source === null) return () => {};
      return subscribeRef.current(source, () => {
        cache.current = null;
        onChange();
      });
    },
    [source],
  );
  const get = React.useCallback(() => {
    if (source === null) return fallback;
    if (cache.current?.source !== source) cache.current = { source, value: readRef.current(source) };
    return cache.current.value;
  }, [source, fallback]);
  return React.useSyncExternalStore(sub, get, () => fallback);
}

const NO_OTHERS: Other[] = [];

/** The connection status: `connecting`, `connected`, `reconnecting` or `disconnected`. */
export function useStatus(): Status {
  return useLive(useRoom(), (r, f) => r.on("status", f), (r) => r.status, "connecting" as Status);
}

/** True once the room's document has caught up with the server since the last (re)connect. */
export function useSynced(): boolean {
  return useLive(useRoom(), (r, f) => r.on("synced", f), (r) => r.synced, false);
}

/** You in this room (identity and access from your token), or null until connected. */
export function useSelf(): Self | null {
  return useLive(useRoom(), (r, f) => r.on("self", f), (r) => r.self, null);
}

/** Everyone else in the room, with their presence. */
export function useOthers(): Other[] {
  return useLive(useRoom(), (r, f) => r.on("others", f), (r) => r.others(), NO_OTHERS);
}

/** The room's shared Y.Doc, or null until mounted. */
export function useDoc(): Y.Doc | null {
  return useRoom()?.doc ?? null;
}

/** A stable function that changes some fields of your presence. Calls before mount are dropped. */
export function useUpdatePresence(): (fields: Record<string, unknown>) => void {
  const room = useRoom();
  return React.useCallback((fields: Record<string, unknown>) => room?.updatePresence(fields), [room]);
}

export interface ThreadsState {
  threads: Thread[];
  /** False until the first list has arrived. */
  ready: boolean;
}
const NO_THREADS: ThreadsState = { threads: [], ready: false };

/** The room's comment threads, kept live. Create, reply and react with `useRoom().threads`. */
export function useThreads(): ThreadsState {
  return useLive(
    useRoom(),
    (r, f) => r.threads.subscribe(f),
    (r) => ({ threads: r.threads.list(), ready: r.threads.ready }),
    NO_THREADS,
  );
}

export interface HistoryState {
  versions: Version[];
  ready: boolean;
}
const NO_VERSIONS: HistoryState = { versions: [], ready: false };

/** Saved versions of the room's document, newest first. Save and restore with `useRoom().history`. */
export function useHistory(): HistoryState {
  return useLive(
    useRoom(),
    (r, f) => r.history.subscribe(f),
    (r) => ({ versions: r.history.list(), ready: r.history.ready }),
    NO_VERSIONS,
  );
}

export interface InboxState {
  notifications: Notification[];
  unread: number;
  ready: boolean;
  markRead(ids: readonly string[]): Promise<void>;
  markAllRead(): Promise<void>;
}

/**
 * Your notifications across rooms, kept live. Opens the inbox connection on first use (your token
 * endpoint is asked for `towhee.inbox`); it stays open for the client's lifetime. Needs only a
 * {@link TowheeProvider}, not a room.
 */
export function useInbox(): InboxState {
  const client = useClient();
  const [inbox, setInbox] = React.useState<Inbox | null>(null);
  // Opened after mount, so server rendering never connects.
  React.useEffect(() => setInbox(client.inbox), [client]);
  const state = useLive(
    inbox,
    (i, f) => i.subscribe(f),
    (i) => ({ notifications: i.list(), unread: i.unread, ready: i.ready }),
    NO_INBOX,
  );
  const markRead = React.useCallback(async (ids: readonly string[]) => {
    await inbox?.markRead(ids);
  }, [inbox]);
  const markAllRead = React.useCallback(async () => {
    await inbox?.markAllRead();
  }, [inbox]);
  return React.useMemo(() => ({ ...state, markRead, markAllRead }), [state, markRead, markAllRead]);
}
const NO_INBOX: Pick<InboxState, "notifications" | "unread" | "ready"> = { notifications: [], unread: 0, ready: false };

