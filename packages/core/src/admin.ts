import { isReservedRoomId, isValidRoomId, isValidUserId } from "@towhee/protocol";
import type { RoomExport, RoomInfo } from "./room";

/** What a host does for the admin API. Each returns null (or false, 0) for a room that doesn't exist. */
export interface AdminOps {
  info(room: string): Promise<RoomInfo | null>;
  export(room: string): Promise<RoomExport | null>;
  /** Disconnects everyone with `room_deleted` and deletes all the room's data. */
  delete(room: string): Promise<boolean>;
  /** Disconnects one user's connections with `removed`. */
  kick(room: string, userId: string): Promise<number>;
}

export const MIN_ADMIN_SECRET_LENGTH = 32;
const ADMIN_PATH = /^\/v1\/admin\/rooms\/([^/]+)(\/export|\/kick)?$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Compares in time that doesn't depend on where the strings differ. */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Whether a path is the admin API's, so hosts can route it before anything else. */
export function isAdminPath(pathname: string): boolean {
  return pathname.startsWith("/v1/admin/");
}

/**
 * The admin API, for any host. Requests need `Authorization: Bearer <secret>`; without a secret
 * configured the API doesn't exist (404).
 *
 * - `GET /v1/admin/rooms/<room>`: connections, users, document size, thread and version counts
 * - `GET /v1/admin/rooms/<room>/export`: the document (base64 Yjs update), threads and versions
 * - `DELETE /v1/admin/rooms/<room>`: disconnects everyone and deletes the room's data
 * - `POST /v1/admin/rooms/<room>/kick` with `{ "userId": "..." }`: disconnects that user
 */
export async function handleAdmin(request: Request, secret: string | undefined, ops: AdminOps): Promise<Response> {
  if (!secret) return json({ error: "Not found" }, 404);
  if (secret.length < MIN_ADMIN_SECRET_LENGTH) return json({ error: "The admin secret must be at least 32 characters" }, 500);
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !sameSecret(auth.slice(7), secret)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": "Bearer" } });
  }

  const match = ADMIN_PATH.exec(new URL(request.url).pathname);
  if (!match) return json({ error: "Not found" }, 404);
  let room: string;
  try {
    room = decodeURIComponent(match[1]!);
  } catch {
    return json({ error: "Bad room id" }, 400);
  }
  if (!isValidRoomId(room) || isReservedRoomId(room)) return json({ error: "Bad room id" }, 400);
  const action = match[2];

  if (!action && request.method === "GET") {
    const info = await ops.info(room);
    return info ? json(info) : json({ error: "No such room" }, 404);
  }
  if (action === "/export" && request.method === "GET") {
    const data = await ops.export(room);
    return data ? json({ ...data, document: toBase64(data.document) }) : json({ error: "No such room" }, 404);
  }
  if (!action && request.method === "DELETE") {
    return (await ops.delete(room)) ? json({ deleted: true }) : json({ error: "No such room" }, 404);
  }
  if (action === "/kick" && request.method === "POST") {
    let userId: unknown;
    try {
      ({ userId } = (await request.json()) as { userId?: unknown });
    } catch {
      return json({ error: "Send { \"userId\": \"...\" }" }, 400);
    }
    if (!isValidUserId(userId)) return json({ error: "Send { \"userId\": \"...\" }" }, 400);
    return json({ closed: await ops.kick(room, userId) });
  }
  return json({ error: "Method not allowed" }, 405);
}
