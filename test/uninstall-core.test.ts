import { describe, it, expect } from "vitest";
import {
  planUninstall,
  orderSteps,
  classifyWorktree,
  irreversible,
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
