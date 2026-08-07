import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as releaseCore from "../scripts/lib/release-core.mjs";
import { isSemVer, rollChangelog } from "../scripts/lib/release-core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenModule = "(?:node:)?(?:fs(?:/promises)?|child_process|process)";
const forbiddenModuleImport = new RegExp(
  `(?:from\\s+["']${forbiddenModule}["']|import\\s+["']${forbiddenModule}["']|import\\s*\\(\\s*["']${forbiddenModule}["']\\s*\\)|require\\s*\\(\\s*["']${forbiddenModule}["']\\s*\\))`
);
const forbiddenProcessAccess = /\b(?:(?:global|globalThis)\s*\.\s*)?process\s*\./;

function hasForbiddenReleaseCoreEffect(source: string): boolean {
  return forbiddenModuleImport.test(source) || forbiddenProcessAccess.test(source);
}

describe("isSemVer", () => {
  it.each(["0.1.0", "1.2.3", "1.2.3-rc.1", "1.2.3+build.4"])("accepts %s", (version) => {
    expect(isSemVer(version)).toBe(true);
  });

  it.each(["1.2", "v1.2.3", "1.2.3-01", "1.2.3 "])("rejects %s", (version) => {
    expect(isSemVer(version)).toBe(false);
  });
});

describe("release-core purity", () => {
  it("does not import or invoke filesystem, subprocess, or process APIs", () => {
    const source = fs.readFileSync(path.join(ROOT, "scripts", "lib", "release-core.mjs"), "utf8");

    expect(hasForbiddenReleaseCoreEffect(source)).toBe(false);
  });

  it.each([
    [`import "node:fs";`],
    [`import "fs/promises";`],
    [`require ("node:child_process");`],
    [`global.process.exitCode = 1;`],
  ])("rejects an otherwise bypassable I/O entry point: %s", (source) => {
    expect(hasForbiddenReleaseCoreEffect(source)).toBe(true);
  });
});

describe("rollChangelog", () => {
  it("creates a dated release section immediately below Unreleased", () => {
    const changelog = "# Changelog\n\n## [Unreleased]\n\n### Added\n- A change\n";

    expect(rollChangelog(changelog, "0.2.0", "2026-08-06")).toBe(
      "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-08-06\n\n### Added\n- A change\n"
    );
  });

  it("refuses to tag a changelog with no Unreleased section", () => {
    expect(() => rollChangelog("# Changelog\n", "0.2.0", "2026-08-06")).toThrow(/unreleased/i);
  });
});

describe("parseConventionalCommit", () => {
  it("parses a scoped conventional commit subject", () => {
    expect(typeof releaseCore.parseConventionalCommit).toBe("function");
    expect(releaseCore.parseConventionalCommit?.("feat(parser): add release planning", "")).toEqual({
      type: "feat",
      scope: "parser",
      breaking: false,
      description: "add release planning",
    });
  });

  it("marks a commit as breaking for bang subjects and BREAKING CHANGE footers", () => {
    expect(typeof releaseCore.parseConventionalCommit).toBe("function");
    expect(releaseCore.parseConventionalCommit?.("refactor!: redesign release flow", "")).toEqual({
      type: "refactor",
      breaking: true,
      description: "redesign release flow",
    });
    expect(
      releaseCore.parseConventionalCommit?.("fix: preserve CLI compatibility", "BREAKING-CHANGE: drops the old command")
    ).toEqual({
      type: "fix",
      breaking: true,
      description: "preserve CLI compatibility",
    });
    expect(
      releaseCore.parseConventionalCommit?.("feat: preserve CLI compatibility", "BREAKING CHANGE: drops the old command")
    ).toEqual({
      type: "feat",
      breaking: true,
      description: "preserve CLI compatibility",
    });
  });

  it.each([
    ["feat add parser", ""],
    ["feat: ", ""],
    ["修正: 支援釋出", ""],
  ])("rejects invalid or non-ASCII conventional subjects: %s", (subject, body) => {
    expect(typeof releaseCore.parseConventionalCommit).toBe("function");
    expect(releaseCore.parseConventionalCommit?.(subject, body)).toBeNull();
  });
});

describe("changelogSectionFor", () => {
  it("maps release-worthy commit types to Keep a Changelog sections", () => {
    expect(typeof releaseCore.changelogSectionFor).toBe("function");
    expect(releaseCore.changelogSectionFor?.("feat", false, "feat: add release planning")).toBe("Added");
    expect(releaseCore.changelogSectionFor?.("fix", false, "fix: preserve compatibility")).toBe("Fixed");
    expect(releaseCore.changelogSectionFor?.("perf", false, "perf: reduce render work")).toBe("Changed");
    expect(releaseCore.changelogSectionFor?.("refactor", false, "refactor: simplify update steps")).toBe("Changed");
    expect(releaseCore.changelogSectionFor?.("revert", false, "revert: remove risky publish flow")).toBe("Removed");
  });

  it("routes security fixes and all breaking changes to their required sections", () => {
    expect(typeof releaseCore.changelogSectionFor).toBe("function");
    expect(releaseCore.changelogSectionFor?.("fix", false, "fix(security): patch shell quoting")).toBe("Security");
    expect(releaseCore.changelogSectionFor?.("fix", false, "fix: address CVE-2026-1234 in updater")).toBe("Security");
    expect(releaseCore.changelogSectionFor?.("docs", true, "docs!: remove old guide")).toBe("Changed");
  });

  it.each([
    ["docs", false, "docs: refresh release notes"],
    ["test", false, "test: expand release coverage"],
    ["ci", false, "ci: tighten release job"],
    ["build", false, "build: tune packaging"],
    ["chore", false, "chore: prepare release"],
    ["style", false, "style: normalize whitespace"],
  ])("returns null for non-release section type %s", (type, breaking, subject) => {
    expect(typeof releaseCore.changelogSectionFor).toBe("function");
    expect(releaseCore.changelogSectionFor?.(type, breaking, subject)).toBeNull();
  });
});

describe("proposeVersion", () => {
  const commit = (subject: string, body = "") => ({ subject, body });

  it("bumps 0.x releases by patch for features and by minor for breaking changes", () => {
    expect(typeof releaseCore.proposeVersion).toBe("function");
    expect(releaseCore.proposeVersion?.("0.5.3", [commit("feat: add release planning")])).toEqual({
      level: "patch",
      version: "0.5.4",
    });
    expect(releaseCore.proposeVersion?.("0.5.3", [commit("fix!: drop deprecated updater")])).toEqual({
      level: "minor",
      version: "0.6.0",
    });
  });

  it("takes the strongest release level for stable versions", () => {
    expect(typeof releaseCore.proposeVersion).toBe("function");
    expect(
      releaseCore.proposeVersion?.("1.4.2", [
        commit("fix: preserve CLI compatibility"),
        commit("feat: add changelog drafting"),
        commit("refactor!: redesign release planning"),
      ])
    ).toEqual({
      level: "major",
      version: "2.0.0",
    });
  });

  it("returns null when commits are null or not release-worthy", () => {
    expect(typeof releaseCore.proposeVersion).toBe("function");
    expect(
      releaseCore.proposeVersion?.("1.4.2", [null, commit("docs: refresh release guide"), commit("chore: sort imports")])
    ).toBeNull();
  });

  it("bumps valid prerelease or build SemVer versions from their numeric core", () => {
    expect(typeof releaseCore.proposeVersion).toBe("function");
    expect(releaseCore.proposeVersion?.("1.4.2-rc.1", [commit("fix: preserve CLI compatibility")])).toEqual({
      level: "patch",
      version: "1.4.3",
    });
    expect(releaseCore.proposeVersion?.("0.5.3+build.9", [commit("feat: add release planning")])).toEqual({
      level: "patch",
      version: "0.5.4",
    });
  });

  it("rejects an invalid current version instead of guessing", () => {
    expect(typeof releaseCore.proposeVersion).toBe("function");
    expect(() => releaseCore.proposeVersion?.("1.4", [commit("fix: preserve CLI compatibility")])).toThrow(/semver/i);
  });
});

describe("draftChangelog", () => {
  const commit = (subject: string, body = "") => ({ subject, body });

  it("groups conventional commits into changelog sections and flags manual review subjects", () => {
    expect(typeof releaseCore.draftChangelog).toBe("function");

    const draft = releaseCore.draftChangelog?.([
      commit("feat: add release planning"),
      commit("fix: preserve CLI compatibility"),
      commit("fix(security): patch shell quoting"),
      commit("refactor!: redesign release flow"),
      commit("docs: refresh release guide"),
      commit("release tweaks"),
      commit("修正: 支援釋出"),
    ]);

    expect(draft).toEqual({
      sections: {
        Added: ["add release planning"],
        Changed: ["**BREAKING** redesign release flow"],
        Fixed: ["preserve CLI compatibility"],
        Removed: [],
        Security: ["patch shell quoting"],
        Deprecated: [],
      },
      reviewByHand: ["docs: refresh release guide", "release tweaks", "修正: 支援釋出"],
      markdown: [
        "### Added",
        "",
        "- add release planning",
        "",
        "### Changed",
        "",
        "- **BREAKING** redesign release flow",
        "",
        "### Fixed",
        "",
        "- preserve CLI compatibility",
        "",
        "### Security",
        "",
        "- patch shell quoting",
      ].join("\n"),
    });
  });

  it("keeps non-ASCII and non-conventional subjects out of draft markdown", () => {
    expect(typeof releaseCore.draftChangelog).toBe("function");

    const draft = releaseCore.draftChangelog?.([commit("修正: 支援釋出"), commit("release tweaks")]);

    expect(draft?.markdown).toBe("");
    expect(draft?.reviewByHand).toEqual(["修正: 支援釋出", "release tweaks"]);
  });
});

describe("extractChangelogSection", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "## [1.2.0] - 2026-08-01",
    "",
    "### Added",
    "",
    "- Release planning",
    "",
    "## [1.1.0] - 2026-07-01",
    "",
    "### Fixed",
    "",
    "- Preserve compatibility",
    "",
    "## [1.0.0] - 2026-06-01",
    "",
  ].join("\n");

  it("extracts the exact dated release body until the next release heading", () => {
    expect(typeof releaseCore.extractChangelogSection).toBe("function");
    expect(releaseCore.extractChangelogSection?.(changelog, "1.2.0")).toBe("### Added\n\n- Release planning");
    expect(releaseCore.extractChangelogSection?.(changelog, "1.1.0")).toBe("### Fixed\n\n- Preserve compatibility");
  });

  it("returns null when the version section is missing", () => {
    expect(typeof releaseCore.extractChangelogSection).toBe("function");
    expect(releaseCore.extractChangelogSection?.(changelog, "9.9.9")).toBeNull();
  });

  it("returns null when the matched release section is empty", () => {
    expect(typeof releaseCore.extractChangelogSection).toBe("function");
    expect(releaseCore.extractChangelogSection?.(changelog, "1.0.0")).toBeNull();
  });

  it("extracts a release section even when the heading date text is not ISO formatted", () => {
    expect(typeof releaseCore.extractChangelogSection).toBe("function");

    const datedChangelog = [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "## [1.2.0] - TBD",
      "",
      "### Added",
      "",
      "- Release planning",
      "",
    ].join("\n");

    expect(releaseCore.extractChangelogSection?.(datedChangelog, "1.2.0")).toBe("### Added\n\n- Release planning");
  });

  it("extracts a populated final exact dated release section with no next heading", () => {
    expect(typeof releaseCore.extractChangelogSection).toBe("function");

    const finalSectionChangelog = [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "## [1.2.0] - 2026-08-01",
      "",
      "### Added",
      "",
      "- Release planning",
      "",
      "## [1.0.0] - 2026-06-01",
      "",
      "### Fixed",
      "",
      "- Preserve compatibility",
      "",
      "- Handle final section parsing",
    ].join("\n");

    expect(releaseCore.extractChangelogSection?.(finalSectionChangelog, "1.0.0")).toBe(
      "### Fixed\n\n- Preserve compatibility\n\n- Handle final section parsing"
    );
  });
});

describe("parseReleaseArgs", () => {
  it("parses plan, notes, and release modes", () => {
    expect(typeof releaseCore.parseReleaseArgs).toBe("function");
    expect(releaseCore.parseReleaseArgs?.(["--plan"])).toEqual({ mode: "plan", version: undefined, error: null });
    expect(releaseCore.parseReleaseArgs?.(["--notes", "1.2.3"])).toEqual({
      mode: "notes",
      version: "1.2.3",
      error: null,
    });
    expect(releaseCore.parseReleaseArgs?.(["1.2.3"])).toEqual({ mode: "release", version: "1.2.3", error: null });
  });

  it.each([
    [["--unknown"], "unknown-flag"],
    [["--notes"], "missing-version"],
    [[], "missing-mode"],
    [["--plan", "1.2.3"], "conflicting-args"],
    [["--notes", "1.2.3", "1.2.4"], "conflicting-args"],
    [["1.2.3", "1.2.4"], "conflicting-args"],
    [["--plan", "--notes", "1.2.3"], "conflicting-args"],
    [["banana"], "invalid-version"],
  ])("fails closed for invalid release args %o", (args, error) => {
    expect(typeof releaseCore.parseReleaseArgs).toBe("function");
    expect(releaseCore.parseReleaseArgs?.(args)).toEqual({ mode: null, version: undefined, error });
  });
});
