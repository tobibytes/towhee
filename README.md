# Towhee

A self-hosted realtime collaboration engine. Run it on Cloudflare or anywhere Node and Docker run, and give your app:

- **Presence and cursors:** who's here, where they're pointing, what they're editing
- **Shared state:** a Yjs document that syncs live and works offline, so TipTap, BlockNote, CodeMirror and other Yjs editors plug straight in
- **Comments and threads:** anchored to text or to anything in your app, with replies, mentions, reactions and resolve
- **History:** versions you can preview and restore
- **Notifications:** an inbox per user for mentions and replies, plus a signed webhook for email

Your app keeps its users. Its backend signs a short-lived token for each room, and Towhee checks it.

**Try it:** [towhee.madebytobi.com/demo](https://towhee.madebytobi.com/demo) is a shared board. Open it in two windows. Docs are at [towhee.madebytobi.com/docs](https://towhee.madebytobi.com/docs).

> **Status:** early. The plan is in [docs/PLAN.md](docs/PLAN.md) and the build order in [docs/SESSIONS.md](docs/SESSIONS.md). Nothing is published yet.

## Packages

| Package | Purpose |
| --- | --- |
| `@towhee/protocol` | Messages and framing shared by clients and servers |
| `@towhee/auth` | Create room tokens in your backend; verify them in the server |
| `@towhee/core` | Rooms: sync, presence, access, comments, history, notifications |
| `@towhee/node` | Node WebSocket server with SQLite, also shipped as a Docker image |
| `@towhee/cloudflare` | Worker + Durable Objects |
| `@towhee/client` | Browser and Node client |
| `@towhee/react` | React hooks |
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
