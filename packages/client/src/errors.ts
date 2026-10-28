import type { ErrorCode } from "@towhee/protocol";

/** Thrown when a room request fails. */
export class RequestError extends Error {
  readonly code: ErrorCode | "disconnected";
  constructor(code: ErrorCode | "disconnected", message: string) {
    super(message);
    this.name = "RequestError";
    this.code = code;
  }
}
