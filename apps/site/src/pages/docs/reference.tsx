import { C } from "../../site/code";
import { H1, H2, P, Table } from "./layout";

export function Reference() {
  return (
    <>
      <H1 lead="What a Towhee server exposes, the limits it enforces, and the errors it closes connections with.">Endpoints, limits and errors</H1>

      <H2 id="endpoints">Endpoints</H2>
      <Table
        head={["Path", ""]}
        rows={[
          [<C key="1">GET /</C>, "A page describing the server"],
          [<C key="2">GET /health</C>, "Liveness"],
          [<C key="3">wss /v1/rooms/&lt;room&gt;</C>, "A room: document, presence, threads, history. First frame must be auth with a room token"],
          [<C key="4">wss /v1/inbox/&lt;user&gt;</C>, "A user's notifications, with an inbox token for that user"],
          [<C key="5">GET /v1/admin/rooms/&lt;room&gt;</C>, "Admin: connections, users, document size, thread and version counts"],
          [<C key="6">GET /v1/admin/rooms/&lt;room&gt;/export</C>, "Admin: document (base64 Yjs update), threads and versions"],
          [<C key="7">POST /v1/admin/rooms/&lt;room&gt;/kick</C>, "Admin: disconnect a user, { \"userId\": \"...\" }"],
          [<C key="8">DELETE /v1/admin/rooms/&lt;room&gt;</C>, "Admin: disconnect everyone and delete the room's data"],
        ]}
      />

      <H2 id="limits">Limits</H2>
      <Table
        head={["Limit", "Default", "When hit"]}
        rows={[
          ["Frame size", "1 MB", "message_too_large"],
          ["Document size", "50 MB", "document_too_large"],
          ["Connections per room (including ones authenticating)", "100", "room_full"],
          ["Messages per second per connection", "120", "rate_limited"],
          ["Time to authenticate", "10 s", "auth_timeout"],
          ["Presence ids per connection", "8", "extra ones ignored"],
          ["Token lifetime", "1 h default, 24 h max", "token_expired"],
          ["Comment body", "8 KB", "request error"],
          ["Comments per thread / threads per room", "200 / 5000", "request error"],
          ["Automatic versions kept", "50 (saved ones all kept)", "oldest deleted"],
          ["Notifications kept per user", "500", "oldest deleted"],
        ]}
      />
      <P>Documents are compacted after 500 updates or 4 MB of log, and when a room empties. Automatic versions are saved after 5 minutes of changes.</P>

      <H2 id="errors">Errors and close codes</H2>
      <Table
        head={["Code", "Close", "Client does"]}
        rows={[
          ["protocol_error", "4000", "stops"],
          ["unauthorized", "4001", "stops"],
          ["token_expired", "4002", "gets a new token, reconnects at once"],
          ["forbidden", "4003", "stops"],
          ["not_found", "4004", "stops (request errors use it too)"],
          ["invalid_room", "4005", "stops"],
          ["unsupported_protocol", "4006", "stops"],
          ["auth_timeout", "4008", "retries"],
          ["message_too_large", "4009", "stops"],
          ["document_too_large", "4010", "stops"],
          ["room_full", "4011", "retries with backoff"],
          ["server_restarting", "4012", "retries with backoff"],
          ["room_deleted", "4013", "stops (an admin deleted the room)"],
          ["removed", "4014", "stops (an admin removed this user)"],
          ["rate_limited", "4029", "retries with backoff"],
          ["internal", "4500", "retries with backoff"],
        ]}
      />
    </>
  );
}
