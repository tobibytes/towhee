import { Outlet, ScrollRestoration, useLocation } from "react-router";
import { BrandMark, LinkProvider, SiteFooter, SiteHeader } from "@junco/blocks/marketing";
import { RouterLink, useInternalLinks } from "./links";
import { ThemeToggle } from "./theme-toggle";

export const GITHUB = "https://github.com/tobibytes/towhee";
export const JUNCO = "https://junco.madebytobi.com";

const brand = { name: "Towhee", href: "/", logo: <BrandMark className="size-6 text-primary" /> };
const links = [
  { label: "Docs", href: "/docs" },
  { label: "Examples", href: "/examples" },
  { label: "Live demo", href: "/demo" },
  { label: "GitHub", href: GITHUB },
];

/** Every route: router-aware links, and scroll to the top on navigation. */
export function RootLayout() {
  useInternalLinks();
  return (
    <LinkProvider component={RouterLink}>
      <Outlet />
      <ScrollRestoration />
    </LinkProvider>
  );
}

export function Header() {
  const { pathname } = useLocation();
  const current = links.find((l) => l.href !== "/" && pathname.startsWith(l.href))?.href;
  return (
    <SiteHeader
      brand={brand}
      links={links}
      currentHref={current}
      cta={{ label: "Try the demo", href: "/demo" }}
      secondaryCta={null}
      actions={<ThemeToggle />}
      isSticky
    />
  );
}

export function Footer() {
  return (
    <SiteFooter
      brand={brand}
      tagline="Realtime collaboration you host yourself. MIT."
      columns={[
        {
          title: "Towhee",
          links: [
            { label: "Docs", href: "/docs" },
            { label: "Examples", href: "/examples" },
            { label: "Live demo", href: "/demo" },
          ],
        },
        {
          title: "Run it",
          links: [
            { label: "On Cloudflare", href: "/docs/cloudflare" },
            { label: "With Docker", href: "/docs/docker" },
            { label: "Managing Towhee", href: "/docs/managing" },
          ],
        },
        {
          title: "More",
          links: [
            { label: "GitHub", href: GITHUB },
            { label: "Junco design system", href: JUNCO },
          ],
        },
      ]}
      legal={
        <>
          Built with <a className="underline underline-offset-4" href={JUNCO}>Junco</a>.
        </>
      }
      status={{ label: "Server status", href: "/health", state: "ok" }}
    />
  );
}
