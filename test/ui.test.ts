import { describe, expect, it } from "vitest";

async function loadUi() {
  return import("../scripts/lib/ui.mjs");
}

describe("displayWidth", () => {
  it("counts ASCII, CJK, combining marks, and SGR escapes by visible width", async () => {
    const { displayWidth } = await loadUi();

    expect(displayWidth("Build")).toBe(5);
    expect(displayWidth("版本")).toBe(4);
    expect(displayWidth("e\u0301")).toBe(1);
    expect(displayWidth("\u001b[31mred\u001b[0m")).toBe(3);
    expect(displayWidth("✌️")).toBe(1);
  });
});

describe("truncateDisplayWidth", () => {
  it("truncates to the requested visible width and uses a fitting suffix", async () => {
    const { truncateDisplayWidth, displayWidth } = await loadUi();

    expect(truncateDisplayWidth("abcdef", 5)).toBe("abcd…");
    expect(displayWidth(truncateDisplayWidth("abcdef", 5))).toBeLessThanOrEqual(5);
  });

  it("drops the suffix when the suffix itself does not fit", async () => {
    const { truncateDisplayWidth, displayWidth } = await loadUi();

    expect(truncateDisplayWidth("abcdef", 2, "<<<")).toBe("ab");
    expect(displayWidth(truncateDisplayWidth("abcdef", 2, "<<<"))).toBeLessThanOrEqual(2);
  });

  it("returns an empty string for a non-positive max width", async () => {
    const { truncateDisplayWidth } = await loadUi();

    expect(truncateDisplayWidth("abcdef", 0)).toBe("");
    expect(truncateDisplayWidth("abcdef", -1)).toBe("");
  });

  it("preserves reset safety and never splits a Unicode code point", async () => {
    const { truncateDisplayWidth } = await loadUi();

    expect(truncateDisplayWidth("\u001b[31mabcdef\u001b[0m", 4)).toBe("\u001b[31mabc…\u001b[0m");
    expect(truncateDisplayWidth("🙂🙂", 1, "")).toBe("🙂");
    expect(truncateDisplayWidth("e\u0301f", 1, "")).toBe("e\u0301");
  });
});

describe("formatters", () => {
  it("formats stage and section headers exactly", async () => {
    const { formatStage, formatSection } = await loadUi();

    expect(formatStage(2, 5, "Build")).toBe("[2/5] Build");
    expect(formatSection("Install plan")).toBe("\nInstall plan");
  });

  it("aligns visible key width for CJK keys", async () => {
    const { formatKeyValue } = await loadUi();

    expect(formatKeyValue("版本", "1.2.0", 8)).toBe("版本      1.2.0");
  });

  it("renders summary boundaries and interior rows", async () => {
    const { formatSummary, formatKeyValue } = await loadUi();

    expect(formatSummary([["Version", "1.2.0"], ["版本", "stable"]], 10)).toBe(
      ["----------", formatKeyValue("Version", "1.2.0"), formatKeyValue("版本", "stable"), "----------"].join("\n")
    );
  });

  it("rejects invalid summary widths and rows", async () => {
    const { formatSummary } = await loadUi();

    expect(() => formatSummary([["Version", "1.2.0"]], 0)).toThrow(TypeError);
    expect(() => formatSummary([["Version", "1.2.0"]], 1.5)).toThrow(TypeError);
    expect(() => formatSummary([["Version", "1.2.0"], ["broken"] as unknown as [string, string]], 10)).toThrow(TypeError);
    expect(() => formatSummary([["Version", 120] as unknown as [string, string]], 10)).toThrow(TypeError);
  });
});

describe("supportsDynamicProgress", () => {
  it("enables dynamic progress only for TTY output without NO_COLOR", async () => {
    const { supportsDynamicProgress } = await loadUi();

    expect(supportsDynamicProgress({ isTTY: true, noColor: false })).toBe(true);
    expect(supportsDynamicProgress({ isTTY: true, noColor: true })).toBe(false);
    expect(supportsDynamicProgress({ isTTY: false, noColor: false })).toBe(false);
    expect(supportsDynamicProgress({ isTTY: false, noColor: true })).toBe(false);
  });
});
