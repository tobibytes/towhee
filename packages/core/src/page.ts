/**
 * What a browser sees at a Towhee server's root: what this is, and where to go next. Both hosts
 * serve it, so the bare URL isn't a "Not found".
 */
export function landingPage(origin: string): string {
  const ws = origin.replace(/^http/, "ws");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Towhee</title>
<meta name="description" content="A self-hosted realtime collaboration server: presence, shared documents, comments, history and notifications.">
<style>
  :root { color-scheme: light dark; --fg: #18181b; --muted: #52525b; --bg: #fafafa; --code: #f4f4f5; --border: #e4e4e7; }
  @media (prefers-color-scheme: dark) { :root { --fg: #fafafa; --muted: #a1a1aa; --bg: #09090b; --code: #18181b; --border: #27272a; } }
  body { font: 16px/1.6 system-ui, sans-serif; color: var(--fg); background: var(--bg); max-width: 42rem; margin: 3rem auto; padding: 0 1rem; }
  p, li { color: var(--muted); } h1, h2 { line-height: 1.2; } a { color: inherit; }
  code, pre { font: 14px ui-monospace, monospace; background: var(--code); border-radius: 6px; }
  code { padding: .1rem .3rem; } pre { padding: .75rem 1rem; overflow-x: auto; border: 1px solid var(--border); }
</style>
</head>
<body>
<h1>Towhee</h1>
<p>A realtime collaboration server you run yourself: live presence and cursors, a shared document that syncs and works offline (Yjs), comments and threads, version history, and per-user notifications.</p>
<p>This is an API server. Apps connect to it with <code>@towhee/client</code>; there's nothing to use in a browser here.</p>
<h2>Endpoints</h2>
<ul>
<li><code>${ws}/v1/rooms/&lt;room&gt;</code>: a room's document, presence, comments and history (WebSocket)</li>
<li><code>${ws}/v1/inbox/&lt;user&gt;</code>: a user's notifications (WebSocket)</li>
<li><code>${origin}/health</code>: is it up</li>
</ul>
<h2>Connect an app</h2>
<pre>import { createClient } from "@towhee/client";

const client = createClient({ url: "${ws}", authEndpoint: "/api/towhee-token" });
const room = client.enter("doc:42");</pre>
<p>Your backend signs a short-lived token for each room with <code>createRoomToken</code> from <code>@towhee/auth</code>.</p>
<p><a href="https://github.com/tobibytes/towhee">Code and docs on GitHub</a> · MIT</p>
</body>
</html>
`;
}
