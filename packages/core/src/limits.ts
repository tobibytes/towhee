/** Limits a room enforces. Hitting one closes the connection with the matching error code. */
export interface Limits {
  /** Largest frame a client may send. `message_too_large`. Default 1 MB. */
  maxMessageBytes: number;
  /** Largest the document may grow. `document_too_large`. Default 50 MB. */
  maxDocumentBytes: number;
  /** Connections per room, counting ones still authenticating. `room_full`. Default 100. */
  maxConnections: number;
  /** Frames per second per connection. `rate_limited`. Default 120 (cursor moves are chatty). */
  maxMessagesPerSecond: number;
  /** Time to send `auth` after connecting. `auth_timeout`. Default 10 seconds. */
  authTimeoutMs: number;
  /** Presence client ids one connection may own. Extra ones are ignored. Default 8. */
  maxPresencePerConnection: number;
  /** Compact the stored document after this many logged updates. Default 500. */
  compactAfterUpdates: number;
  /** ...or after this many logged bytes. Default 4 MB. */
  compactAfterBytes: number;
  /** Save an automatic version once the document has changed and this long has passed since the last. Default 5 minutes. */
  autoVersionEveryMs: number;
  /** Automatic versions to keep per room; older ones are deleted. Saved and restore versions are kept. Default 50. */
  keepAutoVersions: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxMessageBytes: 1024 * 1024,
  maxDocumentBytes: 50 * 1024 * 1024,
  maxConnections: 100,
  maxMessagesPerSecond: 120,
  authTimeoutMs: 10_000,
  maxPresencePerConnection: 8,
  compactAfterUpdates: 500,
  compactAfterBytes: 4 * 1024 * 1024,
  autoVersionEveryMs: 5 * 60 * 1000,
  keepAutoVersions: 50,
};

export function resolveLimits(overrides: Partial<Limits> = {}): Limits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) throw new TypeError(`Limit ${name} must be a positive whole number`);
  }
  return limits;
}
