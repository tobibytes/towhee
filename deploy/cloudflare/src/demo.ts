import { createInboxToken, createRoomToken } from "@towhee/auth";
import { keysFromEnv, type TowheeEnv } from "@towhee/cloudflare";
import { INBOX_ROOM } from "@towhee/protocol";

/**
 * POST /demo/token: anonymous tokens for the Towhee Board demo on this site. They're signed with
 * the "demo" key, which only covers demo:* rooms, so they can't open anything else on this
 * deployment. Each browser keeps a random id in a cookie, and gets a bird name and color from it.
 *
 * Other sites listed in DEMO_ORIGINS (like Junco's docs editor) can call it too, with CORS. A cookie
 * can't cross sites, so they send their own random `visitor` id (24 hex characters) instead.
 */
export interface DemoEnv extends TowheeEnv {
  /** 30 requests per minute per IP (wrangler.jsonc ratelimits). */
  DEMO_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** Comma-separated origins allowed to call /demo/token from the browser, like https://junco.madebytobi.com. */
  DEMO_ORIGINS?: string;
}

const VISITOR = /^[a-f0-9]{24}$/;

/** The calling origin when it's another site on the DEMO_ORIGINS list; null for same-site requests or anyone else. */
function crossOrigin(request: Request, env: DemoEnv): string | null {
  const origin = request.headers.get("origin");
  if (!origin || origin === new URL(request.url).origin) return null;
  const allowed = (env.DEMO_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

const corsHeaders = (origin: string) => ({
  "access-control-allow-origin": origin,
  "access-control-allow-methods": "POST",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
  vary: "Origin",
});

const DEMO_ROOM = /^demo:[a-z0-9-]{1,40}$/;
const COOKIE = "towhee_demo";
const ADJECTIVES = ["Curious", "Swift", "Quiet", "Bright", "Brave", "Clever", "Gentle", "Lucky", "Sunny", "Bold", "Calm", "Merry"];
const BIRDS = ["Towhee", "Junco", "Wren", "Finch", "Robin", "Sparrow", "Swallow", "Heron", "Kestrel", "Warbler", "Oriole", "Plover"];
// Presence colors: readable as text on white and on near-black.
const COLORS = ["#e11d48", "#ea580c", "#ca8a04", "#16a34a", "#0d9488", "#0284c7", "#4f46e5", "#9333ea", "#c026d3", "#db2777"];

function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

function identity(id: string) {
  const h = hash(id);
  return { name: `${ADJECTIVES[h % ADJECTIVES.length]} ${BIRDS[(h >>> 8) % BIRDS.length]}`, color: COLORS[(h >>> 16) % COLORS.length]! };
}

function cookieId(request: Request): string | undefined {
  const match = /(?:^|;\s*)towhee_demo=([a-f0-9]{24})(?:;|$)/.exec(request.headers.get("cookie") ?? "");
  return match?.[1];
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

export async function demoToken(request: Request, env: DemoEnv): Promise<Response> {
  const origin = crossOrigin(request, env);
  const cors: Record<string, string> = origin ? corsHeaders(origin) : {};
  if (request.method === "OPTIONS" && origin) return new Response(null, { status: 204, headers: cors });
  const response = await issue(request, env, origin);
  for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
  return response;
}

async function issue(request: Request, env: DemoEnv, origin: string | null): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Use POST" }, 405, { allow: "POST" });
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (env.DEMO_LIMITER && !(await env.DEMO_LIMITER.limit({ key: ip })).success) return json({ error: "Too many requests" }, 429, { "retry-after": "60" });

  const key = keysFromEnv(env).find((k) => k.id === "demo");
  if (!key) return json({ error: "The demo isn't set up on this deployment" }, 503);

  let room: unknown;
  let visitor: unknown;
  try {
    const text = await request.text();
    if (text.length > 1024) return json({ error: "Too large" }, 413);
    ({ room, visitor } = JSON.parse(text) as { room?: unknown; visitor?: unknown });
  } catch {
    return json({ error: "Send { \"room\": \"demo:...\" }" }, 400);
  }
  if (origin && !(typeof visitor === "string" && VISITOR.test(visitor))) return json({ error: "Send a visitor id: 24 hex characters" }, 400);

  const known = origin ? (visitor as string) : cookieId(request);
  const userId = known ?? Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
  const user = identity(userId);
  let token: string;
  if (room === INBOX_ROOM) token = await createInboxToken({ userId, user }, key);
  else if (typeof room === "string" && DEMO_ROOM.test(room)) token = await createRoomToken({ userId, room, access: "write", user, expiresIn: 3600 }, key);
  else return json({ error: "Demo tokens are for demo:* rooms" }, 403);

  const headers: Record<string, string> = {};
  if (!known && !origin) headers["set-cookie"] = `${COOKIE}=${userId}; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax`;
  return json({ token }, 200, headers);
}
