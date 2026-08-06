import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface VersionInfo {
  app: string;
  commit: string;
  sdk: string;
}

type ReadFile = (file: string) => string;
type RunGit = (command: string, args: string[]) => string;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Read the release version only when the package belongs to this application. */
export function readAppVersion(
  repoRoot: string,
  readFile: ReadFile = (file) => fs.readFileSync(file, "utf8")
): string {
  try {
    const pkg: unknown = JSON.parse(readFile(path.join(repoRoot, "package.json")));
    const version = typeof pkg === "object" && pkg !== null ? (pkg as Record<string, unknown>)["version"] : undefined;
    if (
      typeof pkg !== "object" ||
      pkg === null ||
      (pkg as Record<string, unknown>)["name"] !== "discord-copilot-sdk" ||
      typeof version !== "string" ||
      !SEMVER.test(version)
    ) {
      return "unknown";
    }
    return version;
  } catch {
    return "unknown";
  }
}

/**
 * Resolve HEAD from the installation root rather than process.cwd(), because a
 * manual `node /path/to/dist/index.js --version` must identify this checkout.
 */
export function readCommitSha(
  repoRoot: string,
  runGit: RunGit = (command, args) =>
    execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
): string {
  try {
    const sha = runGit("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"]).trim();
    return /^[0-9a-f]{4,64}$/i.test(sha) ? sha : "unknown";
  } catch {
    return "unknown";
  }
}

export function formatVersionInfo({ app, commit, sdk }: VersionInfo): string {
  return `discord-copilot-sdk ${app} • commit ${commit} • @github/copilot-sdk ${sdk}`;
}
