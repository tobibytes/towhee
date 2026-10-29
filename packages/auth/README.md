# @towhee/auth

Room tokens for [Towhee](https://towhee.madebytobi.com). Your backend signs a short-lived token for each user and room after its normal session check; the Towhee server verifies it. Standard HS256 JWTs on WebCrypto, so it runs in Node, Workers, Deno and Bun.

```ts
import { createInboxToken, createRoomToken } from "@towhee/auth";
import { INBOX_ROOM } from "@towhee/protocol";

// POST /api/towhee-token  { room }
const key = { id: "default", secret: process.env.TOWHEE_SECRET! };
const token =
  room === INBOX_ROOM
    ? await createInboxToken({ userId: user.id }, key)
    : await createRoomToken({ userId: user.id, room, access: "write", user: { name: user.name } }, key);
return Response.json({ token });
```

Also: `generateSecret()`, keys limited to a room prefix (`{ id, secret, rooms: "acme:*" }`), and `verifyWebhook` for Towhee's signed notification webhooks.

Docs: [towhee.madebytobi.com/docs/tokens](https://towhee.madebytobi.com/docs/tokens).
