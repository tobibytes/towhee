# @towhee/client

## 0.1.2

### Patch Changes

- 5a7d088: Admin API: set `TOWHEE_ADMIN_SECRET` to get `/v1/admin/rooms/<room>` (info), `/export`, `/kick` and `DELETE` on both hosts. New close codes `room_deleted` and `removed` stop clients from reconnecting. `Storage` gains `deleteRoom` (custom storages need to add it).
- Updated dependencies [5a7d088]
  - @towhee/protocol@0.2.0

## 0.1.1

### Patch Changes

- 24566ff: New logo and README on npm, clearer package descriptions.
- Updated dependencies [24566ff]
  - @towhee/protocol@0.1.1

## 0.1.0

### Minor Changes

- 61d5979: First release: rooms with Yjs sync and presence, comments with mentions and reactions, version history with restore, per-user inboxes with webhooks, hosts for Cloudflare (Durable Objects, expiring rooms) and Node (also a Docker image), the browser client and React hooks.

### Patch Changes

- Updated dependencies [61d5979]
  - @towhee/protocol@0.1.0
