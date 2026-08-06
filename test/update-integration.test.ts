import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

async function runUpdate(target: string, ...args: string[]): Promise<{ code: number; output: string }> {
  const home = path.join(root, `home-${serial}`);
  await fs.promises.mkdir(home, { recursive: true });
  try {
    await exec(process.execPath, [ENGINE, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        DISCORD_COPILOT_SDK_UPDATE_ROOT: target,
        DISCORD_COPILOT_SDK_INSTANCE_ID: `integration-${serial}`,
        HOME: home,
        USERPROFILE: home,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });
    return { code: 0, output: "" };
  } catch (error) {
    const failure = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
    const output = `${typeof failure["stdout"] === "string" ? failure["stdout"] : ""}${typeof failure["stderr"] === "string" ? failure["stderr"] : ""}`;
    return {
      code: typeof failure["code"] === "number" ? failure["code"] : 1,
      output,
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
  await fs.promises.writeFile(path.join(source, ".gitignore"), ".env\n");
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
    expect(result.code, result.output).toBe(1);
    expect((await git(local, "rev-parse", "HEAD")).stdout.trim(), result.output).toBe(expected);
  });

  it("moves a bootstrap-managed detached checkout to FETCH_HEAD through the engine", async () => {
    const local = await cloneTarget("managed");
    await git(local, "checkout", "-q", "--detach");
    const expected = await advanceRemote("managed update");

    const result = await runUpdate(local);
    expect(result.code, result.output).toBe(1);
    expect((await git(local, "rev-parse", "HEAD")).stdout.trim(), result.output).toBe(expected);
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
});
