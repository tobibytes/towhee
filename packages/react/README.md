<p><a href="https://towhee.madebytobi.com"><img src="https://raw.githubusercontent.com/tobibytes/towhee/main/apps/site/public/brand/mark.svg" width="48" height="48" alt="Towhee"></a></p>

# @towhee/react

React hooks for [Towhee](https://towhee.madebytobi.com): rooms, presence, status, threads, history and the inbox.

```tsx
import { createClient } from "@towhee/client";
import { RoomProvider, TowheeProvider, useOthers, useStatus } from "@towhee/react";

const client = createClient({ url: "wss://towhee.example.com", authEndpoint: "/api/towhee-token" });

function App() {
  return (
    <TowheeProvider client={client}>
      <RoomProvider id="doc:42">
        <WhoIsHere />
      </RoomProvider>
    </TowheeProvider>
  );
}

function WhoIsHere() {
  const status = useStatus();
  const others = useOthers();
  return <p>{status}: {others.map((o) => o.user.name).join(", ")}</p>;
}
```

Hooks: `useRoom`, `useStatus`, `useSynced`, `useDoc`, `useSelf`, `useOthers`, `useUpdatePresence`, `useThreads`, `useHistory`, `useInbox`, `useClient`.

- **Strict mode:** `RoomProvider` counts rooms and leaves a tick after the last one unmounts, so React's double mount keeps one connection and one `Y.Doc`.
- **Server rendering:** nothing connects on the server; hooks return their empty values until mounted.
- **No Suspense:** check `ready` on `useThreads`, `useHistory` and `useInbox`.

Docs: [towhee.madebytobi.com/docs/react](https://towhee.madebytobi.com/docs/react).

---

Part of [Towhee](https://github.com/tobibytes/towhee), realtime collaboration you host yourself. [Docs](https://towhee.madebytobi.com/docs) · [Live demo](https://towhee.madebytobi.com/demo) · MIT
