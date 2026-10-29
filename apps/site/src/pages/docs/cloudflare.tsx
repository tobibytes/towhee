import { Code, C } from "../../site/code";
import { GITHUB } from "../../site/layout";
import { A, H1, H2, List, P, Table } from "./layout";

export function Cloudflare() {
  return (
    <>
      <H1 lead="On Cloudflare, each room and each user's inbox is a Durable Object. Sockets hibernate between messages, so an idle room costs nothing.">
        Deploy on Cloudflare
      </H1>

      <H2 id="deploy">Deploy</H2>
      <P>
        Copy <A href={`${GITHUB}/tree/main/packages/cloudflare/template`}>packages/cloudflare/template</A> into a new folder (or use{" "}
        <A href={`${GITHUB}/tree/main/deploy/cloudflare`}>deploy/cloudflare</A> from the repo, which is how this site is deployed), then:
      </P>
      <Code
        code={`npm install
npx wrangler login
node -e "console.log(crypto.randomBytes(32).toString('base64url'))" | npx wrangler secret put TOWHEE_SECRET
npx wrangler deploy`}
      />
      <P>Keep a copy of the secret: your backend signs tokens with it.</P>

      <H2 id="config">wrangler.jsonc</H2>
      <Code
        code={`{
  "name": "towhee",
  "main": "src/index.ts",            // export { default, TowheeInbox, TowheeRoom } from "@towhee/cloudflare";
  "compatibility_date": "2026-10-01",
  "durable_objects": {
    "bindings": [
      { "name": "TOWHEE_ROOMS", "class_name": "TowheeRoom" },
      { "name": "TOWHEE_INBOXES", "class_name": "TowheeInbox" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["TowheeRoom"] },
    { "tag": "v2", "new_sqlite_classes": ["TowheeInbox"] }
  ],
  // Optional: your own domain. Cloudflare creates the DNS record and certificate.
  "routes": [{ "pattern": "towhee.example.com", "custom_domain": true }]
}`}
      />

      <H2 id="settings">Settings</H2>
      <Table
        head={["Name", "Kind", ""]}
        rows={[
          [<C key="1">TOWHEE_SECRET</C>, "secret", "One signing key (id default) for every room"],
          [<C key="2">TOWHEE_KEYS</C>, "secret", "Several keys as JSON, instead of TOWHEE_SECRET"],
          [<C key="3">TOWHEE_WEBHOOK_URL</C>, "var", "POST each notification to your app"],
          [<C key="4">TOWHEE_WEBHOOK_SECRET</C>, "secret", "Signs those webhooks (32+ characters)"],
          [<C key="5">TOWHEE_MAX_CONNECTIONS</C>, "var", "Per room (default 100)"],
          [<C key="6">TOWHEE_MAX_MESSAGE_BYTES</C>, "var", "Default 1 MB"],
          [<C key="7">TOWHEE_MAX_DOCUMENT_BYTES</C>, "var", "Default 50 MB"],
          [<C key="8">TOWHEE_AUTH_TIMEOUT_MS</C>, "var", "Default 10000"],
        ]}
      />

      <H2 id="how">How it runs</H2>
      <List
        items={[
          "The Worker answers /health and routes /v1/rooms/<room> and /v1/inbox/<user> to Durable Objects by name.",
          "Rooms keep the document, threads and versions in Durable Object SQLite; big states are stored in 1 MB chunks.",
          "When an object wakes from hibernation it rebuilds its connections from SQLite and asks clients to resend their presence.",
          "An alarm closes connections that never authenticate or whose token expired.",
        ]}
      />
      <P>
        Then see <A href="/docs/managing">Managing Towhee</A>.
      </P>
    </>
  );
}
