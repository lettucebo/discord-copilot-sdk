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
const SETUP_LOG_PREFIX = "setup-";

type RunSetupOptions = {
  env?: NodeJS.ProcessEnv;
  keepHome?: boolean;
};

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
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "discord-copilot-sdk", version: FIXTURE_VERSION, type: "module" }));
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

function stubBuiltDist(repo) {
  fs.mkdirSync(path.join(repo, "dist", "core"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "dist", "config.js"),
    'export function parseConfig(env) { return { REPOS_ROOT: env.REPOS_ROOT }; }\n'
  );
  fs.writeFileSync(path.join(repo, "dist", "core", "repo.js"), "export function resolveReposRoot(value) { return value; }\n");
}

function runSetup(repo: string, args: readonly string[], options: RunSetupOptions = {}) {
  const { env: envOverrides = {}, keepHome = false } = options;
  // Isolate HOME/USERPROFILE so any accidental STATE_DIR write (~/.discord-copilot-sdk)
  // lands in the fixture, never the real home, and would be observable.
  const home = fs.mkdtempSync(path.join(tmpdir(), "dp-int-home-"));
  const env = {
    ...process.env,
    NO_COLOR: "1",
    HOME: home,
    USERPROFILE: home,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ...envOverrides,
  };
  try {
    const result = spawnSync(process.execPath, [path.join(repo, "scripts", "setup.mjs"), ...args], {
      cwd: repo,
      env,
      encoding: "utf8",
    });
    return Object.assign(result, { home });
  } finally {
    if (!keepHome) fs.rmSync(home, { recursive: true, force: true });
  }
}

// Any leftover .env write artifact: the unique temp (.env.<pid>.<uuid>.tmp) or a backup.
function listStray(repo) {
  return fs.readdirSync(repo).filter((f) => /^\.env\..*\.(tmp|bak)$/.test(f) || f === ".env.tmp" || f === ".env.bak");
}

function setupLogDir(home) {
  return path.join(home, ".discord-copilot-sdk", "logs");
}

function listSetupLogs(home) {
  const dir = setupLogDir(home);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(SETUP_LOG_PREFIX))
    .map((name) => path.join(dir, name));
}

function firstLogPath(logs: string[]): string {
  const [logPath] = logs;
  if (logPath === undefined) throw new Error("expected one setup log path");
  return logPath;
}

function numberLines(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`).join("\n") + "\n";
}

function rewriteSetupFixture(repo, replacer) {
  const setupPath = path.join(repo, "scripts", "setup.mjs");
  const original = fs.readFileSync(setupPath, "utf8");
  const updated = replacer(original);
  expect(updated).not.toBe(original);
  fs.writeFileSync(setupPath, updated);
}

function writeNodeCommandStub(name, source, targetDir = binDir) {
  const scriptPath = path.join(targetDir, `${name}-stub.mjs`);
  fs.writeFileSync(scriptPath, source);
  if (isWin) {
    fs.writeFileSync(path.join(targetDir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0${name}-stub.mjs" %*\r\n`);
  } else {
    const wrapperPath = path.join(targetDir, name);
    fs.writeFileSync(wrapperPath, `#!/bin/sh\n${JSON.stringify(process.execPath)} "$(dirname "$0")/${name}-stub.mjs" "$@"\n`);
    fs.chmodSync(wrapperPath, 0o755);
  }
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), "dp-int-bin-"));
  binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  // Stub git + copilot so the read-only prereq gate resolves them on any host.
  writeNodeCommandStub(
    "git",
    [
      'const args = process.argv.slice(2);',
      'if (args[0] === "--version") { console.log("git version 2.47.0"); process.exit(0); }',
      'if (args[0] === "ls-files") process.exit(1);',
      "process.exit(0);",
      "",
    ].join("\n")
  );
  writeNodeCommandStub(
    "copilot",
    [
      'const args = process.argv.slice(2);',
      'if (args[0] === "--version") { console.log("copilot 1.0.0"); process.exit(0); }',
      "process.exit(0);",
      "",
    ].join("\n")
  );
  writeNodeCommandStub(
    "npm",
    [
      'import { spawn } from "node:child_process";',
      'import fs from "node:fs";',
      'const args = process.argv.slice(2);',
      'const joined = args.join(" ");',
      'if (joined === "--version") { console.log("10.9.0"); process.exit(0); }',
      'const phase = joined === "run build" ? "BUILD" : args[0] === "ci" || args[0] === "install" ? "INSTALL" : "GENERIC";',
      'const writeHexParts = async (target, envKey) => {',
      '  const raw = process.env[envKey];',
      '  if (!raw) return;',
      '  for (const hex of JSON.parse(raw)) {',
      '    target.write(Buffer.from(hex, "hex"));',
      '    await new Promise((resolve) => setTimeout(resolve, 0));',
      "  }",
      "};",
      'const stdout = process.env[`DP_${phase}_STDOUT`] || "";',
      'const stderr = process.env[`DP_${phase}_STDERR`] || "";',
      'const delayMs = Number(process.env[`DP_${phase}_DELAY_MS`] || "0");',
      'const touchPath = process.env[`DP_${phase}_TOUCH_PATH`];',
      'if (stdout) process.stdout.write(stdout);',
      'if (stderr) process.stderr.write(stderr);',
      'await writeHexParts(process.stdout, `DP_${phase}_STDOUT_HEX_PARTS`);',
      'await writeHexParts(process.stderr, `DP_${phase}_STDERR_HEX_PARTS`);',
      'if (process.env[`DP_${phase}_KILL_SELF`] === "1") {',
      '  spawn(process.execPath, ["-e", `setTimeout(() => process.kill(${process.pid}, "SIGTERM"), 25)`], { stdio: "ignore" });',
      '  setInterval(() => {}, 1000);',
      '  await new Promise(() => {});',
      "}",
      'if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));',
      'if (touchPath) fs.writeFileSync(touchPath, `${phase.toLowerCase()}-completed\\n`);',
      'const exitCode = Number(process.env[`DP_${phase}_EXIT`] || "0");',
      "process.exit(Number.isFinite(exitCode) ? exitCode : 0);",
      "",
    ].join("\n")
  );
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

  it("successful non-dry-run explicitly reports completion, while dry-run stays marked as dry-run", () => {
    const repo = makeFixture(true);
    try {
      stubBuiltDist(repo);

      const success = runSetup(repo, ["--yes", "--skip-auth", "--lang", "en"]);
      const successOut = (success.stdout || "") + (success.stderr || "");
      expect(success.status).toBe(0);
      expect(successOut).toContain("✅ Installation complete");
      expect(successOut).toContain("Action summary");
      expect(successOut).not.toContain("Action summary (dry-run)");

      const dryRun = runSetup(repo, ["--dry-run", "--yes", "--skip-auth", "--lang", "en"]);
      const dryRunOut = (dryRun.stdout || "") + (dryRun.stderr || "");
      expect(dryRun.status).toBe(0);
      expect(dryRunOut).toContain("Action summary (dry-run)");
      expect(dryRunOut).not.toContain("✅ Installation complete");
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

  it("dry-run remains mutation-free and does not create a setup log", () => {
    const repo = makeFixture(true);
    let home;
    try {
      const r = runSetup(repo, ["--dry-run", "--yes", "--skip-auth", "--lang", "en"], { keepHome: true });
      home = r.home;
      expect(r.status).toBe(0);
      expect(listSetupLogs(home)).toEqual([]);
    } finally {
      if (home) fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("default build runner keeps non-TTY output stable, hides successful child output, and logs it under the isolated state dir", () => {
    const repo = makeFixture(true);
    let home;
    try {
      stubBuiltDist(repo);
      const r = runSetup(repo, ["--yes", "--skip-auth", "--lang", "en"], {
        keepHome: true,
        env: {
          DP_INSTALL_STDOUT: "install-stdout-marker\n",
          DP_INSTALL_STDERR: "install-stderr-marker\n",
          DP_BUILD_STDOUT: "build-stdout-marker\n",
          DP_BUILD_STDERR: "build-stderr-marker\n",
        },
      });
      home = r.home;
      const out = (r.stdout || "") + (r.stderr || "");
      const logs = listSetupLogs(home);

      expect(r.status).toBe(0);
      expect(out).toContain("npm install --no-audit --no-fund");
      expect(out).toContain("npm run build");
      expect(out).not.toContain("install-stdout-marker");
      expect(out).not.toContain("install-stderr-marker");
      expect(out).not.toContain("build-stdout-marker");
      expect(out).not.toContain("build-stderr-marker");
      expect(out).not.toContain("\r");
      expect(out).not.toContain("DEP0190");
      expect(logs).toHaveLength(1);
      const logPath = firstLogPath(logs);
      expect(logPath.startsWith(setupLogDir(home))).toBe(true);
      const logText = fs.readFileSync(logPath, "utf8");
      expect(logText).toContain("install-stdout-marker");
      expect(logText).toContain("install-stderr-marker");
      expect(logText).toContain("build-stdout-marker");
      expect(logText).toContain("build-stderr-marker");
    } finally {
      if (home) fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("verbose build runner mirrors child output while still succeeding", () => {
    const repo = makeFixture(true);
    let home;
    try {
      stubBuiltDist(repo);
      const r = runSetup(repo, ["--yes", "--skip-auth", "--lang", "en", "--verbose"], {
        keepHome: true,
        env: {
          DP_INSTALL_STDOUT: "verbose-install-marker\n",
          DP_BUILD_STDERR: "verbose-build-marker\n",
        },
      });
      home = r.home;
      const out = (r.stdout || "") + (r.stderr || "");

      expect(r.status).toBe(0);
      expect(out).toContain("verbose-install-marker");
      expect(out).toContain("verbose-build-marker");
      expect(out).toContain("npm install --no-audit --no-fund");
      expect(out).toContain("npm run build");
      expect(out).not.toContain("DEP0190");
      expect(listSetupLogs(home)).toHaveLength(1);
    } finally {
      if (home) fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("setup-log write-stream failures exit non-zero and stop before later stages or the summary", () => {
    const repo = makeFixture(true);
    let home;
    try {
      stubBuiltDist(repo);
      rewriteSetupFixture(repo, (source) =>
        source
          .replace(
            'import { setupResidency, residencyName, chooseResidencyMode, hasResidencyRegistration, instanceId } from "./lib/residency.mjs";',
            [
              'import { setupResidency, residencyName, chooseResidencyMode, hasResidencyRegistration, instanceId } from "./lib/residency.mjs";',
              "const realCreateWriteStream = fs.createWriteStream.bind(fs);",
              "let injectedLogFailure = false;",
              "fs.createWriteStream = (...args) => {",
              "  const stream = realCreateWriteStream(...args);",
              "  const realWrite = stream.write.bind(stream);",
              "  stream.write = (...writeArgs) => {",
              "    const result = realWrite(...writeArgs);",
              "    if (!injectedLogFailure) {",
              "      injectedLogFailure = true;",
              '      setTimeout(() => stream.destroy(new Error("simulated log stream failure")), 150);',
              "    }",
              "    return result;",
              "  };",
              "  return stream;",
              "};",
            ].join("\n")
          )
          .replace(
            '    await run("npm", hasLock ? ["ci"] : ["install", "--no-audit", "--no-fund"], sanitizedChildEnv(), lang, buildLog);\n    await run("npm", ["run", "build"], sanitizedChildEnv(), lang, buildLog);',
            '    await run("npm", hasLock ? ["ci"] : ["install", "--no-audit", "--no-fund"], sanitizedChildEnv(), lang, buildLog);\n    await new Promise((resolve) => setTimeout(resolve, 300));\n    await run("npm", ["run", "build"], sanitizedChildEnv(), lang, buildLog);'
          )
      );

      const r = runSetup(repo, ["--yes", "--skip-auth", "--lang", "en"], {
        keepHome: true,
        env: {
          DP_INSTALL_STDOUT: "install-before-log-failure\n",
        },
      });
      home = r.home;
      const out = (r.stdout || "") + (r.stderr || "");

      expect(r.status).toBe(1);
      expect(out).toContain("Could not create or secure the setup log file: simulated log stream failure");
      expect(out).not.toContain("[4/5] Config validation and .env write");
      expect(out).not.toContain("Action summary");
    } finally {
      if (home) fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("setup-log failures at build spawn do not leave the spawned npm process running", async () => {
    const repo = makeFixture(true);
    let home;
    const markerPath = path.join(repo, "build-child-marker.txt");
    try {
      stubBuiltDist(repo);
      rewriteSetupFixture(repo, (source) =>
        source.replace(
          "        child = spawnChild(cmd, args, env);",
          [
            "        child = spawnChild(cmd, args, env);",
            '        if (cmd === "npm" && args.join(" ") === "run build") {',
            '          log.stream.destroy(new Error("simulated log stream failure"));',
            "        }",
          ].join("\n")
        )
      );

      const r = runSetup(repo, ["--yes", "--skip-auth", "--lang", "en"], {
        keepHome: true,
        env: {
          DP_BUILD_DELAY_MS: "250",
          DP_BUILD_TOUCH_PATH: markerPath,
        },
      });
      home = r.home;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const out = (r.stdout || "") + (r.stderr || "");

      expect(r.status).toBe(1);
      expect(out).toContain("Could not create or secure the setup log file: simulated log stream failure");
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      if (home) fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("command failure prints only the final 40 log lines, names the protected log, and stops before later stages", () => {
    const repo = makeFixture(true);
    let home;
    try {
      const r = runSetup(repo, ["--yes", "--skip-auth", "--lang", "en"], {
        keepHome: true,
        env: {
          DP_BUILD_STDOUT: numberLines("tail", 60),
          DP_BUILD_EXIT: "23",
        },
      });
      home = r.home;
      const out = (r.stdout || "") + (r.stderr || "");
      const logs = listSetupLogs(home);

      expect(r.status).toBe(1);
      expect(out).toContain("npm run build");
      expect(out).toMatch(/failed/i);
      expect(out).toContain(setupLogDir(home));
      expect(out).not.toContain("tail-01");
      expect(out).not.toContain("tail-20");
      expect(out).toContain("tail-21");
      expect(out).toContain("tail-60");
      expect(out.match(/tail-\d{2}/g)).toHaveLength(40);
      expect(out).not.toContain("[4/5] Config validation and .env write");
      expect(out).not.toContain("Action summary");
      expect(logs).toHaveLength(1);
      const logText = fs.readFileSync(firstLogPath(logs), "utf8");
      expect(logText).toContain("tail-01");
      expect(logText).toContain("tail-60");
    } finally {
      if (home) fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("signal-terminated commands still report the protected log path and stop before later stages", () => {
    const repo = makeFixture(true);
    let home;
    try {
      const r = runSetup(repo, ["--yes", "--skip-auth", "--lang", "en"], {
        keepHome: true,
        env: {
          DP_BUILD_STDOUT: "before-signal\n",
          DP_BUILD_KILL_SELF: "1",
        },
      });
      home = r.home;
      const out = (r.stdout || "") + (r.stderr || "");

      expect(r.status).toBe(1);
      expect(out).toContain("npm run build");
      expect(out).toContain(setupLogDir(home));
      expect(out).toMatch(/terminated unexpectedly|failed/i);
      expect(out).not.toContain("[4/5] Config validation and .env write");
      expect(out).not.toContain("Action summary");
    } finally {
      if (home) fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("preserves utf-8 output split across child chunks in verbose output and logs", () => {
    const repo = makeFixture(true);
    let home;
    try {
      stubBuiltDist(repo);
      const r = runSetup(repo, ["--yes", "--skip-auth", "--lang", "en", "--verbose"], {
        keepHome: true,
        env: {
          DP_BUILD_STDOUT_HEX_PARTS: JSON.stringify(["e4", "bda0", "e5", "a5bd0a"]),
        },
      });
      home = r.home;
      const out = (r.stdout || "") + (r.stderr || "");
      const logs = listSetupLogs(home);

      expect(r.status).toBe(0);
      expect(out).toContain("你好");
      expect(out).not.toContain("�");
      expect(out).not.toContain("DEP0190");
      expect(logs).toHaveLength(1);
      const logText = fs.readFileSync(firstLogPath(logs), "utf8");
      expect(logText).toContain("你好");
      expect(logText).not.toContain("�");
    } finally {
      if (home) fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.runIf(!isWin)("reports the protected log path when npm cannot be started at all", () => {
    const repo = makeFixture(true);
    let home;
    const missingNpmDir = fs.mkdtempSync(path.join(root, "bin-no-npm-"));
    try {
      writeNodeCommandStub(
        "git",
        [
          'const args = process.argv.slice(2);',
          'if (args[0] === "--version") { console.log("git version 2.47.0"); process.exit(0); }',
          'if (args[0] === "ls-files") process.exit(1);',
          "process.exit(0);",
          "",
        ].join("\n"),
        missingNpmDir
      );
      writeNodeCommandStub(
        "copilot",
        [
          'const args = process.argv.slice(2);',
          'if (args[0] === "--version") { console.log("copilot 1.0.0"); process.exit(0); }',
          "process.exit(0);",
          "",
        ].join("\n"),
        missingNpmDir
      );
      writeNodeCommandStub(
        "which",
        [
          'const command = process.argv[2];',
          'if (command === "git" || command === "copilot") { console.log(command); process.exit(0); }',
          "process.exit(1);",
          "",
        ].join("\n"),
        missingNpmDir
      );

      const r = runSetup(repo, ["--yes", "--skip-auth", "--lang", "en"], {
        keepHome: true,
        env: {
          PATH: missingNpmDir,
        },
      });
      home = r.home;
      const out = (r.stdout || "") + (r.stderr || "");

      expect(r.status).toBe(1);
      expect(out).toContain("npm install --no-audit --no-fund");
      expect(out).toContain(setupLogDir(home));
      expect(out).toMatch(/Could not start/i);
      expect(out).not.toContain("[4/5] Config validation and .env write");
    } finally {
      if (home) fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(missingNpmDir, { recursive: true, force: true });
    }
  });
});
