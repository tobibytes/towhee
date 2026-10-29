import { Code, C } from "../../site/code";
import { GITHUB } from "../../site/layout";
import { A, H1, H2, List, Note, P } from "./layout";

export function Overview() {
  return (
    <>
      <H1 lead="Towhee is a realtime collaboration server you run yourself: live presence, shared documents that sync and work offline, comments, version history and notifications. Your app keeps its users and signs a token for each room.">
        Towhee
      </H1>
      <Note title="v0.1">
        The first release: packages on npm (<C>@towhee/*</C>) and the server image at <C>ghcr.io/tobibytes/towhee</C>. It&apos;s
        early, so pin versions and read the changelog on the <A href={`${GITHUB}/releases`}>releases page</A> before upgrading.
      </Note>

      <H2 id="what">What you can build</H2>
      <List
        items={[
          "Google Docs-style editors: TipTap, BlockNote or CodeMirror bound to a room's Yjs document, with live cursors.",
          "Whiteboards, kanban boards and design canvases where every change and cursor shows up for everyone (see the live demo).",
          "Review flows: threads anchored to a paragraph, a cell or a block, with @mentions, reactions and resolve.",
          "Anything that needs \"who's here\": an avatar stack, \"Ada is editing\", selection highlights.",
          "Undo-able version history: save named versions, preview old ones, restore for everyone.",
          "In-app notifications for mentions and replies, plus email through your own webhook.",
        ]}
      />

      <H2 id="pieces">The pieces</H2>
      <List
        items={[
          <><C>@towhee/client</C>: connects a browser (or Node) to a room. Reconnects, refreshes tokens, syncs offline edits.</>,
          <><C>@towhee/auth</C>: <C>createRoomToken</C> and <C>createInboxToken</C> for your backend; <C>verifyWebhook</C> for notification webhooks.</>,
          <><C>@towhee/cloudflare</C>: the server as a Worker with a Durable Object per room and per inbox.</>,
          <><C>@towhee/node</C>: the server as a Node process with SQLite, also a Docker image.</>,
          <><C>@towhee/react</C>: providers and hooks (<A href="/docs/react">React</A>).</>,
          <><C>@towhee/core</C> and <C>@towhee/protocol</C>: what both servers and the client share.</>,
          <>
            <A href="https://junco.madebytobi.com/docs/collaboration/">@junco/collab</A> (from Junco): ready-made UI for all of it, with a
            Towhee adapter.
          </>,
        ]}
      />

      <H2 id="quick-start">Quick start</H2>
      <P>1. Run a server. Locally with Docker (or see <A href="/docs/cloudflare">Cloudflare</A>):</P>
      <Code
        code={`export TOWHEE_SECRET="$(node -e "console.log(crypto.randomBytes(32).toString('base64url'))")"
docker run -p 8080:8080 -e TOWHEE_SECRET -v towhee-data:/data ghcr.io/tobibytes/towhee:0.1.0`}
      />
      <P>2. Add a token endpoint to your backend. It decides who may open which room:</P>
      <Code
        title="POST /api/towhee-token"
        code={`import { createInboxToken, createRoomToken } from "@towhee/auth";

const key = { id: "default", secret: process.env.TOWHEE_SECRET };

export async function POST(request) {
  const user = await getSessionUser(request);           // your auth
  if (!user) return new Response("Sign in", { status: 401 });
  const { room } = await request.json();
  const token =
    room === "towhee.inbox"
      ? await createInboxToken({ userId: user.id, user: { name: user.name } }, key)
      : await createRoomToken({ userId: user.id, room, access: "write", user: { name: user.name } }, key);
  return Response.json({ token });
}`}
      />
      <P>3. Connect from the browser:</P>
      <Code
        code={`import { createClient } from "@towhee/client";

const client = createClient({ url: "ws://localhost:8080", authEndpoint: "/api/towhee-token" });
const room = client.enter("doc:42");
room.on("synced", (synced) => synced && console.log(room.doc.getText("body").toString()));`}
      />
      <P>
        Next: <A href="/docs/client">use presence, comments, history and the inbox</A>, or <A href="/examples">see the examples</A>.
      </P>
    </>
  );
}
