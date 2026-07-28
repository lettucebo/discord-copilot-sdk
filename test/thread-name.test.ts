import { describe, it, expect } from "vitest";
import { deriveThreadTitle, THREAD_NAME_MAX } from "../src/core/thread-name.js";

describe("deriveThreadTitle", () => {
  it("uses the first meaningful line of the prompt", () => {
    expect(deriveThreadTitle("修復 /stop 的 latch bug\n\n細節在下面…")).toBe("修復 /stop 的 latch bug");
  });

  it("collapses whitespace and strips markdown noise that reads badly in a sidebar", () => {
    expect(deriveThreadTitle("##   **Fix**   the   bug")).toBe("Fix the bug");
    expect(deriveThreadTitle("- [ ] do the thing")).toBe("do the thing");
  });

  it("skips a leading code fence and uses the first prose line", () => {
    expect(deriveThreadTitle("```ts\nconst a = 1;\n```\nexplain this code")).toBe("explain this code");
  });

  it("strips bidi/control characters (a thread name must not be spoofable)", () => {
    expect(deriveThreadTitle("safe\u202etitle")).toBe("safetitle");
  });

  it("truncates long prompts to fit the Discord limit", () => {
    const t = deriveThreadTitle("x".repeat(400));
    expect(t.length).toBeLessThanOrEqual(THREAD_NAME_MAX);
  });

  it("returns empty for a prompt with no usable text so the caller can fall back", () => {
    expect(deriveThreadTitle("")).toBe("");
    expect(deriveThreadTitle("   \n\n  ")).toBe("");
    expect(deriveThreadTitle("```\ncode only\n```")).toBe("code only");
  });

  it("adds no ordinal prefix — Discord already orders threads by creation", () => {
    // Verified live 2026-07-28: posting the newest message into an OLDER thread
    // did not move it above a newer thread in the sidebar or the Threads
    // browser, so a "#012 ·" prefix conveyed nothing and cost about a quarter of
    // the width the sidebar actually renders.
    expect(deriveThreadTitle("fix the bug")).toBe("fix the bug");
  });
});
