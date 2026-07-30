import { describe, it, expect } from "vitest";
import {
  planUninstall,
  orderSteps,
  classifyWorktree,
  irreversible,
  isOurBotCommandLine,
  isOurTaskDefinition,
  isSignalablePid,
  NEVER_TOUCHED,
  STEPS,
} from "../scripts/lib/uninstall-core.mjs";

describe("orderSteps", () => {
  it("deregisters Discord commands BEFORE deleting .env", () => {
    // The token is the only way to reach the guild's commands, and its only copy
    // is in .env. Reverse this and the commands are stranded in Discord forever.
    const s = orderSteps(["env", "commands"]);
    expect(s.indexOf("commands")).toBeLessThan(s.indexOf("env"));
  });

  it("removes residency BEFORE killing the process", () => {
    // The scheduler restarts the bot within a minute, so killing first just
    // means it comes back in the middle of the uninstall.
    const s = orderSteps(["process", "residency"]);
    expect(s.indexOf("residency")).toBeLessThan(s.indexOf("process"));
  });

  it("is stable no matter what order the caller supplies", () => {
    const a = orderSteps([...STEPS].reverse());
    const b = orderSteps([...STEPS]);
    expect(a).toEqual(b);
  });
});

describe("planUninstall", () => {
  it("by default removes everything the tool created, including the token", () => {
    const { steps } = planUninstall();
    expect(steps).toContain("env"); // the bot token goes
    expect(steps).toContain("state"); // approvals + session store + logs go
    expect(steps).toContain("commands");
    expect(steps).toContain("residency");
  });

  it("does NOT delete branches by default — they can hold commits", () => {
    expect(planUninstall().steps).not.toContain("branches");
    expect(planUninstall({ branches: true }).steps).toContain("branches");
  });

  it("says out loud that --keep-config leaves the bot token on disk", () => {
    // "Uninstalled" while the single most sensitive artifact is still there is
    // exactly the kind of half-truth this project refuses to ship.
    const { steps, refusals } = planUninstall({ keepConfig: true });
    expect(steps).not.toContain("env");
    expect(refusals.join(" ")).toMatch(/bot token/i);
  });

  it("keeps state when asked, and still reports it", () => {
    const { steps } = planUninstall({ keepState: true });
    expect(steps).not.toContain("state");
  });
});

describe("classifyWorktree", () => {
  it("refuses a worktree with ANY local content, including ignored files", () => {
    // A tree holding only a .env reads clean under plain `git status`; that is
    // why the caller passes --ignored=matching output.
    expect(classifyWorktree(" M a.txt", "refs/heads/copilot/t-1", "copilot/t-1")).toBe("dirty");
    expect(classifyWorktree("!! .env", "refs/heads/copilot/t-1", "copilot/t-1")).toBe("dirty");
  });

  it("refuses a detached HEAD — its commits may have no other ref", () => {
    expect(classifyWorktree("", "", "copilot/t-1")).toBe("detached");
  });

  it("refuses a HEAD moved to a different branch than recorded", () => {
    expect(classifyWorktree("", "refs/heads/somewhere-else", "copilot/t-1")).toBe("detached");
  });

  it("refuses when git could not be asked at all", () => {
    // Fail closed: not knowing is not the same as knowing it is safe.
    expect(classifyWorktree(null, null, "copilot/t-1")).toBe("unknown");
  });

  it("removes only a clean tree still on its own branch", () => {
    expect(classifyWorktree("", "refs/heads/copilot/t-1", "copilot/t-1")).toBe("removable");
  });

  it("removes a clean tree when no branch was recorded (v1 records)", () => {
    expect(classifyWorktree("", "refs/heads/whatever", undefined)).toBe("removable");
  });
});

describe("isOurBotCommandLine", () => {
  it("accepts the bot however it was started", () => {
    // run-bot, the residency wrapper and `npm start` all land on dist/index.js.
    expect(isOurBotCommandLine(`"C:\\nvm4w\\nodejs\\node.exe" C:\\repo\\dist\\index.js`)).toBe(true);
    expect(isOurBotCommandLine("node /home/me/discord-copilot-sdk/dist/index.js")).toBe(true);
  });

  it("REFUSES an unrelated node process on a recycled PID", () => {
    // The lock holds only a PID and survives a crash — it is released solely on
    // a clean shutdown — so an operator who hard-killed the bot and is now
    // uninstalling has a stale PID sitting there. This is the exact check
    // stop-bot makes, and the uninstaller was the one tool skipping it.
    expect(isOurBotCommandLine(`"C:\\nvm4w\\nodejs\\node.exe" -e setTimeout(()=>{},25000)`)).toBe(false);
    expect(isOurBotCommandLine("node .../chrome-devtools-mcp/build/src/telemetry/watchdog/main.js")).toBe(false);
    expect(isOurBotCommandLine("node /some/other/index.js")).toBe(false); // not under dist/
  });

  it("fails closed on anything it could not read", () => {
    expect(isOurBotCommandLine(null)).toBe(false);
    expect(isOurBotCommandLine("")).toBe(false);
    expect(isOurBotCommandLine(undefined)).toBe(false);
  });
});

describe("isSignalablePid", () => {
  it("REFUSES pid 0 — on POSIX that signals the whole process group", () => {
    // A truncated or corrupt lock file reading as "0" would otherwise make the
    // uninstaller take out the caller's entire session.
    expect(isSignalablePid(0)).toBe(false);
  });

  it("refuses pid 1 (init) and anything negative", () => {
    expect(isSignalablePid(1)).toBe(false);
    expect(isSignalablePid(-1)).toBe(false); // kill(-1) = every process we may signal
  });

  it("refuses non-integers", () => {
    expect(isSignalablePid(NaN)).toBe(false);
    expect(isSignalablePid(1.5)).toBe(false);
  });

  it("accepts a normal pid", () => {
    expect(isSignalablePid(4321)).toBe(true);
  });
});

describe("isOurTaskDefinition", () => {
  it("accepts a task whose action runs one of our wrappers", () => {
    expect(isOurTaskDefinition("<Exec><Arguments>-File \"C:\\r\\scripts\\run-bot.default.ps1\"</Arguments></Exec>")).toBe(
      true
    );
  });

  it("REFUSES a same-named task that is not ours", () => {
    // The installer explicitly declines to REPLACE such a task; an uninstaller
    // that deletes on a name match alone would destroy what the installer
    // deliberately left alone.
    expect(isOurTaskDefinition("<Exec><Command>C:\\other\\thing.exe</Command></Exec>")).toBe(false);
    expect(isOurTaskDefinition(null)).toBe(false);
  });
});

describe("irreversible", () => {
  it("flags the steps re-running the installer cannot undo", () => {
    const flagged = irreversible(planUninstall({ branches: true }).steps);
    expect(flagged).toEqual(expect.arrayContaining(["env", "branches", "state"]));
  });

  it("flags nothing that a reinstall would restore", () => {
    expect(irreversible(["residency", "process", "commands", "worktrees"])).toEqual([]);
  });
});

describe("NEVER_TOUCHED", () => {
  it("covers the four things an uninstall must not delete", () => {
    const text = NEVER_TOUCHED.map(([what]) => what).join(" ");
    expect(text).toMatch(/controlled repo/i); // the user's code
    expect(text).toMatch(/\.copilot/); // the CLI login, not ours
    expect(text).toMatch(/node/i); // shared prerequisites
    expect(text).toMatch(/Discord application/i); // only the human can delete it
  });

  it("gives a reason for every one of them", () => {
    for (const entry of NEVER_TOUCHED) {
      const what = entry[0] ?? "";
      const why = entry[1] ?? "";
      expect(what.length).toBeGreaterThan(0);
      expect(why.length).toBeGreaterThan(10);
    }
  });
});
