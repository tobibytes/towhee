---
"@towhee/core": minor
"@towhee/node": minor
"@towhee/cloudflare": minor
---

The admin API lists rooms: `GET /v1/admin/rooms?prefix=&cursor=&limit=`. Node reads them from storage (`Storage.listRooms`, optional); Cloudflare keeps an index in a new `TowheeDirectory` Durable Object. Add its binding and a `v3` migration (see the template) and export it from your Worker; rooms made earlier join the index on their next visit.
