import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  nodeVersionOk,
  reposRootProblem,
  livePidFromLock,
  reportLogInfo,
  createOutputTail,
  pushOutputTail,
  outputTailLines,
  writeChunkToSinks,
} from "../scripts/lib/setup-core.mjs";
import { resolveReposRoot } from "../src/core/repo.js";

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
 * FAST repos-root check (reposRootProblem, used before npm ci/build and by the
 * interactive prompt) must accept and reject exactly what the RUNTIME's
 * resolveReposRoot does — the function the bot actually calls at startup. A
 * mirror nobody checks is how they drift, and drift here means the installer
 * reports "complete" for a config that kills the bot on first launch (the real
 * incident this guards).
 *
 * Note the polarity flip since the single-repo version: a directory that merely
 * CONTAINS repos used to be the canonical REJECT case and is now the canonical
 * ACCEPT case.
 */
describe("reposRootProblem ⇄ resolveReposRoot contract", () => {
  const made: string[] = [];
  const mkTmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-repochk-"));
    made.push(d);
    return d;
  };
  // Trust-store stand-ins kept well away from the fixtures, so the overlap rule
  // only fires in the test that asks for it.
  const stateDir = path.join(os.tmpdir(), "dcs-repochk-state-fixture");
  const runtimeAccepts = (p: string): boolean => {
    try {
      resolveReposRoot(p, { stateDir, worktreeRoot: `${stateDir}-worktrees` });
      return true;
    } catch {
      return false;
    }
  };

  const cases: Array<[string, () => string]> = [
    [
      "a directory that merely CONTAINS repos (the shape REPOS_ROOT must accept)",
      () => {
        const parent = mkTmp();
        fs.mkdirSync(path.join(parent, "child-repo", ".git"), { recursive: true });
        return parent;
      },
    ],
    ["an empty plain directory", () => mkTmp()],
    [
      "a normal clone (.git is a DIRECTORY) — now REJECTED, it is a repo not a root",
      () => {
        const d = mkTmp();
        fs.mkdirSync(path.join(d, ".git"));
        return d;
      },
    ],
    [
      "a git worktree (.git is a FILE, not a directory) — also a repo, also rejected",
      () => {
        const d = mkTmp();
        fs.writeFileSync(path.join(d, ".git"), "gitdir: /somewhere/.git/worktrees/x\n");
        return d;
      },
    ],
    [
      "a SUBdirectory of a repo (no .git of its own, so it is a usable root)",
      () => {
        const d = mkTmp();
        fs.mkdirSync(path.join(d, ".git"));
        const sub = path.join(d, "src");
        fs.mkdirSync(sub);
        return sub;
      },
    ],
    ["a path that does not exist at all", () => path.join(mkTmp(), "nope")],
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
    ["a Windows drive-relative path", () => "C:repos"],
    ["an empty string", () => ""],
  ];

  it.each(cases)("agrees on: %s", (_name, build) => {
    const p = build();
    const installerAccepts = reposRootProblem(p, fs, path, stateDir) === null;
    expect(installerAccepts).toBe(runtimeAccepts(p));
  });

  it("distinguishes the four mistakes so the user gets the right advice", () => {
    // Four different mistakes with four different fixes: make it absolute vs
    // create/choose a path vs point at the PARENT instead of the repo vs move it
    // away from the bot's own state. One generic message for all of them is how
    // "path is wrong" becomes a guessing game.
    const plain = mkTmp();
    const repo = mkTmp();
    fs.mkdirSync(path.join(repo, ".git"));
    expect(reposRootProblem(plain, fs, path, stateDir)).toBe(null);
    expect(reposRootProblem(repo, fs, path, stateDir)).toBe("isRepo");
    expect(reposRootProblem(path.join(plain, "nope"), fs, path, stateDir)).toBe("missing");
    expect(reposRootProblem(".", fs, path, stateDir)).toBe("notAbsolute");
    expect(reposRootProblem("C:repos", fs, path, stateDir)).toBe("notAbsolute");
  });

  it("refuses a root that overlaps the bot's own state directory, in BOTH directions", () => {
    const state = mkTmp(); // pretend this is ~/.discord-copilot-sdk
    const inside = path.join(state, "repos");
    fs.mkdirSync(inside, { recursive: true });
    expect(reposRootProblem(inside, fs, path, state)).toBe("trustOverlap");
    expect(reposRootProblem(path.dirname(state), fs, path, state)).toBe("trustOverlap");
    // …and the worktree sibling counts too.
    const wt = `${state}-worktrees`;
    fs.mkdirSync(path.join(wt, "x"), { recursive: true });
    made.push(wt);
    expect(reposRootProblem(path.join(wt, "x"), fs, path, state)).toBe("trustOverlap");
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

describe("reportLogInfo (installer completion report log target)", () => {
  it("uses the manual launcher log until the bot has actually been started", () => {
    expect(reportLogInfo({ platform: "win32", stateDir: "C:\\State", instance: "default", residencyInstalled: false }, path)).toEqual({
      kind: "path",
      value: path.join("C:\\State", "logs", "run-bot.default.log"),
      afterFirstStart: true,
    });
  });

  describe("bounded installer output tails", () => {
    it("keeps only the final lines across chunk boundaries", () => {
      const tail = createOutputTail(3);

      pushOutputTail(tail, "line-01\nline-02\nline");
      pushOutputTail(tail, "-03\nline-04");

      expect(outputTailLines(tail)).toEqual(["line-02", "line-03", "line-04"]);
    });

    it("treats carriage returns as boundaries and bounds unterminated partial output", () => {
      const tail = createOutputTail(2, 8);

      pushOutputTail(tail, "alpha\rbeta\r123456789");

      expect(outputTailLines(tail)).toEqual(["beta", "…3456789"]);
    });

    it("treats CRLF split across chunks as one boundary", () => {
      const tail = createOutputTail(5);

      pushOutputTail(tail, "line-1\r");
      pushOutputTail(tail, "\nline-2");

      expect(outputTailLines(tail)).toEqual(["line-1", "line-2"]);
    });
  });

  describe("writeChunkToSinks", () => {
    it("pauses the source until every backpressured sink drains", () => {
      const events = [];
      const source = {
        pause: () => events.push("pause"),
        resume: () => events.push("resume"),
      };
      const logSink = new EventEmitter();
      logSink.write = () => false;
      const verboseSink = new EventEmitter();
      verboseSink.write = () => false;

      writeChunkToSinks(source, "chunk", [logSink, verboseSink]);
      expect(events).toEqual(["pause"]);

      logSink.emit("drain");
      expect(events).toEqual(["pause"]);

      verboseSink.emit("drain");
      expect(events).toEqual(["pause", "resume"]);
    });
  });

  it("uses the residency log file when Windows or macOS residency was installed", () => {
    expect(reportLogInfo({ platform: "win32", stateDir: "C:\\State", instance: "default", residencyInstalled: true }, path)).toEqual({
      kind: "path",
      value: path.join("C:\\State", "logs", "discord-copilot-sdk-default.log"),
      afterFirstStart: false,
    });
    expect(reportLogInfo({ platform: "darwin", stateDir: "/state", instance: "qa", residencyInstalled: true }, path)).toEqual({
      kind: "path",
      value: path.join("/state", "logs", "discord-copilot-sdk-qa.log"),
      afterFirstStart: false,
    });
  });

  it("uses the systemd journal command when Linux residency was installed", () => {
    expect(reportLogInfo({ platform: "linux", stateDir: "/state", instance: "ops", residencyInstalled: true }, path)).toEqual({
      kind: "command",
      value: "journalctl --user -u discord-copilot-sdk-ops.service -f",
      afterFirstStart: false,
    });
  });
});
