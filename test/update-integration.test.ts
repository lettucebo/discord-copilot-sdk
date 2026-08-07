import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
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

async function advanceToVersion(version: string): Promise<string> {
  serial++;
  await fs.promises.mkdir(path.join(source, "scripts"), { recursive: true });
  await fs.promises.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "discord-copilot-sdk", version }));
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
  beforeRun?: (home: string) => Promise<void>
): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = path.join(root, `home-${serial}`);
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
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
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

  it("reports source identity and the resolved ref when the source is already current", async () => {
    const local = await cloneTarget("up-to-date");

    const result = await runUpdate(local, ["--check", "--lang", "en"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("discord-copilot-sdk unknown (");
    expect(result.stdout).toContain(`root ${local}`);
    expect(result.stdout).toContain("checkout branch-clean (main)");
    expect(result.stdout).toContain("requested main -> refs/heads/main @");
    expect(result.stdout).toContain("Source HEAD already matches refs/heads/main; no update is needed.");
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
    expect(result.stdout).toContain("Source HEAD already matches refs/heads/main; no update is needed.");
    expect(result.stdout).toContain("Warning: a failed update still awaits --restore; the bot remains stopped.");
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
    expect(result.stdout).toContain("Source HEAD already matches refs/heads/main; no update is needed.");
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
