// End-to-end check of a live deployment: health, sync, presence, comments, inbox, history, and
// bad tokens refused. Needs the deployment's secret:
//   TOWHEE_SECRET=... node smoke.mjs [https://towhee.madebytobi.com]
import { createInboxToken, createRoomToken } from "@towhee/auth";
import { createClient } from "@towhee/client";

const base = (process.argv[2] ?? "https://towhee.madebytobi.com").replace(/\/$/, "");
const secret = process.env.TOWHEE_SECRET;
if (!secret) {
  console.error("Set TOWHEE_SECRET");
  process.exit(2);
}
const key = { id: "default", secret };
const wsUrl = base.replace(/^http/, "ws");
const room = `smoke:${Date.now().toString(36)}`;
const cleanup = [];
let failed = false;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
}
async function until(cond, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) {
      check(false, `${what} (timed out)`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}
const signIn = (userId) =>
  createClient({
    url: wsUrl,
    authEndpoint: (r) => (r === "towhee.inbox" ? createInboxToken({ userId, user: { name: userId } }, key) : createRoomToken({ userId, room: r, access: "write", user: { name: userId } }, key)),
  });
const text = (c) => c.doc.getText("t").toString();

try {
  const health = await fetch(`${base}/health`).then((r) => r.json());
  check(health.ok === true, `GET /health -> ${JSON.stringify(health)}`);

  const ada = signIn("ada").enter(room);
  const bob = signIn("bob").enter(room);
  const inbox = signIn("bob").inbox;
  cleanup.push(() => ada.leave(), () => bob.leave(), () => inbox.close());
  if (await until(() => ada.synced && bob.synced && inbox.ready, "connect, sync and open the inbox")) check(true, `two clients synced in ${room}, inbox open`);

  ada.doc.getText("t").insert(0, "hello from ada");
  bob.doc.getText("t").insert(0, ">> ");
  if (await until(() => text(ada) === text(bob) && text(ada).length === 17, "convergence")) check(true, `both clients see "${text(ada)}"`);

  ada.setPresence({ cursor: 3 });
  if (await until(() => bob.others().some((o) => o.user.id === "ada" && o.presence.cursor === 3), "presence")) check(true, "bob sees ada's cursor");

  const thread = await ada.threads.create({
    body: { version: 1, content: [{ type: "paragraph", children: [{ type: "mention", userId: "bob" }, { type: "text", text: " smoke test" }] }] },
  });
  if (await until(() => bob.threads.get(thread.id) !== undefined, "thread")) check(true, "the thread reached bob");
  if (await until(() => inbox.list().some((n) => n.threadId === thread.id), "notification")) check(true, `bob's inbox got the mention (unread ${inbox.unread})`);
  await inbox.markAllRead();
  await until(() => inbox.unread === 0, "mark read");

  const v1 = await ada.history.save("smoke v1");
  ada.doc.getText("t").insert(text(ada).length, " (changed)");
  await until(() => text(bob).endsWith("(changed)"), "edit before restore");
  await bob.history.restore(v1.id);
  if (await until(() => !text(ada).endsWith("(changed)"), "restore")) check(true, `restore reached ada: "${text(ada)}"`);

  const late = signIn("cy").enter(room);
  cleanup.push(() => late.leave());
  if (await until(() => late.synced, "late joiner")) check(text(late) === text(ada), `a late joiner loads "${text(late)}"`);

  const intruder = createClient({ url: wsUrl, authEndpoint: async () => "not.a.token" }).enter(room);
  cleanup.push(() => intruder.leave());
  if (await until(() => intruder.status === "disconnected", "bad token refused")) check(intruder.lastError?.code === "unauthorized", "a bad token is refused");
} catch (error) {
  check(false, `unexpected error: ${error?.message ?? error}`);
} finally {
  for (const fn of cleanup) fn();
}
console.log(failed ? "\nSMOKE TEST FAILED" : "\nAll checks passed");
process.exit(failed ? 1 : 0);
