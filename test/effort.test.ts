import { describe, it, expect } from "vitest";
import { shouldResetEffort, validateEffort, EFFORT_LEVELS } from "../src/core/effort.js";

/**
 * Real `supportedReasoningEfforts` captured from `client.listModels()` on
 * 2026-07-28 (20 models). This is the ground truth the /effort choice list must
 * cover — Discord choices are static, so a level missing here is UNREACHABLE
 * from the UI no matter which model is selected.
 */
const OBSERVED_MODEL_EFFORTS: Record<string, string[]> = {
  auto: [],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4.6": ["low", "medium", "high", "max"],
  "claude-haiku-4.5": [],
  "claude-opus-4.8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4.7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4.6": ["low", "medium", "high", "max"],
  "gpt-5.6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.5": ["none", "low", "medium", "high", "xhigh"],
  "gpt-5.4": ["none", "low", "medium", "high", "xhigh"],
  "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["none", "low", "medium", "high", "xhigh"],
  "gpt-5-mini": ["low", "medium", "high"],
  "gemini-3.1-pro-preview": ["low", "medium", "high"],
  "gemini-3.5-flash": ["minimal", "low", "medium", "high"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "gemini-3.6-flash": [],
  "mai-code-1-flash-picker": ["low", "medium", "high"],
};

describe("EFFORT_LEVELS (the /effort choice list)", () => {
  it("covers EVERY effort the runtime reports, so none is unreachable from Discord", () => {
    const union = new Set(Object.values(OBSERVED_MODEL_EFFORTS).flat());
    const missing = [...union].filter((e) => !(EFFORT_LEVELS as readonly string[]).includes(e));
    expect(missing).toEqual([]); // regression guard: max/none/minimal were missing before
  });

  it("every offered level is accepted for at least one real model", () => {
    for (const level of EFFORT_LEVELS) {
      const accepted = Object.entries(OBSERVED_MODEL_EFFORTS).some(
        ([model, supported]) => validateEffort(model, level, supported).ok
      );
      expect(accepted, `no model accepts effort "${level}"`).toBe(true);
    }
  });

  it("stays within Discord's 25-choice limit", () => {
    expect(EFFORT_LEVELS.length).toBeLessThanOrEqual(25);
  });
});

describe("shouldResetEffort", () => {
  it("does not reset when no effort is currently set", () => {
    expect(shouldResetEffort(undefined, [])).toBe(false);
    expect(shouldResetEffort(undefined, ["low"])).toBe(false);
  });

  it("does not reset for an unknown model (undefined support)", () => {
    // Model absent from the snapshot: we cannot judge, so keep the effort.
    expect(shouldResetEffort("high", undefined)).toBe(false);
  });

  it("resets when switching to a known model with NO effort support ([])", () => {
    // The blocking bug: [] was collapsed with undefined and skipped the reset.
    expect(shouldResetEffort("high", [])).toBe(true);
  });

  it("resets when the known model doesn't list the current effort", () => {
    expect(shouldResetEffort("xhigh", ["low", "medium", "high"])).toBe(true);
  });

  it("keeps the effort when the known model supports it", () => {
    expect(shouldResetEffort("high", ["low", "medium", "high"])).toBe(false);
  });
});

describe("validateEffort", () => {
  it("allows any level for an unknown model (undefined support)", () => {
    expect(validateEffort("mystery", "high", undefined)).toEqual({ ok: true });
  });

  it("rejects any level for a known model with NO effort support ([])", () => {
    const r = validateEffort("haiku", "high", []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("不支援");
  });

  it("rejects an unsupported level with the supported list", () => {
    const r = validateEffort("sonnet", "xhigh", ["low", "medium", "high"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("low, medium, high");
      expect(r.message).toContain("sonnet");
    }
  });

  it("accepts a supported level", () => {
    expect(validateEffort("sonnet", "high", ["low", "medium", "high"])).toEqual({ ok: true });
  });
});
