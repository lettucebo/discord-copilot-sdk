import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SkillDirectoryOptions {
  workingDirectory: string;
  includeRepoSkills: boolean;
  includeUserSkills: boolean;
  /** Injectable for tests; production uses the logged-in Copilot user's home. */
  homeDirectory?: string;
}

/** Project skill locations that the Copilot CLI discovers when config discovery is enabled.
 * We pass these explicitly instead, so a controlled repo can supply skills without also
 * supplying MCP configuration. */
export function projectSkillDirectories(workingDirectory: string): string[] {
  return [
    path.join(workingDirectory, ".github", "skills"),
    path.join(workingDirectory, ".agents", "skills"),
    path.join(workingDirectory, ".claude", "skills"),
  ];
}

/** User-owned Copilot skill root. This is deliberately not configurable from .env:
 * an arbitrary path setting could point back at the controlled repository. */
export function userSkillDirectory(homeDirectory: string = os.homedir()): string {
  return path.join(homeDirectory, ".copilot", "skills");
}

/**
 * Return enabled roots that are known to contain a skill, or cannot be inspected.
 *
 * This intentionally fails open for inspection errors. Treating an unreadable user
 * skill directory as empty would silently remove the skill tool; keeping it merely
 * preserves the prior tool availability until the filesystem is healthy again.
 */
export function resolveSkillDirectories(opts: SkillDirectoryOptions): string[] {
  const candidates: Array<{
    directory: string;
    followLinks: boolean;
    repositoryBoundary?: string;
  }> = [
    ...(opts.includeRepoSkills
      ? projectSkillDirectories(opts.workingDirectory).map((directory) => ({
          directory,
          followLinks: false,
          repositoryBoundary: opts.workingDirectory,
        }))
      : []),
    ...(opts.includeUserSkills
      ? [{ directory: userSkillDirectory(opts.homeDirectory), followLinks: true }]
      : []),
  ];
  return candidates
    .filter(({ directory, followLinks, repositoryBoundary }) =>
      directoryMayContainSkill(directory, followLinks, new Set(), repositoryBoundary)
    )
    .map(({ directory }) => directory);
}

function directoryMayContainSkill(
  directory: string,
  followLinks: boolean,
  visited: Set<string> = new Set(),
  repositoryBoundary?: string
): boolean {
  try {
    return followLinks
      ? userDirectoryContainsSkill(directory, visited)
      : repositoryDirectoryContainsSkill(directory, repositoryBoundary);
  } catch (error) {
    // A controlled repo must not make an unreadable root look usable: that
    // could pass a link or inaccessible external path to the CLI. The user
    // root is different local state; preserve it on uncertain IO so operator
    // skills do not silently disappear during a transient filesystem failure.
    return followLinks && !isDefinitelyAbsent(error);
  }
}

/** A repo root is all-or-nothing: the CLI follows child links, so allowing a
 * root containing even one link could silently bypass ENABLE_USER_SKILLS. */
function repositoryDirectoryContainsSkill(
  directory: string,
  repositoryBoundary: string | undefined
): boolean {
  if (!repositoryBoundary) return false;
  return scanRepositoryDirectory(directory, repositoryBoundary).hasSkill;
}

function scanRepositoryDirectory(
  directory: string,
  repositoryBoundary: string
): { hasSkill: boolean; safe: boolean } {
  if (!isStrictlyInside(directory, repositoryBoundary)) return { hasSkill: false, safe: false };
  // `readdirSync()` follows a root symlink automatically. Reject it before
  // enumeration, including a link in `.github` / `.agents` / `.claude`.
  if (fs.lstatSync(directory).isSymbolicLink()) return { hasSkill: false, safe: false };

  let hasSkill = false;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) return { hasSkill: false, safe: false };
    if (entry.isFile() && entry.name === "SKILL.md") {
      hasSkill = true;
      continue;
    }
    if (entry.isDirectory()) {
      const child = scanRepositoryDirectory(path.join(directory, entry.name), repositoryBoundary);
      if (!child.safe) return child;
      hasSkill ||= child.hasSkill;
    }
  }
  return { hasSkill, safe: true };
}

function userDirectoryContainsSkill(directory: string, visited: Set<string>): boolean {
  const real = fs.realpathSync(directory);
  if (visited.has(real)) return false;
  visited.add(real);

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === "SKILL.md") return true;
    const child = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      // User-owned links support common dotfile layouts, but only after stat
      // proves a real target; realpath + visited prevents directory-link cycles.
      let target: fs.Stats;
      try {
        target = fs.statSync(child);
      } catch (error) {
        if (!isDefinitelyAbsent(error)) return true; // fail open for unreadable user state
        continue; // dangling link cannot be a loaded skill
      }
      if (entry.name === "SKILL.md" && target.isFile()) return true;
      if (target.isDirectory() && directoryMayContainSkill(child, true, visited)) return true;
      continue;
    }
    if (entry.isDirectory() && directoryMayContainSkill(child, true, visited)) return true;
  }
  return false;
}

function isDefinitelyAbsent(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Resolve links before comparing; a lexical prefix check would let `.github`
 * junction outside the worktree while still looking like a repo-local path. */
function isStrictlyInside(directory: string, boundary: string): boolean {
  const relative = path.relative(fs.realpathSync(boundary), fs.realpathSync(directory));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
