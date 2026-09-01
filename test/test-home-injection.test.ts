import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CopilotClient } from "@github/copilot-sdk";
import { DiscordCopilotApp } from "../src/app.js";
import { ApprovalPolicy } from "../src/core/approval-policy.js";
import { ChannelRegistry } from "../src/core/channel-registry.js";
import { SessionStore } from "../src/core/session-store.js";
import { STATE_DIR_NAME, worktreeRoot } from "../src/core/paths.js";
import { SessionActor } from "../src/copilot/session-actor.js";
import { PendingInteractionBroker } from "../src/core/broker.js";
import type { AuditEntry, AuditSink } from "../src/core/audit-log.js";
import type { Config } from "../src/config.js";
import type { SendFileResult, Transport } from "../src/core/transport.js";
import { appTestDependencies } from "./support/app-test-dependencies.js";

/**
 * The compile-time rule has a runtime half.
 *
 * `createForTest` and `SessionActor.createForTest` now REQUIRE every home-backed
 * dependency, so an omission is a type error. That protects the code we write;
 * it says nothing about whether the app actually USES what it was handed. This
 * suite answers that question the only way that cannot be faked: it points
 * `HOME`/`USERPROFILE` at a sentinel home, POISONS it with state the app would
 * visibly act on if it read it, and then asserts both that the app behaved as
 * though that state does not exist and that the sentinel is byte-for-byte
 * unchanged afterwards.
 *
 * Poisoning is what makes this a READ detector. An existence check alone only
 * catches creation, and the dependencies that hurt most — an approval rule, an
 * enabled channel, a resumable record — are ones an app can read from an
 * existing home without writing anything back.
 *
 * `stateDir()` is deliberately NOT called anywhere here: it CREATES the
 * directory it returns, so a guard built on it would manufacture the very
 * evidence it is looking for. The paths are composed from `STATE_DIR_NAME` and
 * the pure `worktreeRoot()` helper instead, so this file never re-spells the
 * state directory or its worktree sibling.
 *
 * The Vitest-wide `HOME` redirect in `test/global-home.ts` stays: it is
 * defence in depth for suites this one cannot speak for, and it is what makes
 * the sentinel safe to point at a throwaway directory instead of a real home.
 */

const GUILD = "guild-1";
const SENTINEL_CHANNEL = "sentinel-channel";
const INJECTED_CHANNEL = "injected-channel";

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

class RecordingAuditLog implements AuditSink {
  readonly entries: AuditEntry[] = [];
  append(entry: AuditEntry): boolean {
    this.entries.push(entry);
    return true;
  }
}

function config(reposRoot: string): Config {
  return {
    DISCORD_BOT_TOKEN: "token",
    DISCORD_ALLOWED_USER_IDS: ["u1"],
    DISCORD_GUILD_ID: GUILD,
    DISCORD_PARENT_CHANNEL_ID: INJECTED_CHANNEL,
    REPOS_ROOT: reposRoot,
    DEFAULT_MODEL: "claude-sonnet-5",
    DEFAULT_CONTEXT_TIER: "default",
    ENABLE_REPO_SKILLS: "true",
    ENABLE_USER_SKILLS: "true",
    REPO_CLONE_HOST_POLICY: "github",
    REPO_CLONE_ALLOWED_HOSTS: [],
    REPO_CLONE_TIMEOUT_MS: 300_000,
  } as unknown as Config;
}

const fakeCopilot = (): CopilotClient =>
  ({
    createSession: async () => ({
      sessionId: "sentinel-session",
      on(): void {},
      async send(): Promise<void> {},
      async abort(): Promise<boolean> {
        return true;
      },
      async disconnect(): Promise<void> {},
    }),
    async stop(): Promise<Error[]> {
      return [];
    },
  }) as unknown as CopilotClient;

interface Snapshot {
  readonly entries: string[];
}

/** Every path under `root`, with size and mtime, so a WRITE anywhere inside is
 *  visible even when it replaces a file that already existed. */
function snapshot(root: string): Snapshot {
  const entries: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const stat = fs.lstatSync(absolute);
      entries.push(
        `${path.relative(root, absolute)}\0${entry.isDirectory() ? "d" : "f"}\0${stat.size}\0${stat.mtimeMs}`
      );
      if (entry.isDirectory()) walk(absolute);
    }
  };
  walk(root);
  entries.sort();
  return { entries };
}

interface Sentinel {
  /** The home every home-backed default would resolve through. */
  home: string;
  /** `<home>/.discord-copilot-sdk`, composed from the exported constant. */
  stateDir: string;
  /** The worktree sibling, from the pure helper — never re-spelled here. */
  worktrees: string;
  strayWorktree: string;
  /** Where the injected (correct) dependencies live. */
  injected: string;
  restore: () => void;
}

/**
 * Build a sentinel home that is FULL of state the app would act on, and point
 * the process at it.
 *
 * Written through the real classes on purpose: a hand-rolled JSON fixture that
 * drifts from the store's format would be ignored by the app for the wrong
 * reason, and the guard would pass while proving nothing.
 */
function poisonedHome(): Sentinel {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-home-guard-"));
  const home = path.join(base, "home");
  const injected = path.join(base, "injected");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(injected, { recursive: true });

  const originalHome = process.env["HOME"];
  const originalUserProfile = process.env["USERPROFILE"];
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;

  const stateDir = path.join(home, STATE_DIR_NAME);
  // `worktreeRoot()` is pure — unlike `stateDir()` it creates nothing — so it is
  // the right way to learn where the sibling is without manufacturing it.
  const worktrees = worktreeRoot();
  fs.mkdirSync(stateDir, { recursive: true });

  const sentinelStore = new SessionStore(path.join(stateDir, "default.session.json"));
  sentinelStore.reserve({
    threadId: "sentinel-thread",
    sessionId: "sentinel-session-id",
    generation: 1,
    repoPath: path.join(base, "sentinel-repo"),
    guildId: GUILD,
    parentChannelId: SENTINEL_CHANNEL,
    workDir: path.join(base, "sentinel-repo"),
    devMode: "local",
  });
  sentinelStore.commit("sentinel-thread");

  const sentinelApprovals = new ApprovalPolicy(path.join(stateDir, "approvals.json"));
  sentinelApprovals.approveForRepo(path.join(base, "sentinel-repo"), "sentinel-exe");

  new ChannelRegistry(SENTINEL_CHANNEL, GUILD, path.join(stateDir, "default.channels.json"));

  const strayWorktree = path.join(worktrees, "sentinel-stray");
  fs.mkdirSync(strayWorktree, { recursive: true });
  fs.writeFileSync(path.join(strayWorktree, ".git"), "gitdir: sentinel\n", "utf8");

  // A skill the SDK would load for a session whose skills home defaulted here.
  const userSkill = path.join(home, ".copilot", "skills", "sentinel");
  fs.mkdirSync(userSkill, { recursive: true });
  fs.writeFileSync(path.join(userSkill, "SKILL.md"), "---\nname: sentinel\n---\n", "utf8");

  return {
    home,
    stateDir,
    worktrees,
    strayWorktree,
    injected,
    restore: (): void => {
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
      if (originalUserProfile === undefined) delete process.env["USERPROFILE"];
      else process.env["USERPROFILE"] = originalUserProfile;
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    },
  };
}

let sentinel: Sentinel | undefined;

afterEach(() => {
  sentinel?.restore();
  sentinel = undefined;
});

type AppInternals = {
  approvals: ApprovalPolicy;
  store: SessionStore;
  channels: ChannelRegistry;
  worktreeRootOf(): string;
  strayWorktreeDirs(known: ReadonlySet<string>): string[];
  actorSourceOptions(): {
    enableRepoSkills: boolean;
    enableUserSkills: boolean;
    auditLog?: AuditSink;
    skillsHomeDirectory?: string;
  };
};

describe("createForTest uses what it was injected, and nothing from a real home", () => {
  it("acts on the injected store, registry, approvals, audit sink, skills home and worktree root", async () => {
    sentinel = poisonedHome();
    const before = snapshot(sentinel.home);

    const store = new SessionStore(path.join(sentinel.injected, "sessions.json"));
    const channels = new ChannelRegistry(
      INJECTED_CHANNEL,
      GUILD,
      path.join(sentinel.injected, "channels.json")
    );
    const approvals = new ApprovalPolicy(path.join(sentinel.injected, "approvals.json"));
    const actorAuditLog = new RecordingAuditLog();
    const actorSkillsHomeDirectory = path.join(sentinel.injected, "skills-home");
    const injectedWorktreeRoot = path.join(sentinel.injected, "worktrees");
    const injectedStray = path.join(injectedWorktreeRoot, "injected-stray");
    fs.mkdirSync(injectedStray, { recursive: true });
    fs.writeFileSync(path.join(injectedStray, ".git"), "gitdir: injected\n", "utf8");
    let startupReadyCleared = 0;

    const app = DiscordCopilotApp.createForTest(
      config(path.join(sentinel.injected, "repos")),
      path.join(sentinel.injected, "repos"),
      fakeCopilot(),
      new NullTransport(),
      {
        store,
        channels,
        approvals,
        actorAuditLog,
        actorSkillsHomeDirectory,
        worktreeRoot: injectedWorktreeRoot,
        clearStartupReady: async (): Promise<void> => {
          startupReadyCleared++;
        },
      }
    );
    const internals = app as unknown as AppInternals;

    // Identity, not equivalence: a second ApprovalPolicy over the same file
    // would satisfy a value comparison while still being a second loader.
    expect(internals.approvals).toBe(approvals);
    expect(internals.store).toBe(store);
    expect(internals.channels).toBe(channels);

    // The poisoned home holds a resumable record, a repo approval rule and a
    // registry enabling another channel. None of it may be visible here.
    expect(internals.store.all()).toEqual([]);
    expect(internals.approvals.repoKeys()).toEqual([]);
    expect([...internals.channels.enabledSet()]).toEqual([INJECTED_CHANNEL]);

    // Every actor this app creates is handed the injected sink and skills home.
    const actorOptions = internals.actorSourceOptions();
    expect(actorOptions.auditLog).toBe(actorAuditLog);
    expect(actorOptions.skillsHomeDirectory).toBe(actorSkillsHomeDirectory);

    // The stray scan reads the INJECTED root: it reports the tree that is there
    // and never the one planted under the sentinel home's worktree sibling.
    expect(internals.worktreeRootOf()).toBe(injectedWorktreeRoot);
    const strays = internals.strayWorktreeDirs(new Set());
    expect(strays).toContain(injectedStray);
    expect(strays).not.toContain(sentinel.strayWorktree);

    await app.stop();
    expect(startupReadyCleared).toBe(1);

    // `clearStartupReady()` resolves `startupReadyDirectory()`, which creates the
    // real state directory; the injected seam is what keeps teardown out of it.
    expect(fs.existsSync(path.join(sentinel.stateDir, "startup-ready"))).toBe(false);
    expect(snapshot(sentinel.home)).toEqual(before);
  });

  it("keeps an actor's audit sink and skills home out of the sentinel home", async () => {
    sentinel = poisonedHome();
    const before = snapshot(sentinel.home);

    const auditLog = new RecordingAuditLog();
    const workingDirectory = path.join(sentinel.injected, "work");
    fs.mkdirSync(workingDirectory, { recursive: true });

    const actor = await SessionActor.createForTest(
      fakeCopilot(),
      {
        sessionKey: "guard",
        workingDirectory,
        broker: new PendingInteractionBroker(),
        transport: new NullTransport(),
        policy: new ApprovalPolicy(path.join(sentinel.injected, "actor-approvals.json")),
        initialFileDeliveryBytes: 0,
        fileDeliverySessionId: "guard-session",
        reserveFileDeliveryBytes: () => true,
        enableRepoSkills: true,
        enableUserSkills: true,
      },
      {
        auditLog,
        // The sentinel home has a `~/.copilot/skills/sentinel` this would load.
        skillsHomeDirectory: path.join(sentinel.injected, "skills-home"),
      }
    );

    expect(actor.hasRepoSkills()).toBe(false);
    await actor.disconnect();

    expect(fs.existsSync(path.join(sentinel.stateDir, "default.audit.jsonl"))).toBe(false);
    expect(snapshot(sentinel.home)).toEqual(before);
  });
});
