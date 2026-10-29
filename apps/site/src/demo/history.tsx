import { History as HistoryIcon, Undo2 } from "lucide-react";
import * as React from "react";
import type { RoomConnection, Version } from "@towhee/client";
import * as Y from "yjs";
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  Input,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  toast,
} from "@junco/react";
import { cardsMap, useVersions } from "./room";

/** Restores run with this origin so the board's undo manager can take them back. */
const RESTORE = Symbol("restore");

const kindLabel: Record<Version["kind"], string> = { auto: "Automatic", manual: "Saved", restore: "Restored" };

export function HistorySheet({ room, canEdit }: { room: RoomConnection; canEdit: boolean }) {
  const versions = useVersions(room);
  const [name, setName] = React.useState("");
  const [canUndo, setCanUndo] = React.useState(false);
  const undo = React.useMemo(() => new Y.UndoManager(cardsMap(room.doc), { trackedOrigins: new Set([RESTORE]) }), [room]);
  React.useEffect(() => () => undo.destroy(), [undo]);

  const save = async () => {
    try {
      await room.history.save(name.trim() || undefined);
      setName("");
      toast.success("Version saved");
    } catch (error) {
      toast.error("Couldn't save", { description: (error as Error).message });
    }
  };

  const restore = async (v: Version) => {
    try {
      undo.clear();
      await room.history.restore(v.id, { origin: RESTORE, types: { cards: "map" } });
      setCanUndo(true);
      toast.success("Restored for everyone", { description: "Undo puts the board back as it was." });
    } catch (error) {
      toast.error("Couldn't restore", { description: (error as Error).message });
    }
  };

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <Icon as={HistoryIcon} /> History
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="grid w-full content-start gap-4 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Version history</SheetTitle>
          <SheetDescription>Saved automatically after 5 minutes of changes, or whenever you save. Restoring changes the board for everyone.</SheetDescription>
        </SheetHeader>
        {canEdit && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Input aria-label="Version name" placeholder="Name this version (optional)" value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit">Save</Button>
          </form>
        )}
        {canUndo && (
          <Button
            variant="soft"
            onClick={() => {
              undo.undo();
              setCanUndo(false);
            }}
          >
            <Icon as={Undo2} /> Undo restore
          </Button>
        )}
        {versions.length === 0 ? (
          <EmptyState title="No versions yet" description="Save one, change the board, then restore it." />
        ) : (
          <ul className="grid gap-2">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center gap-3 rounded-card border border-border p-3">
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <p className="truncate text-sm font-medium">{v.name ?? kindLabel[v.kind]}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(v.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    {v.createdBy?.name ? ` · ${v.createdBy.name}` : ""}
                  </p>
                </div>
                <Badge variant="outline">{kindLabel[v.kind]}</Badge>
                {canEdit && (
                  <Button size="sm" variant="ghost" onClick={() => void restore(v)}>
                    Restore
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </SheetContent>
    </Sheet>
  );
}
