import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import {
  parseCloneSource,
  validateRepoName,
  isInternalHost,
  sanitizeToolOutput,
  sweepStaleStaging,
  RepoProvisioner,
  type ClonePolicy,
} from "../src/core/repo-provision.js";

const github: ClonePolicy = { hostPolicy: "github", allowedHosts: [] };
const allowlist: ClonePolicy = { hostPolicy: "allowlist", allowedHosts: ["git.example.com"] };

describe("parseCloneSource — what it REFUSES", () => {
  it("refuses `ext::`, which git would EXECUTE", () => {
    // Not theoretical: git's protocol.ext.allow defaults to `user`, so a
    // directly-invoked `git clone 'ext::sh -c id'` runs the command.
    expect(() => parseCloneSource("ext::sh -c 'id'", github)).toThrow();
    expect(() => parseCloneSource("ext::sh -c 'id'", allowlist)).toThrow();
  });

  it("refuses file:, http: and any other scheme", () => {
    expect(() => parseCloneSource("file:///etc/passwd", allowlist)).toThrow(/scheme|recognised/i);
    expect(() => parseCloneSource("http://git.example.com/x", allowlist)).toThrow(/scheme/i);
    expect(() => parseCloneSource("ftp://git.example.com/x", allowlist)).toThrow(/scheme/i);
  });

  it("refuses a source that starts with `-` (git would read it as an OPTION)", () => {
    // argv arrays stop shell injection; they do NOT stop `--upload-pack=<cmd>`.
    expect(() => parseCloneSource("--upload-pack=evil", github)).toThrow(/start with/i);
    expect(() => parseCloneSource("-c", github)).toThrow(/start with/i);
  });

  it("refuses control characters and empty input", () => {
    expect(() => parseCloneSource("owner/re\u0000po", github)).toThrow(/control/i);
    expect(() => parseCloneSource("   ", github)).toThrow(/required/i);
  });

  it("refuses embedded credentials", () => {
    expect(() => parseCloneSource("https://user:pw@github.com/o/r", github)).toThrow(/credential/i);
    expect(() => parseCloneSource("https://user@github.com/o/r", github)).toThrow(/username/i);
  });

  it("refuses internal, loopback and metadata hosts even under an allowlist", () => {
    const permissive: ClonePolicy = {
      hostPolicy: "allowlist",
      allowedHosts: ["localhost", "127.0.0.1", "169.254.169.254", "10.0.0.5"],
    };
    for (const h of ["localhost", "127.0.0.1", "169.254.169.254", "10.0.0.5"]) {
      expect(() => parseCloneSource(`https://${h}/x/y`, permissive)).toThrow(/internal|loopback/i);
    }
  });

  it("refuses a host that is not in the allowlist", () => {
    expect(() => parseCloneSource("https://evil.example.net/x/y", allowlist)).toThrow(/allowlist|not in/i);
  });

  it("refuses non-github hosts under the default github policy", () => {
    expect(() => parseCloneSource("https://git.example.com/x/y", github)).toThrow(/github/i);
  });
});

describe("parseCloneSource — what it ACCEPTS", () => {
  it("accepts owner/repo shorthand and routes it through gh", () => {
    const p = parseCloneSource("lettucebo/seam-acp", github);
    expect(p).toMatchObject({ kind: "gh", host: "github.com", suggestedName: "seam-acp" });
  });

  it("accepts an https github URL and strips a trailing .git from the name", () => {
    const p = parseCloneSource("https://github.com/lettucebo/career-ops.git", github);
    expect(p.kind).toBe("gh");
    expect(p.suggestedName).toBe("career-ops");
  });

  it("accepts ssh and scp-style addresses for an allowlisted host", () => {
    expect(parseCloneSource("ssh://git@git.example.com/o/r.git", allowlist)).toMatchObject({
      kind: "git",
      suggestedName: "r",
    });
    expect(parseCloneSource("git@git.example.com:o/r.git", allowlist)).toMatchObject({
      kind: "git",
      host: "git.example.com",
      suggestedName: "r",
    });
  });
});

describe("isInternalHost", () => {
  it("sees through the disguises a naive check misses", () => {
    expect(isInternalHost("localhost.")).toBe(true); // trailing dot
    expect(isInternalHost("::ffff:127.0.0.1")).toBe(true); // IPv4-mapped IPv6
    expect(isInternalHost("[::1]")).toBe(true); // bracketed IPv6 loopback
    expect(isInternalHost("thing.internal")).toBe(true);
    expect(isInternalHost("printer.local")).toBe(true);
    expect(isInternalHost("fd00::1")).toBe(true); // unique-local
    expect(isInternalHost("fe80::1")).toBe(true); // link-local
    expect(isInternalHost("172.16.0.1")).toBe(true);
    expect(isInternalHost("172.32.0.1")).toBe(false); // just OUTSIDE RFC1918
    expect(isInternalHost("github.com")).toBe(false);
  });
});

describe("validateRepoName", () => {
  it("accepts an ordinary name", () => {
    expect(validateRepoName("career-ops")).toBe("career-ops");
  });

  it("refuses Windows device names, which cannot be directories at all", () => {
    for (const n of ["CON", "nul", "COM1", "LPT9", "con.txt"]) {
      expect(() => validateRepoName(n)).toThrow(/reserved/i);
    }
  });

  it("refuses separators, traversal, and leading/trailing punctuation", () => {
    for (const n of ["a/b", "a\\b", "..", "../x", ".hidden", "trailing.", "-lead"]) {
      expect(() => validateRepoName(n)).toThrow();
    }
  });

  it("TRIMS surrounding whitespace rather than refusing a copy-pasted value", () => {
    expect(validateRepoName("  career-ops  ")).toBe("career-ops");
  });

  it("refuses characters that are illegal on Windows", () => {
    for (const n of ['a"b', "a<b", "a>b", "a|b", "a?b", "a*b", "a:b"]) {
      expect(() => validateRepoName(n)).toThrow();
    }
  });

  it("refuses an over-long name", () => {
    expect(() => validateRepoName("x".repeat(101))).toThrow(/too long/i);
  });
});

describe("sanitizeToolOutput", () => {
  it("strips the FULL unsafe class, including bidi ISOLATES and markdown breakout", () => {
    // The first version of this used a narrower character class than the
    // project's own `UNSAFE_CLASS`: it missed \u2066-\u2069 (the modern bidi
    // ISOLATES that replaced the overrides) and left backticks intact — and a
    // single backtick closes an inline code span, after which a remote can forge
    // a line that reads like the bot's own success message.
    const nasty = "fatal: \u001b[31mred\u0007 \u2066spoof\u2069 \u202ereversed\u202c `x`\nSECOND LINE";
    const out = sanitizeToolOutput(nasty);
    expect(out).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u2028\u2029]/);
    expect(out).not.toContain("`");
    expect(out).not.toContain("\n"); // one message cannot fake several lines
    expect(out).toContain("fatal:");
  });

  it("bounds the length", () => {
    expect(sanitizeToolOutput("x".repeat(5000), 100).length).toBeLessThanOrEqual(101);
  });
});

describe("RepoProvisioner (real git)", { timeout: 60_000 }, () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-prov-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const prov = (): RepoProvisioner => new RepoProvisioner({ reposRoot: root, timeoutMs: 45_000 });

  it("init creates a repo with a REAL initial commit and leaves no staging behind", async () => {
    // The empty commit matters: with an unborn HEAD, the git reads the agent
    // makes (status/log/diff) fail in ways that look like a broken repo.
    const r = await prov().init("my-new-proj");
    expect(r.path).toBe(path.join(root, "my-new-proj"));
    expect(fs.existsSync(path.join(r.path, ".git"))).toBe(true);
    expect(fs.readdirSync(root).filter((n) => n.startsWith(".staging-"))).toEqual([]);
    const { execFileSync } = await import("node:child_process");
    const head = execFileSync("git", ["-C", r.path, "rev-parse", "--verify", "HEAD"]).toString().trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("init refuses a name that already exists, without touching it", async () => {
    await prov().init("dup");
    fs.writeFileSync(path.join(root, "dup", "marker.txt"), "keep me");
    await expect(prov().init("dup")).rejects.toThrow(/already exists/i);
    expect(fs.existsSync(path.join(root, "dup", "marker.txt"))).toBe(true);
  });

  it("init refuses a reserved name before touching the filesystem", async () => {
    await expect(prov().init("CON")).rejects.toThrow(/reserved/i);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("hands git a destination it will actually accept — the clone regression", async () => {
    // `git clone` refuses ANY destination that exists and is non-empty, and a
    // dot-file counts. An earlier version pre-created the staging directory and
    // wrote an ownership marker INTO it, so every clone failed with
    // "destination path already exists and is not an empty directory" — and the
    // only clone test asserted a rejection, so it passed for the wrong reason.
    // `git init` has no such rule, which is why /repo new kept working.
    let seen: { existed: boolean; entries: string[] } | undefined;
    const fakeSpawn = ((_file: string, args: readonly string[]) => {
      const dest = args[args.length - 1] as string;
      seen = {
        existed: fs.existsSync(dest),
        entries: fs.existsSync(dest) ? fs.readdirSync(dest) : [],
      };
      fs.mkdirSync(path.join(dest, ".git"), { recursive: true });
      const ee = new EventEmitter() as EventEmitter & { pid: number; stderr: null };
      ee.pid = 1234;
      ee.stderr = null;
      setImmediate(() => ee.emit("close", 0));
      return ee;
    }) as unknown as typeof spawn;

    const p = new RepoProvisioner({ reposRoot: root, timeoutMs: 5_000, spawnImpl: fakeSpawn });
    const r = await p.clone("lettucebo/seam-acp", "cloned-ok", github);

    expect(seen?.existed === false || seen?.entries.length === 0).toBe(true);
    expect(r.path).toBe(path.join(root, "cloned-ok"));
    expect(fs.existsSync(path.join(r.path, ".git"))).toBe(true);
    // No scratch left behind — neither the directory nor its marker.
    expect(fs.readdirSync(root).filter((n) => n.startsWith(".staging-"))).toEqual([]);
  });

  it("removes the staging directory when the build fails", async () => {
    // A clone that cannot resolve leaves nothing behind: a half-built directory
    // that survives would be bindable on the next /repo list.
    const p = new RepoProvisioner({ reposRoot: root, timeoutMs: 20_000 });
    await expect(
      p.clone("https://github.com/this-user-does-not-exist-9f3c/nope.git", "broken", github)
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(root, "broken"))).toBe(false);
    expect(fs.readdirSync(root).filter((n) => n.startsWith(".staging-"))).toEqual([]);
  });
});

describe("sweepStaleStaging", () => {
  it("removes only OUR staging directories, never a stranger's dot-directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-sweep-"));
    try {
      const ours = path.join(root, ".staging-abc123");
      fs.mkdirSync(ours, { recursive: true });
      fs.writeFileSync(`${ours}.dcs-staging`, "999999999"); // a pid that is not alive
      const live = path.join(root, ".staging-live");
      fs.mkdirSync(live, { recursive: true });
      fs.writeFileSync(`${live}.dcs-staging`, String(process.pid)); // a LIVE sibling
      const theirs = path.join(root, ".staging-not-ours");
      fs.mkdirSync(theirs, { recursive: true });
      const unrelated = path.join(root, ".config");
      fs.mkdirSync(unrelated, { recursive: true });

      await sweepStaleStaging(root);

      expect(fs.existsSync(ours)).toBe(false);
      expect(fs.existsSync(`${ours}.dcs-staging`)).toBe(false); // marker swept too
      expect(fs.existsSync(live)).toBe(true); // a live instance's clone is untouched
      expect(fs.existsSync(theirs)).toBe(true); // no marker → not ours to delete
      expect(fs.existsSync(unrelated)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
