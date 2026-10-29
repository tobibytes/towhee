import { Code, C } from "../../site/code";
import { GITHUB } from "../../site/layout";
import { A, H1, H2, List, P } from "./layout";

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
      <P>
        For throwaway rooms (demos, previews, test runs) set <C>TOWHEE_EXPIRE_ROOMS</C> to a pattern like <C>demo:*</C> on Cloudflare.
        Matching rooms are wiped once they&apos;re older than <C>TOWHEE_EXPIRE_AFTER_HOURS</C> (default 24): document, threads,
        versions, everything. A room that still has people in it waits until the last one leaves. Someone who kept the old board open
        offline and comes back later brings their copy with them, as with any Yjs document.
      </P>
      <H2 id="admin">Admin API</H2>
      <P>
        Set <C>TOWHEE_ADMIN_SECRET</C> (32+ random characters; a Worker secret on Cloudflare) to turn on{" "}
        <C>/v1/admin</C>. Every request needs <C>Authorization: Bearer &lt;secret&gt;</C>. Without the secret the API doesn&apos;t exist.
      </P>
      <Code
        title="Look, export, remove someone, delete"
        code={`A="Authorization: Bearer $TOWHEE_ADMIN_SECRET"
curl -H "$A" "https://towhee.example.com/v1/admin/rooms?prefix=doc:"   # room ids, 100 a page (cursor=, limit=)
curl -H "$A" https://towhee.example.com/v1/admin/rooms/doc:42          # who's here, sizes, counts
curl -H "$A" https://towhee.example.com/v1/admin/rooms/doc:42/export   # document (base64 Yjs), threads, versions
curl -H "$A" -X POST -d '{"userId":"u_123"}' https://towhee.example.com/v1/admin/rooms/doc:42/kick
curl -H "$A" -X DELETE https://towhee.example.com/v1/admin/rooms/doc:42`}
      />
      <List
        items={[
          <>
            <C>kick</C> closes that user&apos;s connections with <C>removed</C>, and their client stops instead of reconnecting. Their
            token stays valid until it expires, so also stop your token endpoint from signing new ones for them.
          </>,
          <>
            <C>DELETE</C> closes everyone with <C>room_deleted</C> (clients stop, so nobody writes the old copy back) and erases the
            document, update log, threads and versions. Notifications already in inboxes stay.
          </>,
          <>
            The export&apos;s <C>document</C> is one Yjs update: <C>Y.applyUpdate(new Y.Doc(), base64Decode(document))</C> rebuilds it.
          </>,
          <>
            The room list comes from storage on Node. On Cloudflare it needs the <C>TOWHEE_DIRECTORY</C> binding (a small index rooms add
            themselves to; rooms from before you add it join on their next visit).
          </>,
        ]}
      />
    </>
  );
}
