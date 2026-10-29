import { Code, C } from "../../site/code";
import { GITHUB } from "../../site/layout";
import { A, H1, H2, List, Note, P } from "./layout";

export function Managing() {
  return (
    <>
      <H1 lead="Day-to-day running of a Towhee deployment: checking it's healthy, reading logs, rotating keys, changing limits, webhooks, upgrades and backups.">
        Managing Towhee
      </H1>

      <H2 id="health">Is it up?</H2>
      <Code
        code={`curl https://towhee.example.com/health
# {"ok":true}                               on Cloudflare
# {"ok":true,"rooms":3,"connections":7}     on Node`}
      />
      <P>Point an uptime monitor at <C>/health</C>. The root URL shows a page describing the server.</P>

      <H2 id="smoke">Check everything works</H2>
      <P>
        <A href={`${GITHUB}/blob/main/deploy/cloudflare/smoke.mjs`}>deploy/cloudflare/smoke.mjs</A> runs a real session against a live
        deployment: two clients sync, presence, a comment thread, a mention reaching the inbox, saving and restoring a version, a late
        joiner, and a bad token being refused.
      </P>
      <Code
        code={`cd deploy/cloudflare
TOWHEE_SECRET="<the deployment's secret>" node smoke.mjs https://towhee.example.com
# ok   GET /health -> {"ok":true}
# ok   two clients synced in smoke:..., inbox open
# ...
# All checks passed`}
      />

      <H2 id="logs">Logs</H2>
      <List
        items={[
          <>Cloudflare: <C>npx wrangler tail towhee</C> streams live logs; with <C>observability</C> on, they&apos;re also in the dashboard under Workers → towhee → Logs.</>,
          <>Docker: <C>docker logs -f towhee</C>. Node: stdout.</>,
          <>Storage failures and bugs are logged as <C>[towhee] room …</C> or <C>[towhee] inbox …</C>.</>,
        ]}
      />

      <H2 id="keys">Rotate a key</H2>
      <List
        items={[
          <>Add the new key next to the old one in <C>TOWHEE_KEYS</C> (new <C>id</C>, same <C>rooms</C>) and deploy.</>,
          "Switch your backend to sign with the new key. Connected users keep working: tokens name their key.",
          "After the longest token lifetime (default 1 hour), remove the old key and deploy again.",
        ]}
      />
      <Code
        title="Cloudflare"
        code={`npx wrangler secret put TOWHEE_KEYS   # paste the JSON array
npx wrangler deploy`}
      />

      <H2 id="limits">Change limits</H2>
      <P>
        Set <C>TOWHEE_MAX_CONNECTIONS</C>, <C>TOWHEE_MAX_MESSAGE_BYTES</C>, <C>TOWHEE_MAX_DOCUMENT_BYTES</C> (and on Node{" "}
        <C>TOWHEE_UNLOAD_AFTER_MS</C>) as vars or env and redeploy. Defaults are in the <A href="/docs/reference#limits">reference</A>.
      </P>

      <H2 id="webhooks">Notification webhooks</H2>
      <P>
        Set <C>TOWHEE_WEBHOOK_URL</C> and <C>TOWHEE_WEBHOOK_SECRET</C>. Each notification is POSTed as{" "}
        <C>{`{ type: "notification", userId, scope, notification }`}</C>, signed, and retried after 1, 5 and 25 seconds if your app is
        down. Check the signature before trusting it:
      </P>
      <Code
        code={`import { verifyWebhook } from "@towhee/auth";

export async function POST(request) {
  const body = await request.text();
  const ok = await verifyWebhook(process.env.TOWHEE_WEBHOOK_SECRET, {
    body,
    timestamp: request.headers.get("x-towhee-timestamp"),
    signature: request.headers.get("x-towhee-signature"),
  });
  if (!ok) return new Response("Bad signature", { status: 401 });
  const { userId, notification } = JSON.parse(body);
  await sendEmail(userId, notification.excerpt);
  return new Response(null, { status: 204 });
}`}
      />

      <H2 id="upgrade">Upgrade</H2>
      <List
        items={[
          <>Pull the new version and deploy (<C>wrangler deploy</C>, or rebuild and restart the container).</>,
          <>Clients see <C>server_restarting</C> (Node) or a dropped socket, reconnect within seconds and resync. Nothing is lost: documents, threads and versions are in storage.</>,
          "Run the smoke test afterwards.",
        ]}
      />

      <H2 id="backups">Backups</H2>
      <List
        items={[
          <>Node: back up the SQLite file while it runs with <C>sqlite3 /data/towhee.sqlite ".backup /backups/towhee-$(date +%F).sqlite"</C>, or snapshot the volume.</>,
          "Cloudflare: Durable Object storage is replicated by Cloudflare. SQLite-backed Durable Objects can also be restored to any point in the last 30 days with Cloudflare's point-in-time recovery API (ctx.storage bookmarks, called from inside the object). Towhee doesn't expose a command for it yet.",
          "Rooms also keep their own version history: 50 automatic versions plus every saved one.",
        ]}
      />

      <H2 id="data">Deleting data</H2>
      <P>
        Room ids are yours to choose: putting a tenant or document id in them (<C>acme:doc:42</C>) makes them easy to find. On Node, rooms
        are rows in the SQLite file, keyed by room id. Notifications keep the newest 500 per user.
      </P>
      <Note title="Coming later">
        An admin API (list rooms, export and delete a room, revoke a user) is planned. Today, managing data means working with the
        storage directly.
      </Note>
    </>
  );
}
