// CI smoke test for the Docker image. `write` stores text in a room; `read` checks it's still there
// (run after a container restart). Needs SMOKE_SECRET (the container's TOWHEE_SECRET) and the
// workspace packages built.
import { createRoomToken } from "@towhee/auth";
import { createClient } from "@towhee/client";

const mode = process.argv[2];
const url = process.env.SMOKE_URL ?? "ws://127.0.0.1:8080";
const secret = process.env.SMOKE_SECRET;
if (!secret || (mode !== "write" && mode !== "read")) {
  console.error("Usage: SMOKE_SECRET=... node docker-smoke.mjs write|read");
  process.exit(2);
}
const expected = "stored in docker";
const key = { id: "default", secret };
const client = createClient({ url, authEndpoint: (room) => createRoomToken({ userId: "smoke", room, access: "write" }, key) });
const room = client.enter("smoke:check");

const deadline = Date.now() + 15_000;
while (!room.synced) {
  if (Date.now() > deadline) {
    console.error(`No sync: status ${room.status}, error ${JSON.stringify(room.lastError)}`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
if (mode === "write") {
  room.doc.getText("t").insert(0, expected);
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const text = room.doc.getText("t").toString();
room.leave();
console.log(`${mode}: ${JSON.stringify(text)}`);
process.exit(text === expected ? 0 : 1);
