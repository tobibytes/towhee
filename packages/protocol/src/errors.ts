/**
 * Every error the server reports, with the WebSocket close code it closes with. Close codes are in
 * the 4000-4999 range that the WebSocket spec leaves to applications.
 */
export const ERROR_CODES = {
  /** A frame couldn't be decoded, or came in the wrong order. */
  protocol_error: 4000,
  /** The token is missing, malformed, signed with an unknown key or for another room. */
  unauthorized: 4001,
  /** The token expired. Get a new one and reconnect. */
  token_expired: 4002,
  /** The connection's access level doesn't allow what it tried. */
  forbidden: 4003,
  not_found: 4004,
  invalid_room: 4005,
  /** The client speaks a protocol version this server doesn't. */
  unsupported_protocol: 4006,
  /** No `auth` message arrived in time. */
  auth_timeout: 4008,
  message_too_large: 4009,
  document_too_large: 4010,
  room_full: 4011,
  /** The server is restarting or deploying. Reconnect shortly. */
  server_restarting: 4012,
  /** An admin deleted the room. Its data is gone; don't reconnect with the old copy. */
  room_deleted: 4013,
  /** An admin removed this user from the room. */
  removed: 4014,
  rate_limited: 4029,
  internal: 4500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CODES, value);
}

export function closeCodeFor(code: ErrorCode): number {
  return ERROR_CODES[code];
}

const BY_CLOSE_CODE = new Map<number, ErrorCode>(
  Object.entries(ERROR_CODES).map(([name, close]) => [close, name as ErrorCode]),
);

/** The error behind a WebSocket close code, if it's one of ours. */
export function errorCodeFromClose(closeCode: number): ErrorCode | undefined {
  return BY_CLOSE_CODE.get(closeCode);
}

/**
 * What a client should do after the server closes with `code`:
 * - `refresh`: get a new token, then reconnect
 * - `retry`: reconnect with backoff
 * - `fatal`: stop; reconnecting would fail the same way
 */
export function recoveryFor(code: ErrorCode): "refresh" | "retry" | "fatal" {
  switch (code) {
    case "token_expired":
      return "refresh";
    case "auth_timeout":
    case "room_full":
    case "server_restarting":
    case "rate_limited":
    case "internal":
      return "retry";
    default:
      return "fatal";
  }
}

/** Thrown when a frame can't be decoded. Servers close with `protocol_error`. */
export class ProtocolError extends Error {
  readonly code = "protocol_error" as const;
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}
