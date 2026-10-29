import { Bell } from "lucide-react";
import * as React from "react";
import { useNavigate } from "react-router";
import type { Notification } from "@towhee/client";
import { Badge, Button, EmptyState, Icon, Popover, PopoverContent, PopoverTrigger } from "@junco/react";
import { demoClient } from "./room";

function useInbox() {
  const inbox = demoClient().inbox;
  const [state, setState] = React.useState({ notifications: inbox.list(), unread: inbox.unread });
  React.useEffect(() => inbox.subscribe(setState), [inbox]);
  return { inbox, ...state };
}

/** The bell: mentions and replies from every board you've been on, live. */
export function InboxButton({
  boardRoom,
  cardForThread,
  onOpen,
}: {
  boardRoom: string;
  /** The card a thread on this board is about, if any. */
  cardForThread: (threadId: string) => string | undefined;
  onOpen: (cardId: string) => void;
}) {
  const { inbox, notifications, unread } = useInbox();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);

  const go = (n: Notification) => {
    setOpen(false);
    if (n.readAt === undefined) void inbox.markRead([n.id]);
    if (n.room !== boardRoom) {
      navigate(`/demo/${n.room.replace(/^demo:/, "")}`);
      return;
    }
    const cardId = cardForThread(n.threadId);
    if (cardId) onOpen(cardId);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" aria-label={unread ? `Inbox, ${unread} unread` : "Inbox"} className="relative">
          <Icon as={Bell} />
          {unread > 0 && (
            <Badge color="primary" className="absolute -top-1.5 -right-1.5 min-w-5 justify-center px-1">
              {unread}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-80 gap-2 p-2">
        <div className="flex items-center justify-between px-2 py-1">
          <p className="text-sm font-medium">Inbox</p>
          {unread > 0 && (
            <Button size="sm" variant="ghost" onClick={() => void inbox.markAllRead()}>
              Mark all read
            </Button>
          )}
        </div>
        {notifications.length === 0 ? (
          <EmptyState title="Nothing yet" description="When someone @mentions you or replies to your thread, it shows up here." />
        ) : (
          <ul className="grid max-h-96 gap-1 overflow-y-auto">
            {notifications.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => go(n)}
                  className="grid w-full gap-0.5 rounded-control px-2 py-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="flex items-center gap-2 text-sm">
                    {n.readAt === undefined && <span role="img" aria-label="Unread" className="size-2 rounded-pill bg-primary" />}
                    <span className="font-medium">{n.actor.name ?? n.actor.id}</span>
                    <span className="text-muted-foreground">{n.kind === "mention" ? "mentioned you" : "replied"}</span>
                  </span>
                  <span className="truncate text-sm text-muted-foreground">{n.excerpt}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
