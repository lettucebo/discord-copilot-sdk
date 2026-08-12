import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DiscordCopilotApp } from "../src/app.js";
import { SessionStore, type SessionBinding } from "../src/core/session-store.js";
import { addWorktree } from "../src/core/worktree.js";
import type { CopilotClient } from "@github/copilot-sdk";
import type { SendFileResult, Transport } from "../src/core/transport.js";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]): Promise<{ stdout: string }> => exec("git", args, { cwd });

class NullTransport implements Transport {
  async render(): Promise<void> {}
  async sendFile(..._args: Parameters<Transport["sendFile"]>): Promise<SendFileResult> {
    return { ok: false, reason: "unavailable" };
  }
  async showPermission(): Promise<void> {}
  async showUserInput(): Promise<void> {}
  async showPlan(): Promise<void> {}
  async notice(): Promise<void> {}
  async noticeDelivered(): Promise<boolean> {
    return true;
  }
  onDecision(): () => void {
    return () => {};
  }
  onChoice(): () => void {
    return () => {};
  }
  onPlan(): () => void {
    return () => {};
  }
  deliverDecision(): void {}
  deliverChoice(): void {}
  deliverPlan(): void {}
  async flush(): Promise<void> {}
  resetTurn(): void {}
  dispose(): void {}
}

let repo: string;
let storeFile: string;
let worktreeDir: string;

const cfgFor = (r: string): Parameters<typeof DiscordCopilotApp.createForTest>[0] =>
  ({
    DISCORD_BOT_TOKEN: "t",
    DISCORD_ALLOWED_USER_IDS: ["u1"],
    DISCORD_GUILD_ID: "g1",
    DISCORD_PARENT_CHANNEL_ID: "c1",
    REPOS_ROOT: path.dirname(r),
    DEFAULT_MODEL: "claude-sonnet-5",
    DEFAULT_CONTEXT_TIER: "default",
    PERMISSION_POLICY: "ask",
  }) as unknown as Parameters<typeof DiscordCopilotApp.createForTest>[0];

const fakeCopilot = (): CopilotClient => ({}) as unknown as CopilotClient;

beforeEach(async () => {
  repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dcs-reclaim-"));
  storeFile = path.join(repo, "..", `${path.basename(repo)}-store.json`);
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "t@t.t");
  await git(repo, "config", "user.name", "t");
  await fs.promises.writeFile(path.join(repo, "a.txt"), "one\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "one");
});

afterEach(async () => {
  // The worktree lives OUTSIDE `repo` (that is the point of a worktree), so
  // removing the repo alone leaks a full checkout into the temp dir on every run.
  if (worktreeDir) await fs.promises.rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(repo, { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(storeFile, { force: true }).catch(() => {});
});

/** A stopped session's record + a real worktree on its own branch. */
async function seed(): Promise<{ app: DiscordCopilotApp; store: SessionStore; dir: string; branch: string }> {
  const dir = path.join(repo, "..", `${path.basename(repo)}-wt`);
  worktreeDir = dir;
  const branch = "copilot/t-x";
  await addWorktree(repo, dir, branch);
  const store = new SessionStore(storeFile);
  const b: SessionBinding = {
    threadId: "t1",
    sessionId: "s1",
    generation: 1,
    repoPath: repo,
    guildId: "g1",
    parentChannelId: "c1",
    workDir: dir,
    devMode: "worktree",
    branch,
  };
  store.reserve(b);
  store.commit("t1");
  const app = DiscordCopilotApp.createForTest(
    cfgFor(repo),
    path.dirname(repo),
    fakeCopilot(),
    new NullTransport(),
    store
  );
  return { app, store, dir, branch };
}

const reclaim = (
  app: DiscordCopilotApp,
  id: string,
  repoPath: string,
  wd: string,
  br?: string
): Promise<{ ok: boolean; tail: string }> =>
  (
    app as unknown as {
      reclaim(t: string, r: string, w: string, b?: string): Promise<{ ok: boolean; tail: string }>;
    }
  ).reclaim(id, repoPath, wd, br);

// Each test here creates a real git repo AND a real worktree, so it pays for
// several git subprocesses. Locally that is ~1.4s; CI runs roughly 4-5x slower
// (measured: a test at 1.4s locally timed out at 6707ms against vitest's 5s
// default there), which would make this flake on timing rather than behaviour.
describe("reclaim — the record and its worktree retire together", { timeout: 60_000 }, () => {
  it("clean worktree: both go, branch stays", async () => {
    const { app, store, dir, branch } = await seed();
    const out = await reclaim(app, "t1", repo, dir, branch);
    expect(out.ok).toBe(true);
    expect(store.get("t1")).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
    const { stdout } = await git(repo, "branch", "--list", branch);
    expect(stdout).toContain(branch);
  });

  it("KEPT worktree: the record is kept too, retired to blocked/worktree-kept", async () => {
    // Dropping the record while the tree survives is the invisible-artifact bug:
    // nothing lists it and no command can reach it. The record must stay, but it
    // must NOT stay `active` either — the next boot would try to resume a session
    // that has already been stopped.
    const { app, store, dir, branch } = await seed();
    await fs.promises.writeFile(path.join(dir, "untracked.txt"), "operator's work\n");
    const out = await reclaim(app, "t1", repo, dir, branch);
    expect(out.ok).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
    const rec = store.get("t1");
    expect(rec?.state).toBe("blocked");
    expect(rec?.reason).toBe("worktree-kept");
    await git(repo, "worktree", "remove", "--force", dir);
  });

  it("worktree ALREADY gone: the record is dropped, not stranded forever", async () => {
    // Reachable by following our own advice ("確認後可自行 git worktree remove"),
    // and after a crash between removing the tree and removing the record.
    // Treating a missing directory as a failure keeps the record for ever,
    // because every retry fails identically.
    const { app, store, dir, branch } = await seed();
    await git(repo, "worktree", "remove", "--force", dir);
    expect(fs.existsSync(dir)).toBe(false);
    const out = await reclaim(app, "t1", repo, dir, branch);
    expect(out.ok).toBe(true);
    expect(store.get("t1")).toBeUndefined();
  });

  it("a retired record can be reclaimed on a later attempt once the tree is dealt with", async () => {
    const { app, store, dir, branch } = await seed();
    await fs.promises.writeFile(path.join(dir, "untracked.txt"), "x\n");
    expect((await reclaim(app, "t1", repo, dir, branch)).ok).toBe(false);
    expect(store.get("t1")).toBeDefined();
    await git(repo, "worktree", "remove", "--force", dir); // operator cleans up
    expect((await reclaim(app, "t1", repo, dir, branch)).ok).toBe(true);
    expect(store.get("t1")).toBeUndefined();
  });

  it("shared-tree session (no branch): only the record is touched", async () => {
    const store = new SessionStore(storeFile);
    store.reserve({
      threadId: "t2",
      sessionId: "s2",
      generation: 1,
      repoPath: repo,
      guildId: "g1",
      parentChannelId: "c1",
      workDir: repo,
      devMode: "local",
    });
    store.commit("t2");
    const app = DiscordCopilotApp.createForTest(cfgFor(repo), path.dirname(repo), fakeCopilot(), new NullTransport(), store);
    const out = await reclaim(app, "t2", repo, repo, undefined);
    expect(out.ok).toBe(true);
    expect(store.get("t2")).toBeUndefined();
    expect(fs.existsSync(path.join(repo, "a.txt"))).toBe(true); // repo untouched
  });
});
