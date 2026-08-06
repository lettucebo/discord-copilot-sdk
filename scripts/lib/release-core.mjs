// Pure release helpers. scripts/release.mjs owns all git and filesystem effects.

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isSemVer(version) {
  return typeof version === "string" && SEMVER.test(version);
}

/** Move the prepared Unreleased notes into an immutable dated release section. */
export function rollChangelog(changelog, version, date) {
  const marker = "## [Unreleased]";
  if (typeof changelog !== "string" || !changelog.includes(marker)) {
    throw new Error("CHANGELOG.md must contain a ## [Unreleased] section");
  }
  if (!isSemVer(version)) throw new Error(`invalid SemVer release: ${version}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid release date: ${date}`);
  return changelog.replace(marker, `${marker}\n\n## [${version}] - ${date}`);
}
