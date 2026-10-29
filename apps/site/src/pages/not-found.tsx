import { PageShell } from "@junco/blocks/marketing";
import { Button, EmptyState } from "@junco/react";
import { Footer, Header } from "../site/layout";

export function NotFound() {
  return (
    <PageShell header={<Header />} footer={<Footer />}>
      <div className="grid min-h-[50dvh] place-items-center px-4">
        <EmptyState
          title="Page not found"
          description="That page doesn't exist."
          actions={
            <Button asChild>
              <a href="/">Home</a>
            </Button>
          }
        />
      </div>
    </PageShell>
  );
}
