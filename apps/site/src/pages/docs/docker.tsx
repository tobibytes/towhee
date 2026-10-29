import { Code, C } from "../../site/code";
import { GITHUB } from "../../site/layout";
import { A, H1, H2, List, Note, P, Table } from "./layout";

export function Docker() {
  return (
    <>
      <H1 lead="The Node server keeps rooms in memory and documents in a SQLite file. It runs anywhere Docker or Node 22.18+ does.">
        Run with Docker or Node
      </H1>

      <H2 id="docker">Docker</H2>
      <Code
        code={`docker run -d --name towhee -p 8080:8080 \\
  -e TOWHEE_SECRET="<32+ random characters>" \\
  -v towhee-data:/data --restart unless-stopped ghcr.io/tobibytes/towhee:0.1.0`}
      />
      <P>
        Images are on GitHub Container Registry for amd64 and arm64, tagged with each release and <C>latest</C>. To build one yourself:{" "}
        <C>git clone {GITHUB}.git &amp;&amp; cd towhee &amp;&amp; docker build -t towhee .</C>
      </P>
      <P>
        Or use <A href={`${GITHUB}/blob/main/examples/docker/compose.yaml`}>examples/docker/compose.yaml</A>. The image runs as the{" "}
        <C>node</C> user, stores <C>/data/towhee.sqlite</C> on the volume and has a health check. <C>docker stop</C> saves every room before
        exiting, and clients reconnect when it&apos;s back.
      </P>

      <H2 id="tls">TLS</H2>
      <P>
        Put it behind a proxy that terminates TLS and passes WebSockets (Caddy, nginx, Traefik, a Cloudflare Tunnel). Clients then use{" "}
        <C>wss://your-host</C>.
      </P>
      <Code
        title="Caddyfile"
        code={`towhee.example.com {
  reverse_proxy localhost:8080
}`}
      />

      <H2 id="node">Node, without Docker</H2>
      <Code
        code={`TOWHEE_SECRET=... TOWHEE_DATA=./data/towhee.sqlite npx towhee`}
      />
      <P>Or in code:</P>
      <Code
        code={`import { createServer } from "@towhee/node";

const server = createServer({ keys: [{ id: "default", secret: process.env.TOWHEE_SECRET }], dataPath: "./data/towhee.sqlite" });
await server.listen(8080);
process.on("SIGTERM", () => server.close()); // saves every room`}
      />

      <H2 id="env">Environment</H2>
      <Table
        head={["Variable", "Default", ""]}
        rows={[
          [<C key="1">TOWHEE_SECRET</C>, "", "One signing key, id default"],
          [<C key="2">TOWHEE_KEYS</C>, "", "Several keys as JSON"],
          [<C key="3">TOWHEE_DATA</C>, "./data/towhee.sqlite", "SQLite file"],
          [<C key="4">PORT / TOWHEE_PORT</C>, "8080", ""],
          [<C key="5">TOWHEE_HOST</C>, "0.0.0.0", ""],
          [<C key="12">TOWHEE_ADMIN_SECRET</C>, "", "Turns on the admin API at /v1/admin (32+ characters)"],
          [<C key="6">TOWHEE_UNLOAD_AFTER_MS</C>, "30000", "How long an empty room stays in memory"],
          [<C key="7">TOWHEE_MAX_CONNECTIONS</C>, "100", "Per room"],
          [<C key="8">TOWHEE_MAX_MESSAGE_BYTES</C>, "1048576", ""],
          [<C key="9">TOWHEE_MAX_DOCUMENT_BYTES</C>, "52428800", ""],
          [<C key="10">TOWHEE_WEBHOOK_URL / _SECRET</C>, "", "Notification webhooks"],
        ]}
      />
      <Note title="One instance per data file">
        Rooms live in the server&apos;s memory, so run one instance per SQLite file. Spreading one deployment across several machines
        needs a shared pub/sub layer, which isn&apos;t in v1. For that, use Cloudflare.
      </Note>
      <List items={[<>Health: <C>GET /health</C> → <C>{`{ ok, rooms, connections }`}</C></>]} />
    </>
  );
}
