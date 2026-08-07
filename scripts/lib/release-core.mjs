// Pure release helpers. scripts/release.mjs owns all git and filesystem effects.

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ASCII = /^[\x20-\x7E]+$/;
const CONVENTIONAL_SUBJECT = /^([a-z]+)(?:\(([^()\r\n]+)\))?(!)?: ([\x20-\x7E]+)$/;
const CHANGELOG_SECTIONS = ["Added", "Changed", "Fixed", "Removed", "Security", "Deprecated"];

export function isSemVer(version) {
  return typeof version === "string" && SEMVER.test(version);
}

/**
 * Parse a conventional-commit subject/body pair for release planning.
 *
 * @param {string} subject
 * @param {string} body
 * @returns {{type: string, scope?: string, breaking: boolean, description: string} | null}
 */
export function parseConventionalCommit(subject, body) {
  if (typeof subject !== "string" || typeof body !== "string" || !ASCII.test(subject)) return null;
  const match = CONVENTIONAL_SUBJECT.exec(subject);
  if (!match) return null;

  const [, type, scope, bang, description] = match;
  if (description.trim() === "") return null;

  return {
    type,
    ...(scope ? { scope } : {}),
    breaking: bang === "!" || /\bBREAKING[ -]CHANGE:/.test(body),
    description,
  };
}

/**
 * Map a parsed conventional commit to a Keep a Changelog section.
 *
 * @param {string} type
 * @param {boolean} breaking
 * @param {string} subject
 * @returns {"Added" | "Changed" | "Fixed" | "Removed" | "Security" | "Deprecated" | null}
 */
export function changelogSectionFor(type, breaking, subject) {
  if (breaking) return "Changed";
  if (typeof type !== "string" || typeof subject !== "string") return null;
  if (type === "feat") return "Added";
  if (type === "perf" || type === "refactor") return "Changed";
  if (type === "revert") return "Removed";
  if (type === "fix") {
    return type === "fix" && (/\(security\)/i.test(subject) || /\bCVE\b/i.test(subject)) ? "Security" : "Fixed";
  }
  return null;
}

function normalizeCommit(commit) {
  if (!commit || typeof commit !== "object") return null;
  if (typeof commit.type === "string" && typeof commit.description === "string" && typeof commit.breaking === "boolean") {
    return commit;
  }
  if (typeof commit.subject === "string") {
    return parseConventionalCommit(commit.subject, typeof commit.body === "string" ? commit.body : "");
  }
  return null;
}

function subjectOf(commit) {
  if (!commit || typeof commit !== "object") return null;
  if (typeof commit.subject === "string") return commit.subject;
  if (typeof commit.type === "string" && typeof commit.description === "string") {
    return `${commit.type}${commit.scope ? `(${commit.scope})` : ""}${commit.breaking ? "!" : ""}: ${commit.description}`;
  }
  return null;
}

function bumpVersion(currentVersion, level) {
  const [coreVersion] = currentVersion.split(/[+-]/, 1);
  const [major, minor, patch] = coreVersion.split(".", 3).map(Number);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Propose the next SemVer version from a set of conventional commits.
 *
 * @param {string} currentVersion
 * @param {Array<unknown>} commits
 * @returns {{level: "major" | "minor" | "patch", version: string} | null}
 */
export function proposeVersion(currentVersion, commits) {
  if (!isSemVer(currentVersion)) throw new Error(`invalid SemVer version: ${currentVersion}`);
  if (!Array.isArray(commits)) return null;

  const isZeroMajor = currentVersion.startsWith("0.");
  let level = null;
  const rank = { patch: 1, minor: 2, major: 3 };

  for (const entry of commits) {
    const commit = normalizeCommit(entry);
    if (!commit) continue;

    let next = null;
    if (commit.breaking) next = isZeroMajor ? "minor" : "major";
    else if (commit.type === "feat") next = isZeroMajor ? "patch" : "minor";
    else if (commit.type === "fix" || commit.type === "perf") next = "patch";

    if (next && (level === null || rank[next] > rank[level])) level = next;
  }

  return level ? { level, version: bumpVersion(currentVersion, level) } : null;
}

/**
 * Draft grouped Keep a Changelog notes from raw commit subjects/bodies.
 *
 * @param {Array<unknown>} commits
 * @returns {{
 *   sections: Record<"Added" | "Changed" | "Fixed" | "Removed" | "Security" | "Deprecated", string[]>,
 *   reviewByHand: string[],
 *   markdown: string
 * }}
 */
export function draftChangelog(commits) {
  /** @type {Record<"Added" | "Changed" | "Fixed" | "Removed" | "Security" | "Deprecated", string[]>} */
  const sections = {
    Added: [],
    Changed: [],
    Fixed: [],
    Removed: [],
    Security: [],
    Deprecated: [],
  };
  const reviewByHand = [];
  if (!Array.isArray(commits)) return { sections, reviewByHand, markdown: "" };

  for (const entry of commits) {
    const parsed = normalizeCommit(entry);
    const subject = subjectOf(entry);
    if (!parsed) {
      if (typeof subject === "string") reviewByHand.push(subject);
      continue;
    }

    const section = changelogSectionFor(parsed.type, parsed.breaking, subject ?? "");
    if (!section) {
      if (typeof subject === "string") reviewByHand.push(subject);
      continue;
    }

    sections[section].push(parsed.breaking ? `**BREAKING** ${parsed.description}` : parsed.description);
  }

  const markdown = CHANGELOG_SECTIONS.flatMap((section) =>
    sections[section].length === 0 ? [] : [`### ${section}`, "", ...sections[section].map((entry) => `- ${entry}`), ""]
  )
    .join("\n")
    .trimEnd();

  return { sections, reviewByHand, markdown };
}

/**
 * Extract a released changelog body by exact version heading.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {string | null}
 */
export function extractChangelogSection(changelog, version) {
  if (typeof changelog !== "string" || typeof version !== "string" || version === "") return null;
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingMatch = new RegExp(`^## \\[${escapedVersion}\\](?:[^\\r\\n]*)\\r?\\n`, "m").exec(changelog);
  if (!headingMatch || headingMatch.index === undefined) return null;
  const bodyStart = headingMatch.index + headingMatch[0].length;
  const nextHeading = /^## /m.exec(changelog.slice(bodyStart));
  const bodyEnd = nextHeading ? bodyStart + nextHeading.index : changelog.length;
  const body = changelog.slice(bodyStart, bodyEnd).trim();
  return body === "" ? null : body;
}

/**
 * Parse release CLI arguments without touching runtime globals.
 *
 * @param {string[]} args
 * @returns {{
 *   mode: "plan" | "notes" | "release" | null,
 *   version: string | undefined,
 *   error: string | null
 * }}
 */
export function parseReleaseArgs(args) {
  const fail = (error) => ({ mode: null, version: undefined, error });
  if (!Array.isArray(args)) return fail("invalid-args");

  let plan = false;
  let notesVersion;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--plan") {
      plan = true;
      continue;
    }
    if (arg === "--notes") {
      const value = args[++i];
      if (typeof value !== "string" || value === "" || value.startsWith("-")) return fail("missing-version");
      notesVersion = value;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("-")) return fail("unknown-flag");
    positional.push(arg);
  }

  if (positional.length > 1) return fail("conflicting-args");
  if ((plan ? 1 : 0) + (notesVersion ? 1 : 0) + (positional.length > 0 ? 1 : 0) !== 1) {
    return fail(args.length === 0 ? "missing-mode" : "conflicting-args");
  }
  if (plan) return { mode: "plan", version: undefined, error: null };

  const version = notesVersion ?? positional[0];
  if (!isSemVer(version)) return fail("invalid-version");
  return { mode: notesVersion ? "notes" : "release", version, error: null };
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
