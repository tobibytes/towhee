import * as React from "react";
import { Link, useNavigate } from "react-router";
import type { LinkComponentProps } from "@junco/blocks/marketing";

/** For <LinkProvider>: Junco's marketing blocks render their links through React Router. */
export const RouterLink = React.forwardRef<HTMLAnchorElement, LinkComponentProps>(({ href, ...props }, ref) => (
  <Link ref={ref} to={href} {...props} />
));
RouterLink.displayName = "RouterLink";

/** Routes clicks on plain same-origin <a href> links through React Router, without a page load. */
export function useInternalLinks() {
  const navigate = useNavigate();
  React.useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download") || anchor.origin !== window.location.origin) return;
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#")) return;
      event.preventDefault();
      navigate(anchor.pathname + anchor.search + anchor.hash);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [navigate]);
}
