import { describe, expect, it } from "vitest";
import { formatTimeline, formatTimelineItems } from "../src/core/format-timeline.js";
import type { TimelineItem } from "../src/core/turn-render.js";

describe("formatTimeline", () => {
  it("renders chronological text, compact tools, and collapsed thinking with stable spacing", () => {
    const items: TimelineItem[] = [
      { kind: "text", text: "I will inspect the renderer.\n\n\n\nThen I will report back.", open: false },
      {
        kind: "tool",
        id: "t1",
        name: "read",
        possiblePaths: ["C:\\repo\\src\\core\\turn-render.ts"],
        status: "completed",
      },
      { kind: "reasoning", id: "r1", text: "I need to keep events in arrival order.", open: false },
      { kind: "text", text: "The renderer currently appends every tool at the end.", open: false },
    ];

    const rendered = formatTimeline(items);
    expect(rendered).toContain("I will inspect the renderer.\n\nThen I will report back.");
    expect(rendered).toContain("-# ⚙ `read` `C:\\repo\\src\\core\\turn-render.ts` ✓");
    expect(rendered).toContain("-# 💭 Thinking\n||I need to keep events in arrival order.||");
    expect(rendered).toContain("The renderer currently appends every tool at the end.");
    expect(rendered.indexOf("I will inspect")).toBeLessThan(rendered.indexOf("⚙"));
    expect(rendered.indexOf("⚙")).toBeLessThan(rendered.indexOf("💭"));
    expect(rendered.indexOf("💭")).toBeLessThan(rendered.indexOf("The renderer"));
    expect(rendered).not.toContain("\n\n\n");
  });

  it("neutralizes spoiler and fence delimiters inside reasoning before wrapping it", () => {
    const rendered = formatTimeline([
      {
        kind: "reasoning",
        id: "r1",
        text: "Try ||forged spoiler||\n```\nnot a fenced block\n```",
        open: false,
      },
    ]);

    expect(rendered).toBe(
      "-# 💭 Thinking\n||Try |\u200b|forged spoiler|\u200b|\n'''\nnot a fenced block\n'''||"
    );
  });

  it("converts a CJK markdown table to an aligned text code block", () => {
    const rendered = formatTimeline([
      {
        kind: "text",
        open: false,
        text: [
          "Summary:",
          "| # | 公司 | 評分 |",
          "|---|---|---|",
          "| 004 | 空中巴士 | 1.8/5 |",
        ].join("\n"),
      },
    ]);

    expect(rendered).toContain("```text");
    expect(rendered).toContain("公司");
    expect(rendered).toContain("空中巴士");
    expect(rendered).not.toContain("| 004 | 空中巴士 |");
  });

  it("falls back to readable bullets for a table that exceeds display limits", () => {
    const rows = Array.from({ length: 21 }, (_, i) => `| ${i} | Candidate ${i} |`).join("\n");
    const rendered = formatTimeline([
      { kind: "text", open: false, text: `| # | Company |\n|---|---|\n${rows}` },
    ]);

    expect(rendered).not.toContain("```text");
    expect(rendered).toContain("- **#**: 0 · **Company**: Candidate 0");
    expect(rendered).toContain("- **#**: 20 · **Company**: Candidate 20");
  });

  it("does not change already-rendered table rows when a later row is wider", () => {
    const first = formatTimeline([
      {
        kind: "text",
        open: true,
        text: "| Company | Score |\n|---|---|\n| A | 1 |",
      },
    ]);
    const extended = formatTimeline([
      {
        kind: "text",
        open: true,
        text: "| Company | Score |\n|---|---|\n| A | 1 |\n| A much longer company name | 100 |",
      },
    ]);

    expect(extended.startsWith(first.replace(/\n```$/, ""))).toBe(true);
  });

  it("preserves intentional blank lines inside fenced code blocks", () => {
    const rendered = formatTimeline([
      {
        kind: "text",
        open: false,
        text: "Before\n\n\n\n```text\none\n\n\n\nthree\n```\n\n\n\nAfter",
      },
    ]);

    expect(rendered).toBe("Before\n\n```text\none\n\n\n\nthree\n```\n\nAfter");
  });

  it("formats audit repetition only as the exact count provided by the renderer", () => {
    const formatted = formatTimelineItems([
      { kind: "audit", raw: "read:a", display: "⚡ `read`: `a`", count: 2 },
    ]);

    expect(formatted).toEqual(["-# ⚡ `read`: `a` ×2"]);
  });
});
