import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nodeVersionOk, controlledRepoProblem, livePidFromLock } from "../scripts/lib/setup-core.mjs";
import { resolveControlledRepo } from "../src/core/repo.js";

describe("nodeVersionOk (engines: ^20.19 || >=22.12)", () => {
  it.each([
    ["20.19.0", true], // first supported 20.x
    ["20.19.5", true],
    ["20.20.0", true],
    ["22.12.0", true], // first supported 22.x
    ["22.13.1", true],
    ["24.0.0", true], // any >=22 major
    ["23.5.0", true], // 23.x is >=22 major -> allowed by >=22.12 rule
  ])("accepts %s", (v, ok) => {
    expect(nodeVersionOk(v)).toBe(ok);
  });

  it.each([
    ["20.18.9", false], // one patch line below the 20.19 gate
    ["20.0.0", false],
    ["21.7.3", false], // odd/non-LTS major is unsupported
    ["22.11.0", false], // one minor below the 22.12 gate
    ["18.20.0", false], // too old
    ["19.9.0", false],
  ])("rejects %s", (v, ok) => {
    expect(nodeVersionOk(v)).toBe(ok);
  });

  it("rejects malformed version strings", () => {
    expect(nodeVersionOk("not.a.version")).toBe(false);
    expect(nodeVersionOk("")).toBe(false);
    expect(nodeVersionOk("22")).toBe(false); // no minor -> min is NaN
  });
});

/**
 * Contract test, same spirit as test/config-contract.test.ts: the installer's
 * FAST controlled-repo check (controlledRepoProblem, used before npm ci/build
 * and by the interactive prompt) must accept and reject exactly what the
 * RUNTIME's resolveControlledRepo does — the function the bot actually calls at
 * startup. A mirror nobody checks is how they drift, and drift here means the
 * installer reports "complete" for a config that kills the bot on first launch
 * (the real incident this guards).
 */
describe("controlledRepoProblem ⇄ resolveControlledRepo contract", () => {
  const made: string[] = [];
  const mkTmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-repochk-"));
    made.push(d);
    return d;
  };
  const runtimeAccepts = (p: string): boolean => {
    try {
      resolveControlledRepo(p);
      return true;
    } catch {
      return false;
    }
  };

  const cases: Array<[string, () => string]> = [
    [
      "a normal clone (.git is a DIRECTORY)",
      () => {
        const d = mkTmp();
        fs.mkdirSync(path.join(d, ".git"));
        return d;
      },
    ],
    [
      "a git worktree (.git is a FILE, not a directory)",
      () => {
        const d = mkTmp();
        fs.writeFileSync(path.join(d, ".git"), "gitdir: /somewhere/.git/worktrees/x\n");
        return d;
      },
    ],
    [
      "a plain directory that is not a repo",
      () => mkTmp(),
    ],
    [
      "a directory that merely CONTAINS repos (the real incident: parent of a clone)",
      () => {
        const parent = mkTmp();
        fs.mkdirSync(path.join(parent, "child-repo", ".git"), { recursive: true });
        return parent;
      },
    ],
    [
      "a SUBdirectory of a repo (has no .git of its own, so it is not a root)",
      () => {
        const d = mkTmp();
        fs.mkdirSync(path.join(d, ".git"));
        const sub = path.join(d, "src");
        fs.mkdirSync(sub);
        return sub;
      },
    ],
    [
      "a path that does not exist at all",
      () => path.join(mkTmp(), "nope"),
    ],
    [
      "a FILE where a directory was expected",
      () => {
        const d = mkTmp();
        const f = path.join(d, "a-file");
        fs.writeFileSync(f, "x");
        return f;
      },
    ],
    // Relative paths: the runtime refuses them outright (a relative path means
    // a different directory depending on the process's cwd, and the bot's cwd
    // is not the installer's). The FIRST version of the mirror omitted this
    // rule and accepted ".", which really is a repo root relative to this
    // repo — caught only by probing by hand, because every case above uses an
    // absolute mkdtemp path. That is the drift this file exists to prevent, so
    // it is pinned here permanently.
    ["a relative path that IS a repo root relative to cwd", () => "."],
    ["a relative path with a separator", () => path.join(".", "src")],
    ["an empty string", () => ""],
  ];

  it.each(cases)("agrees on: %s", (_name, build) => {
    const p = build();
    const installerAccepts = controlledRepoProblem(p, fs, path) === null;
    expect(installerAccepts).toBe(runtimeAccepts(p));
  });

  it("distinguishes 'missing' from 'notGit' from 'notAbsolute' so the user gets the right advice", () => {
    // Three different mistakes with three different fixes: make it absolute vs
    // create/choose a path vs `git init` (or point at the repo instead of its
    // parent). One generic message for all three is how "path is wrong"
    // becomes a guessing game.
    const plain = mkTmp();
    expect(controlledRepoProblem(plain, fs, path)).toBe("notGit");
    expect(controlledRepoProblem(path.join(plain, "nope"), fs, path)).toBe("missing");
    expect(controlledRepoProblem(".", fs, path)).toBe("notAbsolute");
  });

  afterAll(() => {
    for (const d of made) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

/**
 * Guards the installer's refusal to reinstall over a RUNNING bot. npm must
 * replace files inside node_modules that the live process holds open; on Windows
 * that surfaces as a hard EPERM naming only `runtime.node`, which reads like a
 * permissions/antivirus problem. Re-running the installer to fix a bad config is
 * exactly when the bot is most likely to be running, so getting this right
 * matters more than it looks.
 */
describe("livePidFromLock (installer's running-bot guard)", () => {
  const made: string[] = [];
  const lockWith = (contents: string): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-lock-"));
    made.push(d);
    const p = path.join(d, "default.lock");
    fs.writeFileSync(p, contents);
    return p;
  };
  const alive = (): void => undefined;
  const dead = (): never => {
    const e = new Error("ESRCH") as NodeJS.ErrnoException;
    e.code = "ESRCH";
    throw e;
  };
  const notOurs = (): never => {
    const e = new Error("EPERM") as NodeJS.ErrnoException;
    e.code = "EPERM";
    throw e;
  };

  it("reports the pid when the holder is alive", () => {
    expect(livePidFromLock(lockWith("4242"), fs, alive)).toBe(4242);
  });

  it("tolerates trailing whitespace/newline the app may write", () => {
    expect(livePidFromLock(lockWith("4242\n"), fs, alive)).toBe(4242);
  });

  it("reports the pid on EPERM — the process exists, it just isn't ours", () => {
    // Still alive, still holding the files npm wants to replace. Treating EPERM
    // as "not running" would put us straight back into the cryptic npm failure.
    expect(livePidFromLock(lockWith("4242"), fs, notOurs)).toBe(4242);
  });

  it("ignores a STALE lock left by a crashed process", () => {
    // A crash leaves the file behind. Refusing to install forever afterwards
    // would be a worse bug than the one this guard prevents.
    expect(livePidFromLock(lockWith("4242"), fs, dead)).toBeUndefined();
  });

  it("fails OPEN on a missing or unparsable lock", () => {
    const gone = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dcs-lock-")), "nope.lock");
    expect(livePidFromLock(gone, fs, alive)).toBeUndefined();
    expect(livePidFromLock(lockWith(""), fs, alive)).toBeUndefined();
    expect(livePidFromLock(lockWith("not-a-pid"), fs, alive)).toBeUndefined();
    expect(livePidFromLock(lockWith("0"), fs, alive)).toBeUndefined();
    expect(livePidFromLock(lockWith("-1"), fs, alive)).toBeUndefined();
  });

  it("agrees with a REAL live process (this test runner)", () => {
    // End-to-end sanity that the injected killFn contract matches process.kill.
    const p = lockWith(String(process.pid));
    expect(livePidFromLock(p, fs, process.kill.bind(process))).toBe(process.pid);
  });

  afterAll(() => {
    for (const d of made) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});
