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

const VALID_ENV = [
  "DISCORD_BOT_TOKEN=tok_UNIQUE_SENTINEL_do_not_leak_9f3c",
  "DISCORD_ALLOWED_USER_IDS=123456789012345678",
  "DISCORD_GUILD_ID=234567890123456789",
  "DISCORD_PARENT_CHANNEL_ID=345678901234567890",
  "CONTROLLED_REPO_PATH=/tmp/discopilot-fixture-repo",
  "DEV_GUILD_ID=",
  "DEFAULT_MODEL=claude-sonnet-5",
  "DEFAULT_CONTEXT_TIER=default",
  "",
].join("\n");

let root; // temp fixture root
let binDir; // stub-bin prepended to PATH

function makeFixture(withEnv) {
  const repo = fs.mkdtempSync(path.join(tmpdir(), "dp-int-"));
  fs.cpSync(REAL_SCRIPTS, path.join(repo, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "discopilot", version: "0.0.0" }));
  fs.writeFileSync(path.join(repo, ".env.example"), "DISCORD_BOT_TOKEN=\nDEV_GUILD_ID=\n");
  if (withEnv) fs.writeFileSync(path.join(repo, ".env"), VALID_ENV);
  return repo;
}

function runSetup(repo, args) {
  // Isolate HOME/USERPROFILE so any accidental STATE_DIR write (~/.discopilot)
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
    return spawnSync(process.execPath, [path.join(repo, "scripts", "setup.mjs"), ...args], {
      cwd: repo,
      env,
      encoding: "utf8",
    });
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

describe("setup.mjs --dry-run orchestration (integration)", () => {
  it("valid config, English: exits 0, masks the token, and mutates NOTHING", () => {
    const repo = makeFixture(true);
    try {
      const before = fs.readFileSync(path.join(repo, ".env"), "utf8");
      const r = runSetup(repo, ["--dry-run", "--yes", "--skip-auth", "--lang", "en"]);
      const out = (r.stdout || "") + (r.stderr || "");

      expect(r.status).toBe(0);
      expect(out).toContain("Config to write (token masked)");
      expect(out).toContain("DISCORD_BOT_TOKEN=********");
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
      expect(fs.existsSync(path.join(repo, ".env"))).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects a non-discopilot repo root (guard) with the guard message and no mutation", () => {
    const repo = makeFixture(true);
    try {
      fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "not-discopilot" }));
      const before = fs.readFileSync(path.join(repo, ".env"), "utf8");
      const r = runSetup(repo, ["--dry-run", "--yes", "--skip-auth", "--lang", "en"]);
      expect(r.error).toBeUndefined();
      expect(r.signal).toBeNull();
      expect(r.status).toBe(1);
      const out = (r.stdout || "") + (r.stderr || "");
      expect(out).toMatch(/no package\.json with name=discopilot found/i); // the repo-root guard text
      expect(fs.readFileSync(path.join(repo, ".env"), "utf8")).toBe(before);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
