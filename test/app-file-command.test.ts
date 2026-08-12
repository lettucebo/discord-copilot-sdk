import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { CopilotClient } from "@github/copilot-sdk";
import { DiscordCopilotApp, type Session } from "../src/app.js";
import type { SessionActor } from "../src/copilot/session-actor.js";
import type { Config } from "../src/config.js";
import { PendingInteractionBroker } from "../src/core/broker.js";
import { ChannelRegistry } from "../src/core/channel-registry.js";
import {
  MAX_DISCORD_UPLOAD_BYTES,
  type OutboundFile,
  type OutboundFilePolicy,
  type ResolveOutboundFileResult,
} from "../src/core/outbound-file.js";
import { SessionStore } from "../src/core/session-store.js";
import type { SendFileOptions, SendFileResult, Transport } from "../src/core/transport.js";

const OWNER = "u1";
const OTHER = "u2";
const GUILD = "g1";
const PARENT = "c1";
const THREAD = "t1";

class FakeTransport implements Transport {
  sentFiles: Array<{ key: string; file: OutboundFile; note?: string; options?: SendFileOptions }> = [];
  sendFileResult: SendFileResult = { ok: true };
  sendFileGate?: Promise<void>;
  sendFileStarted?: () => void;
  ignoreCurrentness = false;
  async render(): Promise<void> {}
  async sendFile(
    sessionKey: string,
    file: OutboundFile,
    note?: string,
    options?: SendFileOptions
  ): Promise<SendFileResult> {
    this.sendFileStarted?.();
    if (this.sendFileGate) await this.sendFileGate;
    if (!this.ignoreCurrentness && options?.canSend && !options.canSend()) {
      return { ok: false, reason: "cancelled" };
    }
    this.sentFiles.push({
      key: sessionKey,
      file,
      ...(note === undefined ? {} : { note }),
      ...(options === undefined ? {} : { options }),
    });
    return this.sendFileResult;
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

interface FakeSlash {
  readonly commandName: string;
  readonly user: { id: string };
  readonly guildId: string | null;
  readonly channelId: string;
  readonly channel: { isThread: () => boolean; parentId: string | null };
  readonly replies: Array<{ content: string; flags?: MessageFlags }>;
  readonly defers: Array<{ flags?: MessageFlags }>;
  readonly edits: string[];
  readonly options: {
    getString(name: string, required?: boolean): string | null;
  };
  readonly isAutocomplete: () => false;
  readonly isButton: () => false;
  readonly isRepliable: () => true;
  readonly isChatInputCommand: () => true;
  reply(value: { content: string; flags?: MessageFlags }): Promise<void>;
  deferReply(value: { flags?: MessageFlags }): Promise<void>;
  editReply(value: string | { content: string }): Promise<void>;
}

function textOf(value: string | { content: string }): string {
  return typeof value === "string" ? value : value.content;
}

function slash(
  over: Partial<{
    commandName: string;
    userId: string;
    guildId: string | null;
    channelId: string;
    parentId: string | null;
    pathValue: string;
  }> = {}
): FakeSlash {
  const replies: Array<{ content: string; flags?: MessageFlags }> = [];
  const defers: Array<{ flags?: MessageFlags }> = [];
  const edits: string[] = [];
  return {
    commandName: over.commandName ?? "file",
    user: { id: over.userId ?? OWNER },
    guildId: over.guildId ?? GUILD,
    channelId: over.channelId ?? THREAD,
    channel: { isThread: () => true, parentId: over.parentId ?? PARENT },
    replies,
    defers,
    edits,
    options: {
      getString(name: string): string | null {
        return name === "path" ? (over.pathValue ?? "artifacts\\report.txt") : null;
      },
    },
    isAutocomplete: () => false,
    isButton: () => false,
    isRepliable: () => true,
    isChatInputCommand: () => true,
    async reply(value): Promise<void> {
      replies.push(value);
    },
    async deferReply(value): Promise<void> {
      defers.push(value);
    },
    async editReply(value): Promise<void> {
      edits.push(textOf(value));
    },
  };
}

function interactionOf(fake: FakeSlash): ChatInputCommandInteraction {
  return fake as unknown as ChatInputCommandInteraction;
}

function config(reposRoot: string): Config {
  return {
    DISCORD_BOT_TOKEN: "token",
    DISCORD_ALLOWED_USER_IDS: [OWNER],
    DISCORD_GUILD_ID: GUILD,
    DISCORD_PARENT_CHANNEL_ID: PARENT,
    DEV_GUILD_ID: undefined,
    REPOS_ROOT: reposRoot,
    DEFAULT_REPO: "repo",
    DEFAULT_MODEL: "claude-sonnet-5",
    DEFAULT_CONTEXT_TIER: "default",
    PERMISSION_POLICY: "ask",
    ENABLE_REPO_SKILLS: "false",
    ENABLE_USER_SKILLS: "false",
    REPO_CLONE_HOST_POLICY: "github",
    REPO_CLONE_ALLOWED_HOSTS: [],
    REPO_CLONE_TIMEOUT_MS: 300_000,
    TITLE_MODEL: undefined,
  };
}

function sessionsOf(app: DiscordCopilotApp): Map<string, Session> {
  return (app as unknown as { sessions: Map<string, Session> }).sessions;
}

function invokeInteraction(app: DiscordCopilotApp, interaction: FakeSlash): Promise<void> {
  (app as unknown as { phase: "booting" | "reconciling" | "ready" | "shuttingDown" }).phase = "ready";
  return (app as unknown as { onInteraction(i: ChatInputCommandInteraction): Promise<void> }).onInteraction(
    interactionOf(interaction)
  );
}

type FileResolverActor = Pick<SessionActor, "resolveFileForDelivery">;

function actorResolving(result: ResolveOutboundFileResult): {
  actor: FileResolverActor & { canDeliverFiles(): boolean };
  resolveFileForDelivery: ReturnType<typeof vi.fn>;
} {
  const resolveFileForDelivery = vi.fn(async (_path: string, _policy: OutboundFilePolicy) => result);
  return {
    actor: { resolveFileForDelivery, canDeliverFiles: () => true },
    resolveFileForDelivery,
  };
}

function session(workDir: string, actor: FileResolverActor & { canDeliverFiles(): boolean }): Session {
  return {
    actor: actor as SessionActor,
    broker: new PendingInteractionBroker(),
    running: false,
    titled: true,
    titleEpoch: 0,
    queue: [],
    workDir,
    repoPath: workDir,
    devMode: "local",
    parentChannelId: PARENT,
    hasRunTurn: false,
  };
}

let root: string;
let reposRoot: string;
let storeFile: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "dcs-app-file-"));
  reposRoot = path.join(root, "repos");
  mkdirSync(reposRoot, { recursive: true });
  storeFile = path.join(root, "sessions.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("/file", () => {
  it("dispatches /file from onInteraction to the dedicated handler", async () => {
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as CopilotClient,
      new FakeTransport(),
      new SessionStore(storeFile),
      new ChannelRegistry(PARENT, GUILD, path.join(root, "channels.json"))
    );
    const spy = vi
      .spyOn(app as unknown as { cmdFile(interaction: ChatInputCommandInteraction): Promise<void> }, "cmdFile")
      .mockResolvedValue(undefined);

    await invokeInteraction(app, slash());

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refuses an unauthorized operator without touching transport", async () => {
    const transport = new FakeTransport();
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as CopilotClient,
      transport,
      new SessionStore(storeFile),
      new ChannelRegistry(PARENT, GUILD, path.join(root, "channels.json"))
    );

    await invokeInteraction(app, slash({ userId: OTHER }));

    expect(transport.sentFiles).toHaveLength(0);
  });

  it("refuses when the thread has no live session", async () => {
    const transport = new FakeTransport();
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as CopilotClient,
      transport,
      new SessionStore(storeFile),
      new ChannelRegistry(PARENT, GUILD, path.join(root, "channels.json"))
    );
    const interaction = slash();

    await invokeInteraction(app, interaction);

    expect(interaction.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(interaction.edits).toEqual(["這個討論串沒有進行中的 session，無法傳送檔案。"]);
    expect(transport.sentFiles).toHaveLength(0);
  });

  it("uses the actor-owned resolver rather than rebinding a mutable session workDir", async () => {
    const transport = new FakeTransport();
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as CopilotClient,
      transport,
      new SessionStore(storeFile),
      new ChannelRegistry(PARENT, GUILD, path.join(root, "channels.json"))
    );
    const workDir = path.join(reposRoot, "repo");
    const outsideRoot = path.join(root, "outside");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    writeFileSync(path.join(outsideRoot, "secret.txt"), "nope");
    const resolver = actorResolving({ ok: false, reason: "outside-workdir" });
    sessionsOf(app).set(THREAD, session(workDir, resolver.actor));
    const interaction = slash({ pathValue: "..\\..\\outside\\secret.txt" });

    await invokeInteraction(app, interaction);

    expect(resolver.resolveFileForDelivery).toHaveBeenCalledWith("..\\..\\outside\\secret.txt", "operator");
    expect(resolver.resolveFileForDelivery).toHaveBeenCalledTimes(1);
    expect(interaction.edits).toEqual(["無法傳送這個檔案：路徑不在這個 session 的工作目錄內。"]);
    expect(transport.sentFiles).toHaveLength(0);
  });

  it("routes an in-workdir file through transport with the canonical size cap", async () => {
    const transport = new FakeTransport();
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as CopilotClient,
      transport,
      new SessionStore(storeFile),
      new ChannelRegistry(PARENT, GUILD, path.join(root, "channels.json"))
    );
    const workDir = path.join(reposRoot, "repo");
    mkdirSync(path.join(workDir, "artifacts"), { recursive: true });
    const filePath = path.join(workDir, "artifacts", "report.txt");
    writeFileSync(filePath, "hello");
    const resolver = actorResolving({
      ok: true,
      file: {
        absPath: filePath,
        displayName: "report.txt",
        relativePath: "report.txt",
        size: 5,
        fingerprint: "artifact-identity:5:1",
        digest: "sha256:test",
        bytes: Buffer.from("hello"),
      },
    });
    sessionsOf(app).set(THREAD, session(workDir, resolver.actor));
    const interaction = slash({ pathValue: "artifacts\\report.txt" });

    await invokeInteraction(app, interaction);

    expect(interaction.edits).toEqual(["已將檔案傳送到這個討論串。"]);
    expect(resolver.resolveFileForDelivery).toHaveBeenCalledWith("artifacts\\report.txt", "operator");
    expect(transport.sentFiles).toHaveLength(1);
    expect(transport.sentFiles[0]).toMatchObject({
      key: THREAD,
      file: {
        absPath: filePath,
        displayName: "report.txt",
        bytes: Buffer.from("hello"),
      },
    });
    expect(MAX_DISCORD_UPLOAD_BYTES).toBe(8 * 1024 * 1024);
  });

  it("does not send or claim success when the session is replaced while resolving", async () => {
    const transport = new FakeTransport();
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as CopilotClient,
      transport,
      new SessionStore(storeFile),
      new ChannelRegistry(PARENT, GUILD, path.join(root, "channels.json"))
    );
    const workDir = path.join(reposRoot, "repo");
    const filePath = path.join(workDir, "report.txt");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(filePath, "hello");
    let releaseResolution!: (result: ResolveOutboundFileResult) => void;
    const resolutionStarted = new Promise<void>((resolve) => {
      const resolver = {
        resolveFileForDelivery: vi.fn(
          () =>
            new Promise<ResolveOutboundFileResult>((resolveResult) => {
              releaseResolution = resolveResult;
              resolve();
            })
        ),
        canDeliverFiles: () => true,
      };
      sessionsOf(app).set(THREAD, session(workDir, resolver));
    });
    const interaction = slash({ pathValue: "report.txt" });

    const command = invokeInteraction(app, interaction);
    await resolutionStarted;
    const replacement = actorResolving({ ok: false, reason: "unreadable" });
    sessionsOf(app).set(THREAD, session(workDir, replacement.actor));
    releaseResolution({
      ok: true,
      file: {
        absPath: filePath,
        displayName: "report.txt",
        relativePath: "report.txt",
        size: 5,
        fingerprint: "artifact-identity:5:1",
        digest: "sha256:test",
        bytes: Buffer.from("hello"),
      },
    });
    await command;

    expect(transport.sentFiles).toHaveLength(0);
    expect(interaction.edits).toEqual(["檔案傳送已取消。"]);
  });

  it("passes a currentness gate to cancel a send when the session ends in flight", async () => {
    const transport = new FakeTransport();
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as CopilotClient,
      transport,
      new SessionStore(storeFile),
      new ChannelRegistry(PARENT, GUILD, path.join(root, "channels.json"))
    );
    const workDir = path.join(reposRoot, "repo");
    const filePath = path.join(workDir, "report.txt");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(filePath, "hello");
    const resolver = actorResolving({
      ok: true,
      file: {
        absPath: filePath,
        displayName: "report.txt",
        relativePath: path.join("artifacts", "report.txt"),
        size: 5,
        fingerprint: "artifact-identity:5:1",
        digest: "sha256:test",
        bytes: Buffer.from("hello"),
      },
    });
    sessionsOf(app).set(THREAD, session(workDir, resolver.actor));
    let releaseSend!: () => void;
    transport.sendFileGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      transport.sendFileStarted = resolve;
    });
    const interaction = slash({ pathValue: "report.txt" });

    const command = invokeInteraction(app, interaction);
    await sendStarted;
    sessionsOf(app).delete(THREAD);
    releaseSend();
    await command;

    expect(transport.sentFiles).toHaveLength(0);
    expect(interaction.edits).toEqual(["檔案傳送已取消。"]);
  });

  it("warns that an attachment may remain visible when a stale send reports success", async () => {
    const transport = new FakeTransport();
    transport.ignoreCurrentness = true;
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as CopilotClient,
      transport,
      new SessionStore(storeFile),
      new ChannelRegistry(PARENT, GUILD, path.join(root, "channels.json"))
    );
    const workDir = path.join(reposRoot, "repo");
    const filePath = path.join(workDir, "report.txt");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(filePath, "hello");
    const resolver = actorResolving({
      ok: true,
      file: {
        absPath: filePath,
        displayName: "report.txt",
        relativePath: "report.txt",
        size: 5,
        fingerprint: "artifact-identity:5:1",
        digest: "sha256:test",
        bytes: Buffer.from("hello"),
      },
    });
    sessionsOf(app).set(THREAD, session(workDir, resolver.actor));
    let releaseSend!: () => void;
    transport.sendFileGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      transport.sendFileStarted = resolve;
    });
    const interaction = slash({ pathValue: "report.txt" });

    const command = invokeInteraction(app, interaction);
    await sendStarted;
    sessionsOf(app).delete(THREAD);
    releaseSend();
    await command;

    expect(transport.sentFiles).toHaveLength(1);
    expect(interaction.edits).toHaveLength(1);
    expect(interaction.edits[0]).toMatch(/可能仍.*(?:可見|看見)/);
    expect(interaction.edits[0]).not.toContain("已將檔案傳送");
  });

  it("reports an unknown upload outcome truthfully when cancellation races a lost response", async () => {
    const transport = new FakeTransport();
    transport.ignoreCurrentness = true;
    transport.sendFileResult = { ok: false, reason: "upload-outcome-unknown" };
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as CopilotClient,
      transport,
      new SessionStore(storeFile),
      new ChannelRegistry(PARENT, GUILD, path.join(root, "channels.json"))
    );
    const workDir = path.join(reposRoot, "repo");
    const filePath = path.join(workDir, "report.txt");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(filePath, "hello");
    const resolver = actorResolving({
      ok: true,
      file: {
        absPath: filePath,
        displayName: "report.txt",
        relativePath: "report.txt",
        size: 5,
        fingerprint: "artifact-identity:5:1",
        digest: "sha256:test",
        bytes: Buffer.from("hello"),
      },
    });
    sessionsOf(app).set(THREAD, session(workDir, resolver.actor));
    let releaseSend!: () => void;
    transport.sendFileGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      transport.sendFileStarted = resolve;
    });
    const interaction = slash({ pathValue: "report.txt" });

    const command = invokeInteraction(app, interaction);
    await sendStarted;
    sessionsOf(app).delete(THREAD);
    releaseSend();
    await command;

    expect(transport.sentFiles).toHaveLength(1);
    expect(interaction.edits).toHaveLength(1);
    expect(interaction.edits[0]).toMatch(/可能.*(?:已傳送|接受|可見)/);
    expect(interaction.edits[0]).not.toContain("檔案傳送已取消");
    expect(interaction.edits[0]).not.toContain("已將檔案傳送");
  });

  it("reports transport failure honestly", async () => {
    const transport = new FakeTransport();
    transport.sendFileResult = { ok: false, reason: "transient" };
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as CopilotClient,
      transport,
      new SessionStore(storeFile),
      new ChannelRegistry(PARENT, GUILD, path.join(root, "channels.json"))
    );
    const workDir = path.join(reposRoot, "repo");
    mkdirSync(workDir, { recursive: true });
    const filePath = path.join(workDir, "report.txt");
    writeFileSync(filePath, "hello");
    const resolver = actorResolving({
      ok: true,
      file: {
        absPath: filePath,
        displayName: "report.txt",
        relativePath: "report.txt",
        size: 5,
        fingerprint: "artifact-identity:5:1",
        digest: "sha256:test",
        bytes: Buffer.from("hello"),
      },
    });
    sessionsOf(app).set(THREAD, session(workDir, resolver.actor));
    const interaction = slash({ pathValue: "report.txt" });

    await invokeInteraction(app, interaction);

    expect(interaction.edits).toEqual(["檔案已解析，但傳送到 Discord 失敗。"]);
    expect(resolver.resolveFileForDelivery).toHaveBeenCalledWith("report.txt", "operator");
    expect(transport.sentFiles).toHaveLength(1);
  });

  it("reports a cancelled transport delivery without claiming the attachment was sent", async () => {
    const transport = new FakeTransport();
    transport.sendFileResult = { ok: false, reason: "cancelled" };
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as CopilotClient,
      transport,
      new SessionStore(storeFile),
      new ChannelRegistry(PARENT, GUILD, path.join(root, "channels.json"))
    );
    const workDir = path.join(reposRoot, "repo");
    mkdirSync(workDir, { recursive: true });
    const filePath = path.join(workDir, "report.txt");
    writeFileSync(filePath, "hello");
    const resolver = actorResolving({
      ok: true,
      file: {
        absPath: filePath,
        displayName: "report.txt",
        relativePath: "report.txt",
        size: 5,
        fingerprint: "artifact-identity:5:1",
        digest: "sha256:test",
        bytes: Buffer.from("hello"),
      },
    });
    sessionsOf(app).set(THREAD, session(workDir, resolver.actor));
    const interaction = slash({ pathValue: "report.txt" });

    await invokeInteraction(app, interaction);

    expect(interaction.edits).toEqual(["檔案傳送已取消。"]);
    expect(transport.sentFiles).toHaveLength(1);
  });

  it("reports an unconfirmed late attachment retraction without claiming cancellation was complete", async () => {
    const transport = new FakeTransport();
    transport.sendFileResult = { ok: false, reason: "retraction-unconfirmed" };
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as CopilotClient,
      transport,
      new SessionStore(storeFile),
      new ChannelRegistry(PARENT, GUILD, path.join(root, "channels.json"))
    );
    const workDir = path.join(reposRoot, "repo");
    mkdirSync(workDir, { recursive: true });
    const filePath = path.join(workDir, "report.txt");
    writeFileSync(filePath, "hello");
    const resolver = actorResolving({
      ok: true,
      file: {
        absPath: filePath,
        displayName: "report.txt",
        relativePath: "report.txt",
        size: 5,
        fingerprint: "artifact-identity:5:1",
        digest: "sha256:test",
        bytes: Buffer.from("hello"),
      },
    });
    sessionsOf(app).set(THREAD, session(workDir, resolver.actor));
    const interaction = slash({ pathValue: "report.txt" });

    await invokeInteraction(app, interaction);

    expect(interaction.edits).toHaveLength(1);
    expect(interaction.edits[0]).toMatch(/無法確認.*收回|可能仍.*可見/);
    expect(interaction.edits[0]).not.toContain("已將檔案傳送");
  });

  it("refuses /file before resolution when the injected platform does not support safe delivery", async () => {
    const transport = new FakeTransport();
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as CopilotClient,
      transport,
      new SessionStore(storeFile),
      new ChannelRegistry(PARENT, GUILD, path.join(root, "channels.json")),
      { fileDeliveryPlatform: "linux" }
    );
    const workDir = path.join(reposRoot, "repo");
    const filePath = path.join(workDir, "report.txt");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(filePath, "hello");
    const resolver = actorResolving({
      ok: true,
      file: {
        absPath: filePath,
        displayName: "report.txt",
        relativePath: "report.txt",
        size: 5,
        fingerprint: "artifact-identity:5:1",
        digest: "sha256:test",
        bytes: Buffer.from("hello"),
      },
    });
    sessionsOf(app).set(THREAD, session(workDir, resolver.actor));
    const interaction = slash({ pathValue: "report.txt" });

    await invokeInteraction(app, interaction);

    expect(interaction.edits).toEqual(["檔案傳送在此平台無法使用（僅支援 Windows）。"]);
    expect(resolver.resolveFileForDelivery).not.toHaveBeenCalled();
    expect(transport.sentFiles).toHaveLength(0);
  });
});
