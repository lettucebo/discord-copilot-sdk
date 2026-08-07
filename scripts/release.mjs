#!/usr/bin/env node
// Create one auditable SemVer release commit and its annotated Git tag.
// This intentionally runs only when an operator explicitly invokes `npm run
// release -- <version>`; CI publishes an already-created v* tag, never creates
// one on the operator's behalf.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  draftChangelog,
  extractChangelogSection,
  isSemVer,
  parseConventionalCommit,
  parseReleaseArgs,
  proposeVersion,
  rollChangelog,
} from "./lib/release-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const args = parseReleaseArgs(process.argv.slice(2));

function run(command, commandArgs, opts = {}) {
  return execFileSync(command, commandArgs, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function requireCleanTree() {
  for (const commandArgs of [["diff", "--quiet"], ["diff", "--cached", "--quiet"]]) {
    try {
      run("git", commandArgs);
    } catch {
      throw new Error("release requires a clean working tree");
    }
  }
}

function usage() {
  return "usage: npm run release -- [--plan | --notes <SemVer version> | <SemVer version>]";
}

function readPackage() {
  const packagePath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (pkg?.name !== "discord-copilot-sdk") throw new Error("not a discord-copilot-sdk checkout");
  return { packagePath, pkg };
}

function readChangelog() {
  const changelogPath = path.join(ROOT, "CHANGELOG.md");
  return { changelogPath, changelog: fs.readFileSync(changelogPath, "utf8") };
}

function listReachableReleaseTags() {
  const output = run("git", ["log", "--decorate=full", "--simplify-by-decoration", "--format=%D%x1e", "HEAD"]);
  const tags = [];
  for (const entry of output.split("\x1e")) {
    const decorations = entry
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    for (const decoration of decorations) {
      const match = /^tag:\s+(?:refs\/tags\/)?(.+)$/.exec(decoration);
      const tag = match?.[1]?.trim();
      if (tag && tag.startsWith("v") && isSemVer(tag.slice(1)) && !tags.includes(tag)) tags.push(tag);
    }
  }
  return tags;
}

function latestReachableReleaseTag() {
  return listReachableReleaseTags()[0] ?? null;
}

function readCommitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const output = run("git", ["log", "--reverse", "--format=%s%x1f%b%x1e", range]);
  return output
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [subject = "", body = ""] = entry.split("\x1f");
      return { subject: subject.trim(), body: body.trim() };
    })
    .filter((entry) => entry.subject !== "");
}

function releaseReason(currentVersion, commits, proposal) {
  if (!proposal) return null;
  const zeroMajor = currentVersion.startsWith("0.");
  const rank = { patch: 1, minor: 2, major: 3 };
  let strongest = null;

  for (const commit of commits) {
    const parsed = parseConventionalCommit(commit.subject, commit.body);
    if (!parsed) continue;

    let level = null;
    if (parsed.breaking) level = zeroMajor ? "minor" : "major";
    else if (parsed.type === "feat") level = zeroMajor ? "patch" : "minor";
    else if (parsed.type === "fix" || parsed.type === "perf") level = "patch";
    if (!level) continue;

    if (!strongest || rank[level] > rank[strongest.level]) {
      strongest = { level, subject: commit.subject, parsed };
    }
  }

  if (!strongest) return null;
  if (strongest.parsed.breaking) {
    return zeroMajor ? `breaking change in ${strongest.subject} (0.x keeps this at minor)` : `breaking change in ${strongest.subject}`;
  }
  if (strongest.parsed.type === "feat") {
    return zeroMajor ? `feature commit ${strongest.subject} (0.x keeps this at patch)` : `feature commit ${strongest.subject}`;
  }
  if (strongest.parsed.type === "perf") return `performance commit ${strongest.subject}`;
  return `fix commit ${strongest.subject}`;
}

function printPlan() {
  const { pkg } = readPackage();
  const currentVersion = pkg.version;
  if (!isSemVer(currentVersion)) throw new Error(`package.json version must be strict SemVer: ${currentVersion}`);

  const baselineTag = latestReachableReleaseTag();
  const commits = readCommitsSince(baselineTag);
  const proposal = proposeVersion(currentVersion, commits);
  const draft = draftChangelog(commits);

  console.log(`Current version: ${currentVersion}`);
  console.log(`Baseline tag: ${baselineTag ?? "(none found; using all reachable history)"}`);
  if (proposal) {
    console.log(`Proposed version: ${proposal.version}`);
    console.log(`Release level: ${proposal.level}`);
    console.log(`Reason: ${releaseReason(currentVersion, commits, proposal) ?? "see release-worthy commits below"}`);
  } else {
    console.log("No release-worthy commits found.");
  }
  console.log("");
  console.log("CHANGELOG DRAFT");
  console.log(draft.markdown || "(none)");
  console.log("");
  console.log("REVIEW BY HAND");
  if (draft.reviewByHand.length === 0) console.log("(none)");
  else for (const subject of draft.reviewByHand) console.log(`- ${subject}`);
}

function printNotes(version) {
  const { changelog } = readChangelog();
  const section = extractChangelogSection(changelog, version);
  if (!section) throw new Error(`could not find release notes for ${version}`);
  process.stdout.write(`${section}\n`);
}

function createRelease(version) {
  if (!isSemVer(version)) throw new Error(usage());
  requireCleanTree();
  const tag = `v${version}`;
  try {
    run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]);
    throw new Error(`tag ${tag} already exists`);
  } catch (error) {
    if (error instanceof Error && error.message === `tag ${tag} already exists`) throw error;
  }

  const { packagePath, pkg } = readPackage();
  const { changelogPath, changelog } = readChangelog();
  const rolled = rollChangelog(changelog, version, new Date().toISOString().slice(0, 10));

  pkg.version = version;
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  fs.writeFileSync(changelogPath, rolled, "utf8");
  run("git", ["add", "package.json", "CHANGELOG.md"]);
  run("git", ["commit", "-m", `chore(release): v${version}`], { stdio: "inherit" });
  run("git", ["tag", "-a", tag, "-m", `discord-copilot-sdk ${version}`]);
  console.log(`Created release commit and tag ${tag}. Push the branch and tag to publish the GitHub Release.`);
}

function parseErrorMessage(error) {
  if (error === "unknown-flag") return "unknown release argument";
  if (error === "missing-version") return "--notes requires a strict SemVer version";
  if (error === "invalid-version") return usage();
  if (error === "missing-mode" || error === "conflicting-args") return usage();
  return "invalid release arguments";
}

function main() {
  if (args.error) throw new Error(parseErrorMessage(args.error));
  if (args.mode === "plan") return printPlan();
  if (args.mode === "notes" && args.version) return printNotes(args.version);
  if (args.mode === "release" && args.version) return createRelease(args.version);
  throw new Error(usage());
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
