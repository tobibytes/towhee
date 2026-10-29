import type { RoomConnection, TowheeClient } from "@towhee/client";
import * as React from "react";
import type * as Y from "yjs";

const ClientContext = React.createContext<TowheeClient | null>(null);
const RoomContext = React.createContext<RoomConnection | null>(null);

/** Makes a client available to everything below it. Create the client once, outside render. */
export function TowheeProvider({ client, children }: { client: TowheeClient; children?: React.ReactNode }) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

/** The client from the nearest {@link TowheeProvider}. */
export function useClient(): TowheeClient {
  const client = React.useContext(ClientContext);
  if (!client) throw new Error("useClient needs a <TowheeProvider> above it");
  return client;
}

export interface RoomProviderProps {
  /** The room id, like `doc:42`. Changing it leaves the old room and enters the new one. */
  id: string;
  /** Your presence when you join, before any `updatePresence`. */
  initialPresence?: Record<string, unknown>;
  /** A Y.Doc you already have, for editor bindings. Only used when the room is entered. */
  doc?: Y.Doc;
  children?: React.ReactNode;
}

/**
 * Enters a room while mounted. Rooms are shared and counted: two providers for one id use one
 * connection, and React's strict-mode unmount and remount keeps it rather than reconnecting.
 * Nothing connects during server rendering; hooks return their empty values until mounted.
 */
export function RoomProvider({ id, initialPresence, doc, children }: RoomProviderProps) {
  const client = useClient();
  const [room, setRoom] = React.useState<RoomConnection | null>(null);
  // Read once per entered room: later changes to these props don't re-enter.
  const options = React.useRef({ initialPresence, doc });
  options.current = { initialPresence, doc };

  React.useEffect(() => {
    const entered = acquire(client, id, options.current);
    setRoom(entered);
    return () => {
      setRoom(null);
      release(client, id);
    };
  }, [client, id]);

  return <RoomContext.Provider value={room}>{children}</RoomContext.Provider>;
}

/** The room from the nearest {@link RoomProvider}, or null until it has mounted. */
export function useRoom(): RoomConnection | null {
  return React.useContext(RoomContext);
}

interface Entry {
  room: RoomConnection;
  refs: number;
}
const entries = new WeakMap<TowheeClient, Map<string, Entry>>();

function acquire(client: TowheeClient, id: string, options: { initialPresence?: Record<string, unknown>; doc?: Y.Doc }): RoomConnection {
  let rooms = entries.get(client);
  if (!rooms) {
    rooms = new Map();
    entries.set(client, rooms);
  }
  let entry = rooms.get(id);
  if (!entry) {
    const room = client.enter(id, options.doc ? { doc: options.doc } : {});
    if (options.initialPresence) room.setPresence(options.initialPresence);
    entry = { room, refs: 0 };
    rooms.set(id, entry);
  }
  entry.refs++;
  return entry.room;
}

/** Leaves on the next tick if nothing took the room again by then (strict mode remounts at once). */
function release(client: TowheeClient, id: string): void {
  const rooms = entries.get(client);
  const entry = rooms?.get(id);
  if (!rooms || !entry) return;
  entry.refs--;
  setTimeout(() => {
    if (entry.refs > 0 || rooms.get(id) !== entry) return;
    rooms.delete(id);
    entry.room.leave();
  }, 0);
}
