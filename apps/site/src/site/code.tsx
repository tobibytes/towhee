import { Check, Copy } from "lucide-react";
import * as React from "react";
import { Button, cn, Icon, Tooltip } from "@junco/react";

/** A code sample with a copy button. */
export function Code({ code, title, className }: { code: string; title?: string; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked; nothing to do.
    }
  };
  return (
    <figure className={cn("overflow-hidden rounded-card border border-border bg-surface", className)}>
      {title && <figcaption className="border-b border-border px-4 py-2 font-mono text-xs text-muted-foreground">{title}</figcaption>}
      <div className="relative">
        <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed text-foreground">
          <code>{code}</code>
        </pre>
        <Tooltip content={copied ? "Copied" : "Copy"}>
          <Button variant="ghost" size="icon" className="absolute top-2 right-2" aria-label="Copy code" onClick={copy}>
            <Icon as={copied ? Check : Copy} />
          </Button>
        </Tooltip>
      </div>
    </figure>
  );
}

/** Inline code. */
export const C = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded-xs bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">{children}</code>
);
