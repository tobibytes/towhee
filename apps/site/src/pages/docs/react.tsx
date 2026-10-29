import { Code, C } from "../../site/code";
import { H1, H2, P, Table } from "./layout";

export function ReactGuide() {
  return (
    <>
      <H1 lead="@towhee/react wraps the client in a provider and hooks. Safe in strict mode and with server rendering.">React</H1>

      <H2 id="setup">Set up</H2>
      <Code
        code={`import { createClient } from "@towhee/client";
import { RoomProvider, TowheeProvider } from "@towhee/react";

// Create the client once, outside render.
const client = createClient({ url: "wss://towhee.example.com", authEndpoint: "/api/towhee-token" });

export function App() {
  return (
    <TowheeProvider client={client}>
      <RoomProvider id="doc:42" initialPresence={{ cursor: null }}>
        <Editor />
      </RoomProvider>
    </TowheeProvider>
  );
}`}
      />
      <P>
        <C>RoomProvider</C> enters the room while it&apos;s mounted. Two providers for one id share a connection, and strict mode&apos;s
        unmount and remount keeps it instead of reconnecting. Nothing connects during server rendering: hooks return their empty values
        until the page mounts.
      </P>

      <H2 id="hooks">Hooks</H2>
      <Table
        head={["Hook", "Returns"]}
        rows={[
          [<C key="r">useRoom()</C>, "The room connection, or null before mount. Its threads and history objects create, reply, save and restore"],
          [<C key="s">useStatus()</C>, "connecting, connected, reconnecting or disconnected"],
          [<C key="y">useSynced()</C>, "True once the document has caught up with the server"],
          [<C key="d">useDoc()</C>, "The room's Y.Doc, for editor bindings"],
          [<C key="me">useSelf()</C>, "You: user, access and connection id, from your token"],
          [<C key="o">useOthers()</C>, "Everyone else, with their presence"],
          [<C key="u">useUpdatePresence()</C>, "A stable function that changes some fields of your presence"],
          [<C key="t">useThreads()</C>, "{ threads, ready }, kept live"],
          [<C key="h">useHistory()</C>, "{ versions, ready }, newest first"],
          [<C key="i">useInbox()</C>, "{ notifications, unread, ready, markRead, markAllRead }; needs only TowheeProvider"],
          [<C key="c">useClient()</C>, "The client from TowheeProvider"],
        ]}
      />

      <H2 id="example">Example: who&apos;s here and where they point</H2>
      <Code
        code={`import { useOthers, useRoom, useThreads, useUpdatePresence } from "@towhee/react";

function Cursors() {
  const others = useOthers();
  const update = useUpdatePresence();
  return (
    <div onPointerMove={(e) => update({ cursor: { x: e.clientX, y: e.clientY } })}>
      {others.map((o) => {
        const c = o.presence.cursor as { x: number; y: number } | undefined;
        return c && <span key={o.clientId} style={{ position: "fixed", left: c.x, top: c.y }}>{o.user.name}</span>;
      })}
    </div>
  );
}

function Comments() {
  const room = useRoom();
  const { threads, ready } = useThreads();
  if (!ready) return null;
  return (
    <>
      {threads.map((t) => <p key={t.id}>{t.comments.length} comments</p>)}
      <button onClick={() => room?.threads.create({ body: "Looks good?" })}>Comment</button>
    </>
  );
}`}
      />
    </>
  );
}
