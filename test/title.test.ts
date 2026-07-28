import { describe, it, expect } from "vitest";
import {
  pickTitleModel,
  buildTitlePrompt,
  cleanModelTitle,
  TITLE_INPUT_MAX,
  TITLE_MODEL_PREFERENCE,
} from "../src/core/title.js";
import { THREAD_NAME_MAX } from "../src/core/thread-name.js";

describe("pickTitleModel", () => {
  it("prefers the cheapest available model in preference order", () => {
    expect(pickTitleModel(["claude-sonnet-5", "claude-haiku-4.5", "gemini-3.5-flash"])).toBe(
      "gemini-3.5-flash"
    );
    expect(pickTitleModel(["claude-sonnet-5", "claude-haiku-4.5"])).toBe("claude-haiku-4.5");
  });

  it("returns undefined rather than guessing when no preferred model exists", () => {
    // Titling must never silently run on an expensive/unknown model just because
    // it happened to be first in the tenant's list.
    expect(pickTitleModel(["some-private-preview-model"])).toBeUndefined();
    expect(pickTitleModel([])).toBeUndefined();
  });

  it("honours an explicit override even when it is not in the preference list", () => {
    expect(pickTitleModel(["a", "b"], "b")).toBe("b");
  });

  it("ignores an override that the tenant does not actually have", () => {
    expect(pickTitleModel(["claude-haiku-4.5"], "not-a-model")).toBe("claude-haiku-4.5");
  });

  it("its preference list is non-empty and ordered cheapest-first", () => {
    expect(TITLE_MODEL_PREFERENCE.length).toBeGreaterThan(0);
  });
});

describe("buildTitlePrompt", () => {
  it("bounds the prompt it forwards (a huge first message is the whole point)", () => {
    const p = buildTitlePrompt("x".repeat(50_000));
    expect(p.length).toBeLessThan(TITLE_INPUT_MAX + 600);
    expect(p).toContain("x".repeat(50));
  });

  it("asks for a short title and forbids quoting/prefixing", () => {
    const p = buildTitlePrompt("fix the login bug");
    expect(p).toContain("fix the login bug");
    expect(p.toLowerCase()).toContain("title");
  });
});

describe("cleanModelTitle", () => {
  it("strips the wrapper text small models like to add", () => {
    expect(cleanModelTitle('"Fix login bug"')).toBe("Fix login bug");
    expect(cleanModelTitle("Title: Fix login bug")).toBe("Fix login bug");
    expect(cleanModelTitle("「修復登入錯誤」")).toBe("修復登入錯誤");
    expect(cleanModelTitle("**Fix login bug**")).toBe("Fix login bug");
  });

  it("keeps only the first line when the model rambles", () => {
    expect(cleanModelTitle("Fix login bug\n\nHere is why: ...")).toBe("Fix login bug");
  });

  it("bounds the result to Discord's channel-name limit", () => {
    expect(cleanModelTitle("y".repeat(500)).length).toBeLessThanOrEqual(THREAD_NAME_MAX);
  });

  it("returns empty for junk so the caller can fall back to the heuristic", () => {
    expect(cleanModelTitle("")).toBe("");
    expect(cleanModelTitle("   ")).toBe("");
    expect(cleanModelTitle('""')).toBe("");
  });

  it("strips bidi/control characters (a thread name must not be spoofable)", () => {
    expect(cleanModelTitle("safe\u202etitle")).toBe("safetitle");
  });
});
