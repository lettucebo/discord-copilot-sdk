import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";

// End-to-end orchestration regression test for the installer's ONE config engine
// (scripts/setup.mjs). We copy the real scripts/ tree into a throwaway fixture
// repo (setup.mjs derives REPO_ROOT from its own location), stub git+copilot on
// PATH so the prereq gate passes on any host, and drive `--dry-run` to assert the
// validate-before-mutate contract WITHOUT running npm or writing a real .env.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_SCRIPTS = path.join(HERE, "..", "scripts");
const isWin = process.platform === "win32";
const FIXTURE_VERSION = "9.8.7";

// REPOS_ROOT is filled in per-fixture (see makeFixture) — it must be a REAL
// directory that is NOT itself a git repo, because setup.mjs enforces that
// unconditionally (interactive AND --yes), mirroring src/core/repo.ts's
// resolveReposRoot(). Note this is the exact INVERSE of the old
// CONTROLLED_REPO_PATH rule: that one required a `.git` entry, this one refuses
// it. A placeholder like `/tmp/does-not-exist` would fail every one of these
// "valid config" cases.
function validEnv(reposRoot) {
  return [
    "DISCORD_BOT_TOKEN=tok_UNIQUE_SENTINEL_do_not_leak_9f3c",
    "DISCORD_ALLOWED_USER_IDS=123456789012345678",
    "DISCORD_GUILD_ID=234567890123456789",
    "DISCORD_PARENT_CHANNEL_ID=345678901234567890",
    `REPOS_ROOT=${reposRoot}`,
    "DEV_GUILD_ID=",
    "DEFAULT_MODEL=claude-sonnet-5",
    "DEFAULT_CONTEXT_TIER=default",
    "",
  ].join("\n");
}

let root; // temp fixture root
let binDir; // stub-bin prepended to PATH

function makeFixture(withEnv) {
  const repo = fs.mkdtempSync(path.join(tmpdir(), "dp-int-"));
  fs.cpSync(REAL_SCRIPTS, path.join(repo, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "discord-copilot-sdk", version: FIXTURE_VERSION }));
  fs.writeFileSync(path.join(repo, ".env.example"), "DISCORD_BOT_TOKEN=\nDEV_GUILD_ID=\n");
  if (withEnv) {
    // A separate directory from the fixture root itself, so it can't be
    // confused with the "is THIS a discord-copilot-sdk checkout" guard — just a
    // disposable folder that HOLDS repos, which is exactly what REPOS_ROOT is
    // supposed to point at. One child repo makes it realistic; the root itself
    // must have no `.git`. Nested inside `repo` so the caller's single
    // rmSync(repo) cleans it up too.
    const reposRoot = path.join(repo, "repos-root");
    fs.mkdirSync(path.join(reposRoot, "demo-repo", ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".env"), validEnv(reposRoot));
  }
  return repo;
}

function runSetup(repo, args) {
  // Isolate HOME/USERPROFILE so any accidental STATE_DIR write (~/.discord-copilot-sdk)
  // lands in the fixture, never the real home, and would be observable.
  const home = fs.mkdtempSync(path.join(tmpdir(), "dp-int-home-"));
  const env = {
    ...process.env,
    NO_COLOR: "1",
    HOME: home,
    USERPROFILE: home,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
  };
  try {
    const result = spawnSync(process.execPath, [path.join(repo, "scripts", "setup.mjs"), ...args], {
      cwd: repo,
      env,
      encoding: "utf8",
    });
    return Object.assign(result, { home });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// Any leftover .env write artifact: the unique temp (.env.<pid>.<uuid>.tmp) or a backup.
function listStray(repo) {
  return fs.readdirSync(repo).filter((f) => /^\.env\..*\.(tmp|bak)$/.test(f) || f === ".env.tmp" || f === ".env.bak");
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), "dp-int-bin-"));
  binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  // Stub git + copilot so the read-only prereq gate resolves them on any host.
  for (const name of ["git", "copilot"]) {
    if (isWin) {
      fs.writeFileSync(path.join(binDir, `${name}.cmd`), "@echo off\r\nexit /b 0\r\n");
    } else {
      const p = path.join(binDir, name);
      fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(p, 0o755);
    }
  }
});

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// Every test in here spawns a REAL `node scripts/setup.mjs` subprocess. Node
// startup alone is ~1s, and on a loaded CI runner (Windows especially) the whole
// round trip routinely exceeds vitest's 5s default — observed at 6707ms on a
// commit that changed only documentation. A test that fails on timing rather
// than behaviour is worse than no test, so the budget is stated explicitly here
// instead of being raised globally, which would blunt the signal for genuinely
// hanging unit tests.
describe("setup.mjs --dry-run orchestration (integration)", { timeout: 60_000 }, () => {
  it("valid config, English dry-run: prints the install plan before stage 1, masks secrets, and mutates NOTHING", () => {
    const repo = makeFixture(true);
    try {
      const before = fs.readFileSync(path.join(repo, ".env"), "utf8");
      const r = runSetup(repo, ["--dry-run", "--yes", "--skip-auth", "--lang", "en"]);
      const out = (r.stdout || "") + (r.stderr || "");
      const shell = isWin ? "ps1" : "sh";
      const stateDir = path.join(r.home, ".discord-copilot-sdk");

      expect(r.status).toBe(0);
      expect(out).toContain(`== discord-copilot-sdk installer ${FIXTURE_VERSION} ==`);
      expect(out).toContain("Install plan");
      expect(out.indexOf("Install plan")).toBeLessThan(out.indexOf("[1/5] Prerequisites and Copilot sign-in state"));
      expect(out).toContain("[1/5] Prerequisites and Copilot sign-in state");
      expect(out).toContain("[2/5] Configuration collection");
      expect(out).not.toContain("[3/5] Dependency install and build");
      expect(out).not.toContain("[4/5] Config validation and .env write");
      expect(out).not.toContain("[5/5] Residency setup");
      expect(out).toContain("Package version");
      expect(out).toContain(FIXTURE_VERSION);
      expect(out).toContain("Repository root");
      expect(out).toContain(repo);
      expect(out).toContain(".env path");
      expect(out).toContain(path.join(repo, ".env"));
      expect(out).toContain("State directory");
      expect(out).toContain(stateDir);
      expect(out).toContain("Instance id");
      expect(out).toContain("default");
      expect(out).toContain("Dry run");
      expect(out).toContain("Yes");
      expect(out).toContain("Config to write (token masked)");
      expect(out).toMatch(/DISCORD_BOT_TOKEN\s+\*{8}/);
      expect(out).toContain("Action summary");
      expect(out).toContain(`./run-bot.${shell}`);
      expect(out).toContain(`./stop-bot.${shell}`);
      expect(out).toMatch(/View logs\s+after the first start,/);
      expect(out).toContain("run-bot.default.log");
      expect(out).toContain(`./update.${shell}`);
      expect(out).toContain(`./uninstall.${shell}`);
      expect(out).toContain("Final step (manual): send a test message in your Discord channel, or use /new to begin.");
      expect(out).toContain("Safety: use a private server, enable 2FA, and never commit .env / your token.");
      expect(out).not.toContain("Config-load health check passed.");
      expect(out).not.toContain("Writing .env");
      // The real secret must NEVER appear in output.
      expect(out).not.toContain("tok_UNIQUE_SENTINEL_do_not_leak_9f3c");
      // Dry-run is read-only: .env unchanged, no temp/backup left behind.
      expect(fs.readFileSync(path.join(repo, ".env"), "utf8")).toBe(before);
      expect(listStray(repo)).toEqual([]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("valid config, Traditional Chinese: exits 0 with the localized preview header", () => {
    const repo = makeFixture(true);
    try {
      const r = runSetup(repo, ["--dry-run", "--yes", "--skip-auth", "--lang", "zh"]);
      const out = (r.stdout || "") + (r.stderr || "");
      expect(r.status).toBe(0);
      expect(out).toContain("token 已遮蔽"); // zh preview header
      expect(out).not.toContain("tok_UNIQUE_SENTINEL_do_not_leak_9f3c");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("dry-run residency preview shows both the manual log and the residency log convention", () => {
    const repo = makeFixture(true);
    try {
      const r = runSetup(repo, ["--dry-run", "--yes", "--skip-auth", "--lang", "en", "--residency"]);
      const out = (r.stdout || "") + (r.stderr || "");

      expect(r.status).toBe(0);
      expect(out).toMatch(/View logs\s+after the first start,/);
      expect(out).toContain("run-bot.default.log");
      if (isWin) {
        expect(out).toMatch(/Residency log\s+if residency is enabled,/);
        expect(out).toContain("discord-copilot-sdk-default.log");
      } else {
        expect(out).toMatch(/Residency log\s+if residency is enabled,/);
        expect(out).toContain(
          process.platform === "linux"
            ? "journalctl --user -u discord-copilot-sdk-default.service -f"
            : "discord-copilot-sdk-default.log"
        );
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("FAIL-CLOSED: a REPOS_ROOT that is itself a git repo is rejected, even under --yes", () => {
    // The inverse of a REAL production bug. The single-repo installer once
    // accepted a folder that merely CONTAINED repos, reported success, and the
    // bot crashed on its first launch. The polarity is now flipped — REPOS_ROOT
    // must be exactly that containing folder — so the mistake worth catching is
    // the opposite one, and it is the mistake an upgrade invites: pasting the
    // old CONTROLLED_REPO_PATH value straight in. This must be caught even under
    // --yes, where promptField() (the interactive prompt loop) never runs.
    const repo = makeFixture(true);
    try {
      const aRepo = path.join(repo, "an-actual-repo");
      fs.mkdirSync(path.join(aRepo, ".git"), { recursive: true });
      const env = fs
        .readFileSync(path.join(repo, ".env"), "utf8")
        .replace(/REPOS_ROOT=.*/, `REPOS_ROOT=${aRepo}`);
      fs.writeFileSync(path.join(repo, ".env"), env);
      const r = runSetup(repo, ["--dry-run", "--yes", "--skip-auth", "--lang", "en"]);
      expect(r.error).toBeUndefined();
      expect(r.signal).toBeNull();
      expect(r.status).toBe(1);
      const out = (r.stdout || "") + (r.stderr || "");
      expect(out).toMatch(/itself a git repo|CONTAINS your repos/i);
      expect(out).toContain(aRepo);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("FAIL-CLOSED: a REPOS_ROOT that does not exist is rejected, even under --yes", () => {
    const repo = makeFixture(true);
    try {
      const missing = path.join(repo, "no-such-folder");
      const env = fs
        .readFileSync(path.join(repo, ".env"), "utf8")
        .replace(/REPOS_ROOT=.*/, `REPOS_ROOT=${missing}`);
      fs.writeFileSync(path.join(repo, ".env"), env);
      const r = runSetup(repo, ["--dry-run", "--yes", "--skip-auth", "--lang", "en"]);
      expect(r.status).toBe(1);
      const out = (r.stdout || "") + (r.stderr || "");
      expect(out).toMatch(/does not exist|not a directory/i);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("MIGRATES a pre-multi-repo .env instead of failing on the removed key", () => {
    // The runtime REJECTS CONTROLLED_REPO_PATH outright, so an installer that
    // merely left it in place would hand back a .env the bot refuses to start
    // on. Its parent is the repos root and its basename the default repo.
    const repo = makeFixture(false);
    try {
      const reposRoot = path.join(repo, "my-repos");
      const oneRepo = path.join(reposRoot, "career-ops");
      fs.mkdirSync(path.join(oneRepo, ".git"), { recursive: true });
      fs.writeFileSync(
        path.join(repo, ".env"),
        [
          "DISCORD_BOT_TOKEN=tok_UNIQUE_SENTINEL_do_not_leak_9f3c",
          "DISCORD_ALLOWED_USER_IDS=123456789012345678",
          "DISCORD_GUILD_ID=234567890123456789",
          "DISCORD_PARENT_CHANNEL_ID=345678901234567890",
          `CONTROLLED_REPO_PATH=${oneRepo}`,
          "SESSION_ISOLATION=worktree",
          "",
        ].join("\n")
      );
      const r = runSetup(repo, ["--dry-run", "--yes", "--skip-auth", "--lang", "en"]);
      const out = (r.stdout || "") + (r.stderr || "");
      expect(r.status).toBe(0);
      expect(out).toContain(reposRoot); // derived repos root
      expect(out).toContain("career-ops"); // derived default repo
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("FAIL-CLOSED: missing required config (no .env) exits non-zero and writes no .env", () => {
    const repo = makeFixture(false);
    try {
      const r = runSetup(repo, ["--dry-run", "--yes", "--skip-auth", "--lang", "en"]);
      expect(r.error).toBeUndefined(); // the process actually spawned
      expect(r.signal).toBeNull(); // exited normally (not killed)
      expect(r.status).toBe(1); // main().catch → process.exit(1)
      const out = (r.stdout || "") + (r.stderr || "");
      // Names the missing required key(s); never mutates on a fail-closed abort.
      expect(out).toMatch(/DISCORD_BOT_TOKEN/);
      expect(out).not.toContain("Action summary");
      expect(fs.existsSync(path.join(repo, ".env"))).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects a non-discord-copilot-sdk repo root (guard) with the guard message and no mutation", () => {
    const repo = makeFixture(true);
    try {
      fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "not-discord-copilot-sdk" }));
      const before = fs.readFileSync(path.join(repo, ".env"), "utf8");
      const r = runSetup(repo, ["--dry-run", "--yes", "--skip-auth", "--lang", "en"]);
      expect(r.error).toBeUndefined();
      expect(r.signal).toBeNull();
      expect(r.status).toBe(1);
      const out = (r.stdout || "") + (r.stderr || "");
      expect(out).toMatch(/no package\.json with name=discord-copilot-sdk found/i); // the repo-root guard text
      expect(fs.readFileSync(path.join(repo, ".env"), "utf8")).toBe(before);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
