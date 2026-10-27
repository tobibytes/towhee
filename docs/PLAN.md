# Towhee

Towhee is a self-hosted realtime collaboration engine: a Liveblocks replacement you run yourself. It gives an app live presence and cursors, shared state that syncs and works offline, comments and threads, version history, and notifications. It is free and open source (MIT).

The name is a bird. A towhee is a big American sparrow, a cousin of the junco. Towhee is the engine; [Junco](https://github.com/tobibytes/junco) is the design system whose `@junco/collab` UI talks to it through an adapter.

## Who it's for

1. Tobi's apps (Talvra, Itch, the Junco site), running on Tobi's Cloudflare account.
2. Anyone who wants to self-host it, on Cloudflare or on any machine that runs Node or Docker.

It is not a hosted multi-tenant service. There are no accounts, billing or usage dashboards. One deployment serves one owner, who may run several apps on it.

## Decisions

| Topic | Decision |
| --- | --- |
| Repo | Its own repo (`tobibytes/towhee`). Junco only holds the UI and an adapter |
| Sync | Standard Yjs sync (`y-protocols`) over WebSocket, so TipTap, BlockNote, CodeMirror and other Yjs bindings work unchanged |
| Hosts | One host-agnostic core, run by two hosts: Cloudflare (a Durable Object per room) and Node (a WebSocket server, shipped as a Docker image) |
| Storage | Behind an interface. Durable Object SQLite on Cloudflare, SQLite (`node:sqlite`) on Node. Postgres can come later as another implementation |
| Auth | The app's backend mints short-lived room tokens signed with a shared secret. The engine never sees the app's users or passwords |
| v1 features | Presence and cursors, shared state, comments and threads, history, notifications |
| First user | A collaborative docs demo on the Junco site |

## Packages

| Package | Runs in | Purpose |
| --- | --- | --- |
| `@towhee/protocol` | everywhere | Message types and framing, access levels, error codes. No dependencies beyond `lib0` |
| `@towhee/auth` | app backends, hosts | `createRoomToken()` for the app, `verifyRoomToken()` for the hosts. WebCrypto only, so it runs on Workers, Node, Deno and Bun |
| `@towhee/core` | hosts | Rooms: Yjs sync, presence, access checks, limits, comments, history, notifications. Talks to the network through a small `Connection` interface and to storage through `Storage`. No Node or Cloudflare APIs |
| `@towhee/node` | Node | WebSocket server (`ws`) + SQLite storage + config from env. Also the Docker image |
| `@towhee/cloudflare` | Workers | Worker entry + room Durable Object (WebSocket hibernation) + Durable Object SQLite storage |
| `@towhee/client` | browsers, Node | Connects to a room: auth handshake, reconnect with backoff, token refresh, a `Y.Doc`, presence, comments, history and inbox APIs |
| `@towhee/react` | browsers | Hooks: `useRoom`, `useSelf`, `useOthers`, `useThreads`, `useHistory`, `useInbox` |

## How it works

### Connecting

1. The browser asks the app's backend for a token. The backend checks its own session, decides the user's access to the room, and calls `createRoomToken({ user, room, access }, secret)`.
2. The client opens `wss://<host>/v1/rooms/<room>`. The room id is in the path so the host can route to the right Durable Object or in-memory room.
3. The first frame is an `auth` message carrying the token. Tokens never go in the URL, where they would end up in logs. A connection that doesn't authenticate within 10 seconds is closed.
4. The server verifies the token (signature, expiry, room) and replies `ready` with the connection id and the user's access. Sync starts.
5. When the token expires, the server closes the connection with a `token_expired` code. The client fetches a new token and reconnects; Yjs resends anything that didn't arrive.

### Tokens

A compact JWT (HS256 via WebCrypto). Claims:

| Claim | Meaning |
| --- | --- |
| `sub` | User id in the app |
| `room` | Exact room id, or a prefix ending in `*` (`doc:42`, `team:7:*`) |
| `access` | `read`, `comment` or `write` |
| `user` | Display info for presence and comments: `name`, `avatar`, `color` (optional) |
| `exp` | Expiry, at most 24 hours ahead (default 1 hour) |
| `kid` | Which key signed it, for rotation |

A deployment has one or more keys. Each key can be limited to a room prefix, so one deployment can serve Talvra and Itch with separate secrets that can't open each other's rooms.

### Access levels

| | read | comment | write |
| --- | --- | --- | --- |
| Receive document and presence | yes | yes | yes |
| Send presence (cursor, selection) | yes | yes | yes |
| Edit the document | no | no | yes |
| Create threads, reply, react | no | yes | yes |
| Resolve, edit or delete others' comments | no | no | yes |
| Create and restore versions | no | no | yes |

The server enforces this. A read-only client that sends a document update is disconnected with `forbidden`.

### Messages

Binary WebSocket frames. The first varint is the message type:

| Type | Direction | Body |
| --- | --- | --- |
| `auth` | client to server | token |
| `ready` / `error` | server to client | connection id, access / error code and message |
| `sync` | both | a standard `y-protocols/sync` message |
| `awareness` | both | a standard `y-protocols/awareness` update (presence) |
| `request` / `response` | client to server and back | JSON with an id: comments, history and inbox calls |
| `event` | server to client | JSON: thread created, comment added, version saved, notification |

Using the standard sync and awareness messages unchanged keeps Towhee compatible with every Yjs editor binding.

### Rooms

A room is one `Y.Doc` plus its connections. In `@towhee/core`:

- **Sync:** the standard Yjs handshake (state vectors, then missing updates), then live updates broadcast to everyone else in the room.
- **Persistence:** every update is appended to the room's update log. The log is compacted into a single state when it grows past a size or count, and when the room empties.
- **Presence:** Yjs awareness. The server sets each connection's `user` from its token, so nobody can pretend to be someone else, and it clears a connection's presence when it leaves.
- **Limits** (configurable): message size (default 1 MB), document size (default 50 MB), connections per room (default 100), messages per second per connection.
- **Lifecycle:** a room loads from storage on first connect and is unloaded a while after the last one leaves. On Cloudflare the Durable Object hibernates between messages.

### Storage interface

```ts
interface Storage {
  // document
  loadDocument(room: string): Promise<Uint8Array | null>; // merged state + log, as one update
  appendUpdate(room: string, update: Uint8Array): Promise<void>;
  compact(room: string, state: Uint8Array): Promise<void>;
  // history
  saveVersion(room: string, version: VersionInput): Promise<Version>;
  listVersions(room: string, page?: Page): Promise<Version[]>;
  getVersion(room: string, id: string): Promise<VersionWithState | null>;
  // comments
  threads: ThreadStore;
  // notifications
  inbox: InboxStore;
}
```

The core ships an in-memory implementation for tests. Each host ships a durable one, and both run the same shared test suite.

### Comments and threads

- A thread has an id, a room, an anchor, a resolved flag and app metadata. The anchor is either a Yjs relative position range (text that moves with edits) or an app-defined string (a block id, a point on a canvas).
- A comment has an id, its thread, its author (`sub` from the token, plus a copy of `user` display info), a body as a small rich-text JSON (paragraphs, bold, italic, code, links, mentions), reactions, and created, edited and deleted times.
- Changes are stored by the host and pushed to everyone in the room as events.
- Mentions are user ids. The app supplies names for autocomplete through the client (`resolveUsers`); the engine stores only ids.

### History

- **Versions:** the full document state at a point in time, with an author, time and optional name. Saved automatically after a stretch of editing (default: after 5 minutes of activity, at most every 5 minutes) and on request.
- **Preview:** the client loads a version's state into a separate, read-only `Y.Doc`.
- **Restore:** a new update that brings the live document back to the version's content, so the restore itself syncs to everyone and can be undone. How to compute this for any Yjs document is the hardest part of the project. Session 7 prototypes it before building on it.

### Notifications

- A user gets a notification when they are mentioned, or when someone replies in a thread they started or commented in.
- Notifications live in a per-user inbox across rooms, with read and unread state. On Cloudflare that is one Durable Object per user. On Node it is a table.
- A connected client gets new notifications live over an inbox connection (`/v1/inbox`, authenticated with a token for that user).
- The engine can call an app webhook for each notification, signed with HMAC, so the app can send email or push. The engine never sends email itself.

### Hosts

**Node** (`@towhee/node`, Docker image `towhee`): one process, rooms in memory, SQLite on a volume. Configured by env: `TOWHEE_KEYS`, `TOWHEE_DATA`, `TOWHEE_WEBHOOK_URL`, limits. A health endpoint. One instance only in v1. Running several instances needs a pub/sub layer (Redis or Postgres) and comes after v1.

**Cloudflare** (`@towhee/cloudflare`): a Worker routes `/v1/rooms/<room>` to a room Durable Object by name and `/v1/inbox` to the user's inbox Durable Object. Rooms use WebSocket hibernation and Durable Object SQLite storage. Keys are Worker secrets. Deploy with `wrangler deploy` from a template.

## Security

- Tokens are verified on every connection; access is checked on every message.
- Presence identity comes from the token, never from the client.
- Comment bodies are structured JSON that clients render, never HTML.
- Every limit has a default and closes the connection with a clear code when hit.
- Webhooks are signed; keys can be rotated without downtime (`kid`).
- Room ids are validated (length, characters) before they reach storage or Durable Object names.

## Testing

- `@towhee/core` is tested with an in-process transport: several simulated clients converge, read-only clients can't write, late joiners catch up, presence clears on disconnect, limits close connections.
- One storage test suite runs against every `Storage` implementation.
- `@towhee/node` has end-to-end tests with real sockets, including a restart that keeps the document.
- `@towhee/cloudflare` is tested in workerd with `@cloudflare/vitest-pool-workers`, so CI needs no Cloudflare account.
- `@towhee/client` is tested against a real Node host.

## Junco integration

`@junco/collab` (in the Junco repo) holds the UI: avatar stack, cursors, who's-editing bar, comment threads and sidebar, history sidebar, inbox, share and status. It defines an adapter interface and ships two adapters: fake data (for docs and prototypes) and Towhee. It depends on `@towhee/client` only through the Towhee adapter.

## Not in v1

Multiple Node instances, Postgres storage, a hosted multi-tenant service, a dashboard, email sending, end-to-end encryption, Liveblocks API compatibility.
