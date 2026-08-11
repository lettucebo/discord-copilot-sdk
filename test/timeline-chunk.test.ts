import { describe, expect, it } from "vitest";
import { chunkTimeline } from "../src/core/timeline-chunk.js";

describe("chunkTimeline", () => {
  it("packs complete display items greedily without changing earlier chunks", () => {
    const first = chunkTimeline(["a".repeat(10), "b".repeat(10)], 15);
    const extended = chunkTimeline(["a".repeat(10), "b".repeat(10), "c".repeat(10)], 15);

    expect(first).toEqual(["a".repeat(10), "b".repeat(10)]);
    expect(extended.slice(0, first.length)).toEqual(first);
  });

  it("keeps every hard-split spoiler independently balanced", () => {
    const item = `-# 💭 Thinking\n||${"x".repeat(100)}||`;
    const chunks = chunkTimeline([item], 40);

    expect(chunks).toHaveLength(5);
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true);
    expect(chunks.every((chunk) => (chunk.match(/\|\|/g) ?? []).length === 2)).toBe(true);
    expect(chunks.map((chunk) => chunk.slice("-# 💭 Thinking\n||".length, -2)).join("")).toBe(
      "x".repeat(100)
    );
  });

  it("closes and reopens a fenced block when a table item exceeds one message", () => {
    const item = `\`\`\`text\n${Array.from({ length: 10 }, (_, i) => `row-${i} ${"x".repeat(12)}`).join("\n")}\n\`\`\``;
    const chunks = chunkTimeline([item], 50);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 50)).toBe(true);
    expect(
      chunks.every((chunk) => {
        const fences = chunk.match(/```/g) ?? [];
        return fences.length % 2 === 0;
      })
    ).toBe(true);
    expect(chunks.map((chunk) => chunk.replace(/```(?:text)?\n?/g, "")).join("")).toContain("row-9");
  });

  it("rejects a non-positive maximum", () => {
    expect(() => chunkTimeline(["hello"], 0)).toThrow(/positive/i);
  });
});
