import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyCheckout,
  orderUpdateSteps,
  parseLsRemote,
  resolveRemoteSha,
} from "../scripts/lib/update-core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenModule = "(?:node:)?(?:fs(?:/promises)?|child_process|process)";
const forbiddenModuleImport = new RegExp(
  `(?:from\\s+["']${forbiddenModule}["']|import\\s+["']${forbiddenModule}["']|import\\s*\\(\\s*["']${forbiddenModule}["']\\s*\\)|require\\s*\\(\\s*["']${forbiddenModule}["']\\s*\\))`
);
const forbiddenProcessAccess = /\b(?:(?:global|globalThis)\s*\.\s*)?process\s*\./;

function hasForbiddenUpdateCoreEffect(source: string): boolean {
  return forbiddenModuleImport.test(source) || forbiddenProcessAccess.test(source);
}

describe("update-core purity", () => {
  it("does not import or invoke filesystem or subprocess APIs", () => {
    // This module decides whether it is safe to stop a running bot. Keeping its
    // decision functions free of effects lets its tests cover every path without
    // mutating a checkout or probing a real process.
    const source = fs.readFileSync(path.join(ROOT, "scripts", "lib", "update-core.mjs"), "utf8");

    expect(hasForbiddenUpdateCoreEffect(source)).toBe(false);
  });

  it.each([
    [`import "node:fs";`],
    [`import "fs/promises";`],
    [`require ("node:child_process");`],
    [`global.process.exitCode = 1;`],
  ])("rejects an otherwise bypassable I/O entry point: %s", (source) => {
    expect(hasForbiddenUpdateCoreEffect(source)).toBe(true);
  });
});

describe("classifyCheckout", () => {
  it("recognizes a clean detached checkout as bootstrap-managed", () => {
    expect(classifyCheckout({ symbolicRef: "", status: "" })).toBe("managed");
  });

  it("recognizes a clean named branch as eligible for fast-forward-only update", () => {
    expect(classifyCheckout({ symbolicRef: "main", status: "" })).toBe("branch-clean");
  });

  it("refuses a named branch with local changes before stopping the bot", () => {
    expect(classifyCheckout({ symbolicRef: "main", status: " M README.md" })).toBe("branch-dirty");
  });

  it("fails closed when git could not supply a checkout fact", () => {
    expect(classifyCheckout({ symbolicRef: null, status: "" })).toBe("unknown");
    expect(classifyCheckout({ symbolicRef: "", status: null })).toBe("unknown");
  });
});

describe("resolveRemoteSha", () => {
  it("uses the peeled commit for an annotated tag instead of its tag object", () => {
    const refs = parseLsRemote(
      [
        "1111111111111111111111111111111111111111\trefs/heads/main",
        "2222222222222222222222222222222222222222\trefs/tags/v1.2.3",
        "3333333333333333333333333333333333333333\trefs/tags/v1.2.3^{}",
      ].join("\n")
    );

    expect(resolveRemoteSha(refs, "v1.2.3")).toEqual({
      sha: "3333333333333333333333333333333333333333",
      ref: "refs/tags/v1.2.3^{}",
    });
  });

  it("prefers a branch when a short ref ambiguously names both a branch and a tag", () => {
    const refs = parseLsRemote(
      [
        "1111111111111111111111111111111111111111\trefs/heads/release",
        "2222222222222222222222222222222222222222\trefs/tags/release",
        "3333333333333333333333333333333333333333\trefs/tags/release^{}",
      ].join("\n")
    );

    expect(resolveRemoteSha(refs, "release")).toEqual({
      sha: "1111111111111111111111111111111111111111",
      ref: "refs/heads/release",
    });
  });

  it("honors a fully-qualified tag ref to remove the branch/tag ambiguity", () => {
    const refs = parseLsRemote(
      [
        "1111111111111111111111111111111111111111\trefs/heads/release",
        "2222222222222222222222222222222222222222\trefs/tags/release",
        "3333333333333333333333333333333333333333\trefs/tags/release^{}",
      ].join("\n")
    );

    expect(resolveRemoteSha(refs, "refs/tags/release")).toEqual({
      sha: "3333333333333333333333333333333333333333",
      ref: "refs/tags/release^{}",
    });
  });

  it("fails closed for malformed records and an unknown ref", () => {
    expect(parseLsRemote("malformed\n")).toEqual([]);
    expect(resolveRemoteSha(parseLsRemote("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/main"), "nope")).toBe(null);
  });
});

describe("orderUpdateSteps", () => {
  it("disables residency before stopping the process", () => {
    const steps = orderUpdateSteps(["process", "residency", "source"]);

    expect(steps.indexOf("residency")).toBeLessThan(steps.indexOf("process"));
  });
});
