import { describe, expect, it } from "vitest";
import {
  ACCESS_LEVELS,
  canComment,
  canEdit,
  canModerate,
  closeCodeFor,
  decodeClientMessage,
  decodeMessage,
  decodeServerMessage,
  ERROR_CODES,
  type ErrorCode,
  encodeMessage,
  errorCodeFromClose,
  isAccess,
  isRoomUser,
  isValidRoomId,
  isValidRoomPattern,
  MAX_TOKEN_LENGTH,
  MESSAGE_TYPES,
  type Message,
  PROTOCOL_VERSION,
  ProtocolError,
  patternWithin,
  recoveryFor,
  roomMatches,
} from "../src";

const json = (type: number, body: unknown) => {
  const text = new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  const frame = new Uint8Array(text.length + 1);
  frame[0] = type;
  frame.set(text, 1);
  return frame;
};

describe("access", () => {
  it("orders read < comment < write", () => {
    expect(ACCESS_LEVELS).toEqual(["read", "comment", "write"]);
    expect(ACCESS_LEVELS.map(canEdit)).toEqual([false, false, true]);
    expect(ACCESS_LEVELS.map(canComment)).toEqual([false, true, true]);
    expect(ACCESS_LEVELS.map(canModerate)).toEqual([false, false, true]);
  });

  it("recognizes access levels and nothing else", () => {
    for (const a of ACCESS_LEVELS) expect(isAccess(a)).toBe(true);
    for (const a of ["admin", "WRITE", "", null, 1, undefined]) expect(isAccess(a)).toBe(false);
  });
});

describe("room ids and patterns", () => {
  it("accepts safe ids", () => {
    for (const id of ["a", "doc:42", "team.7_notes-v2", "A1", "x".repeat(128)]) expect(isValidRoomId(id), id).toBe(true);
  });

  it("rejects ids that could escape a path, key or name", () => {
    for (const id of ["", ".hidden", "-x", ":x", "a/b", "../a", "a*", "*", "a b", "é", "a\n", "x".repeat(129), 42, null]) {
      expect(isValidRoomId(id), String(id)).toBe(false);
    }
  });

  it("accepts exact, prefix and catch-all patterns", () => {
    for (const p of ["*", "doc:42", "team:7:*", "a*"]) expect(isValidRoomPattern(p), p).toBe(true);
    for (const p of ["", "**", "*a", "a*b", "a**", "a/*", ":*", `${"x".repeat(128)}*`]) expect(isValidRoomPattern(p), p).toBe(false);
  });

  it("matches rooms against patterns", () => {
    expect(roomMatches("*", "anything")).toBe(true);
    expect(roomMatches("doc:42", "doc:42")).toBe(true);
    expect(roomMatches("doc:42", "doc:420")).toBe(false);
    expect(roomMatches("team:7:*", "team:7:notes")).toBe(true);
    expect(roomMatches("team:7:*", "team:70:notes")).toBe(false);
    expect(roomMatches("team:7:*", "team:7:")).toBe(true);
    expect(roomMatches("team:7:*", "team:7")).toBe(false);
  });

  it("never matches invalid input", () => {
    expect(roomMatches("*", "a/b")).toBe(false);
    expect(roomMatches("a/*", "a/b")).toBe(false);
  });

  it("knows when one pattern is inside another", () => {
    const cases: [string, string, boolean][] = [
      ["doc:1", "*", true],
      ["*", "*", true],
      ["*", "doc:*", false],
      ["doc:1", "doc:*", true],
      ["doc:a:*", "doc:*", true],
      ["doc:*", "doc:*", true],
      ["do*", "doc:*", false],
      ["note:1", "doc:*", false],
      ["doc:1", "doc:1", true],
      ["doc:*", "doc:1", false],
      ["doc:12", "doc:1", false],
    ];
    for (const [inner, outer, expected] of cases) expect(patternWithin(inner, outer), `${inner} in ${outer}`).toBe(expected);
  });
});

describe("error codes", () => {
  it("uses unique application close codes", () => {
    const codes = Object.values(ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c >= 4000 && c <= 4999, String(c)).toBe(true);
  });

  it("maps close codes both ways", () => {
    for (const name of Object.keys(ERROR_CODES) as ErrorCode[]) expect(errorCodeFromClose(closeCodeFor(name))).toBe(name);
    expect(errorCodeFromClose(1000)).toBeUndefined();
    expect(errorCodeFromClose(4999)).toBeUndefined();
  });

  it("tells clients how to recover", () => {
    expect(recoveryFor("token_expired")).toBe("refresh");
    for (const c of ["auth_timeout", "room_full", "server_restarting", "rate_limited", "internal"] as const) expect(recoveryFor(c)).toBe("retry");
    for (const c of ["protocol_error", "unauthorized", "forbidden", "invalid_room", "unsupported_protocol", "message_too_large"] as const) {
      expect(recoveryFor(c)).toBe("fatal");
    }
  });
});

describe("users", () => {
  it("accepts ids with optional display info", () => {
    expect(isRoomUser({ id: "u1" })).toBe(true);
    expect(isRoomUser({ id: "u1", name: "Ada", avatar: "https://example.com/a.png", color: "#0ea5e9" })).toBe(true);
    expect(isRoomUser({ id: "u1", color: "#abc" })).toBe(true);
  });

  it("rejects unsafe or malformed display info", () => {
    expect(isRoomUser({ id: "" })).toBe(false);
    expect(isRoomUser({ id: "u1", avatar: "javascript:alert(1)" })).toBe(false);
    expect(isRoomUser({ id: "u1", avatar: "data:image/png;base64,AAAA" })).toBe(false);
    expect(isRoomUser({ id: "u1", avatar: "not a url" })).toBe(false);
    expect(isRoomUser({ id: "u1", color: "red" })).toBe(false);
    expect(isRoomUser({ id: "u1", color: "#12345" })).toBe(false);
    expect(isRoomUser({ id: "u1", name: "x".repeat(129) })).toBe(false);
    expect(isRoomUser({ id: "u1", admin: true })).toBe(false);
    expect(isRoomUser(["u1"])).toBe(false);
  });
});

describe("messages", () => {
  const user = { id: "u1", name: "Ada", color: "#0ea5e9" };
  const messages: Message[] = [
    { type: "sync", data: new Uint8Array([0, 1, 2, 255]) },
    { type: "awareness", data: new Uint8Array([9]) },
    { type: "auth", protocol: PROTOCOL_VERSION, token: "a.b.c" },
    { type: "ready", protocol: PROTOCOL_VERSION, connectionId: "c1", access: "comment", user },
    { type: "error", code: "forbidden", message: "Read-only connections can't edit" },
    { type: "request", id: 1, method: "threads.create", params: { body: "hi" } },
    { type: "request", id: 0xffffffff, method: "threads.list" },
    { type: "response", id: 1, ok: true, result: { id: "t1" } },
    { type: "response", id: 2, ok: true },
    { type: "response", id: 3, ok: false, error: { code: "not_found", message: "No such thread" } },
    { type: "event", name: "thread.created", data: { id: "t1" } },
    { type: "event", name: "room.reset" },
  ];

  it("round-trips every message type", () => {
    for (const m of messages) expect(decodeMessage(encodeMessage(m))).toEqual(m);
  });

  it("puts the type in the first byte and passes y-protocols bodies through unchanged", () => {
    const data = new Uint8Array([1, 2, 3]);
    const frame = encodeMessage({ type: "sync", data });
    expect(Array.from(frame)).toEqual([MESSAGE_TYPES.sync, 1, 2, 3]);
    expect(encodeMessage({ type: "awareness", data })[0]).toBe(MESSAGE_TYPES.awareness);
  });

  it("splits client and server messages", () => {
    const auth = encodeMessage(messages[2]!);
    const ready = encodeMessage(messages[3]!);
    expect(decodeClientMessage(auth).type).toBe("auth");
    expect(() => decodeClientMessage(ready)).toThrow(ProtocolError);
    expect(decodeServerMessage(ready).type).toBe("ready");
    expect(() => decodeServerMessage(auth)).toThrow(ProtocolError);
    for (const shared of [messages[0]!, messages[1]!]) {
      expect(decodeClientMessage(encodeMessage(shared))).toEqual(shared);
      expect(decodeServerMessage(encodeMessage(shared))).toEqual(shared);
    }
  });

  it("rejects broken frames with a ProtocolError", () => {
    const bad: [string, Uint8Array][] = [
      ["empty", new Uint8Array()],
      ["unknown type", new Uint8Array([8])],
      ["high type byte", new Uint8Array([200, 1])],
      ["empty sync", new Uint8Array([MESSAGE_TYPES.sync])],
      ["empty awareness", new Uint8Array([MESSAGE_TYPES.awareness])],
      ["not JSON", json(MESSAGE_TYPES.auth, "{token")],
      ["JSON array", json(MESSAGE_TYPES.auth, "[]")],
      ["JSON null", json(MESSAGE_TYPES.event, "null")],
      ["invalid UTF-8", new Uint8Array([MESSAGE_TYPES.auth, 0xff, 0xfe])],
      ["auth without token", json(MESSAGE_TYPES.auth, { protocol: 1 })],
      ["auth with empty token", json(MESSAGE_TYPES.auth, { protocol: 1, token: "" })],
      ["auth with huge token", json(MESSAGE_TYPES.auth, { protocol: 1, token: "x".repeat(MAX_TOKEN_LENGTH + 1) })],
      ["auth with protocol 0", json(MESSAGE_TYPES.auth, { protocol: 0, token: "t" })],
      ["auth with fractional protocol", json(MESSAGE_TYPES.auth, { protocol: 1.5, token: "t" })],
      ["ready with bad access", json(MESSAGE_TYPES.ready, { protocol: 1, connectionId: "c", access: "admin", user })],
      ["ready with bad user", json(MESSAGE_TYPES.ready, { protocol: 1, connectionId: "c", access: "read", user: { id: "" } })],
      ["ready without connection id", json(MESSAGE_TYPES.ready, { protocol: 1, access: "read", user })],
      ["error with unknown code", json(MESSAGE_TYPES.error, { code: "oops", message: "x" })],
      ["error without message", json(MESSAGE_TYPES.error, { code: "internal" })],
      ["request with negative id", json(MESSAGE_TYPES.request, { id: -1, method: "a" })],
      ["request with id too large", json(MESSAGE_TYPES.request, { id: 2 ** 32, method: "a" })],
      ["request with bad method", json(MESSAGE_TYPES.request, { id: 1, method: "../x" })],
      ["request with long method", json(MESSAGE_TYPES.request, { id: 1, method: `a${"b".repeat(64)}` })],
      ["response without ok", json(MESSAGE_TYPES.response, { id: 1 })],
      ["failed response without error", json(MESSAGE_TYPES.response, { id: 1, ok: false })],
      ["event without name", json(MESSAGE_TYPES.event, { data: 1 })],
    ];
    for (const [label, frame] of bad) {
      expect(() => decodeMessage(frame), label).toThrow(ProtocolError);
    }
  });

  it("ignores unknown fields instead of passing them on", () => {
    const m = decodeMessage(json(MESSAGE_TYPES.auth, { protocol: 1, token: "t", extra: true }));
    expect(m).toEqual({ type: "auth", protocol: 1, token: "t" });
  });
});
