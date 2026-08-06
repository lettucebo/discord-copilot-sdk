import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyCheckout, parseLsRemote, resolveRemoteSha } from "../scripts/lib/update-core.mjs";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]): Promise<{ stdout: string }> =>
  exec("git", args, { cwd, encoding: "utf8" });

let root: string;
let source: string;
let remote: string;
let serial = 0;

async function clone(name: string): Promise<string> {
  const target = path.join(root, name);
  await exec("git", ["clone", "-q", "--branch", "main", remote, target], { encoding: "utf8" });
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

beforeAll(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dcs-update-git-"));
  source = path.join(root, "source");
  remote = path.join(root, "remote.git");
  await git(root, "init", "-q", "-b", "main", source);
  await git(source, "config", "user.email", "update@test.invalid");
  await git(source, "config", "user.name", "update test");
  await git(source, "config", "commit.gpgsign", "false");
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
  it("fails closed for a dirty named branch without moving HEAD", async () => {
    const local = await clone("dirty");
    const before = (await git(local, "rev-parse", "HEAD")).stdout.trim();
    await fs.promises.writeFile(path.join(local, "local-only.txt"), "do not overwrite\n");
    const status = (await git(local, "status", "--porcelain")).stdout;
    const branch = (await git(local, "symbolic-ref", "--short", "HEAD")).stdout.trim();

    expect(classifyCheckout({ symbolicRef: branch, status })).toBe("branch-dirty");
    expect((await git(local, "rev-parse", "HEAD")).stdout.trim()).toBe(before);
  });

  it("fast-forwards a clean named branch only after Git proves ancestry", async () => {
    const local = await clone("fast-forward");
    const before = (await git(local, "rev-parse", "HEAD")).stdout.trim();
    const expected = await advanceRemote("fast forward");

    await git(local, "fetch", "origin", "main");
    await git(local, "merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD");
    await git(local, "merge", "--ff-only", "FETCH_HEAD");

    expect(before).not.toBe(expected);
    expect((await git(local, "rev-parse", "HEAD")).stdout.trim()).toBe(expected);
  });

  it("updates a bootstrap-managed detached checkout from FETCH_HEAD", async () => {
    const local = await clone("managed");
    await git(local, "checkout", "-q", "--detach");
    const expected = await advanceRemote("managed update");
    const status = (await git(local, "status", "--porcelain")).stdout;

    expect(classifyCheckout({ symbolicRef: "", status })).toBe("managed");
    await git(local, "fetch", "--depth", "1", "origin", "main");
    await git(local, "checkout", "-q", "--detach", "FETCH_HEAD");

    expect((await git(local, "rev-parse", "HEAD")).stdout.trim()).toBe(expected);
    expect((await git(local, "symbolic-ref", "--quiet", "HEAD").catch(() => ({ stdout: "" }))).stdout.trim()).toBe("");
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
