import { type Access, isAccess } from "./access";
import { type ErrorCode, isErrorCode, ProtocolError } from "./errors";
import { isRoomUser, type RoomUser } from "./user";

/** Sent in `auth` and `ready`. A server closes with `unsupported_protocol` when it doesn't speak the client's. */
export const PROTOCOL_VERSION = 1;

export const MAX_TOKEN_LENGTH = 8192;

/**
 * Event a server sends when it lost presence (a Durable Object woke from hibernation). Clients
 * answer by sending their current presence again. Event names starting with `towhee.` are reserved.
 */
export const PRESENCE_RESEND_EVENT = "towhee.presence.resend";
export const MAX_ERROR_MESSAGE_LENGTH = 1024;
export const MAX_CONNECTION_ID_LENGTH = 64;

/** Request methods and event names: `threads.create`, `version.saved`. */
const NAME = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;

/**
 * Each frame is one type byte followed by the body. Bodies of `sync` and `awareness` are standard
 * y-protocols messages, unchanged, so any Yjs binding works with them. The rest are UTF-8 JSON.
 * Types stay below 128, so the type byte is also a valid lib0 varuint.
 */
export const MESSAGE_TYPES = {
  sync: 0,
  awareness: 1,
  auth: 2,
  ready: 3,
  error: 4,
  request: 5,
  response: 6,
  event: 7,
} as const;

export type MessageType = keyof typeof MESSAGE_TYPES;

const TYPE_NAMES: readonly MessageType[] = Object.entries(MESSAGE_TYPES)
  .sort((a, b) => a[1] - b[1])
  .map(([name]) => name as MessageType);

/** A y-protocols sync message (sync step 1, step 2 or update). */
export interface SyncMessage {
  type: "sync";
  data: Uint8Array;
}

/** A y-protocols awareness update (presence). */
export interface AwarenessMessage {
  type: "awareness";
  data: Uint8Array;
}

/** First frame from the client. Tokens travel here rather than in the URL, which ends up in logs. */
export interface AuthMessage {
  type: "auth";
  protocol: number;
  token: string;
}

/** The server accepted the token. Sync can start. */
export interface ReadyMessage {
  type: "ready";
  protocol: number;
  connectionId: string;
  access: Access;
  user: RoomUser;
}

/** Sent before the server closes with the matching close code. */
export interface ErrorMessage {
  type: "error";
  code: ErrorCode;
  message: string;
}

/** A call to a room feature (comments, history, inbox). `id` matches the response. */
export interface RequestMessage {
  type: "request";
  id: number;
  method: string;
  params?: unknown;
}

export type ResponseMessage =
  | { type: "response"; id: number; ok: true; result?: unknown }
  | { type: "response"; id: number; ok: false; error: { code: ErrorCode; message: string } };

/** Something happened in the room that clients should know about (a new comment, a saved version). */
export interface EventMessage {
  type: "event";
  name: string;
  data?: unknown;
}

export type ClientMessage = SyncMessage | AwarenessMessage | AuthMessage | RequestMessage;
export type ServerMessage = SyncMessage | AwarenessMessage | ReadyMessage | ErrorMessage | ResponseMessage | EventMessage;
export type Message = ClientMessage | ServerMessage;

const CLIENT_TYPES = new Set<MessageType>(["sync", "awareness", "auth", "request"]);
const SERVER_TYPES = new Set<MessageType>(["sync", "awareness", "ready", "error", "response", "event"]);

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeMessage(message: Message): Uint8Array {
  const type = MESSAGE_TYPES[message.type];
  let body: Uint8Array;
  if (message.type === "sync" || message.type === "awareness") {
    body = message.data;
  } else {
    const { type: _type, ...fields } = message;
    body = utf8Encoder.encode(JSON.stringify(fields));
  }
  const frame = new Uint8Array(body.length + 1);
  frame[0] = type;
  frame.set(body, 1);
  return frame;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isUint32 = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

const isVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 0xffff;

function readJson(body: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(utf8Decoder.decode(body));
  } catch {
    throw new ProtocolError("Body is not valid UTF-8 JSON");
  }
  if (!isRecord(value)) throw new ProtocolError("Body is not a JSON object");
  return value;
}

function readError(value: unknown): { code: ErrorCode; message: string } {
  if (!isRecord(value) || !isErrorCode(value.code)) throw new ProtocolError("Invalid error code");
  if (typeof value.message !== "string" || value.message.length > MAX_ERROR_MESSAGE_LENGTH) {
    throw new ProtocolError("Invalid error message");
  }
  return { code: value.code, message: value.message };
}

/**
 * Decodes and checks one frame. Everything from the network is untrusted, so every field is
 * validated; anything wrong throws a {@link ProtocolError}. `sync` and `awareness` data is a view
 * into `frame`, not a copy.
 */
export function decodeMessage(frame: Uint8Array): Message {
  if (!(frame instanceof Uint8Array) || frame.length === 0) throw new ProtocolError("Empty frame");
  const type = TYPE_NAMES[frame[0]!];
  if (type === undefined) throw new ProtocolError(`Unknown message type ${frame[0]}`);
  const body = frame.subarray(1);

  if (type === "sync" || type === "awareness") {
    if (body.length === 0) throw new ProtocolError(`Empty ${type} message`);
    return { type, data: body };
  }

  const json = readJson(body);
  switch (type) {
    case "auth": {
      if (!isVersion(json.protocol)) throw new ProtocolError("Invalid protocol version");
      if (typeof json.token !== "string" || json.token.length === 0 || json.token.length > MAX_TOKEN_LENGTH) {
        throw new ProtocolError("Invalid token");
      }
      return { type, protocol: json.protocol, token: json.token };
    }
    case "ready": {
      if (!isVersion(json.protocol)) throw new ProtocolError("Invalid protocol version");
      const { connectionId } = json;
      if (typeof connectionId !== "string" || connectionId.length === 0 || connectionId.length > MAX_CONNECTION_ID_LENGTH) {
        throw new ProtocolError("Invalid connection id");
      }
      if (!isAccess(json.access)) throw new ProtocolError("Invalid access");
      if (!isRoomUser(json.user)) throw new ProtocolError("Invalid user");
      return { type, protocol: json.protocol, connectionId, access: json.access, user: json.user };
    }
    case "error":
      return { type, ...readError(json) };
    case "request": {
      if (!isUint32(json.id)) throw new ProtocolError("Invalid request id");
      if (typeof json.method !== "string" || !NAME.test(json.method)) throw new ProtocolError("Invalid method");
      return json.params === undefined
        ? { type, id: json.id, method: json.method }
        : { type, id: json.id, method: json.method, params: json.params };
    }
    case "response": {
      if (!isUint32(json.id)) throw new ProtocolError("Invalid response id");
      if (json.ok === true) {
        return json.result === undefined ? { type, id: json.id, ok: true } : { type, id: json.id, ok: true, result: json.result };
      }
      if (json.ok === false) return { type, id: json.id, ok: false, error: readError(json.error) };
      throw new ProtocolError("Invalid response");
    }
    case "event": {
      if (typeof json.name !== "string" || !NAME.test(json.name)) throw new ProtocolError("Invalid event name");
      return json.data === undefined ? { type, name: json.name } : { type, name: json.name, data: json.data };
    }
  }
}

/** For servers: decodes a frame and rejects types only a server may send. */
export function decodeClientMessage(frame: Uint8Array): ClientMessage {
  const message = decodeMessage(frame);
  if (!CLIENT_TYPES.has(message.type)) throw new ProtocolError(`A client can't send ${message.type}`);
  return message as ClientMessage;
}

/** For clients: decodes a frame and rejects types only a client may send. */
export function decodeServerMessage(frame: Uint8Array): ServerMessage {
  const message = decodeMessage(frame);
  if (!SERVER_TYPES.has(message.type)) throw new ProtocolError(`A server can't send ${message.type}`);
  return message as ServerMessage;
}
