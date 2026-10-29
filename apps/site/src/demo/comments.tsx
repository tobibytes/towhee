import { AtSign, Check, RotateCcw } from "lucide-react";
import * as React from "react";
import type { CommentBody, Other, RoomConnection, Thread } from "@towhee/client";
import {
  Avatar,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  EmptyState,
  Icon,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Textarea,
  toast,
} from "@junco/react";
import { type Card, useThreads } from "./room";

const REACTIONS = ["👍", "🎉"];
type Person = { id: string; name: string };

function bodyFrom(text: string, mentions: Person[]): CommentBody {
  const children: CommentBody["content"][number]["children"] = [];
  for (const m of mentions) children.push({ type: "mention", userId: m.id, name: m.name }, { type: "text", text: " " });
  if (text.trim()) children.push({ type: "text", text: text.trim() });
  return { version: 1, content: [{ type: "paragraph", children }] };
}

function Body({ body, names }: { body: CommentBody; names: Map<string, string> }) {
  if (body.content.length === 0) return <p className="text-sm text-muted-foreground italic">Deleted</p>;
  return (
    <div className="grid gap-1 text-sm">
      {body.content.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a comment body is rendered whole and never reordered
        <p key={i}>
          {p.children.map((c, j) =>
            c.type === "mention" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: runs have no ids and never reorder
              <span key={j} className="font-medium text-primary">
                @{names.get(c.userId) ?? c.name ?? c.userId}
              </span>
            ) : c.type === "text" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: runs have no ids and never reorder
              <span key={j}>{c.text}</span>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: runs have no ids and never reorder
              <a key={j} href={c.url} className="underline underline-offset-4">
                {c.children.map((t) => t.text).join("")}
              </a>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

/** Text plus @mentions of people in the room. */
function Composer({ people, placeholder, onSend }: { people: Person[]; placeholder: string; onSend: (body: CommentBody) => Promise<unknown> }) {
  const [text, setText] = React.useState("");
  const [mentions, setMentions] = React.useState<Person[]>([]);
  const [busy, setBusy] = React.useState(false);
  const send = async () => {
    if (!text.trim() && mentions.length === 0) return;
    setBusy(true);
    try {
      await onSend(bodyFrom(text, mentions));
      setText("");
      setMentions([]);
    } catch (error) {
      toast.error("Couldn't post that", { description: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-2">
      {mentions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {mentions.map((m) => (
            <Badge key={m.id} variant="outline" color="primary">
              @{m.name}
            </Badge>
          ))}
        </div>
      )}
      <Textarea
        aria-label={placeholder}
        placeholder={placeholder}
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
        }}
      />
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" disabled={people.length === 0}>
              <Icon as={AtSign} /> Mention
            </Button>
          </DropdownMenuTrigger>
          {/* Junco puts menus on z-dropdown, under the sheet's z-overlay; lift this one above it. */}
          <DropdownMenuContent align="start" className="z-overlay!">
            <DropdownMenuLabel>People here</DropdownMenuLabel>
            {people.map((p) => (
              <DropdownMenuItem key={p.id} onSelect={() => setMentions((m) => (m.some((x) => x.id === p.id) ? m : [...m, p]))}>
                {p.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" className="ml-auto" isLoading={busy} onClick={send}>
          Post
        </Button>
      </div>
    </div>
  );
}

function ThreadView({ room, thread, names, people }: { room: RoomConnection; thread: Thread; names: Map<string, string>; people: Person[] }) {
  const me = room.self?.user.id;
  return (
    <li className="grid gap-3 rounded-card border border-border p-3">
      {thread.resolved && <Badge color="success" variant="outline" hasDot className="w-fit">Resolved</Badge>}
      {thread.comments.map((c) => (
        <div key={c.id} className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <Avatar name={c.author.name ?? c.author.id} size="xs" />
            <span className="text-sm font-medium" style={{ color: c.author.color }}>
              {c.author.name ?? c.author.id}
            </span>
            <time className="text-xs text-muted-foreground" dateTime={new Date(c.createdAt).toISOString()}>
              {new Date(c.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </time>
          </div>
          <Body body={c.body} names={names} />
          {!c.deletedAt && (
            <div className="flex gap-1">
              {REACTIONS.map((r) => {
                const who = c.reactions[r] ?? [];
                const mine = me !== undefined && who.includes(me);
                return (
                  <Button
                    key={r}
                    size="sm"
                    variant={mine ? "soft" : "ghost"}
                    aria-pressed={mine}
                    aria-label={`${r} ${who.length}`}
                    onClick={() => void room.threads.react(thread.id, c.id, r, !mine)}
                  >
                    {r} {who.length > 0 && who.length}
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      ))}
      <Composer people={people} placeholder="Reply" onSend={(body) => room.threads.reply(thread.id, body)} />
      <Button variant="ghost" size="sm" className="w-fit" onClick={() => void room.threads.resolve(thread.id, !thread.resolved)}>
        <Icon as={thread.resolved ? RotateCcw : Check} /> {thread.resolved ? "Reopen" : "Resolve"}
      </Button>
    </li>
  );
}

export function CommentsSheet({ room, card, others, onClose }: { room: RoomConnection; card: Card | undefined; others: Other[]; onClose: () => void }) {
  const threads = useThreads(room);
  const anchorId = card ? `card:${card.id}` : "";
  const mine = threads.filter((t) => t.anchor?.type === "app" && t.anchor.id === anchorId);
  const people: Person[] = others.map((o) => ({ id: o.user.id, name: o.user.name ?? o.user.id })).filter((p, i, all) => all.findIndex((x) => x.id === p.id) === i);
  const names = new Map<string, string>();
  for (const t of threads) for (const c of t.comments) names.set(c.author.id, c.author.name ?? c.author.id);
  for (const p of people) names.set(p.id, p.name);
  if (room.self) names.set(room.self.user.id, room.self.user.name ?? room.self.user.id);

  return (
    <Sheet open={Boolean(card)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="grid w-full content-start gap-4 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Comments</SheetTitle>
          <SheetDescription>{card?.title}</SheetDescription>
        </SheetHeader>
        {mine.length === 0 ? (
          <EmptyState title="No comments yet" description="Start a thread. Mention someone here and it lands in their inbox." />
        ) : (
          <ul className="grid gap-3">
            {mine.map((t) => (
              <ThreadView key={t.id} room={room} thread={t} names={names} people={people} />
            ))}
          </ul>
        )}
        <div className="grid gap-2 border-t border-border pt-4">
          <p className="text-sm font-medium">New thread</p>
          <Composer
            people={people}
            placeholder="Write a comment"
            onSend={(body) => room.threads.create({ body, anchor: { type: "app", id: anchorId } })}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
