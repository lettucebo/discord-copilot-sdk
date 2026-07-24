import { describe, it, expect } from "vitest";
import { shouldResetEffort, validateEffort } from "../src/core/effort.js";

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
