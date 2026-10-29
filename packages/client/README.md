<p><a href="https://towhee.madebytobi.com"><img src="https://raw.githubusercontent.com/tobibytes/towhee/main/apps/site/public/brand/mark.svg" width="48" height="48" alt="Towhee"></a></p>

# @towhee/client

Connect to a [Towhee](https://towhee.madebytobi.com) room from the browser or Node: a synced `Y.Doc`, presence, comments, history and an inbox, with reconnects, offline edits and token refresh.

```ts
import { createClient } from "@towhee/client";

const client = createClient({ url: "wss://towhee.example.com", authEndpoint: "/api/towhee-token" });
const room = client.enter("doc:42");

room.doc.getText("body");            // bind any Yjs editor
room.updatePresence({ cursor: 12 }); // others see it in room.others()
await room.threads.create({ body: "Can we ship this?" });
await room.history.save("Before the rewrite");
client.inbox.subscribe(({ unread }) => console.log(unread));
```

Uses web-standard APIs only (works in browsers, Node 22+, Deno, Bun and Workers). For React, see `@towhee/react`.

Docs: [towhee.madebytobi.com/docs/client](https://towhee.madebytobi.com/docs/client).

---

Part of [Towhee](https://github.com/tobibytes/towhee), realtime collaboration you host yourself. [Docs](https://towhee.madebytobi.com/docs) · [Live demo](https://towhee.madebytobi.com/demo) · MIT
