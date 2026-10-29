import { Code, C } from "../../site/code";
import { H1, H2, List, P, Table } from "./layout";

export function Tokens() {
  return (
    <>
      <H1 lead="Towhee never sees your users' passwords or sessions. Your backend decides who may open a room and signs a short-lived token saying so.">
        Tokens and access
      </H1>

      <H2 id="room-tokens">Room tokens</H2>
      <Code
        code={`import { createRoomToken } from "@towhee/auth";

const token = await createRoomToken(
  {
    userId: user.id,                                  // shown to others as user.id
    room: "doc:42",                                   // or a pattern: "team:7:*"
    access: "comment",                                // "read" | "comment" | "write"
    user: { name: user.name, avatar: user.avatarUrl, color: "#0ea5e9" },
    expiresIn: 3600,                                  // seconds, default 1 hour, at most 24 hours
  },
  { id: "default", secret: process.env.TOWHEE_SECRET },
);`}
      />
      <P>
        Tokens are standard HS256 JWTs (<C>sub</C>, <C>room</C>, <C>access</C>, <C>user</C>, <C>iat</C>, <C>exp</C>, header <C>kid</C>), so
        backends in other languages can mint them with any JWT library. Clients send them in the first WebSocket message, never in
        the URL. When one expires, the client asks for a new one and reconnects without losing edits.
      </P>

      <H2 id="access">Access levels</H2>
      <Table
        head={["", "read", "comment", "write"]}
        rows={[
          ["See the document and presence", "yes", "yes", "yes"],
          ["Share presence (cursor, selection)", "yes", "yes", "yes"],
          ["Edit the document", "no", "no", "yes"],
          ["Start threads, reply, react", "no", "yes", "yes"],
          ["Edit, delete or resolve your own comments and threads", "no", "yes", "yes"],
          ["…anyone's", "no", "no", "yes"],
          ["Save and restore versions", "no", "no", "yes"],
        ]}
      />
      <P>The server checks every message. A reader that sends an edit is disconnected with <C>forbidden</C>.</P>

      <H2 id="rooms">Room ids and patterns</H2>
      <List
        items={[
          <>Room ids: letters, digits and <C>. _ : -</C>, starting with a letter or digit, up to 128 characters.</>,
          <>A token for <C>team:7:*</C> opens every room starting with <C>team:7:</C>; <C>*</C> opens all.</>,
          <>Ids ending in <C>towhee.inbox</C> are reserved for inboxes.</>,
        ]}
      />

      <H2 id="keys">Keys, rotation and several apps</H2>
      <P>
        A deployment has one or more keys. Set <C>TOWHEE_SECRET</C> for one key (id <C>default</C>, all rooms), or <C>TOWHEE_KEYS</C> for
        several:
      </P>
      <Code
        code={`TOWHEE_KEYS='[
  { "id": "talvra", "secret": "...", "rooms": "talvra:*" },
  { "id": "itch",   "secret": "...", "rooms": "itch:*" }
]'`}
      />
      <List
        items={[
          "A key limited to a room pattern can only sign and open rooms inside it, so two apps on one deployment can't open each other's rooms.",
          "Each app's users get their own notification inboxes, even if user ids collide.",
          "To rotate: add the new key next to the old one, deploy, switch your backend to the new key, then remove the old one. Tokens name their key (kid), so both work in between.",
          "Secrets must be at least 32 characters. Make one with: node -e \"console.log(crypto.randomBytes(32).toString('base64url'))\"",
        ]}
      />

      <H2 id="inbox">Inbox tokens</H2>
      <Code
        code={`import { createInboxToken } from "@towhee/auth";

// When the client asks for room "towhee.inbox":
const token = await createInboxToken({ userId: user.id, user: { name: user.name } }, key);`}
      />
      <P>An inbox token opens only that user&apos;s notifications and can&apos;t open any document.</P>
    </>
  );
}
