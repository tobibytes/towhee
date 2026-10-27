import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

/** One entry of a y-protocols awareness update. `state` null means the client left. */
export interface PresenceEntry {
  clientId: number;
  clock: number;
  state: unknown;
}

/** Decodes an awareness update. Throws on malformed input. */
export function decodePresence(update: Uint8Array): PresenceEntry[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  // Each entry takes at least 3 bytes, so a huge count in a small frame is malformed.
  if (count > update.length) throw new Error("Awareness update count is larger than the update");
  const entries: PresenceEntry[] = [];
  for (let i = 0; i < count; i++) {
    const clientId = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const state: unknown = JSON.parse(decoding.readVarString(decoder));
    entries.push({ clientId, clock, state });
  }
  if (decoding.hasContent(decoder)) throw new Error("Trailing bytes after awareness update");
  return entries;
}

export function encodePresence(entries: readonly PresenceEntry[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const { clientId, clock, state } of entries) {
    encoding.writeVarUint(encoder, clientId);
    encoding.writeVarUint(encoder, clock);
    encoding.writeVarString(encoder, JSON.stringify(state));
  }
  return encoding.toUint8Array(encoder);
}
