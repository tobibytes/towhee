import { isRoomUser, type RoomUser } from "./user";

/** `auto`: saved by the room during editing. `manual`: someone saved it. `restore`: saved right after a restore. */
export type VersionKind = "auto" | "manual" | "restore";

/** A saved copy of a room's document. The state itself is fetched separately (`history.get`). */
export interface Version {
  id: string;
  kind: VersionKind;
  createdAt: number;
  /** Who saved it; absent for automatic versions. */
  createdBy?: RoomUser;
  name?: string;
  /** For `restore` versions: the version that was restored. */
  restoredFrom?: string;
  /** Bytes of the stored state. */
  size: number;
}

export const MAX_VERSION_NAME_LENGTH = 200;

export function isVersion(value: unknown): value is Version {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    (v.kind === "auto" || v.kind === "manual" || v.kind === "restore") &&
    typeof v.createdAt === "number" &&
    typeof v.size === "number" &&
    (v.createdBy === undefined || isRoomUser(v.createdBy)) &&
    (v.name === undefined || (typeof v.name === "string" && v.name.length <= MAX_VERSION_NAME_LENGTH)) &&
    (v.restoredFrom === undefined || typeof v.restoredFrom === "string")
  );
}
