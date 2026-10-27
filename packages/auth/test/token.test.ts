import { describe, expect, it } from "vitest";
import { decodeBase64Url, encodeBase64Url } from "../src/base64url";
import { createRoomToken, generateSecret, MAX_EXPIRES_IN, type RoomKey, TokenError, type TokenErrorCode, validateRoomKeys, verifyRoomToken } from "../src";

const NOW = Date.UTC(2027, 0, 1); // fixed clock for every test
const key: RoomKey = { id: "main", secret: "s".repeat(32) };
const talvra: RoomKey = { id: "talvra", secret: "t".repeat(40), rooms: "talvra:*" };
const itch: RoomKey = { id: "itch", secret: "i".repeat(40), rooms: "itch:*" };

const sign = (input: Partial<Parameters<typeof createRoomToken>[0]> = {}, k: RoomKey = key, now = NOW) =>
  createRoomToken({ userId: "u1", room: "doc:1", access: "write", ...input }, k, { now });

async function rejects(token: Promise<unknown>, code: TokenErrorCode) {
  const error = await token.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(TokenError);
  expect((error as TokenError).code).toBe(code);
}

/** Re-signs a hand-made header and payload with a secret, like a buggy or hostile backend would. */
async function forge(header: unknown, payload: unknown, secret = key.secret) {
  const enc = (v: unknown) => encodeBase64Url(new TextEncoder().encode(JSON.stringify(v)));
  const data = `${enc(header)}.${enc(payload)}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  return `${data}.${encodeBase64Url(sig)}`;
}
const claims = (extra: Record<string, unknown> = {}) => ({ sub: "u1", room: "doc:1", access: "write", iat: NOW / 1000, exp: NOW / 1000 + 600, ...extra });

describe("createRoomToken + verifyRoomToken", () => {
  it("round-trips the user, room and access", async () => {
    const token = await sign({ access: "comment", user: { name: "Ada", color: "#0ea5e9" }, expiresIn: 600 });
    expect(token.split(".")).toHaveLength(3);
    const v = await verifyRoomToken(token, key, { room: "doc:1", now: NOW });
    expect(v).toEqual({
      userId: "u1",
      room: "doc:1",
      access: "comment",
      user: { id: "u1", name: "Ada", color: "#0ea5e9" },
      expiresAt: NOW + 600_000,
      keyId: "main",
    });
  });

  it("defaults to a one-hour token", async () => {
    const v = await verifyRoomToken(await sign(), key, { now: NOW });
    expect(v.expiresAt).toBe(NOW + 3_600_000);
  });

  it("verifies a standard HS256 JWT signed by another library", async () => {
    // Made with node:crypto's createHmac, not this package, signed with the dummy secret below.
    // Payload includes non-ASCII ("Zoë"). Kept in parts so secret scanners don't flag a test fixture.
    const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImJhY2tlbmQifQ";
    const payload =
      "eyJzdWIiOiJ1c2VyLTciLCJyb29tIjoidGFsdnJhOm5vdGVzOioiLCJhY2Nlc3MiOiJjb21tZW50IiwidXNlciI6eyJuYW1lIjoiWm_DqyIsImNvbG9yIjoiIzE2YTM0YSJ9LCJpYXQiOjE4MDAwMDAwMDAsImV4cCI6MTgwMDAwMzYwMH0";
    const signature = "9_HCXt_in80AQ392yG1bNbgsMbk4M4fTFdKUrAgM4mo";
    const external = [header, payload, signature].join(".");
    const backend: RoomKey = { id: "backend", secret: "interop-secret-0123456789abcdefghij" };
    const v = await verifyRoomToken(external, backend, { room: "talvra:notes:week-1", now: 1_800_000_100_000 });
    expect(v.user).toEqual({ id: "user-7", name: "Zoë", color: "#16a34a" });
    expect(v.access).toBe("comment");
  });

  it("checks the room", async () => {
    const exact = await sign({ room: "doc:1" });
    await rejects(verifyRoomToken(exact, key, { room: "doc:2", now: NOW }), "wrong_room");
    const prefix = await sign({ room: "team:7:*" });
    await expect(verifyRoomToken(prefix, key, { room: "team:7:notes", now: NOW })).resolves.toMatchObject({ room: "team:7:*" });
    await rejects(verifyRoomToken(prefix, key, { room: "team:70:notes", now: NOW }), "wrong_room");
    await rejects(verifyRoomToken(prefix, key, { room: "bad/room", now: NOW }), "wrong_room");
  });

  it("rejects a tampered payload or signature", async () => {
    const token = await sign({ access: "read" });
    const [h, p, s] = token.split(".") as [string, string, string];
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(p)));
    const upgraded = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ ...payload, access: "write" })));
    await rejects(verifyRoomToken(`${h}.${upgraded}.${s}`, key, { now: NOW }), "bad_signature");
    const flipped = s.startsWith("A") ? `B${s.slice(1)}` : `A${s.slice(1)}`;
    await rejects(verifyRoomToken(`${h}.${p}.${flipped}`, key, { now: NOW }), "bad_signature");
    await rejects(verifyRoomToken(token, { id: "main", secret: "x".repeat(32) }, { now: NOW }), "bad_signature");
  });

  it("enforces expiry with clock skew", async () => {
    const token = await sign({ expiresIn: 600 });
    await expect(verifyRoomToken(token, key, { now: NOW + 600_000 + 59_000 })).resolves.toBeTruthy();
    await rejects(verifyRoomToken(token, key, { now: NOW + 600_000 + 61_000 }), "expired");
    await rejects(verifyRoomToken(token, key, { now: NOW + 601_000, clockSkew: 0 }), "expired");
  });

  it("refuses tokens that live longer than 24 hours, wherever they were made", async () => {
    await expect(sign({ expiresIn: MAX_EXPIRES_IN + 1 })).rejects.toThrow(TypeError);
    await expect(sign({ expiresIn: 0 })).rejects.toThrow(TypeError);
    await expect(sign({ expiresIn: 1.5 })).rejects.toThrow(TypeError);
    const longLived = await forge({ alg: "HS256", kid: "main" }, claims({ exp: NOW / 1000 + MAX_EXPIRES_IN + 3600 }));
    await rejects(verifyRoomToken(longLived, key, { now: NOW }), "invalid_claims");
  });

  it("honors nbf and refuses tokens issued in the future", async () => {
    const later = await forge({ alg: "HS256", kid: "main" }, claims({ nbf: NOW / 1000 + 300 }));
    await rejects(verifyRoomToken(later, key, { now: NOW }), "not_yet_valid");
    await expect(verifyRoomToken(later, key, { now: NOW + 300_000 })).resolves.toBeTruthy();
    const future = await forge({ alg: "HS256", kid: "main" }, claims({ iat: NOW / 1000 + 600, exp: NOW / 1000 + 1200 }));
    await rejects(verifyRoomToken(future, key, { now: NOW }), "invalid_claims");
  });

  it("only accepts HS256", async () => {
    for (const alg of ["none", "HS512", "RS256", undefined]) {
      const token = await forge({ alg, kid: "main" }, claims());
      await rejects(verifyRoomToken(token, key, { now: NOW }), "unsupported_algorithm");
    }
    const enc = (v: unknown) => encodeBase64Url(new TextEncoder().encode(JSON.stringify(v)));
    await rejects(verifyRoomToken(`${enc({ alg: "none" })}.${enc(claims())}.`, key, { now: NOW }), "unsupported_algorithm");
  });

  it("validates claims after the signature", async () => {
    const bad: Record<string, unknown>[] = [
      { sub: "" },
      { sub: 42 },
      { room: "a/b" },
      { access: "admin" },
      { user: { name: "Ada", role: "admin" } },
      { user: { avatar: "javascript:alert(1)" } },
      { exp: "soon" },
      { exp: undefined },
      { iat: "now" },
    ];
    for (const extra of bad) {
      const token = await forge({ alg: "HS256", kid: "main" }, claims(extra));
      await rejects(verifyRoomToken(token, key, { now: NOW }), "invalid_claims");
    }
  });

  it("rejects malformed tokens", async () => {
    for (const token of ["", "abc", "a.b", "a.b.c.d", "!!!.e30.e30", `${"x".repeat(9000)}.a.b`, "e30=.e30.e30"]) {
      await rejects(verifyRoomToken(token, key, { now: NOW }), "malformed");
    }
  });
});

describe("keys", () => {
  it("picks the key by kid, so keys can rotate", async () => {
    const next: RoomKey = { id: "next", secret: "n".repeat(32) };
    const old = await sign({}, key);
    const fresh = await sign({}, next);
    await expect(verifyRoomToken(old, [key, next], { now: NOW })).resolves.toMatchObject({ keyId: "main" });
    await expect(verifyRoomToken(fresh, [key, next], { now: NOW })).resolves.toMatchObject({ keyId: "next" });
    await rejects(verifyRoomToken(fresh, [key], { now: NOW }), "unknown_key");
  });

  it("allows a missing kid only when there is exactly one key", async () => {
    const token = await forge({ alg: "HS256" }, claims());
    await expect(verifyRoomToken(token, key, { now: NOW })).resolves.toMatchObject({ keyId: "main" });
    await rejects(verifyRoomToken(token, [key, talvra], { now: NOW }), "unknown_key");
  });

  it("keeps keys inside their room prefix, on both sides", async () => {
    await expect(sign({ room: "talvra:doc:1" }, talvra)).resolves.toBeTruthy();
    await expect(sign({ room: "talvra:*" }, talvra)).resolves.toBeTruthy();
    await expect(sign({ room: "itch:doc:1" }, talvra)).rejects.toThrow(TypeError);
    await expect(sign({ room: "*" }, talvra)).rejects.toThrow(TypeError);

    // A token for another app's rooms, signed with this app's secret, must not open them.
    const crossApp = await forge({ alg: "HS256", kid: "talvra" }, claims({ room: "itch:doc:1" }), talvra.secret);
    await rejects(verifyRoomToken(crossApp, [talvra, itch], { room: "itch:doc:1", now: NOW }), "key_scope");
    const everything = await forge({ alg: "HS256", kid: "talvra" }, claims({ room: "*" }), talvra.secret);
    await rejects(verifyRoomToken(everything, [talvra, itch], { now: NOW }), "key_scope");

    const ok = await sign({ room: "itch:doc:1" }, itch);
    await expect(verifyRoomToken(ok, [talvra, itch], { room: "itch:doc:1", now: NOW })).resolves.toMatchObject({ keyId: "itch" });
  });

  it("throws TypeError for bad key configuration", async () => {
    const t = await sign();
    for (const k of [
      { id: "main", secret: "short" },
      { id: "", secret: "s".repeat(32) },
      { id: "has space", secret: "s".repeat(32) },
      { id: "main", secret: "s".repeat(32), rooms: "a/b" },
    ]) {
      await expect(verifyRoomToken(t, k, { now: NOW })).rejects.toThrow(TypeError);
      await expect(createRoomToken({ userId: "u1", room: "doc:1", access: "write" }, k)).rejects.toThrow(TypeError);
    }
    await expect(verifyRoomToken(t, [], { now: NOW })).rejects.toThrow(TypeError);
    await expect(verifyRoomToken(t, [key, { ...key }], { now: NOW })).rejects.toThrow(TypeError);
    await expect(verifyRoomToken(t, key, { now: NOW, clockSkew: 3600 })).rejects.toThrow(TypeError);
    expect(() => validateRoomKeys([key, talvra])).not.toThrow();
    expect(() => validateRoomKeys([])).toThrow(TypeError);
    expect(() => validateRoomKeys({ id: "x", secret: "short" })).toThrow(TypeError);
  });

  it("checks token input", async () => {
    await expect(sign({ userId: "" })).rejects.toThrow(TypeError);
    await expect(sign({ room: "a b" })).rejects.toThrow(TypeError);
    await expect(sign({ access: "admin" as never })).rejects.toThrow(TypeError);
    await expect(sign({ user: { avatar: "ftp://x/y.png" } })).rejects.toThrow(TypeError);
  });

  it("generates long random secrets", () => {
    const a = generateSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSecret()).not.toBe(a);
  });
});

describe("base64url", () => {
  it("round-trips bytes and rejects non-canonical input", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
    }
    expect(decodeBase64Url("AA==")).toBeUndefined(); // padding
    expect(decodeBase64Url("A+/A")).toBeUndefined(); // standard alphabet
    expect(decodeBase64Url("A")).toBeUndefined(); // impossible length
    expect(decodeBase64Url("AB")).toBeUndefined(); // stray bits in the last character
    expect(decodeBase64Url("AA")).toEqual(new Uint8Array([0]));
  });
});
