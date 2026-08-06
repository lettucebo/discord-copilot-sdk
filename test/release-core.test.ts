import { describe, expect, it } from "vitest";
import { isSemVer, rollChangelog } from "../scripts/lib/release-core.mjs";

describe("isSemVer", () => {
  it.each(["0.1.0", "1.2.3", "1.2.3-rc.1", "1.2.3+build.4"])("accepts %s", (version) => {
    expect(isSemVer(version)).toBe(true);
  });

  it.each(["1.2", "v1.2.3", "1.2.3-01", "1.2.3 "])("rejects %s", (version) => {
    expect(isSemVer(version)).toBe(false);
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
