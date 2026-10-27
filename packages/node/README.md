# @towhee/node

Run Towhee on Node 22.18 or newer: a WebSocket server with SQLite storage. Rooms are served at `/v1/rooms/<room>`, plus `GET /health`.

## Docker

```bash
docker build -t towhee .            # from the repo root
docker run -p 8080:8080 \
  -e TOWHEE_SECRET="$(node -e "console.log(crypto.randomBytes(32).toString('base64url'))")" \
  -v towhee-data:/data towhee
```

Or `examples/docker/compose.yaml`. The image runs as the `node` user, keeps its SQLite file in `/data`, has a health check, and on `docker stop` saves every room before exiting.

## Command

```bash
TOWHEE_SECRET=... npx towhee
```

| Variable | Default | |
| --- | --- | --- |
| `TOWHEE_SECRET` | | One signing key (id `default`) for every room |
| `TOWHEE_KEYS` | | Several keys instead, as JSON: `[{"id":"talvra","secret":"...","rooms":"talvra:*"}]` |
| `TOWHEE_DATA` | `./data/towhee.sqlite` | SQLite file |
| `PORT` / `TOWHEE_PORT` | `8080` | |
| `TOWHEE_HOST` | `0.0.0.0` | |
| `TOWHEE_UNLOAD_AFTER_MS` | `30000` | How long an empty room stays in memory |
| `TOWHEE_MAX_CONNECTIONS` | `100` | Per room |
| `TOWHEE_MAX_MESSAGE_BYTES` | `1048576` | |
| `TOWHEE_MAX_DOCUMENT_BYTES` | `52428800` | |

## In code

```ts
import { createServer } from "@towhee/node";

const server = createServer({ keys: [{ id: "main", secret: process.env.TOWHEE_SECRET! }], dataPath: "./data/towhee.sqlite" });
await server.listen(8080);
// later: await server.close();  // saves every room
```

Run one instance per data file: rooms live in that process's memory.
