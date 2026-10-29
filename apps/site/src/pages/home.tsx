import { Bell, History, MessagesSquare, MousePointer2, RefreshCw, Server } from "lucide-react";
import { Container, CtaSection, FeatureGrid, Hero, PageShell, Section, SectionHeading } from "@junco/blocks/marketing";
import { Badge, Button } from "@junco/react";
import { Code } from "../site/code";
import { Footer, GITHUB, Header, JUNCO, JUNCO_COLLAB } from "../site/layout";
import { Screenshot } from "../site/screenshot";

const features = [
  { icon: MousePointer2, title: "Presence and cursors", description: "See who's here, where they're pointing and what they're editing. Identities come from your app's tokens, so nobody can pretend to be someone else." },
  { icon: RefreshCw, title: "Shared state that syncs", description: "A Yjs document per room. Edits merge without conflicts, work offline and sync on reconnect. TipTap, BlockNote and CodeMirror plug straight in." },
  { icon: MessagesSquare, title: "Comments and threads", description: "Threads anchored to text (they follow it through edits) or to anything in your app. Replies, @mentions, reactions and resolve." },
  { icon: History, title: "Version history", description: "Automatic and named versions. Preview any of them, and restore one for everyone as an ordinary edit that can be undone." },
  { icon: Bell, title: "Notifications", description: "An inbox per user for mentions and replies, live across tabs, plus a signed webhook so your app can send email or push." },
  { icon: Server, title: "Yours to run", description: "One core, two hosts: Cloudflare Durable Objects (idle rooms cost nothing) or a Node server in Docker with SQLite. MIT licensed." },
];

const clientSample = `import { createClient } from "@towhee/client";

const client = createClient({
  url: "wss://towhee.example.com",
  authEndpoint: "/api/towhee-token", // your backend signs a token per room
});

const room = client.enter("doc:42");
room.doc.getText("body");             // a Yjs doc: bind any editor
room.setPresence({ cursor: 12 });     // others see it in room.others()
await room.threads.create({ body: "Can we ship this?" });
await room.history.save("Before the rewrite");`;

const serverSample = `import { createRoomToken } from "@towhee/auth";

// In your backend, after checking the user's session:
const token = await createRoomToken(
  { userId: user.id, room, access: "write", user: { name: user.name } },
  { id: "default", secret: process.env.TOWHEE_SECRET },
);
return Response.json({ token });`;

export function Home() {
  return (
    <PageShell header={<Header />} footer={<Footer />}>
      <Hero
        variant="centered"
        announcement={{ label: "Open the live demo", href: "/demo", tag: "New" }}
        title="Realtime collaboration you host yourself"
        description="Towhee gives your app live cursors, shared documents, comments, version history and notifications, on your own Cloudflare account or any server that runs Docker. Like Liveblocks, but yours."
        primaryAction={{ label: "Try the live demo", href: "/demo" }}
        secondaryAction={{ label: "Read the docs", href: "/docs" }}
        note={<>Open source, MIT. Built with <a className="underline underline-offset-4" href={JUNCO}>Junco</a>.</>}
        media={<Screenshot name="board" alt="Towhee Board: two people editing the same board, with live cursors, comments and an inbox" priority />}
      />

      <FeatureGrid
        eyebrow="What you get"
        title="Everything a multiplayer app needs"
        description="The pieces Liveblocks sells, in a server you deploy in minutes and own."
        features={features}
        variant="cards"
        columns={3}
      />

      <Section>
        <Container>
          <SectionHeading
            eyebrow="How it works"
            title="Your app keeps its users"
            description="Your backend signs a short-lived token for each room. Towhee checks it and never sees passwords or sessions."
          />
          <div className="mt-10 grid gap-6 lg:grid-cols-2">
            <div className="grid content-start gap-3">
              <Badge variant="outline" className="w-fit">In your backend</Badge>
              <Code code={serverSample} title="api/towhee-token.ts" />
            </div>
            <div className="grid content-start gap-3">
              <Badge variant="outline" className="w-fit">In the browser</Badge>
              <Code code={clientSample} title="app.ts" />
            </div>
          </div>
        </Container>
      </Section>

      <Section>
        <Container className="grid gap-6 rounded-card border border-border bg-surface p-6 sm:p-10 lg:grid-cols-[1fr_auto] lg:items-center">
          <SectionHeading
            align="start"
            eyebrow="Ready-made UI"
            title="Pair it with Junco"
            description={
              <>
                <a className="underline underline-offset-4" href={JUNCO}>Junco</a>&apos;s <code className="font-mono text-sm">@junco/collab</code>{" "}
                draws the avatar stack, live cursors, comments, version history, inbox and connection status. Hand it a Towhee room and
                it&apos;s live.
              </>
            }
          />
          <Button asChild variant="outline">
            <a href={JUNCO_COLLAB}>See the components</a>
          </Button>
        </Container>
      </Section>

      <CtaSection
        title="See it working"
        description="Open the demo in two windows (or send the link to a friend) and watch cursors, comments and history sync."
        primaryAction={{ label: "Open Towhee Board", href: "/demo" }}
        secondaryAction={{ label: "View on GitHub", href: GITHUB }}
      />
    </PageShell>
  );
}
