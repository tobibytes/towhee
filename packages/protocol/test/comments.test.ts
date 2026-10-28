import { describe, expect, it } from "vitest";
import { bodyMentions, bodyText, COMMENT_LIMITS, hasContent, isAnchor, isCommentBody, isReaction, isThreadMetadata, textBody } from "../src";

const para = (...children: unknown[]) => ({ version: 1, content: [{ type: "paragraph", children }] });

describe("comment bodies", () => {
  it("accept text runs with marks, links and mentions", () => {
    const body = para(
      { type: "text", text: "Hi ", bold: true },
      { type: "mention", userId: "ada" },
      { type: "text", text: ", see " },
      { type: "link", url: "https://example.com/doc", children: [{ type: "text", text: "the doc", italic: true }] },
      { type: "link", url: "mailto:a@b.c", children: [{ type: "text", text: "mail" }] },
    );
    expect(isCommentBody(body)).toBe(true);
    expect(isCommentBody({ version: 1, content: [] })).toBe(true); // a deleted comment's body
  });

  it("refuse anything that could carry markup, scripts or junk", () => {
    const bad = [
      "plain string",
      { version: 2, content: [] },
      { version: 1, content: [], extra: true },
      { version: 1, content: [{ type: "heading", children: [] }] },
      para({ type: "html", html: "<b>x</b>" }),
      para({ type: "text", text: "x", onclick: "alert(1)" }),
      para({ type: "text", text: 5 }),
      para({ type: "text", text: "x", bold: "yes" }),
      para({ type: "link", url: "javascript:alert(1)", children: [{ type: "text", text: "x" }] }),
      para({ type: "link", url: "data:text/html,<script>", children: [{ type: "text", text: "x" }] }),
      para({ type: "link", url: "https://x.com", children: [] }),
      para({ type: "link", url: "https://x.com", children: [{ type: "mention", userId: "a" }] }),
      para({ type: "mention", userId: "" }),
      textBody("x".repeat(COMMENT_LIMITS.bodyBytes)),
    ];
    for (const b of bad) expect(isCommentBody(b), JSON.stringify(b).slice(0, 80)).toBe(false);
  });

  it("convert to and from plain text", () => {
    const body = textBody("line one\n\nline three");
    expect(body.content).toHaveLength(3);
    expect(bodyText(body)).toBe("line one\n\nline three");
    expect(hasContent(body)).toBe(true);
    expect(hasContent(textBody("  \n "))).toBe(false);
    expect(hasContent(para({ type: "mention", userId: "ada" }) as never)).toBe(true);
  });

  it("list mentions once each", () => {
    const body = para({ type: "mention", userId: "ada" }, { type: "text", text: " and " }, { type: "mention", userId: "bob" }, { type: "mention", userId: "ada" });
    expect(bodyMentions(body as never)).toEqual(["ada", "bob"]);
    expect(bodyText(body as never)).toBe("@ada and @bob@ada");
  });
});

describe("anchors, metadata and reactions", () => {
  it("accept text and app anchors only", () => {
    expect(isAnchor({ type: "app", id: "block-1" })).toBe(true);
    expect(isAnchor({ type: "text", start: "AAEC", end: "AQID+/==" })).toBe(true);
    expect(isAnchor({ type: "text", start: "not base64", end: "AA==" })).toBe(false);
    expect(isAnchor({ type: "app", id: "" })).toBe(false);
    expect(isAnchor({ type: "app", id: "x", extra: 1 })).toBe(false);
    expect(isAnchor({ type: "point", x: 1 })).toBe(false);
  });

  it("accept flat metadata only", () => {
    expect(isThreadMetadata({ status: "open", priority: 2, urgent: false })).toBe(true);
    expect(isThreadMetadata({ nested: { a: 1 } })).toBe(false);
    expect(isThreadMetadata({ n: Number.NaN })).toBe(false);
    expect(isThreadMetadata(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])))).toBe(false);
  });

  it("accept short reactions", () => {
    expect(isReaction("👍")).toBe(true);
    expect(isReaction("👍🏽")).toBe(true);
    expect(isReaction("")).toBe(false);
    expect(isReaction("two words")).toBe(false);
    expect(isReaction("x".repeat(33))).toBe(false);
  });
});
