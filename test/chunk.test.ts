import { describe, it, expect } from "vitest";
import { chunkText } from "../src/core/chunk.js";

describe("chunkText", () => {
  it("returns [] for empty input", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("returns a single chunk when within the limit", () => {
    expect(chunkText("hello", 1900)).toEqual(["hello"]);
  });

  it("never exceeds the max and preserves content exactly (lossless)", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkText(text, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("prefers to break on a newline boundary", () => {
    const text = "a".repeat(50) + "\n" + "b".repeat(50);
    const chunks = chunkText(text, 60);
    expect(chunks[0]).toBe("a".repeat(50) + "\n");
    expect(chunks[1]).toBe("b".repeat(50));
  });

  it("breaks on a space when there is no newline", () => {
    const text = "a".repeat(50) + " " + "b".repeat(50);
    const chunks = chunkText(text, 60);
    expect(chunks[0]).toBe("a".repeat(50) + " ");
    expect(chunks.join("")).toBe(text);
  });

  it("hard-splits an over-long token with no boundary", () => {
    const text = "x".repeat(5000);
    const chunks = chunkText(text, 1900);
    expect(chunks.map((c) => c.length)).toEqual([1900, 1900, 1200]);
    expect(chunks.join("")).toBe(text);
  });

  it("rejects a non-positive max", () => {
    expect(() => chunkText("hi", 0)).toThrow(/positive/i);
  });
});
