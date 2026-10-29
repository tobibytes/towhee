---
"@towhee/protocol": minor
"@towhee/core": minor
"@towhee/node": minor
"@towhee/cloudflare": minor
"@towhee/client": patch
---

Admin API: set `TOWHEE_ADMIN_SECRET` to get `/v1/admin/rooms/<room>` (info), `/export`, `/kick` and `DELETE` on both hosts. New close codes `room_deleted` and `removed` stop clients from reconnecting. `Storage` gains `deleteRoom` (custom storages need to add it).
