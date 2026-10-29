# Sessions

Towhee is built in sessions. Each session is one branch and one PR that ends with something working and tested. Do them in order: each one builds on the last. Read `PLAN.md` before starting any of them.

A session is done when its "Done when" list is true, CI is green and the PR is merged. Tick the boxes in the same PR.

## 0. Repo, plan and tooling

- [x] `PLAN.md`, `SESSIONS.md`, `AGENTS.md`, README, MIT license
- [x] pnpm workspaces, Turborepo, TypeScript (strict), tsup, Vitest, Biome, Changesets
- [x] CI: lint, build, typecheck, test on every PR
- [x] Release workflow with npm Trusted Publishing (needs the `@towhee` npm org before the first publish)

**Done when:** `pnpm install && pnpm lint && pnpm build && pnpm typecheck && pnpm test` passes on a fresh clone and in CI.

## 1. Protocol and tokens

- [x] `@towhee/protocol`: message types and binary framing, access levels, close and error codes, room id validation
- [x] `@towhee/auth`: `createRoomToken`, `verifyRoomToken` (HS256, WebCrypto), several keys with `kid`, keys limited to a room prefix, expiry cap

**Done when:** every message type round-trips through encode and decode; tokens with a bad signature, a wrong room, an expired time, an unknown `kid` or a key used outside its prefix are rejected; the same tests pass on Node and in workerd.

## 2. Core room

- [x] `@towhee/core`: `Room` with Yjs sync and awareness over a `Connection` interface
- [x] Auth handshake (`auth` then `ready`, 10 second timeout), access checks per message
- [x] Presence identity set from the token; presence cleared on disconnect
- [x] `Storage` interface, in-memory implementation, update log and compaction
- [x] Limits: message size, document size, connections per room, message rate
- [x] Shared storage test suite that later hosts reuse

**Done when:** with an in-process transport, three clients editing at once converge; a late joiner catches up; a read-only client's edit is refused and it is disconnected; presence disappears when a client leaves; a room unloaded and loaded again has the same document; each limit closes the connection with its code.

## 3. Client SDK

- [x] `@towhee/client`: `createClient({ url, authEndpoint })` (a URL or a function), `client.enter(roomId)` returning a room with a `Y.Doc`
- [x] Reconnect with backoff and jitter, token refresh on `token_expired`, connection status events
- [x] Presence API: `setPresence`, `others`, `self`, subscribe
- [x] Works with an existing `Y.Doc` so editor bindings can use it

**Done when:** two clients against an in-process core converge; a dropped connection reconnects and catches up; an expired token is refreshed without losing edits made offline; status events fire in order.

## 4. Node host and Docker

- [x] `@towhee/node`: WebSocket server, routing `/v1/rooms/<room>`, health endpoint, config from env
- [x] SQLite storage (`node:sqlite`) passing the shared storage suite
- [x] Docker image and a `docker compose` example with a volume
- [x] Graceful shutdown: compact rooms, close connections with a "server restarting" code

**Done when:** end-to-end tests with real sockets pass: two clients converge; the server restarts and the document is still there; a bad token is refused. The Docker image builds and runs in CI.

## 5. Cloudflare host

- [x] `@towhee/cloudflare`: Worker entry, room Durable Object with WebSocket hibernation
- [x] Durable Object SQLite storage passing the shared storage suite
- [x] Keys as Worker secrets; a `wrangler.jsonc` template; deploy guide
- [x] Tests in workerd with `@cloudflare/vitest-plugin` (the renamed `vitest-pool-workers`)

**Done when:** the client converges against the Worker in workerd tests; a hibernated room wakes with its document and presence intact; `wrangler deploy` of the template works on a real account (checked by Tobi).

## 6. Comments and threads

- [x] Thread and comment model, anchors (Yjs relative positions or app strings), rich-text body JSON, mentions, reactions, resolve, edit, delete
- [x] Storage in both hosts; events pushed to the room
- [x] Client API: `room.threads` (list, subscribe, create, reply, react, resolve, edit, delete)
- [x] Access rules from `PLAN.md` enforced

**Done when:** a thread created by one client appears live for another; an anchored thread stays on its text through edits; `read` clients can't comment and `comment` clients can't edit the document; both hosts pass the same tests.

## 7. History

- [x] Prototype restore for any Yjs document first, and write down how it works in `PLAN.md`
- [x] Automatic and manual versions, list, preview (read-only `Y.Doc`), restore as a normal update that syncs and can be undone
- [x] Storage in both hosts

**Done when:** restoring a version gives every client the old content, for text, maps, arrays and XML (TipTap) documents; the restore can be undone; both hosts pass the same tests.

## 8. Notifications

- [x] Inbox per user across rooms (Durable Object per user on Cloudflare, a table on Node)
- [x] Notifications for mentions and replies; read and unread; mark all read
- [x] Live delivery over `/v1/inbox`; signed webhook to the app
- [x] Client API: `client.inbox`

**Done when:** mentioning a user puts a notification in their inbox live, in both hosts; read state syncs across their tabs; the webhook arrives with a valid signature and retries on failure.

## 8b. Site and live demo

- [x] `apps/site`: landing page, docs (client, tokens, Cloudflare, Docker, managing a server, reference) and examples, built with Junco
- [x] Towhee Board demo at `/demo`: cards on a shared Yjs map, cursors, comments with mentions, inbox, history restore with undo
- [x] Demo token endpoint in `deploy/cloudflare` (anonymous bird names, a cookie per browser, `demo:*` rooms only, its own key, rate limited)
- [x] Screenshots in `apps/site/public/screenshots`, light and dark, taken with two users on one board
- [x] Mentions carry an optional `name`, so inbox excerpts and webhooks read "@Ada" rather than a user id

**Done when:** two browsers on towhee.madebytobi.com/demo see each other's cursors and edits, mention each other into their inboxes, and restore a version.

## 9. React

- [x] `@towhee/react`: `TowheeProvider`, `RoomProvider`, `useRoom`, `useStatus`, `useSelf`, `useOthers`, `useUpdatePresence`, `useThreads`, `useHistory`, `useInbox`
- [x] Suspense-free by default, safe with React 19 strict mode and server rendering

**Done when:** hooks are tested with Testing Library against an in-process server, including strict-mode double mounts.

## 10. Junco UI (in the Junco repo)

- [x] `@junco/collab`: adapter interface and a fake-data adapter (junco#47)
- [x] UI from Junco components: avatar stack, live cursors, who's-editing bar, comment threads and sidebar, history sidebar, inbox, connection status
- [x] Towhee adapter on `@towhee/client` (`towheeAdapter`, typed by shape; checked against real clients and core rooms)
- [x] Docs pages and tests. Installed package only for now, like `@junco/motion`; registry copy-in items later

**Done when:** every collab component works on fake data in the Junco docs, and the same components work against a local Towhee server.

## 11. Collaborative docs demo

- [x] A docs editor page on the Junco site: TipTap on Yjs, with cursors, comments, history and inbox through Towhee (junco /editor, `@junco/editor`)
- [ ] A Towhee deployment on Tobi's Cloudflare account and a small token endpoint for the demo (anonymous users, demo rooms only, rooms reset daily). The deployment, token endpoint and daily reset (`TOWHEE_EXPIRE_ROOMS`) exist since 8b

**Done when:** two browsers on the live Junco site edit, comment and restore versions together.

## 13. Admin API

- [x] `TOWHEE_ADMIN_SECRET` turns on `/v1/admin` on both hosts: room info, export, kick a user, delete a room
- [x] Close codes `room_deleted` and `removed`, which stop clients instead of reconnecting
- [x] `Storage.deleteRoom`, covered by the shared storage suite
- [ ] Listing rooms (needs an index on Cloudflare)

## 12. Release v0.1

- [x] Remove `"private": true` from each package and add changesets (packages stay private until now, so merges don't try to publish)
- [ ] `@towhee` npm org and trusted publishers (Tobi), first publish. Steps in `docs/RELEASING.md`
- [x] README and docs: quick start, self-hosting on Cloudflare and with Docker, tokens and access, API reference
- [x] Docker image to GitHub Container Registry: the Release workflow pushes it with each `@towhee/node` release; the "Docker image" workflow pushes the first one

**Done when:** a new project can follow the README from zero to a working shared document on both hosts.
