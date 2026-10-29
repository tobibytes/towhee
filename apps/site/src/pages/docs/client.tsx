import { Code, C } from "../../site/code";
import { A, H1, H2, P, Table } from "./layout";

export function ClientGuide() {
  return (
    <>
      <H1 lead="Everything a browser does with Towhee goes through @towhee/client. It works in browsers, Node 22+, Deno, Bun and Workers.">
        Using the client
      </H1>

      <H2 id="connect">Connect and enter a room</H2>
      <Code
        code={`import { createClient } from "@towhee/client";

const client = createClient({
  url: "wss://towhee.example.com",
  authEndpoint: "/api/towhee-token",   // or (room) => fetchMyToken(room)
});

const room = client.enter("doc:42");  // pass { doc } to bind an editor's existing Y.Doc
room.on("status", (s) => console.log(s)); // connecting → connected → reconnecting → ...
room.on("synced", (synced) => {});        // true once the server's copy has arrived
// later: room.leave()`}
      />
      <P>
        The client POSTs <C>{`{ "room": "doc:42" }`}</C> to your <C>authEndpoint</C> with cookies and expects <C>{`{ "token": "..." }`}</C>. A 401 or
        403 stops it; other failures retry. It reconnects on its own: straight away with a new token when one expires, otherwise
        with backoff (500 ms doubling to 30 s). Edits made while offline sync on reconnect.
      </P>

      <H2 id="document">The shared document</H2>
      <P>
        <C>room.doc</C> is a normal Yjs <C>Y.Doc</C>. Use maps, arrays and text directly, or bind an editor (TipTap&apos;s Collaboration
        extension, y-prosemirror, y-codemirror) to it. Only <C>write</C> access can edit; give readers a read-only editor.
      </P>
      <Code
        code={`const cards = room.doc.getMap("cards");
cards.set("c1", { title: "Ship the demo", column: "doing" });
cards.observe(() => render(cards.toJSON()));`}
      />

      <H2 id="presence">Presence</H2>
      <Code
        code={`room.setPresence({ cursor: { x: 0.4, y: 0.2 } });   // replace yours
room.updatePresence({ selectedCard: "c1" });          // change some fields
room.others();      // [{ clientId, user: { id, name, color }, presence }]
room.on("others", (others) => renderCursors(others));
room.self;          // { connectionId, user, access } once connected`}
      />
      <P>
        <C>user</C> always comes from the token, so nobody can show up as someone else. Others&apos; presence clears when they leave or
        go quiet for 30 seconds.
      </P>

      <H2 id="comments">Comments and threads</H2>
      <Code
        code={`import { createTextAnchor, resolveTextAnchor, textBody } from "@towhee/client";

const thread = await room.threads.create({
  body: "Can we ship Friday?",                      // a string, or a rich-text body
  anchor: { type: "app", id: "card-c1" },           // or createTextAnchor(yText, index, length)
});
await room.threads.reply(thread.id, textBody("Yes, if CI is green"));
await room.threads.react(thread.id, thread.comments[0].id, "👍");
await room.threads.resolve(thread.id);

room.threads.subscribe((threads) => renderThreads(threads));
resolveTextAnchor(room.doc, thread.anchor); // { type, index, length } or null if the text is gone`}
      />
      <P>
        Bodies are a small rich-text tree (paragraphs, bold, italic, code, links, mentions), never HTML. A mention is{" "}
        <C>{`{ type: "mention", userId }`}</C>; mentioned users get a notification.
      </P>

      <H2 id="history">Version history</H2>
      <Code
        code={`const undo = new Y.UndoManager(room.doc.getXmlFragment("default"), { trackedOrigins: new Set(["restore"]) });

await room.history.save("Before the rewrite");     // write access
room.history.subscribe((versions) => renderVersions(versions));
const old = await room.history.preview(versionId);  // a separate, read-only Y.Doc
await room.history.restore(versionId, { origin: "restore" }); // everyone sees it
undo.undo();                                         // and it can be undone`}
      />
      <P>Towhee also saves a version automatically after 5 minutes of changes and when everyone leaves.</P>

      <H2 id="inbox">The inbox</H2>
      <Code
        code={`const inbox = client.inbox;          // asks your endpoint for room "towhee.inbox"
inbox.subscribe(({ notifications, unread }) => renderBell(unread));
await inbox.markRead([notifications[0].id]);
await inbox.markAllRead();`}
      />
      <P>
        Your token endpoint answers <C>towhee.inbox</C> with <C>createInboxToken</C>. Notifications arrive live in every open tab, and
        read state follows.
      </P>

      <H2 id="api">API at a glance</H2>
      <Table
        head={["Object", "Members"]}
        rows={[
          [<C key="c">client</C>, "enter(roomId, { doc? }), inbox"],
          [<C key="r">room</C>, "doc, awareness, status, synced, self, lastError, on(event), others(), setPresence, updatePresence, request, threads, history, leave()"],
          [<C key="t">room.threads</C>, "list, get, subscribe, refresh, create, reply, edit, deleteComment, react, resolve, setMetadata, delete"],
          [<C key="h">room.history</C>, "list, subscribe, refresh, get, preview, save, restore"],
          [<C key="i">client.inbox</C>, "list, unread, ready, subscribe, refresh, markRead, markAllRead, close, connection"],
        ]}
      />
      <P>
        See <A href="/docs/tokens">tokens and access</A> for who can do what.
      </P>
    </>
  );
}
