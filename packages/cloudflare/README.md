<p><a href="https://towhee.madebytobi.com"><img src="https://raw.githubusercontent.com/tobibytes/towhee/main/apps/site/public/brand/mark.svg" width="48" height="48" alt="Towhee"></a></p>

# @towhee/cloudflare

Run Towhee on Cloudflare: a Worker routes `/v1/rooms/<room>` to one Durable Object per room. Rooms use WebSocket hibernation, so an idle room costs nothing while its sockets stay open, and keep their documents in Durable Object SQLite.

## Deploy

Copy [`template/`](template) into a new folder, then:

```bash
npm install
npx wrangler secret put TOWHEE_SECRET   # a random string of at least 32 characters
npx wrangler deploy
```

Clients connect to `wss://towhee.<your-subdomain>.workers.dev` (or a custom domain on the Worker). Your app signs tokens with the same secret, key id `default`:

```ts
import { createRoomToken } from "@towhee/auth";
const token = await createRoomToken({ userId, room, access: "write" }, { id: "default", secret: process.env.TOWHEE_SECRET });
```

## Settings

| Name | Kind | |
| --- | --- | --- |
| `TOWHEE_SECRET` | secret | One signing key (id `default`) for every room |
| `TOWHEE_KEYS` | secret | Several keys as JSON: `[{"id":"talvra","secret":"...","rooms":"talvra:*"}]` |
| `TOWHEE_MAX_CONNECTIONS` | var | Per room (100) |
| `TOWHEE_MAX_MESSAGE_BYTES` | var | 1048576 |
| `TOWHEE_MAX_DOCUMENT_BYTES` | var | 52428800 |
| `TOWHEE_AUTH_TIMEOUT_MS` | var | 10000 |
| `TOWHEE_WEBHOOK_URL` | var | POST each notification here |
| `TOWHEE_WEBHOOK_SECRET` | secret | Signs webhooks (at least 32 characters) |
| `TOWHEE_EXPIRE_ROOMS` | var | Wipe rooms matching this pattern (like `demo:*`) once they expire, when nobody is in them |
| `TOWHEE_EXPIRE_AFTER_HOURS` | var | How long those rooms live (24) |

## How it works

- The Worker answers `GET /health` and checks the room id before it reaches a Durable Object.
- Each room runs `@towhee/core` in manual timer mode: no `setTimeout` or `setInterval`, so the object can hibernate. Auth timeouts, token expiry and stale presence are handled by the Durable Object alarm.
- Each connection's state (user, access, expiry, presence ownership) is stored in SQLite and its id in the socket's attachment. When a hibernated room wakes, it rebuilds its connections from them and asks clients to resend their presence.
- The compacted document is stored in 1 MB chunks (Durable Object SQLite rows are capped at 2 MB).
- Each user's inbox is its own Durable Object (`TowheeInbox`, at `/v1/inbox/<user>`). Rooms hand it notifications over RPC; it stores them, shows them live and sends the webhook.

---

Part of [Towhee](https://github.com/tobibytes/towhee), realtime collaboration you host yourself. [Docs](https://towhee.madebytobi.com/docs) · [Live demo](https://towhee.madebytobi.com/demo) · MIT
