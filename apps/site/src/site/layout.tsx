import { Outlet, ScrollRestoration, useLocation } from "react-router";
import { LinkProvider, SiteFooter, SiteHeader } from "@junco/blocks/marketing";
import { RouterLink, useInternalLinks } from "./links";
import { ThemeToggle } from "./theme-toggle";

export const GITHUB = "https://github.com/tobibytes/towhee";
export const JUNCO = "https://junco.madebytobi.com";
/** Junco's collaboration UI (@junco/collab) and the board on Junco's examples page. */
export const JUNCO_COLLAB = `${JUNCO}/docs/collaboration/`;
export const JUNCO_EXAMPLE = `${JUNCO}/examples/towhee-board/`;

const brand = { name: "Towhee", href: "/", logo: <img src="/brand/mark.svg" alt="" width={28} height={28} className="size-7 rounded-control" /> };
const links = [
  { label: "Docs", href: "/docs" },
  { label: "Examples", href: "/examples" },
  { label: "Live demo", href: "/demo" },
  { label: "UI kit", href: JUNCO_COLLAB },
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
      tagline="Realtime collaboration you host yourself. Open source, on Cloudflare or Docker."
      columns={[
        {
          title: "Towhee",
          links: [
            { label: "Docs", href: "/docs" },
            { label: "Examples", href: "/examples" },
            { label: "Live demo", href: "/demo" },
            { label: "React", href: "/docs/react" },
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
          title: "Project",
          links: [
            { label: "GitHub", href: GITHUB },
            { label: "Releases", href: `${GITHUB}/releases` },
            { label: "npm", href: "https://www.npmjs.com/org/towhee" },
            { label: "Docker image", href: `${GITHUB}/pkgs/container/towhee` },
          ],
        },
        {
          title: "Junco",
          links: [
            { label: "Design system", href: JUNCO },
            { label: "UI kit (@junco/collab)", href: JUNCO_COLLAB },
            { label: "Towhee Board on Junco", href: JUNCO_EXAMPLE },
          ],
        },
      ]}
      legal={
        <>
          © {new Date().getFullYear()} Oluwatobi Olajide. MIT licensed. Built with{" "}
          <a className="underline underline-offset-4" href={JUNCO}>Junco</a>.
        </>
      }
      status={{ label: "Server status", href: "/health", state: "ok" }}
    />
  );
}
