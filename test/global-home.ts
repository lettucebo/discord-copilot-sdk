import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_DIR_NAME } from "../src/core/paths.js";

interface PathSnapshot {
  exists: boolean;
  entries: string[];
}

function snapshot(root: string, depth = 2): PathSnapshot {
  if (!fs.existsSync(root)) return { exists: false, entries: [] };
  const entries: string[] = [];
  const walk = (current: string, remaining: number): void => {
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of children) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolute);
      } catch (err) {
        // Atomic replace and concurrent bot activity can remove an entry
        // between readdir and lstat; a vanished entry has nothing to snapshot.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      entries.push(`${relative}\0${entry.isDirectory() ? "d" : "f"}\0${stat.size}\0${stat.mtimeMs}`);
      // Two levels catch new state files and worktree directories without
      // walking every source file in a developer's existing checkout.
      if (entry.isDirectory() && remaining > 0) walk(absolute, remaining - 1);
    }
  };
  walk(root, depth);
  entries.sort();
  return { exists: true, entries };
}

export default function setup(): () => void {
  const originalHome = process.env["HOME"];
  const originalUserProfile = process.env["USERPROFILE"];
  const realHome = os.homedir();
  const realState = path.join(realHome, STATE_DIR_NAME);
  const realWorktrees = path.join(realHome, `${STATE_DIR_NAME}-worktrees`);
  const stateBefore = snapshot(realState);
  const worktreesBefore = snapshot(realWorktrees);
  const runHome = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-vitest-run-"));

  process.env["HOME"] = runHome;
  process.env["USERPROFILE"] = runHome;
  process.env["DISCORD_COPILOT_SDK_VITEST_RUN_HOME"] = runHome;

  return () => {
    let guardError: unknown;
    const unexpectedCreations: string[] = [];
    let existingStateChanged = false;
    try {
      const stateAfter = snapshot(realState);
      const worktreesAfter = snapshot(realWorktrees);
      if (!stateBefore.exists && stateAfter.exists) unexpectedCreations.push(realState);
      if (!worktreesBefore.exists && worktreesAfter.exists) unexpectedCreations.push(realWorktrees);
      existingStateChanged =
        (stateBefore.exists && JSON.stringify(stateAfter) !== JSON.stringify(stateBefore)) ||
        (worktreesBefore.exists && JSON.stringify(worktreesAfter) !== JSON.stringify(worktreesBefore));
    } catch (err) {
      guardError = err;
    }
    delete process.env["DISCORD_COPILOT_SDK_VITEST_RUN_HOME"];
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalUserProfile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = originalUserProfile;
    let cleanupError: unknown;
    try {
      fs.rmSync(runHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (err) {
      cleanupError = err;
    }
    if (guardError) {
      console.warn(`Vitest could not compare real home state: ${guardError instanceof Error ? guardError.message : String(guardError)}`);
    }
    if (existingStateChanged) {
      console.warn("Real discord-copilot-sdk state changed during Vitest; a concurrent process may be active");
    }
    if (unexpectedCreations.length > 0 || cleanupError) {
      process.exitCode = 1;
      if (unexpectedCreations.length > 0) {
        throw new Error(`Vitest observed unexpected real state creation: ${unexpectedCreations.join(", ")}`);
      }
      throw cleanupError;
    }
  };
}
