import { describe, it, expect } from "vitest";
import { nodeVersionOk } from "../scripts/lib/setup-core.mjs";

describe("nodeVersionOk (engines: ^20.19 || >=22.12)", () => {
  it.each([
    ["20.19.0", true], // first supported 20.x
    ["20.19.5", true],
    ["20.20.0", true],
    ["22.12.0", true], // first supported 22.x
    ["22.13.1", true],
    ["24.0.0", true], // any >=22 major
    ["23.5.0", true], // 23.x is >=22 major -> allowed by >=22.12 rule
  ])("accepts %s", (v, ok) => {
    expect(nodeVersionOk(v)).toBe(ok);
  });

  it.each([
    ["20.18.9", false], // one patch line below the 20.19 gate
    ["20.0.0", false],
    ["21.7.3", false], // odd/non-LTS major is unsupported
    ["22.11.0", false], // one minor below the 22.12 gate
    ["18.20.0", false], // too old
    ["19.9.0", false],
  ])("rejects %s", (v, ok) => {
    expect(nodeVersionOk(v)).toBe(ok);
  });

  it("rejects malformed version strings", () => {
    expect(nodeVersionOk("not.a.version")).toBe(false);
    expect(nodeVersionOk("")).toBe(false);
    expect(nodeVersionOk("22")).toBe(false); // no minor -> min is NaN
  });
});
