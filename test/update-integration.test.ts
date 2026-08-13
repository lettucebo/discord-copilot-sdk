import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { parseLsRemote, resolveRemoteSha } from "../scripts/lib/update-core.mjs";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = path.join(ROOT, "scripts", "update.mjs");
const PUBLIC_ORIGIN = "https://github.com/lettucebo/discord-copilot-sdk.git";
const git = (cwd: string, ...args: string[]): Promise<{ stdout: string }> =>
  exec("git", args, { cwd, encoding: "utf8" });

let root: string;
let source: string;
let remote: string;
let bin: string;
let serial = 0;
const instancePrefix = `test-${randomUUID()}`;

async function cloneTarget(name: string): Promise<string> {
  const target = path.join(root, name);
  await exec("git", ["clone", "-q", "--branch", "main", remote, target], { encoding: "utf8" });
  // The updater rejects every origin except the production project URL. A
  // repository-local insteadOf rule redirects that exact URL to this temporary
  // bare remote, so this test exercises the real origin gate and git commands
  // without globally mutating the developer's Git configuration.
  await git(target, "remote", "set-url", "origin", PUBLIC_ORIGIN);
  await git(target, "config", `url.${pathToFileURL(remote).href}.insteadOf`, PUBLIC_ORIGIN);
  const reposRoot = path.join(root, "repos-root");
  await fs.promises.mkdir(reposRoot, { recursive: true });
  await fs.promises.writeFile(
    path.join(target, ".env"),
    [
      "DISCORD_BOT_TOKEN=token",
      "DISCORD_ALLOWED_USER_IDS=12345",
      "DISCORD_GUILD_ID=12345",
      "DISCORD_PARENT_CHANNEL_ID=12345",
      `REPOS_ROOT=${reposRoot}`,
      "DEFAULT_REPO=",
      "DEV_GUILD_ID=",
      "DEFAULT_MODEL=claude-sonnet-5",
      "DEFAULT_CONTEXT_TIER=default",
      "",
    ].join("\n")
  );
  return target;
}

async function advanceRemote(label: string): Promise<string> {
  serial++;
  await fs.promises.writeFile(path.join(source, `remote-${serial}.txt`), `${label}\n`);
  await git(source, "add", "-A");
  await git(source, "commit", "-q", "-m", label);
  await git(source, "push", "-q", "origin", "main");
  return (await git(source, "rev-parse", "HEAD")).stdout.trim();
}

async function advanceToVersion(version: string, options: { changelog?: string } = {}): Promise<string> {
  serial++;
  await fs.promises.mkdir(path.join(source, "scripts"), { recursive: true });
  await fs.promises.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "discord-copilot-sdk", version }));
  if (options.changelog !== undefined) {
    await fs.promises.writeFile(path.join(source, "CHANGELOG.md"), options.changelog);
  }
  await fs.promises.writeFile(path.join(source, "scripts", "setup.mjs"), "process.exit(0);\n");
  await fs.promises.writeFile(
    path.join(source, "run-bot.ps1"),
    [
      "$ErrorActionPreference = 'Stop'",
      "$target = Join-Path $PSScriptRoot 'dist\\index.js'",
      "Start-Process -FilePath node -ArgumentList $target | Out-Null",
      "",
    ].join("\r\n")
  );
  await fs.promises.writeFile(
    path.join(source, "run-bot.sh"),
    ["#!/usr/bin/env bash", "set -eu", 'node "$PWD/dist/index.js" >/dev/null 2>&1 &', ""].join("\n")
  );
  await git(source, "add", "-A");
  await git(source, "commit", "-q", "-m", `release ${version}`);
  await git(source, "push", "-q", "origin", "main");
  return (await git(source, "rev-parse", "HEAD")).stdout.trim();
}

async function waitForLock(home: string, instance: string): Promise<number> {
  const lock = path.join(home, ".discord-copilot-sdk", `${instance}.lock`);
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const pid = Number((await fs.promises.readFile(lock, "utf8")).trim());
      if (Number.isInteger(pid) && pid > 1) return pid;
    } catch {
      // The bot writes its lock after Node has started.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${instance} to write its lock`);
}

async function runUpdate(
  target: string,
  args: string[] = [],
  beforeRun?: (home: string) => Promise<void>,
  envOverrides: NodeJS.ProcessEnv = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = path.join(root, `home-${serial}`);
  const childPath = envOverrides.PATH ?? `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  await fs.promises.mkdir(home, { recursive: true });
  await beforeRun?.(home);
  try {
    const { stdout, stderr } = await exec(process.execPath, [ENGINE, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        DISCORD_COPILOT_SDK_UPDATE_ROOT: target,
        DISCORD_COPILOT_SDK_INSTANCE_ID: `${instancePrefix}-${serial}`,
        DISCORD_COPILOT_SDK_REF: "main",
        HOME: home,
        USERPROFILE: home,
        PATH: childPath,
        Path: childPath,
        ...envOverrides,
      },
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
    return {
      code: typeof failure["code"] === "number" ? failure["code"] : 1,
      stdout: typeof failure["stdout"] === "string" ? failure["stdout"] : "",
      stderr: typeof failure["stderr"] === "string" ? failure["stderr"] : "",
    };
  }
}

function realGitPath(): string {
  const locator = process.platform === "win32" ? "where" : "which";
  const output = execFileSync(locator, ["git"], { encoding: "utf8" });
  const executable = output.split(/\r?\n/).find((entry) => entry.trim() !== "");
  if (!executable) throw new Error("could not locate real git");
  return executable.trim();
}

async function createFetchBarrier(binDir: string, record: string): Promise<string> {
  const shim = path.join(binDir, "git-fetch-barrier.cjs");
  await fs.promises.mkdir(binDir, { recursive: true });
  await fs.promises.writeFile(
    shim,
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const { spawnSync } = require("node:child_process");',
      'if (path.basename(process.execPath).toLowerCase() === "git.exe") {',
      "  const args = process.argv.slice(1);",
      "  args[0] = path.basename(args[0]);",
      '  if (args[0] === "fetch") {',
      '    fs.writeFileSync(process.env.DCS_FETCH_BARRIER_RECORD, JSON.stringify(args));',
      '    const pushed = spawnSync(process.env.DCS_FETCH_BARRIER_GIT, ["-C", process.env.DCS_FETCH_BARRIER_SOURCE, "push", "-q", "origin", "main"], { stdio: "inherit" });',
      '    if (pushed.status !== 0) process.exit(pushed.status ?? 1);',
      "  }",
      '  const result = spawnSync(process.env.DCS_FETCH_BARRIER_GIT, args, { stdio: "inherit" });',
      "  process.exit(result.status ?? 1);",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  if (process.platform === "win32") {
    const wrapper = path.join(binDir, "git.exe");
    try {
      await fs.promises.link(process.execPath, wrapper);
    } catch {
      await fs.promises.copyFile(process.execPath, wrapper);
    }
  } else {
    const wrapper = path.join(binDir, "git");
    await fs.promises.writeFile(wrapper, `#!/usr/bin/env sh\nexec "${process.execPath}" "${shim}" "$@"\n`, "utf8");
    await fs.promises.chmod(wrapper, 0o755);
  }
  return shim;
}

function expectInOrder(output: string, ...parts: string[]) {
  let previous = -1;
  for (const part of parts) {
    const index = output.indexOf(part);
    expect(index, `missing output fragment: ${part}\n${output}`).toBeGreaterThanOrEqual(0);
    expect(index, `out-of-order output fragment: ${part}\n${output}`).toBeGreaterThan(previous);
    previous = index;
  }
}

function expectedUpdateCommand(target: string, instance: string, args: string[]): string {
  if (process.platform === "win32") {
    return `$env:DISCORD_COPILOT_SDK_INSTANCE_ID = '${instance}'; & '${path.join(target, "update.ps1").replace(/'/g, "''")}'${args
      .map((arg) => (arg.startsWith("refs/") ? ` -Ref '${arg}'` : arg === "all" ? " -AllInstances" : " -Restore"))
      .join("")}`;
  }
  return `DISCORD_COPILOT_SDK_INSTANCE_ID=${instance} bash "${path.join(target, "update.sh")}"${args
    .map((arg) => (arg.startsWith("refs/") ? ` --ref '${arg}'` : arg === "all" ? " --all-instances" : " --restore"))
    .join("")}`;
}

function expectedApplyCommand(target: string, instance: string, ref = "main", allInstances = false): string {
  return expectedUpdateCommand(target, instance, [...(ref === "main" ? [] : [ref]), ...(allInstances ? ["all"] : [])]);
}

function expectedRestoreCommand(target: string, instance: string): string {
  return expectedUpdateCommand(target, instance, ["restore"]);
}

beforeAll(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dcs-update-git-"));
  source = path.join(root, "source");
  remote = path.join(root, "remote.git");
  bin = path.join(root, "bin");
  await fs.promises.mkdir(bin);
  if (process.platform === "win32") {
    await fs.promises.writeFile(path.join(bin, "copilot.cmd"), "@echo off\r\nexit /b 0\r\n");
  } else {
    const copilot = path.join(bin, "copilot");
    await fs.promises.writeFile(copilot, "#!/usr/bin/env sh\nexit 0\n");
    await fs.promises.chmod(copilot, 0o755);
  }
  await git(root, "init", "-q", "-b", "main", source);
  await git(source, "config", "user.email", "update@test.invalid");
  await git(source, "config", "user.name", "update test");
  await git(source, "config", "commit.gpgsign", "false");
  await fs.promises.mkdir(path.join(source, "scripts", "lib"), { recursive: true });
  await fs.promises.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "discord-copilot-sdk" }));
  await fs.promises.writeFile(path.join(source, ".gitignore"), ".env\ndist/\n");
  await fs.promises.copyFile(path.join(ROOT, "scripts", "lib", "validate.mjs"), path.join(source, "scripts", "lib", "validate.mjs"));
  await fs.promises.copyFile(path.join(ROOT, "stop-bot.ps1"), path.join(source, "stop-bot.ps1"));
  await fs.promises.copyFile(path.join(ROOT, "stop-bot.sh"), path.join(source, "stop-bot.sh"));
  await fs.promises.writeFile(path.join(source, "README.md"), "initial\n");
  await git(source, "add", "-A");
  await git(source, "commit", "-q", "-m", "initial");
  await git(root, "init", "-q", "--bare", remote);
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "-q", "-u", "origin", "main");
});

afterAll(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe("git update data paths", { timeout: 60_000 }, () => {
  it("refuses a dirty named branch before moving it to a newer remote commit", async () => {
    const local = await cloneTarget("dirty");
    const before = (await git(local, "rev-parse", "HEAD")).stdout.trim();
    const remoteSha = await advanceRemote("dirty remote advance");
    await fs.promises.writeFile(path.join(local, "local-only.txt"), "do not overwrite\n");

    expect((await runUpdate(local)).code).toBe(1);
    expect(before).not.toBe(remoteSha);
    expect((await git(local, "rev-parse", "HEAD")).stdout.trim()).toBe(before);
  });

  it("fast-forwards a clean named branch through the real updater", async () => {
    const local = await cloneTarget("fast-forward");
    const expected = await advanceRemote("fast forward");

    // The fixture deliberately omits setup.mjs. The updater therefore fails
    // AFTER its git apply phase, which proves the engine's fetch/merge path
    // without installing packages or touching the real bot state.
    const result = await runUpdate(local);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(1);
    expect((await git(local, "rev-parse", "HEAD")).stdout.trim(), `${result.stdout}${result.stderr}`).toBe(expected);
  });

  it("moves a bootstrap-managed detached checkout to FETCH_HEAD through the engine", async () => {
    const local = await cloneTarget("managed");
    await git(local, "checkout", "-q", "--detach");
    const expected = await advanceRemote("managed update");

    const result = await runUpdate(local);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(1);
    expect((await git(local, "rev-parse", "HEAD")).stdout.trim(), `${result.stdout}${result.stderr}`).toBe(expected);
    await expect(git(local, "symbolic-ref", "--quiet", "HEAD")).rejects.toBeDefined();
  });

  it("compares an annotated release tag with its peeled commit, not tag object", async () => {
    const tag = "v9.9.9-integration";
    await git(source, "tag", "-a", tag, "-m", "annotated release");
    await git(source, "push", "-q", "origin", tag);
    const output = (await git(source, "ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`)).stdout;
    const resolved = resolveRemoteSha(parseLsRemote(output), tag);

    expect(resolved?.ref).toBe(`refs/tags/${tag}^{}`);
    expect(resolved?.sha).toBe((await git(source, "rev-parse", "HEAD")).stdout.trim());
  });

  it("never displays an annotated tag's peeled-ref syntax in update status", async () => {
    const tag = "v9.9.10-display";
    await git(source, "tag", "-a", tag, "-m", "annotated display release");
    await git(source, "push", "-q", "origin", tag);
    const local = await cloneTarget("annotated-tag-display");

    const result = await runUpdate(local, ["--check", "--ref", `refs/tags/${tag}`, "--lang", "en"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`refs/tags/${tag} -> refs/tags/${tag} @`);
    expect(result.stdout).not.toContain(`refs/tags/${tag}^{}`);
  });

  it("refuses to restore a state recorded for a different checkout", async () => {
    const local = await cloneTarget("restore-root");
    const otherRoot = path.join(root, "other-checkout");

    const result = await runUpdate(local, ["--restore", "--lang", "en"], async (home) => {
      const stateDir = path.join(home, ".discord-copilot-sdk");
      await fs.promises.mkdir(stateDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(stateDir, `update-state.${instancePrefix}-${serial}.json`),
        JSON.stringify({
          version: 1,
          repoRoot: otherRoot,
          oldSha: "1111111111111111111111111111111111111111",
          createdAt: "2026-01-01T00:00:00.000Z",
          instances: [],
        })
      );
    });

    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(`belongs to ${otherRoot}`);
  });

  it("restores matching state while leaving another checkout's state untouched", async () => {
    const local = await cloneTarget("restore-own-state");
    const otherRoot = path.join(root, "other-checkout");
    const instance = `${instancePrefix}-${serial}`;
    const home = path.join(root, `home-${serial}`);

    const result = await runUpdate(local, ["--restore", "--lang", "en"], async (stateHome) => {
      const stateDir = path.join(stateHome, ".discord-copilot-sdk");
      await fs.promises.mkdir(stateDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(stateDir, "update-state.aaa-foreign.json"),
        JSON.stringify({ version: 1, repoRoot: otherRoot, oldSha: "1111111111111111111111111111111111111111", instances: [] })
      );
      await fs.promises.writeFile(
        path.join(stateDir, `update-state.${instance}.json`),
        JSON.stringify({ version: 1, repoRoot: local, oldSha: "2222222222222222222222222222222222222222", instances: [] })
      );
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Skipping saved state for aaa-foreign; it belongs to root ${otherRoot}.`);
    expect(result.stdout).toContain(`Restoring saved state for ${instance}: root ${local}`);
    expect(fs.existsSync(path.join(home, ".discord-copilot-sdk", "update-state.aaa-foreign.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".discord-copilot-sdk", `update-state.${instance}.json`))).toBe(false);
  });

  it("identifies the saved checkout and source before restoring it", async () => {
    const local = await cloneTarget("restore-summary");
    const instance = `${instancePrefix}-${serial}`;
    const oldSha = "1111111111111111111111111111111111111111";
    const createdAt = "2026-01-01T00:00:00.000Z";

    const result = await runUpdate(local, ["--restore", "--lang", "en"], async (home) => {
      const stateDir = path.join(home, ".discord-copilot-sdk");
      await fs.promises.mkdir(stateDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(stateDir, `update-state.${instance}.json`),
        JSON.stringify({ version: 1, repoRoot: local, oldSha, createdAt, instances: [] })
      );
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Restoring saved state for ${instance}: root ${local}, source ${oldSha.slice(0, 12)}, created ${createdAt}.`);
    expect(result.stdout).toContain("Restored the pre-update running state.");
  });

  it("prints restore status before a matching restore fails and never emits a success-shaped line", async () => {
    const local = await cloneTarget("restore-failure-status");
    const instance = `${instancePrefix}-${serial}`;
    const oldSha = "1111111111111111111111111111111111111111";
    const createdAt = "2026-01-02T03:04:05.000Z";
    await fs.promises.writeFile(path.join(local, "package.json"), JSON.stringify({ name: "discord-copilot-sdk", version: "0.8.0" }));

    const result = await runUpdate(local, ["--restore", "--lang", "en"], async (home) => {
      const stateDir = path.join(home, ".discord-copilot-sdk");
      await fs.promises.mkdir(stateDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(stateDir, `update-state.${instance}.json`),
        JSON.stringify({
          version: 1,
          repoRoot: local,
          oldSha,
          createdAt,
          instances: [{ instance, wasRunning: true, residency: { registered: false, enabled: false, known: false } }],
        })
      );
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("\nRestore status\n");
    expect(result.stdout).toContain("Saved instance");
    expect(result.stdout).toContain(instance);
    expect(result.stdout).toContain(oldSha.slice(0, 12));
    expect(result.stdout).toContain(createdAt);
    expect(result.stdout).toContain("Current version");
    expect(result.stdout).not.toContain("Restored the pre-update running state.");
    expect(result.stderr.toLowerCase()).toContain("run-bot");
  });

  it("reports already-up-to-date status with the installed version and skips fetch", async () => {
    await advanceToVersion("0.1.0");
    const local = await cloneTarget("up-to-date");
    const fetchHead = path.join(local, ".git", "FETCH_HEAD");

    const result = await runUpdate(local, ["--check", "--lang", "en"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("discord-copilot-sdk 0.1.0 (");
    expect(result.stdout).toContain(`root ${local}`);
    expect(result.stdout).toContain("checkout branch-clean (main)");
    expect(result.stdout).toContain("requested main -> refs/heads/main @");
    expect(result.stdout).toContain("\nUpdate status\n");
    expect(result.stdout).toContain("Current version");
    expect(result.stdout).toContain("Repository root");
    expect(result.stdout).toContain("Requested ref");
    expect(result.stdout).toContain("Already up to date: 0.1.0 (");
    expectInOrder(result.stdout, "Update status", "Already up to date: 0.1.0 (");
    expect(fs.existsSync(fetchHead)).toBe(false);
  });

  it("reports the current and target versions when --check finds an update", async () => {
    await advanceToVersion("0.2.0");
    const local = await cloneTarget("update-available");
    const localSha = (await git(local, "rev-parse", "HEAD")).stdout.trim();
    const remoteSha = await advanceToVersion("0.3.0");

    const result = await runUpdate(local, ["--check", "--lang", "en"]);

    expect(result.code, `${result.stdout}${result.stderr}`).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("\nUpdate status\n");
    expect(result.stdout).toContain("Current version");
    expect(result.stdout).toContain("Instance");
    expect(result.stdout).toContain(`Update available: 0.2.0 (${localSha.slice(0, 12)}) -> 0.3.0 (${remoteSha.slice(0, 12)}).`);
    expect(result.stdout).toContain(`Apply it with: ${expectedApplyCommand(local, `${instancePrefix}-${serial}`)}`);
    expectInOrder(result.stdout, "Update status", `Update available: 0.2.0 (${localSha.slice(0, 12)}) -> 0.3.0 (${remoteSha.slice(0, 12)}).`);
    expect(fs.existsSync(path.join(local, ".git", "FETCH_HEAD"))).toBe(true);
  });

  it("preserves a non-main ref and all-instance scope in the wrapper apply hint", async () => {
    await advanceToVersion("3.5.0");
    const local = await cloneTarget("wrapper-apply-flags");
    await advanceToVersion("3.6.0");
    const instance = `${instancePrefix}-${serial}`;

    const result = await runUpdate(local, ["--check", "--ref", "refs/heads/main", "--all-instances", "--lang", "en"]);

    expect(result.code, result.stderr).toBe(2);
    expect(result.stdout).toContain(`Apply it with: ${expectedApplyCommand(local, instance, "refs/heads/main", true)}`);
  });

  it("pins a remote move at the controlled fetch barrier before state or downtime", async () => {
    await advanceToVersion("3.0.0");
    const local = await cloneTarget("fetch-mismatch");
    const before = (await git(local, "rev-parse", "HEAD")).stdout.trim();
    const resolvedSha = await advanceToVersion("3.1.0");
    await fs.promises.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "discord-copilot-sdk", version: "3.2.0" }));
    await git(source, "add", "package.json");
    await git(source, "commit", "-q", "-m", "move main during fetch");
    const movedSha = (await git(source, "rev-parse", "HEAD")).stdout.trim();
    const barrierBin = path.join(root, `fetch-barrier-${serial}`);
    const fetchRecord = path.join(barrierBin, "fetch-args.json");
    const shim = await createFetchBarrier(barrierBin, fetchRecord);

    const result = await runUpdate(local, ["--yes", "--no-restart", "--lang", "en"], undefined, {
      PATH: `${barrierBin}${path.delimiter}${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      DCS_FETCH_BARRIER_GIT: realGitPath(),
      DCS_FETCH_BARRIER_RECORD: fetchRecord,
      DCS_FETCH_BARRIER_SOURCE: source,
      NODE_OPTIONS: `--require=${shim}${process.env.NODE_OPTIONS ? ` ${process.env.NODE_OPTIONS}` : ""}`,
    });
    expect(fs.existsSync(fetchRecord), `${result.stdout}${result.stderr}`).toBe(true);
    const fetchArgs = JSON.parse(await fs.promises.readFile(fetchRecord, "utf8")) as string[];
    const home = path.join(root, `home-${serial}`);

    expect(fetchArgs).toContain("fetch");
    expect(fetchArgs.some((arg) => /^\+?refs\/heads\/main:refs\/dcs-update\/[0-9a-f-]+$/i.test(arg))).toBe(true);
    expect(fs.readFileSync(ENGINE, "utf8")).not.toContain("FETCH_HEAD");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`fetched revision ${movedSha} does not match resolved remote revision ${resolvedSha}`);
    expect((await git(local, "rev-parse", "HEAD")).stdout.trim()).toBe(before);
    expect(result.stdout).not.toContain("[1/4] Stop");
    expect(fs.existsSync(path.join(home, ".discord-copilot-sdk"))).toBe(false);
    expect((await git(local, "for-each-ref", "--format=%(refname)", "refs/dcs-update")).stdout.trim()).toBe("");
  });

  it("displays target metadata from the fetched SHA instead of another fetched object", async () => {
    await advanceToVersion("3.3.0");
    const local = await cloneTarget("pinned-fetched-metadata");
    const pinnedSha = await advanceToVersion("3.4.0");

    const result = await runUpdate(local, ["--check", "--lang", "en"]);

    expect(result.code, result.stderr).toBe(2);
    expect(result.stdout).toContain(`Update available: 3.3.0 (`);
    expect(result.stdout).toContain(`-> 3.4.0 (${pinnedSha.slice(0, 12)}).`);
  });

  it("shows fetched target notes from FETCH_HEAD instead of the stale local changelog during --check", async () => {
    await advanceToVersion(
      "0.8.0",
      {
        changelog: ["# Changelog", "", "## [0.8.0] - 2026-01-01", "", "- stale local note", ""].join("\n"),
      }
    );
    const local = await cloneTarget("check-fetched-target-notes");
    const localSha = (await git(local, "rev-parse", "HEAD")).stdout.trim();
    const remoteSha = await advanceToVersion(
      "0.9.0",
      {
        changelog: ["# Changelog", "", "## [0.9.0] - 2026-02-02", "", "- fetched target note", ""].join("\n"),
      }
    );

    const result = await runUpdate(local, ["--check", "--lang", "en"]);
    const compareUrl = `https://github.com/lettucebo/discord-copilot-sdk/compare/${localSha}...${remoteSha}`;

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Target release notes for 0.9.0:");
    expect(result.stdout).toContain("- fetched target note");
    expect(result.stdout).not.toContain("- stale local note");
    expect(result.stdout).toContain(compareUrl);
    expect(result.stdout).not.toContain("/releases/tag/0.9.0");
    expectInOrder(
      result.stdout,
      `Update available: 0.8.0 (${localSha.slice(0, 12)}) -> 0.9.0 (${remoteSha.slice(0, 12)}).`,
      "Target release notes for 0.9.0:",
      compareUrl,
      `Apply it with: ${expectedApplyCommand(local, `${instancePrefix}-${serial}`)}`
    );
  });

  it("bounds fetched target notes, reports omitted lines, and strips terminal controls during --check", async () => {
    await advanceToVersion("2.0.0");
    const local = await cloneTarget("check-bounded-target-notes");
    const localSha = (await git(local, "rev-parse", "HEAD")).stdout.trim();
    const remoteSha = await advanceToVersion(
      "2.1.0",
      {
        changelog: [
          "# Changelog",
          "",
          "## [2.1.0] - 2026-04-04",
          "",
          "\u001b[31m- fetched target line\u001b[0m",
          "\u0007- control-prefixed line",
          `- ${"x".repeat(200)}`,
          ...Array.from({ length: 15 }, (_, index) => `- later line ${index + 1}`),
          "",
        ].join("\n"),
      }
    );

    const result = await runUpdate(local, ["--check", "--lang", "en"]);
    const compareUrl = `https://github.com/lettucebo/discord-copilot-sdk/compare/${localSha}...${remoteSha}`;

    expect(result.code, result.stderr).toBe(2);
    expect(result.stdout).toContain("Target release notes for 2.1.0:");
    expect(result.stdout).toContain("- fetched target line");
    expect(result.stdout).toContain("- control-prefixed line");
    expect(result.stdout).toContain("... 2 more non-empty line(s) omitted.");
    expect(result.stdout).toContain(compareUrl);
    expect(result.stdout).toContain("…");
    expect(result.stdout).toContain("- later line 13");
    expect(result.stdout).not.toContain("- later line 14");
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).not.toContain("\u0007");
  });


  it("keeps --dry-run read-only while showing the dry-run plan and its limits", async () => {
    const local = await cloneTarget("dry-run");
    await advanceToVersion("0.7.0");
    const before = (await git(local, "rev-parse", "HEAD")).stdout.trim();
    const envBefore = await fs.promises.readFile(path.join(local, ".env"), "utf8");
    const fetchHead = path.join(local, ".git", "FETCH_HEAD");
    const home = path.join(root, `home-${serial}`);
    if (fs.existsSync(fetchHead)) await fs.promises.rm(fetchHead, { force: true });

    const result = await runUpdate(local, ["--dry-run", "--lang", "en"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("\nUpdate status\n");
    expect(result.stdout).toContain("\nDry-run plan\n");
    expect(result.stdout).toContain("Would fetch");
    expect(result.stdout).toContain("Would stop the selected residency/bot processes, move HEAD, run setup, then restore the prior running state.");
    expect(result.stdout).toContain("Target version and release notes will be discovered only during a real update fetch.");
    expect((await git(local, "rev-parse", "HEAD")).stdout.trim()).toBe(before);
    expect(await fs.promises.readFile(path.join(local, ".env"), "utf8")).toBe(envBefore);
    expect(fs.existsSync(fetchHead)).toBe(false);
    expect(fs.existsSync(path.join(home, ".discord-copilot-sdk"))).toBe(false);
  });

  it("does not fail a check when the target changelog has no matching release section", async () => {
    await advanceToVersion("0.4.0");
    const local = await cloneTarget("check-without-target-notes");
    const localSha = (await git(local, "rev-parse", "HEAD")).stdout.trim();
    await advanceToVersion(
      "0.4.1",
      {
        changelog: ["# Changelog", "", "## [0.4.0] - 2026-01-01", "", "- previous release", ""].join("\n"),
      }
    );
    const remoteSha = (await git(source, "rev-parse", "HEAD")).stdout.trim();

    const result = await runUpdate(local, ["--check", "--lang", "en"]);

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Update available: 0.4.0 (");
    expect(result.stdout).not.toContain("Target release notes for 0.4.1:");
    expect(result.stdout).toContain(`https://github.com/lettucebo/discord-copilot-sdk/compare/${localSha}...${remoteSha}`);
  });

  it("falls back to an unknown target version when fetched metadata is not trustworthy", async () => {
    await advanceToVersion("0.4.2");
    const local = await cloneTarget("check-unknown-target-version");
    const localSha = (await git(local, "rev-parse", "HEAD")).stdout.trim();
    await fs.promises.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "discord-copilot-sdk", version: "not-semver" }));
    await git(source, "add", "package.json");
    await git(source, "commit", "-q", "-m", "break package metadata");
    await git(source, "push", "-q", "origin", "main");
    const brokenSha = (await git(source, "rev-parse", "HEAD")).stdout.trim();

    const result = await runUpdate(local, ["--check", "--lang", "en"]);

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Update available: 0.4.2 (${localSha.slice(0, 12)}) -> unknown (${brokenSha.slice(0, 12)}).`);
    expect(result.stdout).not.toContain(`Update available: 0.4.2 (${localSha.slice(0, 12)}) -> 0.4.2 (${brokenSha.slice(0, 12)}).`);
  });

  it("warns when a current source still has a failed update awaiting restore", async () => {
    const local = await cloneTarget("pending-restore");

    const result = await runUpdate(local, ["--check", "--lang", "en"], async (home) => {
      const stateDir = path.join(home, ".discord-copilot-sdk");
      await fs.promises.mkdir(stateDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(stateDir, `update-state.${instancePrefix}-${serial}.json`),
        JSON.stringify({
          version: 1,
          repoRoot: local,
          oldSha: "1111111111111111111111111111111111111111",
          createdAt: "2026-01-01T00:00:00.000Z",
          instances: [],
        })
      );
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Already up to date:");
    expect(result.stdout).toContain(
      `Warning: a previous update left a recovery record; run ${expectedRestoreCommand(local, `${instancePrefix}-${serial}`)}.`
    );
  });

  it("makes a pending restore record actionable when --check finds an update", async () => {
    await advanceToVersion("4.0.0");
    const local = await cloneTarget("pending-restore-check-available");
    await advanceToVersion("4.1.0");

    const result = await runUpdate(local, ["--check", "--lang", "en"], async (home) => {
      const stateDir = path.join(home, ".discord-copilot-sdk");
      await fs.promises.mkdir(stateDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(stateDir, `update-state.${instancePrefix}-${serial}.json`),
        JSON.stringify({ version: 1, repoRoot: local, oldSha: "1".repeat(40), instances: [] })
      );
    });

    expect(result.code, result.stderr).toBe(2);
    expect(result.stdout).toContain("Update available: 4.0.0 (");
    expect(result.stdout).toContain(
      `Warning: a previous update left a recovery record; run ${expectedRestoreCommand(local, `${instancePrefix}-${serial}`)}.`
    );
    expect(result.stdout).not.toContain("Apply it with:");
  });

  it("makes a pending restore record actionable during a read-only dry run", async () => {
    const local = await cloneTarget("pending-restore-dry-run");
    await advanceToVersion("4.2.0");
    const fetchHead = path.join(local, ".git", "FETCH_HEAD");
    if (fs.existsSync(fetchHead)) await fs.promises.rm(fetchHead, { force: true });

    const result = await runUpdate(local, ["--dry-run", "--lang", "en"], async (home) => {
      const stateDir = path.join(home, ".discord-copilot-sdk");
      await fs.promises.mkdir(stateDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(stateDir, `update-state.${instancePrefix}-${serial}.json`),
        JSON.stringify({ version: 1, repoRoot: local, oldSha: "2".repeat(40), instances: [] })
      );
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("\nDry-run plan\n");
    expect(result.stdout).toContain(
      `Warning: a previous update left a recovery record; run ${expectedRestoreCommand(local, `${instancePrefix}-${serial}`)}.`
    );
    expect(result.stdout).not.toContain("Apply it with:");
    expect(fs.existsSync(fetchHead)).toBe(false);
  });

  it("does not warn a checkout about another checkout's pending restore state", async () => {
    const local = await cloneTarget("foreign-pending-restore");
    const otherRoot = path.join(root, "other-checkout");

    const result = await runUpdate(local, ["--check", "--lang", "en"], async (home) => {
      const stateDir = path.join(home, ".discord-copilot-sdk");
      await fs.promises.mkdir(stateDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(stateDir, `update-state.${instancePrefix}-${serial}.json`),
        JSON.stringify({ version: 1, repoRoot: otherRoot, oldSha: "1111111111111111111111111111111111111111", instances: [] })
      );
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Already up to date:");
    expect(result.stdout).not.toContain("Warning: a failed update still awaits --restore");
  });

  it("refuses an apply that would overwrite another checkout's same-instance restore state", async () => {
    const local = await cloneTarget("foreign-apply-state");
    const expected = await advanceToVersion("0.5.0");
    const otherRoot = path.join(root, "other-checkout");
    const instance = `${instancePrefix}-${serial}`;
    const home = path.join(root, `home-${serial}`);
    const foreignState = JSON.stringify({
      version: 1,
      repoRoot: otherRoot,
      oldSha: "1111111111111111111111111111111111111111",
      instances: [],
    });
    const before = (await git(local, "rev-parse", "HEAD")).stdout.trim();

    const result = await runUpdate(local, ["--yes", "--lang", "en"], async (stateHome) => {
      const stateDir = path.join(stateHome, ".discord-copilot-sdk");
      await fs.promises.mkdir(stateDir, { recursive: true });
      await fs.promises.writeFile(path.join(stateDir, `update-state.${instance}.json`), foreignState);
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`pending restore state for ${instance} belongs to ${otherRoot}`);
    expect((await git(local, "rev-parse", "HEAD")).stdout.trim()).toBe(before);
    expect((await fs.promises.readFile(path.join(home, ".discord-copilot-sdk", `update-state.${instance}.json`), "utf8"))).toBe(
      foreignState
    );
    expect((await git(source, "rev-parse", "HEAD")).stdout.trim()).toBe(expected);
  });

  it("shows the fetched target notes between the update plan and the stop phase", async () => {
    await advanceToVersion("1.2.0");
    const local = await cloneTarget("apply-target-notes-placement");
    const localSha = (await git(local, "rev-parse", "HEAD")).stdout.trim();
    const remoteSha = await advanceToVersion(
      "1.3.0",
      {
        changelog: ["# Changelog", "", "## [1.3.0] - 2026-03-03", "", "- apply target note", ""].join("\n"),
      }
    );

    const result = await runUpdate(local, ["--yes", "--no-restart", "--lang", "en"]);
    const compareUrl = `https://github.com/lettucebo/discord-copilot-sdk/compare/${localSha}...${remoteSha}`;

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("\nUpdate plan\n");
    expect(result.stdout).toContain("Target release notes for 1.3.0:");
    expect(result.stdout).toContain("- apply target note");
    expect(result.stdout).toContain(compareUrl);
    expectInOrder(result.stdout, "Update plan", "Target release notes for 1.3.0:", compareUrl, "[1/4] Stop");
  });
  it("reports the version and source transition even when --no-restart is selected", async () => {
    const local = await cloneTarget("successful-no-restart");
    const beforeMetadata = JSON.parse(await fs.promises.readFile(path.join(local, "package.json"), "utf8")) as {
      version?: unknown;
    };
    const beforeVersion = typeof beforeMetadata.version === "string" ? beforeMetadata.version : "unknown";
    const expected = await advanceToVersion("0.2.0");

    const result = await runUpdate(local, ["--yes", "--no-restart", "--lang", "en"]);

    expect(result.code, result.stderr).toBe(0);
    expect((await git(local, "rev-parse", "HEAD")).stdout.trim()).toBe(expected);
    expect(result.stdout).toContain("\nUpdate plan\n");
    expect(result.stdout).toContain("Target version");
    expect(result.stdout).toContain("Target instances");
    expectInOrder(result.stdout, "Update plan", "[1/4] Stop");
    expect(result.stdout).toContain(`Source updated: ${beforeVersion} (`);
    expect(result.stdout).toContain(` -> 0.2.0 (${expected.slice(0, 12)}).`);
    expect(result.stdout).toContain(`${instancePrefix}-${serial} remains stopped because of --no-restart. Start manually:`);
    if (process.platform === "win32") {
      expect(result.stdout).toContain(`$env:DISCORD_COPILOT_SDK_INSTANCE_ID = '${instancePrefix}-${serial}'; & '`);
    } else {
      expect(result.stdout).toContain(`DISCORD_COPILOT_SDK_INSTANCE_ID=${instancePrefix}-${serial} bash "`);
    }
    expect(result.stdout).toContain("Update succeeded; --no-restart leaves it stopped.");
  });

  it("reports a structured incomplete update while leaving a failed apply stopped", async () => {
    await advanceToVersion("0.9.0");
    const local = await cloneTarget("failed-apply");
    const localSha = (await git(local, "rev-parse", "HEAD")).stdout.trim();
    await advanceToVersion("1.0.0");
    await fs.promises.writeFile(path.join(source, "scripts", "setup.mjs"), 'console.error("simulated setup failure"); process.exit(1);\n');
    await git(source, "add", "scripts/setup.mjs");
    await git(source, "commit", "-q", "-m", "break update setup");
    await git(source, "push", "-q", "origin", "main");
    const remoteSha = (await git(source, "rev-parse", "HEAD")).stdout.trim();
    let originalPid: number | undefined;

    try {
      const result = await runUpdate(local, ["--yes", "--lang", "en"], async (home) => {
        const instance = `${instancePrefix}-${serial}`;
        const dist = path.join(local, "dist");
        await fs.promises.mkdir(dist, { recursive: true });
        await fs.promises.writeFile(
          path.join(dist, "index.js"),
          [
            'const fs = require("node:fs");',
            'const path = require("node:path");',
            'const home = process.env.USERPROFILE || process.env.HOME;',
            'const instance = process.env.DISCORD_COPILOT_SDK_INSTANCE_ID;',
            'const state = path.join(home, ".discord-copilot-sdk");',
            "fs.mkdirSync(state, { recursive: true });",
            'const lock = path.join(state, `${instance}.lock`);',
            "fs.writeFileSync(lock, String(process.pid));",
            'const ready = path.join(state, "startup-ready");',
            "fs.mkdirSync(ready, { recursive: true });",
            'fs.writeFileSync(path.join(ready, `${instance}.ready.json`), JSON.stringify({ version: 1, pid: process.pid, instance }));',
            "setInterval(() => {}, 1_000);",
            "",
          ].join("\n")
        );
        const child = spawn(process.execPath, [path.join(dist, "index.js")], {
          env: {
            ...process.env,
            DISCORD_COPILOT_SDK_INSTANCE_ID: instance,
            HOME: home,
            USERPROFILE: home,
          },
          stdio: "ignore",
        });
        originalPid = child.pid;
        await waitForLock(home, instance);
      });

      const instance = `${instancePrefix}-${serial}`;
      const home = path.join(root, `home-${serial}`);
      const stateFile = path.join(home, ".discord-copilot-sdk", `update-state.${instance}.json`);
      const lock = path.join(home, ".discord-copilot-sdk", `${instance}.lock`);
      const ready = path.join(home, ".discord-copilot-sdk", "startup-ready", `${instance}.ready.json`);
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(result.code).toBe(1);
      expect(result.stdout).toContain("\nUpdate incomplete\n");
      expect(result.stdout).toContain(`0.9.0 (${localSha.slice(0, 12)})`);
      expect(result.stdout).toContain(`1.0.0 (${remoteSha.slice(0, 12)})`);
      expect(result.stdout).toContain(instance);
      expect(result.stdout).toContain("Update finalization");
      expect(result.stdout).toContain("did not complete");
      expect(result.stdout).toContain(expectedRestoreCommand(local, instance));
      expect(result.stdout).not.toContain("Restored the pre-update running state.");
      expect(result.stdout).not.toContain("Update complete");
      expect(result.stderr).toContain("simulated setup failure");
      expect(fs.existsSync(stateFile)).toBe(true);
      expect(() => process.kill(originalPid as number, 0)).toThrow();
      if (fs.existsSync(lock)) {
        expect((await fs.promises.readFile(lock, "utf8")).trim()).toBe(String(originalPid));
      }
      if (fs.existsSync(ready)) {
        expect(await fs.promises.readFile(ready, "utf8")).toContain(`"pid":${originalPid}`);
      }
    } finally {
      if (originalPid) {
        try {
          process.kill(originalPid);
        } catch {
          // The updater should already have stopped the original process.
        }
      }
    }
  });

  it("reports structured restore guidance when setup succeeds but restore fails", async () => {
    await advanceToVersion("1.0.1");
    const local = await cloneTarget("restore-phase-failure");
    const localSha = (await git(local, "rev-parse", "HEAD")).stdout.trim();
    await advanceToVersion("1.1.0");
    await fs.promises.writeFile(path.join(source, "scripts", "setup.mjs"), "process.exit(0);\n");
    await fs.promises.writeFile(
      path.join(source, "run-bot.ps1"),
      ["Write-Error 'simulated restore failure'", "exit 1", ""].join("\r\n")
    );
    await fs.promises.writeFile(
      path.join(source, "run-bot.sh"),
      ["#!/usr/bin/env bash", "echo 'simulated restore failure' >&2", "exit 1", ""].join("\n")
    );
    await git(source, "add", "scripts/setup.mjs", "run-bot.ps1", "run-bot.sh");
    await git(source, "commit", "-q", "-m", "break restore startup");
    await git(source, "push", "-q", "origin", "main");
    const remoteSha = (await git(source, "rev-parse", "HEAD")).stdout.trim();
    let originalPid: number | undefined;

    try {
      const result = await runUpdate(local, ["--yes", "--lang", "en"], async (home) => {
        const instance = `${instancePrefix}-${serial}`;
        const dist = path.join(local, "dist");
        await fs.promises.mkdir(dist, { recursive: true });
        await fs.promises.writeFile(
          path.join(dist, "index.js"),
          [
            'const fs = require("node:fs");',
            'const path = require("node:path");',
            'const home = process.env.USERPROFILE || process.env.HOME;',
            'const instance = process.env.DISCORD_COPILOT_SDK_INSTANCE_ID;',
            'const state = path.join(home, ".discord-copilot-sdk");',
            "fs.mkdirSync(state, { recursive: true });",
            'const lock = path.join(state, `${instance}.lock`);',
            "fs.writeFileSync(lock, String(process.pid));",
            'const ready = path.join(state, "startup-ready");',
            "fs.mkdirSync(ready, { recursive: true });",
            'fs.writeFileSync(path.join(ready, `${instance}.ready.json`), JSON.stringify({ version: 1, pid: process.pid, instance }));',
            "setInterval(() => {}, 1_000);",
            "",
          ].join("\n")
        );
        const child = spawn(process.execPath, [path.join(dist, "index.js")], {
          env: {
            ...process.env,
            DISCORD_COPILOT_SDK_INSTANCE_ID: instance,
            HOME: home,
            USERPROFILE: home,
          },
          stdio: "ignore",
        });
        originalPid = child.pid;
        await waitForLock(home, instance);
      });

      const instance = `${instancePrefix}-${serial}`;
      const home = path.join(root, `home-${serial}`);
      const stateFile = path.join(home, ".discord-copilot-sdk", `update-state.${instance}.json`);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain("[4/4] Restore running state");
      expect(result.stdout).toContain("\nUpdate incomplete\n");
      expect(result.stdout).toContain(`1.0.1 (${localSha.slice(0, 12)})`);
      expect(result.stdout).toContain(`1.1.0 (${remoteSha.slice(0, 12)})`);
      expect(result.stdout).toContain(instance);
      expect(result.stdout).toContain("Update finalization");
      expect(result.stdout).toContain("did not complete");
      expect(result.stdout).toContain("Recovery command");
      expect(result.stdout).toContain(expectedRestoreCommand(local, instance));
      expect(result.stdout).not.toContain("Restored the pre-update running state.");
      expect(result.stdout).not.toContain("Update complete");
      expect(result.stdout).not.toContain("Update succeeded; --no-restart leaves it stopped.");
      expect(result.stderr).toContain("simulated restore failure");
      expect(fs.existsSync(stateFile)).toBe(true);
      expect(() => process.kill(originalPid as number, 0)).toThrow();
    } finally {
      if (originalPid) {
        try {
          process.kill(originalPid);
        } catch {
          // The updater should already have stopped the original process.
        }
      }
    }
  });

  it("shows an unknown target version in the apply plan when fetched metadata cannot be parsed", async () => {
    await advanceToVersion("0.6.0");
    const local = await cloneTarget("apply-unknown-target-version");
    const localSha = (await git(local, "rev-parse", "HEAD")).stdout.trim();
    await fs.promises.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "discord-copilot-sdk", version: "invalid-version" }));
    await fs.promises.writeFile(path.join(source, "scripts", "setup.mjs"), "process.exit(0);\n");
    await git(source, "add", "package.json", "scripts/setup.mjs");
    await git(source, "commit", "-q", "-m", "break target package metadata");
    await git(source, "push", "-q", "origin", "main");
    const remoteSha = (await git(source, "rev-parse", "HEAD")).stdout.trim();

    const result = await runUpdate(local, ["--yes", "--no-restart", "--lang", "en"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("\nUpdate plan\n");
    expect(result.stdout).toContain(`0.6.0 (${localSha.slice(0, 12)})`);
    expect(result.stdout).toContain(`unknown (${remoteSha.slice(0, 12)})`);
    expectInOrder(result.stdout, "Update plan", "Target version", `unknown (${remoteSha.slice(0, 12)})`, "[1/4] Stop");
  });

  it("states that a bot stopped before the update remains stopped", async () => {
    const local = await cloneTarget("already-stopped");
    await advanceToVersion("0.4.0");

    const result = await runUpdate(local, ["--yes", "--lang", "en"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("[4/4] Restore running state");
    expect(result.stdout).toContain(`${instancePrefix}-${serial} was not running before the update; leaving it stopped.`);
  });

  it("reports stop and verified restart phases for a bot that was running before the update", async () => {
    const local = await cloneTarget("lifecycle");
    const expected = await advanceToVersion("0.3.0");
    let originalPid: number | undefined;
    let restartedPid: number | undefined;

    try {
      const result = await runUpdate(local, ["--yes", "--lang", "en"], async (home) => {
        const instance = `${instancePrefix}-${serial}`;
        const dist = path.join(local, "dist");
        await fs.promises.mkdir(dist, { recursive: true });
        await fs.promises.writeFile(
          path.join(dist, "index.js"),
          [
            'const fs = require("node:fs");',
            'const path = require("node:path");',
            'const home = process.env.USERPROFILE || process.env.HOME;',
            'const instance = process.env.DISCORD_COPILOT_SDK_INSTANCE_ID;',
            'const state = path.join(home, ".discord-copilot-sdk");',
            "fs.mkdirSync(state, { recursive: true });",
            'const lock = path.join(state, `${instance}.lock`);',
            "fs.writeFileSync(lock, String(process.pid));",
            'const ready = path.join(state, "startup-ready");',
            "fs.mkdirSync(ready, { recursive: true });",
            'fs.writeFileSync(path.join(ready, `${instance}.ready.json`), JSON.stringify({ version: 1, pid: process.pid, instance }));',
            "setInterval(() => {}, 1_000);",
            "",
          ].join("\n")
        );
        const child = spawn(process.execPath, [path.join(dist, "index.js")], {
          env: {
            ...process.env,
            DISCORD_COPILOT_SDK_INSTANCE_ID: instance,
            HOME: home,
            USERPROFILE: home,
          },
          stdio: "ignore",
        });
        originalPid = child.pid;
        await waitForLock(home, instance);
      });

      const instance = `${instancePrefix}-${serial}`;
      restartedPid = await waitForLock(path.join(root, `home-${serial}`), instance);
      expect(result.code, result.stderr).toBe(0);
      expect((await git(local, "rev-parse", "HEAD")).stdout.trim()).toBe(expected);
      expect(result.stdout).toContain("[1/4] Stop");
      expect(result.stdout).toContain(`${instance} bot stopped (previous PID ${originalPid}).`);
      expect(result.stdout).toContain("[2/4] Apply source");
      expect(result.stdout).toContain("[3/4] Run setup");
      expect(result.stdout).toContain("[4/4] Restore running state");
      expect(result.stdout).toContain(`${instance} bot restarted and verified live (PID ${restartedPid}).`);
      expect(restartedPid).not.toBe(originalPid);
    } finally {
      for (const pid of [originalPid, restartedPid]) {
        if (pid) {
          try {
            process.kill(pid);
          } catch {
            // The updater is expected to have already stopped the original bot.
          }
        }
      }
    }
  });
});
