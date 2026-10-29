import { ArrowLeft, ArrowRight, Link2, MessageSquare, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { Link } from "react-router";
import type { Other, RoomConnection } from "@towhee/client";
import { Avatar, Badge, Button, Card, Icon, Input, Spinner, Textarea, Tooltip, toast } from "@junco/react";
import { CommentsSheet } from "./comments";
import { HistorySheet } from "./history";
import { InboxButton } from "./inbox";
import {
  addCard,
  type BoardPresence,
  type Card as CardData,
  COLUMNS,
  cardsMap,
  seedBoard,
  updateCard,
  useCards,
  useOthers,
  useStatus,
  useThreads,
} from "./room";

const presenceOf = (o: Other) => o.presence as BoardPresence;

/** Who's here: you first, then everyone else, each in their color. */
function People({ room, others }: { room: RoomConnection; others: Other[] }) {
  const me = room.self?.user;
  // One avatar per person, even with the board open in several tabs.
  const seen = new Set(me ? [me.id] : []);
  const people = [
    ...(me ? [{ key: "me", user: me, you: true }] : []),
    ...others
      .filter((o) => !seen.has(o.user.id) && seen.add(o.user.id))
      .map((o) => ({ key: String(o.clientId), user: o.user, you: false })),
  ];
  return (
    <div className="flex items-center -space-x-2">
      <span className="sr-only">{people.length === 1 ? "Just you here" : `${people.length} people here`}</span>
      {people.slice(0, 6).map((p) => (
        <Tooltip key={p.key} content={p.you ? `${p.user.name} (you)` : p.user.name}>
          <span className="rounded-pill ring-2 ring-background" style={{ boxShadow: `0 0 0 2px ${p.user.color ?? "transparent"}` }}>
            <Avatar name={p.user.name ?? p.user.id} size="sm" />
          </span>
        </Tooltip>
      ))}
      {people.length > 6 && <Badge variant="outline" className="ml-3">+{people.length - 6}</Badge>}
    </div>
  );
}

/** Other people's pointers over the board, with their names. */
function Cursors({ others }: { others: Other[] }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {others.map((o) => {
        const c = presenceOf(o).cursor;
        if (!c) return null;
        return (
          <div
            key={o.clientId}
            className="absolute flex items-start transition-[left,top] duration-fast ease-standard"
            style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}
          >
            <svg aria-hidden width="18" height="18" viewBox="0 0 18 18" style={{ color: o.user.color }}>
              <path d="M1 1l6 15 2.2-6.3L16 7.5z" fill="currentColor" stroke="var(--background)" strokeWidth="1" />
            </svg>
            <span className="ml-3 rounded-pill px-2 py-0.5 text-xs font-medium whitespace-nowrap text-background" style={{ background: o.user.color }}>
              {o.user.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function CardView({
  room,
  card,
  comments,
  viewers,
  onOpenComments,
  canEdit,
}: {
  room: RoomConnection;
  card: CardData;
  comments: number;
  viewers: Other[];
  onOpenComments: () => void;
  canEdit: boolean;
}) {
  const column = COLUMNS.findIndex((c) => c.id === card.column);
  const move = (delta: number) => updateCard(room.doc, card.id, { column: COLUMNS[column + delta]!.id, order: Date.now() });
  const ring = viewers[0]?.user.color;
  return (
    <Card
      className="grid gap-2 p-3"
      style={ring ? { boxShadow: `0 0 0 2px ${ring}` } : undefined}
      onFocus={() => room.updatePresence({ card: card.id })}
    >
      {viewers.length > 0 && (
        <p className="text-xs font-medium" style={{ color: ring }}>
          {viewers.map((v) => v.user.name).join(", ")} {viewers.length === 1 ? "is" : "are"} here
        </p>
      )}
      <Input
        aria-label="Card title"
        value={card.title}
        readOnly={!canEdit}
        onChange={(e) => updateCard(room.doc, card.id, { title: e.target.value })}
        className="font-medium"
      />
      <Textarea
        aria-label="Card note"
        value={card.note}
        readOnly={!canEdit}
        rows={2}
        onChange={(e) => updateCard(room.doc, card.id, { note: e.target.value })}
        className="text-sm"
      />
      <div className="flex items-center gap-1">
        <Tooltip content="Move left">
          <Button size="icon" variant="ghost" aria-label="Move left" disabled={!canEdit || column === 0} onClick={() => move(-1)}>
            <Icon as={ArrowLeft} />
          </Button>
        </Tooltip>
        <Tooltip content="Move right">
          <Button size="icon" variant="ghost" aria-label="Move right" disabled={!canEdit || column === COLUMNS.length - 1} onClick={() => move(1)}>
            <Icon as={ArrowRight} />
          </Button>
        </Tooltip>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onOpenComments} aria-label={`Comments (${comments})`}>
          <Icon as={MessageSquare} /> {comments}
        </Button>
        <Tooltip content="Delete card">
          <Button size="icon" variant="ghost" aria-label="Delete card" disabled={!canEdit} onClick={() => cardsMap(room.doc).delete(card.id)}>
            <Icon as={Trash2} />
          </Button>
        </Tooltip>
      </div>
    </Card>
  );
}

export function Board({ room, boardId }: { room: RoomConnection; boardId: string }) {
  const { status, synced } = useStatus(room);
  const others = useOthers(room);
  const cards = useCards(room);
  const threads = useThreads(room);
  const [openCard, setOpenCard] = React.useState<string | null>(null);
  const surface = React.useRef<HTMLDivElement>(null);
  const canEdit = room.self?.access === "write";

  React.useEffect(() => {
    if (synced) seedBoard(room.doc);
  }, [room, synced]);

  // Share the pointer position over the board, at most every 40 ms, as a fraction of its size.
  const last = React.useRef(0);
  const onPointerMove = (e: React.PointerEvent) => {
    const now = performance.now();
    if (now - last.current < 40 || !surface.current) return;
    last.current = now;
    const r = surface.current.getBoundingClientRect();
    room.updatePresence({ cursor: { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height } });
  };

  const commentsFor = (cardId: string) =>
    threads.filter((t) => t.anchor?.type === "app" && t.anchor.id === `card:${cardId}`).reduce((n, t) => n + t.comments.filter((c) => !c.deletedAt).length, 0);

  const share = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast.success("Link copied. Open it in another window or send it to someone.");
    } catch {
      toast("Copy the address bar to share this board.");
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <Link to="/" className="font-semibold tracking-tight">
          Towhee Board
        </Link>
        <Badge variant="outline" hasDot color={status === "connected" ? "success" : status === "disconnected" ? "danger" : "warning"}>
          {status === "connected" ? (synced ? "Live" : "Syncing") : status}
        </Badge>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          <span className="font-mono">demo:{boardId}</span> · resets a day after it&apos;s made
        </span>
        <div className="ml-auto flex items-center gap-2">
          <People room={room} others={others} />
          <Tooltip content="Copy link">
            <Button variant="outline" size="icon" aria-label="Copy link to this board" onClick={share}>
              <Icon as={Link2} />
            </Button>
          </Tooltip>
          <InboxButton
            boardRoom={`demo:${boardId}`}
            onOpen={(cardId) => setOpenCard(cardId)}
            cardForThread={(threadId) => {
              // Comments on a card are threads anchored to "card:<id>".
              const anchor = threads.find((t) => t.id === threadId)?.anchor;
              return anchor?.type === "app" && anchor.id.startsWith("card:") ? anchor.id.slice(5) : undefined;
            }}
          />
          <HistorySheet room={room} canEdit={canEdit} />
        </div>
      </header>

      <main className="flex-1 p-4">
        {!synced ? (
          <div className="grid h-64 place-items-center text-muted-foreground">
            <Spinner />
          </div>
        ) : (
          <div
            ref={surface}
            className="relative grid gap-4 md:grid-cols-3"
            style={{ minHeight: "70dvh" }}
            onPointerMove={onPointerMove}
            onPointerLeave={() => room.updatePresence({ cursor: null })}
          >
            {COLUMNS.map((col) => (
              <section key={col.id} aria-labelledby={`col-${col.id}`} className="grid content-start gap-3 rounded-card border border-border bg-surface p-3">
                <div className="flex items-center justify-between">
                  <h2 id={`col-${col.id}`} className="text-sm font-medium">
                    {col.label} <span className="text-muted-foreground">{cards.filter((c) => c.column === col.id).length}</span>
                  </h2>
                  <Tooltip content="Add a card">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Add a card to ${col.label}`}
                      disabled={!canEdit}
                      onClick={() => addCard(room.doc, { title: "New card", note: "", column: col.id })}
                    >
                      <Icon as={Plus} />
                    </Button>
                  </Tooltip>
                </div>
                {cards
                  .filter((c) => c.column === col.id)
                  .map((card) => (
                    <CardView
                      key={card.id}
                      room={room}
                      card={card}
                      canEdit={canEdit}
                      comments={commentsFor(card.id)}
                      viewers={others.filter((o) => presenceOf(o).card === card.id)}
                      onOpenComments={() => {
                        setOpenCard(card.id);
                        room.updatePresence({ card: card.id });
                      }}
                    />
                  ))}
              </section>
            ))}
            <Cursors others={others} />
          </div>
        )}
      </main>

      <CommentsSheet
        room={room}
        card={cards.find((c) => c.id === openCard)}
        others={others}
        onClose={() => {
          setOpenCard(null);
          room.updatePresence({ card: null });
        }}
      />
    </div>
  );
}
