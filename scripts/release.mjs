#!/usr/bin/env node
// Create one auditable SemVer release commit and its annotated Git tag.
// This intentionally runs only when an operator explicitly invokes `npm run
// release -- <version>`; CI publishes an already-created v* tag, never creates
// one on the operator's behalf.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isSemVer, rollChangelog } from "./lib/release-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const version = process.argv[2];

function run(args, opts = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function requireCleanTree() {
  for (const args of [["diff", "--quiet"], ["diff", "--cached", "--quiet"]]) {
    try {
      run(args);
    } catch {
      throw new Error("release requires a clean working tree");
    }
  }
}

function main() {
  if (!isSemVer(version)) throw new Error("usage: npm run release -- <SemVer version>");
  requireCleanTree();
  const tag = `v${version}`;
  try {
    run(["rev-parse", "-q", "--verify", `refs/tags/${tag}`]);
    throw new Error(`tag ${tag} already exists`);
  } catch (error) {
    if (error instanceof Error && error.message === `tag ${tag} already exists`) throw error;
  }

  const packagePath = path.join(ROOT, "package.json");
  const changelogPath = path.join(ROOT, "CHANGELOG.md");
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (pkg?.name !== "discord-copilot-sdk") throw new Error("not a discord-copilot-sdk checkout");
  const rolled = rollChangelog(fs.readFileSync(changelogPath, "utf8"), version, new Date().toISOString().slice(0, 10));

  pkg.version = version;
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  fs.writeFileSync(changelogPath, rolled, "utf8");
  run(["add", "package.json", "CHANGELOG.md"]);
  run(["commit", "-m", `chore(release): v${version}`], { stdio: "inherit" });
  run(["tag", "-a", tag, "-m", `discord-copilot-sdk ${version}`]);
  console.log(`Created release commit and tag ${tag}. Push the branch and tag to publish the GitHub Release.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
