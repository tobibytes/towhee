import { PageShell, Section, Container, SectionHeading } from "@junco/blocks/marketing";
import { Badge, Button } from "@junco/react";
import { Footer, GITHUB, Header, JUNCO, JUNCO_COLLAB, JUNCO_EXAMPLE } from "../site/layout";
import { Screenshot } from "../site/screenshot";

const shots = [
  { name: "board", title: "Live cursors and who's here", text: "Each person's pointer, name and color, and a ring on the card they have open. Presence identity comes from their token." },
  { name: "comments", title: "Comments with @mentions", text: "Threads anchored to a card, replies, reactions and resolve. Mentioning someone sends them a notification." },
  { name: "inbox", title: "An inbox for every user", text: "Mentions and replies from every board, live in every tab, with read state that follows you." },
  { name: "history", title: "Version history and restore", text: "Automatic and saved versions. Restoring changes the board for everyone, and Undo takes it back." },
];

export function Examples() {
  return (
    <PageShell header={<Header />} footer={<Footer />}>
      <Section>
        <Container className="grid gap-12">
          <SectionHeading
            level={1}
            eyebrow="Examples"
            title="Towhee Board"
            description={
              <>
                A shared kanban board: every card, cursor, comment and version syncs live. It runs on this server and is built with{" "}
                <a className="underline underline-offset-4" href={JUNCO}>Junco</a> components.
              </>
            }
          />
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild>
              <a href="/demo">Open a new board</a>
            </Button>
            <Button asChild variant="outline">
              <a href={`${GITHUB}/tree/main/apps/site/src/demo`}>Read the source</a>
            </Button>
            <Button asChild variant="ghost">
              <a href={JUNCO_EXAMPLE}>See it on Junco&apos;s examples</a>
            </Button>
          </div>
          <div className="grid gap-16">
            {shots.map((s, i) => (
              <div key={s.name} className="grid items-center gap-8 lg:grid-cols-[1fr_2fr]">
                <div className={i % 2 ? "lg:order-2" : undefined}>
                  <Badge variant="outline">{String(i + 1).padStart(2, "0")}</Badge>
                  <h2 className="mt-3 text-2xl font-semibold tracking-tight">{s.title}</h2>
                  <p className="mt-2 text-pretty text-muted-foreground">{s.text}</p>
                </div>
                <Screenshot name={s.name} alt={s.title} />
              </div>
            ))}
          </div>
          <div className="grid gap-3 rounded-card border border-border bg-surface p-6">
            <h2 className="text-xl font-semibold tracking-tight">What it uses</h2>
            <ul className="grid gap-1.5 text-muted-foreground sm:grid-cols-2">
              <li>A Yjs map per card (title, note, column), edited by everyone at once</li>
              <li>Presence: pointer position and the open card</li>
              <li>Threads anchored to cards, with mentions and reactions</li>
              <li>The user&apos;s inbox, opened with an inbox token</li>
              <li>History: save, restore, and undo through a Yjs UndoManager</li>
              <li>Anonymous demo tokens, limited to demo:* rooms</li>
            </ul>
          </div>
          <div className="grid gap-3 rounded-card border border-border p-6 sm:grid-cols-[1fr_auto] sm:items-center">
            <div className="grid gap-1">
              <h2 className="text-xl font-semibold tracking-tight">Build your own, faster</h2>
              <p className="text-pretty text-muted-foreground">
                The board&apos;s interface became <a className="underline underline-offset-4" href={JUNCO_COLLAB}>@junco/collab</a>: avatar
                stack, live cursors, who&apos;s-editing bar, comments with mentions, version history and an inbox, ready to plug into
                Towhee with one adapter.
              </p>
            </div>
            <Button asChild variant="outline">
              <a href={JUNCO_COLLAB}>Try the components</a>
            </Button>
          </div>
        </Container>
      </Section>
    </PageShell>
  );
}
