import type * as React from "react";
import { NavLink, Outlet } from "react-router";
import { PageShell } from "@junco/blocks/marketing";
import { cn } from "@junco/react";
import { Footer, Header } from "../../site/layout";

export const DOCS_NAV = [
  {
    title: "Start",
    items: [
      { href: "/docs", label: "Overview and quick start" },
      { href: "/docs/client", label: "Using the client" },
      { href: "/docs/react", label: "React" },
      { href: "/docs/tokens", label: "Tokens and access" },
    ],
  },
  {
    title: "Run it",
    items: [
      { href: "/docs/cloudflare", label: "Deploy on Cloudflare" },
      { href: "/docs/docker", label: "Run with Docker or Node" },
      { href: "/docs/managing", label: "Managing Towhee" },
    ],
  },
  { title: "Reference", items: [{ href: "/docs/reference", label: "Endpoints, limits and errors" }] },
];

/** Docs pages: a sidebar and an article column. */
export function DocsLayout() {
  return (
    <PageShell header={<Header />} footer={<Footer />}>
      <div className="mx-auto grid w-full max-w-screen-xl gap-10 px-4 py-10 md:grid-cols-[14rem_minmax(0,1fr)] md:px-6">
        <nav aria-label="Docs" className="md:sticky md:top-20 md:self-start">
          {DOCS_NAV.map((group) => (
            <div key={group.title} className="mb-6">
              <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{group.title}</p>
              <ul className="grid gap-0.5">
                {group.items.map((item) => (
                  <li key={item.href}>
                    <NavLink
                      to={item.href}
                      end
                      className={({ isActive }) =>
                        cn(
                          "block rounded-control px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
                          isActive && "bg-muted font-medium text-foreground",
                        )
                      }
                    >
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <article className="grid min-w-0 max-w-3xl content-start gap-6">
          <Outlet />
        </article>
      </div>
    </PageShell>
  );
}

export const H1 = ({ children, lead }: { children: React.ReactNode; lead?: React.ReactNode }) => (
  <header className="grid gap-3 border-b border-border pb-6">
    <h1 className="text-3xl font-semibold tracking-tight text-balance">{children}</h1>
    {lead && <p className="text-lg text-pretty text-muted-foreground">{lead}</p>}
  </header>
);

export const H2 = ({ id, children }: { id: string; children: React.ReactNode }) => (
  <h2 id={id} className="mt-6 scroll-mt-20 text-xl font-semibold tracking-tight">
    <a href={`#${id}`} className="hover:underline">
      {children}
    </a>
  </h2>
);

export const P = ({ children }: { children: React.ReactNode }) => <p className="leading-relaxed text-pretty text-muted-foreground">{children}</p>;

export const List = ({ items }: { items: React.ReactNode[] }) => (
  <ul className="grid list-disc gap-1.5 pl-5 text-muted-foreground marker:text-border">
    {items.map((item, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: static docs content
      <li key={i}>{item}</li>
    ))}
  </ul>
);

export function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-card border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted text-foreground">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static docs content
            <tr key={i} className="border-t border-border align-top">
              {row.map((cell, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static docs content
                <td key={j} className="px-3 py-2 text-muted-foreground">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A highlighted note. */
export function Note({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <aside className="rounded-card border border-border bg-surface p-4">
      <p className="font-medium text-foreground">{title}</p>
      <div className="mt-1 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </aside>
  );
}

export const A = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} className="font-medium text-foreground underline underline-offset-4 hover:decoration-primary">
    {children}
  </a>
);
