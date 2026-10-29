# Towhee

A self-hosted realtime collaboration engine. Run it on Cloudflare or anywhere Node and Docker run, and give your app:

- **Presence and cursors:** who's here, where they're pointing, what they're editing
- **Shared state:** a Yjs document that syncs live and works offline, so TipTap, BlockNote, CodeMirror and other Yjs editors plug straight in
- **Comments and threads:** anchored to text or to anything in your app, with replies, mentions, reactions and resolve
- **History:** versions you can preview and restore
- **Notifications:** an inbox per user for mentions and replies, plus a signed webhook for email

Your app keeps its users. Its backend signs a short-lived token for each room, and Towhee checks it.

**Try it:** [towhee.madebytobi.com/demo](https://towhee.madebytobi.com/demo) is a shared board. Open it in two windows. Docs are at [towhee.madebytobi.com/docs](https://towhee.madebytobi.com/docs).

> **Status:** v0.1, the first release. Pin versions. The plan is in [docs/PLAN.md](docs/PLAN.md) and the build order in [docs/SESSIONS.md](docs/SESSIONS.md).

## Quick start

**1. Run a server**, with Docker:

```bash
export TOWHEE_SECRET="$(node -e "console.log(crypto.randomBytes(32).toString('base64url'))")"
docker run -p 8080:8080 -e TOWHEE_SECRET -v towhee-data:/data ghcr.io/tobibytes/towhee:0.1.0
```

or on Cloudflare: copy [`packages/cloudflare/template`](packages/cloudflare/template), then `npm install`, `npx wrangler secret put TOWHEE_SECRET` and `npx wrangler deploy`.

**2. Sign tokens in your backend** (`npm i @towhee/auth @towhee/protocol`), after your own session check:

```ts
import { createInboxToken, createRoomToken } from "@towhee/auth";
import { INBOX_ROOM } from "@towhee/protocol";

export async function POST(request: Request) {
  const user = await getSessionUser(request); // your auth
  if (!user) return new Response("Sign in", { status: 401 });
  const { room } = await request.json();
  const key = { id: "default", secret: process.env.TOWHEE_SECRET! };
  const token =
    room === INBOX_ROOM
      ? await createInboxToken({ userId: user.id }, key)
      : await createRoomToken({ userId: user.id, room, access: "write", user: { name: user.name } }, key);
  return Response.json({ token });
}
```

**3. Share a document** in the browser (`npm i @towhee/client`):

```ts
import { createClient } from "@towhee/client";

const client = createClient({ url: "ws://localhost:8080", authEndpoint: "/api/towhee-token" });
const room = client.enter("doc:42");
const text = room.doc.getText("body");
text.observe(() => console.log(text.toString()));
text.insert(0, "Hello from this tab. ");
```

Open it in two tabs: each sees the other's text. From here, bind an editor to `room.doc` (TipTap, BlockNote, CodeMirror), and add presence, comments, history and the inbox; React apps can use `@towhee/react`, and [Junco](https://junco.madebytobi.com/docs/collaboration/)'s `@junco/collab` draws the UI.

## Packages

| Package | Purpose |
| --- | --- |
| `@towhee/protocol` | Messages and framing shared by clients and servers |
| `@towhee/auth` | Create room tokens in your backend; verify them in the server |
| `@towhee/core` | Rooms: sync, presence, access, comments, history, notifications |
| `@towhee/node` | Node WebSocket server with SQLite, also shipped as a Docker image |
| `@towhee/cloudflare` | Worker + Durable Objects |
| `@towhee/client` | Browser and Node client |
| `@towhee/react` | React hooks: providers, presence, status, threads, history, inbox |
| `apps/site` | towhee.madebytobi.com: landing page, docs, examples and the live demo (private, built with Junco) |

UI components for all of this live in [Junco](https://github.com/tobibytes/junco) (`@junco/collab`).

## Develop

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

Node 22.18 or newer.

## License

MIT
