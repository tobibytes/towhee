/** What a connection may do in a room, from least to most. */
export const ACCESS_LEVELS = ["read", "comment", "write"] as const;

export type Access = (typeof ACCESS_LEVELS)[number];

export function isAccess(value: unknown): value is Access {
  return typeof value === "string" && (ACCESS_LEVELS as readonly string[]).includes(value);
}

/** Edit the shared document. */
export function canEdit(access: Access): boolean {
  return access === "write";
}

/** Create threads, reply and react. */
export function canComment(access: Access): boolean {
  return access === "comment" || access === "write";
}

/** Resolve, edit or delete other people's comments, and create or restore versions. */
export function canModerate(access: Access): boolean {
  return access === "write";
}
