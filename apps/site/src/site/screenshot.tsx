import { cn } from "@junco/react";

/**
 * A screenshot in a browser frame, light or dark to match the site. Files are in
 * public/screenshots as <name>-light.png and <name>-dark.png.
 */
export function Screenshot({ name, alt, priority = false, className }: { name: string; alt: string; priority?: boolean; className?: string }) {
  const loading = priority ? "eager" : "lazy";
  return (
    <figure className={cn("overflow-hidden rounded-card border border-border bg-surface shadow-float", className)}>
      <div className="flex h-8 items-center gap-1.5 border-b border-border bg-muted px-3" aria-hidden>
        <span className="size-2.5 rounded-pill bg-border" />
        <span className="size-2.5 rounded-pill bg-border" />
        <span className="size-2.5 rounded-pill bg-border" />
        <span className="mx-auto truncate rounded-xs bg-background px-2 py-0.5 font-mono text-[11px] text-muted-foreground">towhee.madebytobi.com/demo</span>
      </div>
      <img src={`/screenshots/${name}-light.png`} alt={alt} loading={loading} decoding="async" className="block w-full dark:hidden" />
      <img src={`/screenshots/${name}-dark.png`} alt={alt} loading={loading} decoding="async" className="hidden w-full dark:block" />
    </figure>
  );
}
