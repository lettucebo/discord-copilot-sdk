import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  ThreadAutoArchiveDuration,
  MessageFlags,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Interaction,
  type ButtonInteraction,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type TextChannel,
} from "discord.js";
import type { CopilotClient } from "@github/copilot-sdk";
import type { Config } from "./config.js";
import type { InstanceLock } from "./core/single-instance.js";
import { sessionStorePath, worktreeRoot, channelRegistryPath } from "./core/paths.js";
import { clearStartupReady } from "./core/startup-ready.js";
import { resolveReposRoot, resolveRepoWithinRoot, listRepos, isStrictlyInside, pathRelation, canonicalPathOr } from "./core/repo.js";
import {
  validateBinding,
  describeBindingProblem,
  type Binding,
  type BindingVerdict,
  type DevMode,
} from "./core/binding.js";
import { RepoProvisioner, sweepStaleStaging } from "./core/repo-provision.js";
import { gitDiffSummary } from "./core/git.js";
import { downloadBounded } from "./core/download.js";
import type { OutboundRefusal } from "./core/outbound-file.js";
import { SessionStore, type SessionIdentity, type SessionRecord } from "./core/session-store.js";
import {
  planReconcile,
  classifyResumeError,
  classifyRecordDisposition,
  type ThreadStatus,
} from "./core/reconcile.js";
import { deriveThreadTitle, THREAD_NAME_MAX } from "./core/thread-name.js";
import { pickTitleModel, buildTitlePrompt, cleanModelTitle } from "./core/title.js";
import {
  isGitRepo,
  repoRoot,
  repoRootStrict,
  addWorktree,
  inspectWorktree,
  removeWorktreeIfClean,
  pruneWorktrees,
  worktreeBranch,
  worktreePath,
} from "./core/worktree.js";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import { sendUnlessAborted } from "./core/turn-gate.js";
import { shouldResetEffort, validateEffort, EFFORT_LEVELS } from "./core/effort.js";
import { createCopilotClient, checkSdkCompat } from "./copilot/sdk.js";
import { PendingInteractionBroker, type PendingView } from "./core/broker.js";
import {
  SessionActor,
  type BlobAttachment,
  type SessionActorCreateDependencies,
  type SessionActorOpts,
  formatTodos,
} from "./copilot/session-actor.js";
import { ApprovalPolicy } from "./core/approval-policy.js";
import { DiscordTransport, NO_MENTIONS } from "./platforms/discord/discord-transport.js";
import {
  botCanViewChannel,
  fetchChannelSafe,
  isObfuscatedChannel,
} from "./platforms/discord/channel-fetch.js";
import {
  decodePermissionId,
  decodeChoiceId,
  decodePlanId,
  decodeRepoId,
  encodeRepoId,
  type RebindAction,
} from "./platforms/discord/custom-id.js";
import { isAuthorized, isOwner, type AuthContext, type AuthPolicy } from "./platforms/discord/auth.js";
import { ChannelRegistry, CONFIG_SEED_ADDED_BY } from "./core/channel-registry.js";
import type { Decision, SendFileResult, Transport } from "./core/transport.js";
import { captureTrustedRoot, type SecureOpenBackend, type TrustedRoot } from "./core/secure-open.js";
import { isFileDeliveryAvailable } from "./core/file-delivery-availability.js";

/** One live Discord thread ↔ Copilot session. Exported so tests can build a
 *  TYPED fixture — an untyped `as Record<string, unknown>` fixture is how a
 *  missing field reaches runtime instead of the typechecker. */
export interface Session {
  actor: SessionActor;
  broker: PendingInteractionBroker;
  running: boolean;
  /** Set while a turn is reserved but the prompt hasn't been handed to the agent
   *  yet (e.g. during image download). /stop aborts this to cancel before send. */
  currentAbort?: AbortController;
  /** True once the thread carries a real title (from /new's prompt option, a
   *  first message, an explicit /rename, or because it is a RESUMED thread that
   *  was already named). Gates the one automatic rename per session. */
  titled: boolean;
  /** Bumped by every explicit /rename. A titler that was already in flight
   *  compares this before writing, so it can never clobber a name the operator
   *  just chose. */
  titleEpoch: number;
  /** Prompts waiting to run after the current turn, added with `/queue`. Held
   *  HERE and not in the runtime's own queue on purpose: `session.abort()` does
   *  NOT drain the runtime queue (verified — a queued message still ran after an
   *  abort), so `/stop` could not honestly stop anything we had pushed there. */
  queue: string[];
  /** Directory this session's agent works in — its own git worktree, or the repo
   *  itself under `local` dev mode. */
  workDir: string;
  /** The repo this session is bound to (canonical, under `REPOS_ROOT`). */
  repoPath: string;
  /** How this session gets its working directory. */
  devMode: DevMode;
  /** Branch checked out in `workDir` when it is a worktree we created. */
  branch?: string;
  /** The channel this session's thread hangs under. Carried HERE rather than
   *  re-derived per call site: with several enabled channels, "the parent" is no
   *  longer a constant, and a site that reached for the config value instead is
   *  exactly the bug that broke rebind (it rewrote every record's parent to the
   *  seed channel, so any session started elsewhere failed to resume). */
  parentChannelId: string;
  /** True once a turn has actually run, i.e. the session carries conversation
   *  history worth warning about before a rebind throws it away. A resumed
   *  session is initialised `true`: preserving history is the entire point of
   *  resume, so by definition it has some. Deliberately NOT derived from
   *  `titled` — `/rename` and resume both set that. */
  hasRunTurn: boolean;
}

/** Fallback-primary reconciliation is needed only when terminal stale ownership
 * could not persist. The target is the exact `creating` reservation retained
 * as the crash-surviving barrier; thread id alone would let a later rebind
 * restore or remove the wrong incarnation. */
interface FallbackPrimaryReconciliationPlan {
  expectedTarget: SessionIdentity;
  /** A failed rebind restores this immutable snapshot only while its original
   * actor is still the current, non-ended session. `/end` flips this to remove
   * before it awaits any teardown, so a late retry cannot resurrect it. */
  action: "restore" | "remove";
  original?: SessionRecord;
  canRestore?: () => boolean;
  /** Drops the pre-swap `/end` routing marker only after the primary restore
   * is durable, so a later `/end` reclaims the restored primary row normally. */
  afterRestore?: () => void;
  resumeFileDelivery?: () => void;
}

/** One old SDK incarnation detached by a rebind. The actor remains strongly
 * referenced until its disconnect resolves, because its retained trusted root
 * is the Windows rename/delete fence for the worktree it was using. */
interface StaleRebindActor {
  actor: SessionActor;
  /** Discord thread whose lifecycle owns this detached incarnation. */
  threadId: string;
  /** Immutable durable identity and the exact old binding/worktree to clean. */
  binding: SessionRecord;
  /** Runs only after a confirmed disconnect; it rechecks worktree safety before
   * deleting anything, then removes the paired terminal store record. */
  cleanupPlan: () => Promise<{ ok: boolean; tail: string }>;
  /** Present only when the primary target reservation had to stand in for a
   * stale row that could not be written. Ownership stays retained until this
   * conditional plan durably completes. */
  fallbackPrimary?: FallbackPrimaryReconciliationPlan;
  /** Concurrent `/end`, normal rebind completion and shutdown must join ONE
   * teardown attempt rather than issue duplicate SDK disconnects. */
  disconnecting?: Promise<StaleRebindTeardown>;
}

interface StaleRebindTeardown {
  confirmed: boolean;
  /** A confirmed SDK disconnect is not enough to claim completion: the
   * worktree and durable ownership row must also be reconciled. */
  cleaned: boolean;
  tail: string;
}

/** The subset of an SDK session the throwaway titler uses. */
interface TitlerSession {
  sessionId?: string;
  on(ev: string, h: (e: unknown) => void): void;
  send(o: Record<string, unknown>): Promise<unknown>;
  disconnect?: () => Promise<unknown>;
}

/** What a bot actually needs to run a session in a channel, and the human name
 *  to report when it is missing. `Manage Threads` is deliberately absent: it is
 *  only used to delete the empty thread a failed `/new` leaves behind, which is
 *  a tidiness feature, not a requirement (see `docs/DISCORD-SETUP.md` §4). */
const REQUIRED_CHANNEL_PERMISSIONS: ReadonlyArray<{ flag: bigint; label: string; fileDeliveryOnly?: true }> = [
  { flag: PermissionFlagsBits.ViewChannel, label: "View Channel" },
  { flag: PermissionFlagsBits.SendMessages, label: "Send Messages" },
  { flag: PermissionFlagsBits.CreatePublicThreads, label: "Create Public Threads" },
  { flag: PermissionFlagsBits.SendMessagesInThreads, label: "Send Messages in Threads" },
  { flag: PermissionFlagsBits.AttachFiles, label: "Attach Files", fileDeliveryOnly: true },
  { flag: PermissionFlagsBits.EmbedLinks, label: "Embed Links" },
  { flag: PermissionFlagsBits.ReadMessageHistory, label: "Read Message History" },
];

/** Accept either a raw channel id or a `<#id>` mention, as `/end thread:<id>`
 *  already does for threads. A raw id is the point: a channel that has been
 *  DELETED, or that the bot can no longer see, cannot be picked from a channel
 *  option, and that is exactly the one an operator needs to remove. */
export function parseChannelRef(raw: string | null | undefined): string | undefined {
  const t = (raw ?? "").trim();
  if (!t) return undefined;
  const m = /^<#(\d{5,25})>$/.exec(t);
  if (m) return m[1];
  return /^\d{5,25}$/.test(t) ? t : undefined;
}

function privateChannelAccessGuidance(channelId: string): string {
  return (
    `我看不到頻道 \`${channelId}\`，所以無法安全地啟用它。` +
    "請先到該私密頻道的「編輯頻道 → 權限 → 新增成員或身分組」把這個 bot 加進去，" +
    "確認它有 View Channel，再重新執行 `/channel enable`。"
  );
}

function ephemeralReply(content: string): {
  content: string;
  flags: MessageFlags.Ephemeral;
  allowedMentions: typeof NO_MENTIONS.allowedMentions;
} {
  return { content, ...EPHEMERAL, ...NO_MENTIONS };
}

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

export function restrictCommandDefaults<T extends object>(
  commands: readonly T[]
): Array<T & { default_member_permissions: "0" }> {
  return commands.map((command) => ({ ...command, default_member_permissions: "0" }));
}

/** Most prompts `/queue` will hold. A queue is a convenience, not a job runner;
 *  an unbounded one just defers a pile of work the operator has forgotten
 *  about onto an unattended machine. */
const QUEUE_MAX = 10;

/** How long a repo-rebind confirmation card stays live. Shorter than the
 *  5-minute permission timeout on purpose: this one blocks nothing (the session
 *  keeps working), and a stale "shall I throw away your history?" button sitting
 *  around for five minutes is more likely to be clicked by accident than
 *  answered deliberately. */
const REBIND_CONFIRM_TIMEOUT_MS = 120_000;

/** What a rebind confirmation settles to. */
type RebindDecision = RebindAction;

/** The two buttons on a rebind confirmation. `Danger` on confirm because the
 *  action is irreversible: it discards the conversation. */
function rebindButtons(nonce: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeRepoId(nonce, "confirm"))
      .setLabel("切換（放棄目前對話）")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(encodeRepoId(nonce, "cancel"))
      .setLabel("取消")
      .setStyle(ButtonStyle.Secondary)
  );
}

/** A reconcile failure that must stop startup (a required state transition
 *  could not be persisted), as opposed to one bad record we can skip past. */
class FatalReconcileError extends Error {}

/** Most sessions that may be live at once. Each holds a runtime session, a
 *  worktree and a Discord thread; an unbounded number of them on an unattended
 *  lab machine is a resource leak, not a feature. */
const MAX_LIVE_SESSIONS = 8;

/** Where per-session worktrees live — see `worktreeRoot()` in `core/paths.ts`,
 *  which owns the definition because it is half of a security boundary that
 *  `resolveReposRoot`, `validateBinding`, the stray scan and the uninstaller all
 *  have to agree on. */

/** Milliseconds a single session teardown may take during /new before we give
 *  up on it (and keep it for a later retry) rather than stalling. */
const TEARDOWN_TIMEOUT_MS = 5_000;

/** Milliseconds the thread titler may take. Generous enough for a cold model
 *  start, short enough that a wedged titler falls back to the local heuristic
 *  while the thread name still matters. */
const TITLE_TIMEOUT_MS = 25_000;

/**
 * Wake-ups for the same-process access-restoration retry (ADR-0002).
 *
 * ADR-0002 promises a `thread-no-access` session resumes once the bot's channel
 * access is restored **or** the bot restarts. Only the restart half was real:
 * `reconcileOnStartup` had exactly one production caller. Regaining access does
 * emit a `CHANNEL_UPDATE` for the CHANNEL, but that event neither names the
 * bound threads it makes resumable nor guarantees anything about a thread
 * object the bot may never have cached — a useful hint, not a correctness
 * source. A bounded periodic scan is. An event may only ever poke this loop; it
 * may never be the only trigger.
 *
 * The cadence escalates while a scan keeps finding nothing to resume, so a
 * permission left revoked for days costs one wake-up every five minutes rather
 * than one every fifteen seconds, and resets the moment a resume succeeds. With
 * no candidates at all it idles at the longest interval.
 */
const ACCESS_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;

/** Timer seam for `ACCESS_RETRY_DELAYS_MS`. Tests replace it with a queue they
 *  fire by hand: real waits would be slow/flaky, and freezing global timers
 *  would also freeze the SDK and git timeouts this same app owns. */
interface AccessRetryScheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/**
 * How one reconcile attempt was started, and how it learns it must stop.
 *
 * `cancelled` is the retry loop's cancellation token. Startup passes none — its
 * semantics are unchanged, and it runs before the phase gate opens — but a retry
 * attempt awaits Discord, git and the runtime while `stop()` is free to run to
 * completion and release the single-instance lock. Without a token, a
 * classification that resolves after that would happily persist a terminal
 * state, drop a repo lease and post a Discord message on behalf of a process
 * that no longer owns any of it (and whose replacement may already be running
 * against the same store).
 */
interface ReconcileAttemptOpts {
  via?: "startup" | "access-retry";
  cancelled?: () => string | undefined;
}

/** Format an executable list for a compact reply. */
function fmtList(items: string[]): string {
  return items.length ? items.map((e) => `\`${e}\``).join(", ") : "(none)";
}

/** Reject if `p` doesn't settle within `ms` (the pending work keeps running). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    (t as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** Ack the Discord button interaction BEFORE settling the decision. On ack
 *  success the user's decision is delivered; on ack failure the SAFE default
 *  (deny) is delivered instead, so an Allow never runs while Discord shows an
 *  error. Pure + exported for unit tests. */
export async function resolveButtonAck(
  ack: () => Promise<unknown>,
  deliver: (d: Decision) => void,
  action: Decision
): Promise<void> {
  try {
    await ack();
  } catch {
    deliver("deny");
    return;
  }
  deliver(action);
}

/** Cross-thread guard (§9: "跨 thread 點擊無法 resolve"). A permission/choice/plan
 *  decision may only settle a nonce whose owning session is the very thread the
 *  interaction arrived from. The nonce is unique + Discord-validated, so this is
 *  defense-in-depth: returns true iff the pending request exists AND its
 *  sessionKey matches the interaction's channel; false for a missing pending
 *  (expired) or a mismatched channel (a click from another thread). */
export function decisionBindsToChannel(
  pending: { sessionKey: string } | undefined,
  channelId: string
): boolean {
  return pending !== undefined && pending.sessionKey === channelId;
}

/**
 * The session keys `/approvals` must act on. v1 runs ONE live session, and the
 * command is usable from the parent channel as well as from a session thread —
 * so scoping to `interaction.channelId` meant `/approvals clear:true` run from
 * the parent channel cleared only the on-disk repo rules while the LIVE
 * session's in-memory rules survived, under a reply that said "Cleared
 * approvals … Future commands will prompt again." A false revocation claim on a
 * security control is worse than no command, so "clear my approvals" means every
 * live session, wherever the command was typed. (Torn-down threads hold no
 * in-memory rules, so an empty result is genuinely nothing to clear.)
 */
export function approvalScopeKeys(liveSessionKeys: Iterable<string>): string[] {
  return [...new Set(liveSessionKeys)];
}

/**
 * Whether a message arrived in a thread WE created under the configured parent
 * channel — i.e. a thread that once carried a session and no longer does.
 *
 * `/new` ends the previous session (v1 runs one at a time), after which typing
 * into the old thread did nothing at all: `onMessage` returned silently because
 * there was no live session for that channel. The thread does carry a "this one
 * has ended" notice from when it was superseded, but anything typed afterwards
 * vanished with no explanation.
 *
 * Deliberately narrow, and fails closed on anything unknown: we only speak in
 * threads the bot itself opened under an ENABLED channel, never in the channel
 * itself and never in the operator's own threads.
 */
export function isOurEndedThread(o: {
  channelIsThread: boolean;
  threadParentId?: string;
  threadOwnerId?: string;
  /** Every channel the bot currently answers in (seed + `/channel enable`). */
  enabledParentChannelIds: ReadonlySet<string>;
  botUserId?: string;
}): boolean {
  if (!o.channelIsThread) return false;
  if (!o.threadParentId || !o.enabledParentChannelIds.has(o.threadParentId)) return false;
  if (!o.botUserId || !o.threadOwnerId || o.threadOwnerId !== o.botUserId) return false;
  return true;
}

/**
 * Apply a `/yolo` toggle with the ack-before-allow invariant (same rule as
 * `resolveButtonAck`): turning the guard OFF (`on === true`, i.e. enabling
 * blanket approval) happens only after Discord has ACKNOWLEDGED the warning, so
 * a failed reply can never leave a session silently unguarded. Turning YOLO off
 * is applied FIRST, because failing to confirm that must still be safe.
 *
 * Interaction handlers run concurrently, so the deferred enable is also FENCED:
 * the toggle epoch is snapshotted before the ack and the enable is dropped if
 * anything toggled meanwhile. Without it, `/yolo on` (slow ack) racing a
 * `/yolo off` could land AFTER the off, leaving the operator staring at an "OFF"
 * confirmation while permissions are auto-approved.
 *
 * Returns whether YOLO ended up enabled by this call.
 */
export interface YoloControl {
  /** Current toggle epoch (bumped by every toggle). */
  epoch: () => number;
  /** Disable immediately (also bumps the epoch). */
  disable: () => void;
  /** Enable iff `epoch` is still current; returns whether it applied. */
  enableIfCurrent: (epoch: number) => boolean;
}

export async function applyYoloToggle(
  on: boolean,
  ack: () => Promise<unknown>,
  ctl: YoloControl
): Promise<boolean> {
  if (!on) {
    ctl.disable(); // safe direction: apply immediately, confirm best-effort
    await ack().catch(() => {});
    return false;
  }
  const epoch = ctl.epoch(); // snapshot BEFORE awaiting Discord
  await ack(); // throws ⇒ YOLO stays OFF (fail-safe)
  return ctl.enableIfCurrent(epoch); // superseded by a later toggle ⇒ no-op
}

/** Full acknowledgement text shown before enabling YOLO. Repository skill
 * descriptions are controlled-repo text in the model context; spell out that
 * YOLO removes the human approval boundary that normally constrains this risk. */
function yoloFileDeliveryMessage(fileDeliveryAvailable: boolean): string {
  return fileDeliveryAvailable
    ? "• `discord_send_file` is fast-denied in YOLO; to deliver a file, use `/file path:<file>`.\n"
    : "• Outbound Discord file delivery is unavailable on this platform.\n";
}

export function yoloOnWarning(repoSkillsLoaded: boolean, fileDeliveryAvailable: boolean): string {
  return (
    "⚠️ **YOLO ON for this thread** — other permission requests are auto-approved with **no prompt**. " +
    "Tools run as your OS user with no sandbox.\n" +
    yoloFileDeliveryMessage(fileDeliveryAvailable) +
    "• This is **not** persisted: a restart or session recovery resets it to OFF.\n" +
    (repoSkillsLoaded
      ? "• ⚠️ This session loaded repository skills. Their text can steer the agent, and YOLO removes the Discord approval gate that normally constrains that risk.\n"
      : "") +
    "• Turn it off with `/yolo mode:off`."
  );
}

/**
 * App state-machine tests intentionally use synthetic workdirs. Their actors
 * need an opaque root capability to reach SDK wiring, but must never gain file
 * resolution: a candidate open is always rejected and no OS handle is held.
 */
function createForTestActorDependencies(fileDeliveryPlatform: NodeJS.Platform): SessionActorCreateDependencies {
  const backend: SecureOpenBackend = {
    async open(): Promise<never> {
      throw new Error("createForTest roots must not open file candidates.");
    },
    async openDirectory(trustedRoot) {
      if (!path.isAbsolute(trustedRoot)) {
        throw new Error("createForTest roots require an absolute workdir.");
      }
      const finalPath = path.resolve(trustedRoot);
      const proof = Object.freeze({
        finalPath,
        identity: `create-for-test:${finalPath}`,
        directory: true,
      });
      return {
        ...proof,
        // Synthetic test roots have no OS descriptor; this test-only backend
        // models a stable handle path without weakening the production backend.
        validationPath: finalPath,
        revalidate: async () => proof,
        close: async () => {},
      };
    },
  };
  return { secureOpen: { backend }, fileDeliveryPlatform };
}

/**
 * Composition root: owns the single-instance lock, the Copilot SDK client, the
 * Discord gateway connection, and the per-thread SessionActor map. Wires the
 * three input surfaces (slash commands, thread messages, permission buttons)
 * through the auth gate to the orchestration core, and shuts everything down in
 * reverse order (lock released last).
 */
export class DiscordCopilotApp {
  private readonly discord: Client;
  private readonly transport: Transport;
  private readonly sessions = new Map<string, Session>();
  /** Exact session instances that an explicit teardown has claimed. A rebind
   * snapshots the old object before awaiting git/SDK work, so map identity alone
   * cannot tell it that `/end` is already tearing that same object down. */
  private readonly endedSessions = new WeakSet<Session>();
  private readonly allowedUserIds: ReadonlySet<string>;
  /** Durable set of channels the bot acts in (seed + `/channel enable`). */
  private readonly channels: ChannelRegistry;
  /** Shared approval memory (session + persisted repo rules) across sessions. */
  private readonly approvals = new ApprovalPolicy();
  private modelIds: string[] = [];
  private readonly modelEfforts = new Map<string, string[]>();
  private shuttingDown = false;
  /** Threads already told their session is spent, so the courtesy notice is
   *  posted once rather than on every message. Volatile: a restart may repeat it
   *  once, which is harmless. */
  private readonly endedHinted = new Set<string>();
  /** Serializes /new so two near-simultaneous creations can't both pass the
   *  "one live session" teardown and leave two live sessions. */
  private creating = false;
  /** Durable thread↔session record for crash-safe resume (P2). */
  private readonly store: SessionStore;
  /** Startup phase gate (P2): input is rejected until reconciliation completes,
   *  so a /new can't race startup resume and create a second live actor. */
  private phase: "booting" | "reconciling" | "ready" | "shuttingDown" = "booting";
  /** Canonical `REPOS_ROOT` — the directory that contains every bindable repo.
   *  Resolved once at startup by `resolveReposRoot`. */
  private reposRoot = "";
  /** Repos currently held by a live `local`-mode session, canonical path → thread
   *  id. Two agents in one checkout silently overwrite each other, so this is a
   *  hard mutual exclusion, not a warning. Taken during reconcile BEFORE any
   *  resume, and held across a transient resume failure. */
  private readonly localLeases = new Map<string, string>();
  /** Seam for the git-backed binding proof. Production always uses the real
   *  `validateBinding`; `reconcileOnStartup` lets a test inject one so the
   *  reconcile state machine can be exercised without building real repos on
   *  disk for every case. */
  private bindingCheck: typeof validateBinding = validateBinding;
  /** The thread classifier reconciliation actually used. Captured so the
   *  access-retry loop re-runs the SAME classification/resume path instead of
   *  growing a second, subtly different state machine beside it. */
  private reconcileClassify: (
    threadId: string,
    expectedParentChannelId: string,
    opts?: { force?: boolean }
  ) => Promise<ThreadStatus> = (id, parent, opts) => this.classifyThread(id, parent, opts);
  /** Timer seam for the access-restoration retry loop; production uses an
   *  unref'd `setTimeout` so a pending wake-up never holds the process open. */
  private accessRetryScheduler: AccessRetryScheduler = {
    set(fn: () => void, ms: number): unknown {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    },
    clear(handle: unknown): void {
      clearTimeout(handle as NodeJS.Timeout);
    },
  };
  /** The single armed wake-up. One timer, always cleared before re-arming, so
   *  two overlapping loops cannot exist and double-resume a record. */
  private accessRetryTimer?: unknown;
  /** The tick in flight, if any. Doubles as the no-overlap fence (a tick awaits
   *  SDK work, so a second wake-up can otherwise land inside the first). */
  private accessRetryTickPromise?: Promise<void>;
  /** Index into `ACCESS_RETRY_DELAYS_MS`. */
  private accessRetryBackoff = 0;
  /** True when the last tick found nothing to recover. Idling at the longest
   *  delay keeps an otherwise-quiet bot from waking every 15 seconds for ever,
   *  without making "a candidate can never appear later" a correctness
   *  assumption. */
  private accessRetryIdle = false;
  /** Threads a retry is resuming RIGHT NOW → a promise that settles only once
   *  that whole attempt, INCLUDING any discard and barrier registration, is
   *  finished. Published before the attempt's first await so `/end` and `stop()`
   *  can join the real thing rather than race a timeout against it. */
  private readonly accessResumeSettled = new Map<string, Promise<void>>();
  /** How long `/end` and `stop()` wait for such an attempt before giving up on
   *  it. A test seam: safety does not depend on this value — an attempt that has
   *  not settled makes `/end` refuse, and one that outlives `stop()` is fenced
   *  by its cancellation token — only on how long a caller waits to find out. */
  private accessResumeJoinTimeoutMs = TEARDOWN_TIMEOUT_MS;
  /** Bumped when this process gives up ownership of its durable state (today:
   *  `stop()`). Every retry attempt captures it and re-checks it after each
   *  await, so an attempt that outlives the shutdown it raced cannot write to a
   *  store, drop a lease or post a message on behalf of a process that has
   *  already released its single-instance lock. */
  private accessRetryEpoch = 0;
  /** Bound on one discard/barrier disconnect attempt. Same seam, same reason:
   *  a test must be able to exercise a HANGING teardown, not only one that
   *  rejects immediately, without spending the real bound. */
  private resumeTeardownTimeoutMs = TEARDOWN_TIMEOUT_MS;
  /** Threads an explicit teardown has claimed but not yet finished. `/end` sets
   *  this synchronously, before its own first await, because its record removal
   *  happens several awaits later — long enough for a retry to resume and
   *  register a session that `/end` would then leave live with no record, and
   *  with its local lease released. */
  private readonly endClaims = new Map<string, number>();
  /** Threads already told, once, that a retry reached the runtime and failed
   *  transiently. Volatile on purpose: a restart may repeat it once. */
  private readonly accessRetryNoticed = new Set<string>();
  /** Sessions a retry resumed and then had to discard, whose runtime could NOT
   *  be confirmed stopped. Held STRONGLY: on Windows the reference is the only
   *  thing keeping the root capability alive, and that capability is what stops
   *  a maybe-live runtime from being handed a deleted working tree. */
  private readonly unconfirmedResumes = new Map<string, { actor: SessionActor; binding: SessionRecord }>();
  /** The one teardown, so every later caller joins it instead of returning from
   *  a shutdown that is still half done. */
  private stopPromise?: Promise<void>;
  /** Only createForTest sets this. Production must capture a native trusted
   * root, while app state-machine fixtures receive an opaque fail-closed root. */
  private actorCreateDependencies?: SessionActorCreateDependencies;
  /** Test-only substitute for the Git common-dir proof. State-machine fixtures
   * intentionally use nonexistent roots, so production's strict lookup cannot
   * run there; every production path leaves this unset. */
  private approvalKeyForTest?: (validationPath: string) => Promise<string>;
  /** Threads with a clone/init in flight. A clone can take minutes, during which
   *  a second one in the same thread would race for the same destination. */
  private readonly provisioning = new Set<string>();
  /** Threads with a rebind in progress. Two `applyRebind` runs on one thread
   *  would each create a session and each `sessions.set`, leaving the loser's
   *  SDK session live but referenced by nothing. */
  private readonly rebinding = new Set<string>();
  /** Detached rebind incarnations, whether the detached actor was the old
   * session after a swap or a replacement that lost the race before install.
   * Each entry has a paired durable `blocked` stale-rebind record. Keeping this
   * map strongly owns its actor/root until disconnect is confirmed; otherwise
   * a GC-released root could let a possibly-live runtime write a renamed or
   * deleted worktree. */
  private readonly staleRebindActors = new Map<SessionActor, StaleRebindActor>();
  /** An old incarnation is made durable before rebind overwrites its main
   * thread record. `/end` can arrive while target creation is still suspended;
   * this lets that winner terminalize the OLD binding instead of leaving the
   * target reservation as the only on-disk pointer. */
  private readonly pendingRebindOlds = new WeakMap<Session, StaleRebindActor>();
  /** The pending rebind confirmation per thread, so a second `/repo set` can
   *  supersede the first instead of leaving two live cards that can both be
   *  confirmed. */
  private readonly rebindCards = new Map<string, string>();
  /** See `provisioner()` — one instance, because its lease is instance state. */
  private repoProvisioner?: RepoProvisioner;

  /** Production availability is intentionally derived from the host platform.
   * Tests inject a platform through the actor dependency seam so Windows-only
   * descriptor behavior remains testable on every CI host. */
  private fileDeliveryAvailable(): boolean {
    return isFileDeliveryAvailable(this.actorCreateDependencies?.fileDeliveryPlatform ?? process.platform);
  }

  private constructor(
    private readonly config: Config,
    private readonly copilot: CopilotClient,
    private readonly lock: InstanceLock,
    transportOverride?: Transport,
    storeOverride?: SessionStore,
    channelsOverride?: ChannelRegistry
  ) {
    this.discord = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.transport = transportOverride ?? new DiscordTransport(this.discord);
    this.store = storeOverride ?? new SessionStore(sessionStorePath());
    this.channels =
      channelsOverride ??
      new ChannelRegistry(
        this.config.DISCORD_PARENT_CHANNEL_ID,
        this.config.DISCORD_GUILD_ID,
        channelRegistryPath()
      );
    this.allowedUserIds = new Set(this.config.DISCORD_ALLOWED_USER_IDS);
  }

  /**
   * The authorization policy AS OF RIGHT NOW.
   *
   * Rebuilt per check instead of captured in the constructor: `/channel enable`
   * would otherwise need a restart to take effect, and `/channel disable` would
   * keep authorizing a channel the operator just revoked. The registry is
   * persist-first, so anything this reports is already on disk.
   */
  private policyNow(): AuthPolicy {
    return {
      allowedUserIds: this.allowedUserIds,
      guildId: this.config.DISCORD_GUILD_ID,
      parentChannelIds: this.channels.enabledSet(),
    };
  }

  /** Keep every SessionActor creation path on the same skill-source policy.
   *  Duplicating these conversions at /new, /repo rebind and resume would let a
   *  restart silently load a different trust boundary than a fresh session. */
  private skillSourceOptions(): { enableRepoSkills: boolean; enableUserSkills: boolean } {
    return {
      enableRepoSkills: this.config.ENABLE_REPO_SKILLS === "true",
      enableUserSkills: this.config.ENABLE_USER_SKILLS === "true",
    };
  }

  /** Keep every actor tied to the record that owns its logical Discord thread.
   *  The callback is deliberately required even in createForTest, so no actor
   *  can send attachments against an in-memory-only quota. */
  private fileDeliveryQuotaOptions(
    threadId: string,
    initialFileDeliveryBytes: number,
    sessionId: string,
    generation: number
  ): Pick<SessionActorOpts, "initialFileDeliveryBytes" | "fileDeliverySessionId" | "reserveFileDeliveryBytes"> {
    return {
      initialFileDeliveryBytes,
      fileDeliverySessionId: sessionId,
      reserveFileDeliveryBytes: (boundSessionId, boundGeneration, nextTotal, expectedCurrent) =>
        this.store.reserveFileDeliveryBytes(
          threadId,
          boundSessionId,
          boundGeneration,
          expectedCurrent,
          nextTotal
        ),
    };
  }

  /**
   * On Windows capture the root BEFORE any git proof observes it. Git receives
   * the capability's handle-bound validation path, not its mutable final
   * pathname; otherwise an attacker can swap a root around the proof and
   * restore the captured directory before actor creation. On POSIX there is no
   * safe descriptor-to-SDK-cwd handoff, so file delivery is unavailable and no
   * root capability is opened; normal session binding still uses the pathname.
   *
   * On a failed verdict or approval-key proof this method closes any captured
   * capability itself. On success a Windows capability transfers ownership to
   * the caller, which must either hand it to SessionActor.create() or close it
   * on its own failure path.
   */
  private async captureValidatedRoot(
    binding: Binding
  ): Promise<
    | { ok: true; trustedRoot?: TrustedRoot; binding: Binding; approvalKey: string }
    | { ok: false; verdict: Exclude<BindingVerdict, { ok: true }> }
  > {
    const trustedRoot = this.fileDeliveryAvailable()
      ? await captureTrustedRoot(binding.workDir, this.actorCreateDependencies?.secureOpen)
      : undefined;
    const validationBinding: Binding = {
      ...binding,
      workDir: trustedRoot?.validationPath ?? binding.workDir,
    };
    let verdict: BindingVerdict;
    try {
      verdict = await this.bindingCheck(validationBinding, {
        reposRoot: this.reposRoot,
        worktreeRoot: worktreeRoot(),
      });
    } catch (error) {
      await trustedRoot?.close().catch(() => {});
      throw error;
    }
    if (!verdict.ok) {
      await trustedRoot?.close().catch(() => {});
      return { ok: false, verdict };
    }
    let approvalKey: string;
    try {
      // The approval key is a security-relevant repository identity, not a
      // display label. Derive it only after binding succeeds, from the same
      // retained descriptor path Git just proved owns this worktree.
      approvalKey = await this.approvalKeyFor(validationBinding.workDir);
    } catch (error) {
      await trustedRoot?.close().catch(() => {});
      throw error;
    }
    // Persist and hand the SDK the handle's final display path on Windows. The
    // descriptor capability remains the file-security boundary after this proof.
    return {
      ok: true,
      ...(trustedRoot ? { trustedRoot } : {}),
      binding: { ...binding, workDir: trustedRoot?.finalPath ?? binding.workDir },
      approvalKey,
    };
  }

  /**
   * Ephemeral refusal for anything that failed the gate.
   *
   * Two different answers on purpose. A caller who is not on the allow-list
   * learns nothing at all — the terse form leaks neither the channel policy nor
   * the existence of `/channel`. The OPERATOR, who already knows everything
   * here, gets the one fact they need: this channel is not enabled, and how to
   * enable it (including from another enabled channel, because a correctly locked-down
   * server hides `/channel` in the very channel they are standing in).
   *
   * It has to be a reply at all: Discord invalidates an unanswered interaction
   * after 3s and shows "The application did not respond", which reads as a
   * broken bot rather than a deliberate refusal.
   */
  private async refuseUnauthorized(
    interaction: ChatInputCommandInteraction | ButtonInteraction
  ): Promise<void> {
    const content = isOwner(ctxOf(interaction), this.policyNow())
      ? `⚠️ 這個頻道尚未啟用。在這裡執行 \`/channel enable\`，或在已啟用頻道執行 ` +
        `\`/channel enable channel:${interaction.channelId}\`。詳見 \`docs/CHANNEL-ACCESS.md\`。`
      : "Not authorized.";
    await interaction.reply({ content, ...EPHEMERAL });
  }

  /** Test-only seam: construct the app with an injected transport + store (and
   *  fake copilot/lock), skipping the lock/SDK/login startup, so unit tests can
   *  drive the real runTurn/stop/reconcile wiring without a live Discord
   *  connection. Not used in production (start() is the only production entry).
   *
   *  `reposRoot` is set directly rather than resolved: the filesystem checks in
   *  `resolveReposRoot` are covered by their own tests, and requiring a real
   *  directory here would make every app-level test build one.
   *
   *  `channels` MUST be injectable: without it every app-level test would load
   *  the real `~/.discord-copilot-sdk` registry of whoever runs the suite. */
  static createForTest(
    config: Config,
    reposRoot: string,
    copilot: CopilotClient,
    transport: Transport,
    store?: SessionStore,
    channels?: ChannelRegistry,
    options: { fileDeliveryPlatform?: NodeJS.Platform } = {}
  ): DiscordCopilotApp {
    const noopLock: InstanceLock = { path: "(test)", release: async () => {} };
    const app = new DiscordCopilotApp(config, copilot, noopLock, transport, store, channels);
    app.reposRoot = reposRoot;
    app.actorCreateDependencies = createForTestActorDependencies(options.fileDeliveryPlatform ?? "win32");
    app.approvalKeyForTest = async (validationPath) => validationPath;
    return app;
  }

  /** Fully start after bootstrap has already acquired the instance lock. */
  static async start(config: Config, lock: InstanceLock): Promise<DiscordCopilotApp> {
    let copilot: CopilotClient | undefined;
    let app: DiscordCopilotApp | undefined;
    try {
      // INSIDE the try, both of them. Ownership of `lock` transfers to this
      // function the moment it is CALLED (see `BotRuntime.start`), so a throw
      // that escapes before the catch below leaves the lock held by nobody —
      // bootstrap will not release it, and this process is about to die. These
      // two are the earliest things that can fail: a REPOS_ROOT that does not
      // exist or overlaps the trust store, and an SDK version mismatch.
      const reposRoot = resolveReposRoot(config.REPOS_ROOT);
      const compat = checkSdkCompat();
      if (!compat.ok) {
        // Fatal in bot mode: our event-field and permission-shape assumptions are
        // pinned to the declared SDK version; a mismatch could silently break
        // streaming or, worse, permission handling.
        throw new Error(
          `Installed @github/copilot-sdk ${compat.installed} != declared ${compat.declared}. ` +
            `Refusing to start the bot; run \`npm install\` to align.`
        );
      }
      // A NEUTRAL working directory. Every session sets its own, and pointing the
      // shared client at a repo would make whichever repo happens to be
      // "default" the implicit cwd for anything that forgets to.
      copilot = createCopilotClient();
      await copilot.start();
      await preflightModel(copilot, config.DEFAULT_MODEL);
      app = new DiscordCopilotApp(config, copilot, lock);
      app.reposRoot = reposRoot;
      // Before the gateway, not after: a registry we cannot trust must not reach
      // a state where the bot is online and answering with the wrong channel set.
      app.assertChannelRegistryUsable();
      await app.login();
      return app;
    } catch (err) {
      // Full teardown on any startup failure. If the app was constructed, its
      // stop() also destroys the (possibly logged-in) Discord client — so a
      // registration failure after gateway-ready doesn't leak a connection — and
      // stop() alone decides the lock's fate. Otherwise the lock is still ours.
      if (app) await app.stop().catch(() => {});
      else {
        if (copilot) await copilot.stop().catch(() => {});
        await lock.release().catch(() => {});
      }
      throw err;
    }
  }

  /**
   * Refuse to run on an untrustworthy channel registry.
   *
   * Deliberately fatal rather than "fall back to the configured default": that
   * fallback silently narrows the authorized set, and the reconcile pass that
   * follows would mark every session under a secondary channel `blocked` —
   * terminal, so re-enabling the channel afterwards does not bring the
   * conversations back. Losing a boot is recoverable; losing them is not.
   */
  private assertChannelRegistryUsable(): void {
    if (!this.channels.isCorrupt()) return;
    throw new Error(
      `channel registry at ${channelRegistryPath()} cannot be trusted: ${this.channels.corruptReason()}. ` +
        `Refusing to start rather than silently falling back to ${this.config.DISCORD_PARENT_CHANNEL_ID} alone, ` +
        `which would permanently block every session under another channel. ` +
        `Inspect or delete the file (channels can be re-added with /channel enable) and restart.`
    );
  }

  /** Resolve the repo a name refers to, or throw with a readable reason. */
  private repoByName(name: string): string {
    return resolveRepoWithinRoot(this.reposRoot, name);
  }

  /** The repo `/new` binds to when no `repo:` was given, or undefined. */
  private defaultRepo(): string | undefined {
    const name = this.config.DEFAULT_REPO;
    if (!name) return undefined;
    try {
      return this.repoByName(name);
    } catch {
      return undefined;
    }
  }

  /**
   * Identity that "always allow for this repo" rules are stored under.
   *
   * Follows the REPOSITORY, not the per-session checkout: with worktrees every
   * session has a different `workDir`, so keying on that would silently
   * re-prompt for a command the operator already trusted in this repository.
   * This is intentionally strict: sharing an approval across the wrong repo is
   * a security boundary failure, not merely an extra prompt. Callers may invoke
   * it only after validateBinding has proved this descriptor-backed path.
   */
  private async approvalKeyFor(validationPath: string): Promise<string> {
    if (this.approvalKeyForTest) return this.approvalKeyForTest(validationPath);
    return repoRootStrict(validationPath);
  }

  /** Display-only fallback for `/approvals`; actor approval keys are always
   * derived through approvalKeyFor() after descriptor-backed binding. */
  private async displayApprovalKeyFor(repoPath: string): Promise<string> {
    return (await isGitRepo(repoPath)) ? repoRoot(repoPath) : repoPath;
  }

  /** Log in and resolve only once the gateway is ready AND slash commands are
   *  registered — so a registration failure fails startup (with cleanup) rather
   *  than leaving a logged-in bot with no usable commands. */
  private async login(): Promise<void> {
    this.discord.on(Events.InteractionCreate, (i) => void this.onInteraction(i));
    this.discord.on(Events.MessageCreate, (m) => void this.onMessage(m));
    this.installSignalHandlers();
    await new Promise<void>((resolve, reject) => {
      this.discord.once(Events.ClientReady, (c) => {
        this.onReady(c.user.id).then(resolve, reject);
      });
      this.discord.login(this.config.DISCORD_BOT_TOKEN).catch(reject);
    });
  }

  private async onReady(clientId: string): Promise<void> {
    await this.loadModels();
    await this.warnOperatorsWithoutCommandAccess();
    await this.registerCommands(clientId);
    // Reconcile persisted sessions BEFORE accepting input (phase gate), so a
    // /new can't race startup resume and double-register a thread.
    this.phase = "reconciling";
    await this.reconcileOnStartup();
    // Clear scratch left by a clone that died mid-flight. Safe here: nothing is
    // provisioning yet, and only directories carrying our own marker are swept.
    await sweepStaleStaging(this.reposRoot);
    this.phase = "ready";
    // ADR-0002's other half: a `thread-no-access` record must also come back
    // WITHOUT a restart, once the permission is restored. Armed only now, so a
    // tick can never race the startup pass for the same thread.
    this.startAccessRetryLoop();
    const repos = listRepos(this.reposRoot);
    const dflt = this.config.DEFAULT_REPO;
    console.log(
      `✅ discord-copilot-sdk ready — repos root ${this.reposRoot} (${repos.length} repo(s))\n` +
        `   default repo=${dflt ?? "(none — /new needs repo:)"} · new sessions get their own git worktree\n` +
        `   guild=${this.config.DISCORD_GUILD_ID} configuredDefaultChannel=${this.config.DISCORD_PARENT_CHANNEL_ID}` +
          ` enabledChannels=${this.channels.enabledSet().size}\n` +
        `   model=${this.config.DEFAULT_MODEL} contextTier=${this.config.DEFAULT_CONTEXT_TIER} (${this.modelIds.length} models)\n` +
        `   concurrent sessions: up to ${MAX_LIVE_SESSIONS}\n` +
        `   ⚠️  lab mode: tools run as this OS user with no sandbox. The bot uses your\n` +
        `      logged-in Copilot, so any saved "always allow" rules bypass the Discord prompt.`
    );
    if (dflt && !this.defaultRepo()) {
      console.warn(
        `⚠️  DEFAULT_REPO=${dflt} is not a usable repo under ${this.reposRoot}. ` +
          `/new will require an explicit repo: until that is fixed.`
      );
    }
    if (!this.channels.has(this.config.DISCORD_PARENT_CHANNEL_ID)) {
      console.warn(
        `⚠️  DISCORD_PARENT_CHANNEL_ID=${this.config.DISCORD_PARENT_CHANNEL_ID} is only imported when ` +
          `the channel registry is first created. It is currently disabled; use /channel enable to change ` +
          `the durable whitelist.`
      );
    }
  }

  private async warnOperatorsWithoutCommandAccess(): Promise<void> {
    try {
      const guild = await this.discord.guilds.fetch(this.config.DISCORD_GUILD_ID);
      for (const userId of this.config.DISCORD_ALLOWED_USER_IDS) {
        if (userId === guild.ownerId) continue;
        try {
          const member = await guild.members.fetch(userId);
          if (member.permissions.has(PermissionFlagsBits.Administrator)) continue;
          console.warn(
            `⚠️  allowed Discord user ${userId} is not this guild's owner or an Administrator. ` +
              `Commands default to hidden for non-admins; add a user override in ` +
              `Server Settings → Integrations if this operator should use them.`
          );
        } catch (err) {
          console.warn(
            `⚠️  could not verify command access for allowed Discord user ${userId}: ` +
              `${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    } catch (err) {
      console.warn(
        `⚠️  could not verify allowed users' Discord Administrator access: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Snapshot the available models + their supported reasoning efforts for the
   *  /model and /effort commands (choices are static once registered). */
  private async loadModels(): Promise<void> {
    try {
      const models = await this.copilot.listModels();
      this.modelIds = models.map((m) => m.id).slice(0, 25);
      for (const m of models) {
        // Store EVERY listed model. Empty array (or absent, per the SDK contract
        // "only present if the model supports reasoning effort") = known "no
        // effort support". A MISSING map entry means the model wasn't in the
        // snapshot at all — which must NOT be treated as unsupported. This
        // three-state distinction gates effort validation in cmdReconfigure.
        const raw = m.supportedReasoningEfforts as string[] | undefined;
        this.modelEfforts.set(m.id, Array.isArray(raw) ? raw : []);
      }
    } catch (err) {
      console.warn(`⚠️  could not list models for /model choices: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async registerCommands(clientId: string): Promise<void> {
    const modelChoices = this.modelIds.slice(0, 25).map((id) => ({ name: id, value: id }));
    const commands = [
      new SlashCommandBuilder()
        .setName("new")
        .setDescription("Start a new Copilot session in a thread")
        .addStringOption((o) =>
          o.setName("prompt").setDescription("Optional first prompt").setRequired(false)
        )
        .addStringOption((o) =>
          o
            .setName("repo")
            .setDescription("Repo under REPOS_ROOT (defaults to DEFAULT_REPO)")
            .setRequired(false)
            .setAutocomplete(true)
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName("repo")
        .setDescription("Which repo this thread works in, and how")
        .addSubcommand((s) => s.setName("show").setDescription("What this thread is bound to"))
        .addSubcommand((s) => s.setName("list").setDescription("Repos available under REPOS_ROOT"))
        .addSubcommand((s) =>
          s
            .setName("set")
            .setDescription("Bind this thread to a different repo (starts a fresh conversation)")
            .addStringOption((o) =>
              o.setName("name").setDescription("Repo name").setRequired(true).setAutocomplete(true)
            )
        )
        .addSubcommand((s) =>
          s
            .setName("dev")
            .setDescription("Work in this session's own worktree, or directly in the repo")
            .addStringOption((o) =>
              o
                .setName("mode")
                .setDescription("worktree (isolated, default) or local (edits the repo itself)")
                .setRequired(true)
                .addChoices(
                  { name: "worktree — isolated copy for this session", value: "worktree" },
                  { name: "local — work directly in the repo", value: "local" }
                )
            )
        )
        .addSubcommand((s) =>
          s
            .setName("clone")
            .setDescription("Clone a remote repo into REPOS_ROOT and bind this thread to it")
            .addStringOption((o) =>
              o
                .setName("source")
                .setDescription("owner/repo, https://…, ssh://…, or git@host:owner/repo")
                .setRequired(true)
            )
            .addStringOption((o) =>
              o.setName("name").setDescription("Folder name (defaults to the repo name)").setRequired(false)
            )
        )
        .addSubcommand((s) =>
          s
            .setName("new")
            .setDescription("Create a new empty git repo in REPOS_ROOT and bind this thread to it")
            .addStringOption((o) => o.setName("name").setDescription("New project name").setRequired(true))
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName("stop")
        .setDescription("Abort the current turn in this session thread")
        .toJSON(),
      new SlashCommandBuilder()
        .setName("model")
        .setDescription("Switch this session's model (history preserved)")
        .addStringOption((o) => {
          o.setName("id").setDescription("Model id").setRequired(true);
          if (modelChoices.length) o.addChoices(...modelChoices);
          return o;
        })
        .toJSON(),
      new SlashCommandBuilder()
        .setName("effort")
        .setDescription("Set this session's reasoning effort")
        .addStringOption((o) =>
          o
            .setName("level")
            .setDescription("Reasoning effort (validated against the current model)")
            .setRequired(true)
            .addChoices(...EFFORT_LEVELS.map((l) => ({ name: l, value: l })))
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName("context")
        .setDescription("Set this session's context window tier")
        .addStringOption((o) =>
          o
            .setName("tier")
            .setDescription("Context tier")
            .setRequired(true)
            .addChoices(
              { name: "default", value: "default" },
              { name: "long_context", value: "long_context" }
            )
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName("usage")
        .setDescription("Show this session's token usage")
        .toJSON(),
      new SlashCommandBuilder()
        .setName("approvals")
        .setDescription("List (or clear) remembered command approvals")
        .addBooleanOption((o) =>
          o.setName("clear").setDescription("Clear this session + repo approvals").setRequired(false)
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName("diff")
        .setDescription("Show a git diff summary of the controlled repo")
        .addBooleanOption((o) =>
          o.setName("staged").setDescription("Show staged (--cached) changes instead").setRequired(false)
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName("file")
        .setDescription("Send one file from this session's workdir")
        .addStringOption((o) => o.setName("path").setDescription("Path inside this session workdir").setRequired(true))
        .toJSON(),
      new SlashCommandBuilder()
        .setName("todos")
        .setDescription("Show the agent's current todo checklist")
        .toJSON(),
      new SlashCommandBuilder()
        .setName("yolo")
        .setDescription("⚠️ Auto-approve EVERY permission in this session (no prompts)")
        .addStringOption((o) =>
          o
            .setName("mode")
            .setDescription("Turn blanket auto-approval on or off")
            .setRequired(true)
            .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" })
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName("rename")
        .setDescription("Rename this session thread")
        .addStringOption((o) =>
          o.setName("title").setDescription("New title for this thread").setRequired(true)
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName("queue")
        .setDescription("Queue a prompt to run after the current turn (a plain message steers instead)")
        .addStringOption((o) =>
          o.setName("message").setDescription("Prompt to run next").setRequired(false)
        )
        .addBooleanOption((o) =>
          o.setName("clear").setDescription("Discard everything currently queued").setRequired(false)
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName("end")
        .setDescription("End THIS thread's session (other sessions keep running)")
        .addStringOption((o) =>
          o
            .setName("thread")
            .setDescription("Thread id of a leftover record whose thread is gone (see /sessions)")
            .setRequired(false)
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName("sessions")
        .setDescription("List the sessions running right now")
        .toJSON(),
      new SlashCommandBuilder()
        .setName("channel")
        .setDescription("Manage which channels this bot answers in")
        .addSubcommand((s) =>
          s
            .setName("enable")
            .setDescription("Let sessions be started in a channel")
            .addStringOption((o) =>
              o
                .setName("channel")
                .setDescription("Channel id or #mention (default: this channel)")
                .setRequired(false)
            )
        )
        .addSubcommand((s) =>
          s
            .setName("disable")
            .setDescription("Stop answering in a channel (end its sessions first)")
            .addStringOption((o) =>
              o
                .setName("channel")
                .setDescription("Channel id or #mention (default: this channel)")
                .setRequired(false)
            )
        )
        .addSubcommand((s) =>
          s.setName("list").setDescription("Show which channels this bot answers in")
        )
        .toJSON(),
    ];
    // Guild-scoped and hidden from non-admins by default. The runtime owner +
    // channel authorization remains the real boundary; this default only keeps
    // the command picker quiet for ordinary members.
    const rest = new REST({ version: "10" }).setToken(this.config.DISCORD_BOT_TOKEN);
    await rest.put(Routes.applicationGuildCommands(clientId, this.config.DISCORD_GUILD_ID), {
      body: restrictCommandDefaults(commands),
    });
  }

  // ---- input surface: interactions (slash + buttons) --------------------

  private async onInteraction(interaction: Interaction): Promise<void> {
    try {
      // Autocomplete is handled BEFORE the phase gate's repliable path: an
      // autocomplete interaction is not repliable, so `reply()` throws and
      // Discord shows a stuck "loading options" spinner instead of an empty
      // list. `respond([])` is the only valid answer, and an empty list is the
      // right one while the bot is still booting.
      if (interaction.isAutocomplete()) {
        await this.onAutocomplete(interaction);
        return;
      }
      // Startup gate (P2): reject input until reconciliation finished, so a /new
      // can't race startup resume. Also blocks during shutdown.
      if (this.phase !== "ready") {
        if (!interaction.channelId) return;
        const command = interaction.isChatInputCommand() ? interaction : undefined;
        const button = interaction.isButton() ? interaction : undefined;
        const input = command ?? button;
        if (!input) return;
        const authorized =
          command?.commandName === "channel"
            ? isOwner(ctxOf(command), this.policyNow())
            : isAuthorized(ctxOf(input), this.policyNow());
        if (!authorized) {
          // Preserve the pre-ready no-response behavior for unknown users. An
          // owner's channel may be absent from Discord's cache while booting,
          // so do not claim it is disabled or suggest a command that cannot run
          // until reconciliation finishes.
          if (isOwner(ctxOf(input), this.policyNow())) {
            await input
              .reply(
                ephemeralReply(
                  "⏳ 啟動中，請稍候重試；啟動完成後若仍看到「頻道尚未啟用」，再執行 `/channel enable`。"
                )
              )
              .catch(() => {});
          }
          return;
        }
        if (interaction.isRepliable()) {
          await interaction
            .reply(ephemeralReply("⏳ 啟動中，請稍候重試。"))
            .catch(() => {});
        }
        return;
      }
      if (interaction.isButton()) {
        await this.onButton(interaction);
        return;
      }
      if (interaction.isChatInputCommand()) {
        const c = interaction.commandName;
        if (c === "new") await this.cmdNew(interaction);
        else if (c === "stop") await this.cmdStop(interaction);
        else if (c === "model" || c === "effort" || c === "context") await this.cmdReconfigure(interaction);
        else if (c === "usage") await this.cmdUsage(interaction);
        else if (c === "approvals") await this.cmdApprovals(interaction);
        else if (c === "diff") await this.cmdDiff(interaction);
        else if (c === "file") await this.cmdFile(interaction);
        else if (c === "todos") await this.cmdTodos(interaction);
        else if (c === "yolo") await this.cmdYolo(interaction);
        else if (c === "rename") await this.cmdRename(interaction);
        else if (c === "queue") await this.cmdQueue(interaction);
        else if (c === "end") await this.cmdEnd(interaction);
        else if (c === "sessions") await this.cmdSessions(interaction);
        else if (c === "repo") await this.cmdRepo(interaction);
        // `/channel` is the ONLY command gated on `isOwner` instead of
        // `isAuthorized` — see cmdChannel.
        else if (c === "channel") await this.cmdChannel(interaction);
      }
    } catch (err) {
      console.error("interaction error:", err);
    }
  }

  private async onButton(interaction: ButtonInteraction): Promise<void> {
    const perm = decodePermissionId(interaction.customId);
    const choice = perm ? undefined : decodeChoiceId(interaction.customId);
    const plan = perm || choice ? undefined : decodePlanId(interaction.customId);
    const repo = perm || choice || plan ? undefined : decodeRepoId(interaction.customId);
    if (!perm && !choice && !plan && !repo) return; // not one of ours
    if (!isAuthorized(ctxOf(interaction), this.policyNow())) {
      await this.refuseUnauthorized(interaction);
      return;
    }
    const uid = interaction.user.id;
    const nonce = perm?.nonce ?? choice?.nonce ?? plan?.nonce ?? repo?.nonce ?? "";
    // Unknown nonce (P2): the broker has no entry for it. That is execution-safe
    // (settle would no-op) but it is NOT only the restart case — the same state
    // is reached by the 5-minute timeout, by /stop (which settles pending cards
    // while leaving the buttons visibly intact), and by a /new that tore the old
    // session down. Name all of them rather than asserting a restart that
    // usually didn't happen.
    const pending = this.pendingFor(nonce);
    if (!pending) {
      await interaction
        .reply({
          content:
            "此互動已失效（可能因逾時、/stop、開新 session 或 bot 重啟），未執行任何動作。請重新操作。",
          ...EPHEMERAL,
        })
        .catch(() => {});
      return;
    }
    // Cross-thread guard (§9: "跨 thread 點擊無法 resolve"). A card's buttons only
    // exist in its OWNING thread, so a decision must come from that thread. The
    // nonce is unique + Discord-validated, but bind it to the channel anyway as
    // defense-in-depth: a click whose channel ≠ the nonce's session never settles.
    if (!decisionBindsToChannel(pending, interaction.channelId)) {
      await interaction
        .reply({ content: "此互動不屬於目前的討論串，未執行任何動作。", ...EPHEMERAL })
        .catch(() => {});
      return;
    }
    if (perm) {
      // Snapshot the approval policy's revocation epoch BEFORE the ack. The ack
      // is a network round trip, and `/approvals clear:true` can land during it:
      // the operator would be told "Future commands will prompt again" and then
      // this in-flight click would re-add the very rule they just revoked. A
      // scope-widening decision (session/always) is downgraded to a one-shot
      // approval in that case — the click still does what the operator saw on
      // the card, but it cannot resurrect a revoked grant.
      const epochAtClick = this.approvals.revocationEpoch();
      await resolveButtonAck(
        () => interaction.update({ components: [] }),
        (d) => {
          const widens = d === "session" || d === "always";
          const revoked = this.approvals.revocationEpoch() !== epochAtClick;
          if (widens && revoked) {
            void this.transport
              .notice(
                interaction.channelId,
                "ℹ️ 這次核准只套用於本次請求：在你點擊的同時，核准規則被 `/approvals clear` 清除了，因此沒有記住。"
              )
              .catch(() => {});
            this.transport.deliverDecision(perm.nonce, "once", uid);
            return;
          }
          this.transport.deliverDecision(perm.nonce, d, uid);
        },
        perm.action
      );
      return;
    }
    // choice/plan: ack first, then settle on success.
    let acked = true;
    try {
      await interaction.update({ components: [] });
    } catch {
      acked = false;
    }
    if (choice) {
      // ack failure ⇒ leave the ask pending; it times out to the safe default.
      if (acked) this.transport.deliverChoice(choice.nonce, choice.index, uid);
    } else if (plan) {
      // ack failure ⇒ safe default is reject.
      this.transport.deliverPlan(plan.nonce, acked ? plan.action : "reject", uid);
    } else if (repo) {
      // Same ack-before-act rule as every other card: an unacknowledged click
      // must not discard a conversation. Settling on the OWNING session's broker
      // (`decisionBindsToChannel` above already proved the click came from it)
      // keeps the exactly-once and generation guarantees.
      const owner = this.sessions.get(interaction.channelId);
      owner?.broker.settle<RebindAction>(repo.nonce, acked ? repo.action : "cancel");
    }
  }

  /** The pending view for `nonce` from whichever live session's broker owns it,
   *  or undefined if no live broker has it (e.g. a pre-restart card). Used both
   *  to reject expired nonces and to bind a decision to its owning thread. */
  private pendingFor(nonce: string): PendingView | undefined {
    if (!nonce) return undefined;
    for (const s of this.sessions.values()) {
      const v = s.broker.get(nonce);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  private async cmdNew(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policyNow())) {
      await this.refuseUnauthorized(interaction);
      return;
    }
    if (!this.channels.has(interaction.channelId)) {
      // Reached only when the channel gate passed via a THREAD under an enabled
      // channel: `/new` must open a thread on a text channel, so it has to run
      // in the channel itself, never inside an existing thread.
      await interaction.reply({
        content:
          "`/new` 要在**已啟用的文字頻道**裡執行，不能在討論串裡（不支援討論串中的討論串）。" +
          "用 `/channel list` 看目前啟用了哪些頻道。",
        ...EPHEMERAL,
      });
      return;
    }
    const parentChannelId = interaction.channelId;
    await interaction.deferReply({ ...EPHEMERAL });
    if (this.creating) {
      await interaction.editReply("A session is already being created — please retry in a moment.");
      return;
    }
    // The cap applies to every mode now. It used to be checked only under
    // worktree isolation, because the alternative mode ended the previous
    // session anyway; with per-thread modes nothing else bounds the count.
    if (this.sessions.size >= MAX_LIVE_SESSIONS) {
      await interaction.editReply(
        `⚠️ 已達同時進行的 session 上限（${MAX_LIVE_SESSIONS}）。請先在某個討論串用 \`/end\` 結束，再開新的。用 \`/sessions\` 看目前有哪些。`
      );
      return;
    }
    // Resolve the repo BEFORE creating a thread. A thread with no repo would be
    // a lifecycle state nothing else models — reconcile, /end and the rebind
    // confirmation all assume a session has a working directory — so the
    // failure has to happen while there is still nothing to clean up.
    const repoOption = interaction.options.getString("repo");
    let repoPath: string;
    try {
      repoPath = repoOption ? this.repoByName(repoOption) : (this.defaultRepo() ?? "");
    } catch (err) {
      await interaction.editReply(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!repoPath) {
      const names = listRepos(this.reposRoot);
      await interaction.editReply(
        `⚠️ 沒有指定 repo，而且沒有可用的 \`DEFAULT_REPO\`。請用 \`/new repo:<名稱>\`。` +
          (names.length ? `\n可用的 repo：${names.slice(0, 20).map((n) => `\`${n}\``).join(", ")}` : "\n（`REPOS_ROOT` 底下目前沒有 repo，可用 `/repo clone` 或 `/repo new` 建立。）")
      );
      return;
    }
    this.creating = true;
    try {
      // Everything below crosses several awaits, and `/channel disable` can
      // land in any of those gaps: it checks for live sessions, sees none (this
      // one has no record yet), and revokes. Recheck the TARGET channel before
      // creating the thread and before reserving the record, or this session
      // could be created under a channel the operator had already revoked and
      // become terminally `blocked` on the next restart.
      //
      // This deliberately does NOT use the registry's GLOBAL epoch. An enable
      // or disable for a completely unrelated channel must not abort a valid
      // `/new` here, then falsely tell the operator THIS channel was disabled.
      // The authorization question is only whether THIS parent is enabled now.
      const stillEnabled = (): boolean => this.channels.has(parentChannelId);
      const parentResult = await fetchChannelSafe(this.discord, parentChannelId);
      if (parentResult.kind !== "ok") {
        const reason =
          parentResult.kind === "gone"
            ? "頻道不存在"
            : parentResult.kind === "no-access"
              ? "bot 沒有 View Channel 權限"
              : parentResult.error instanceof Error
                ? parentResult.error.message
                : String(parentResult.error);
        await interaction.editReply(`⚠️ 無法讀取頻道 <#${parentChannelId}>：${reason}`);
        return;
      }
      const parent = parentResult.channel as { type?: number };
      if (!parent || parent.type !== ChannelType.GuildText) {
        await interaction.editReply("Parent channel is not a text channel.");
        return;
      }
      if (!stillEnabled()) {
        await interaction.editReply(
          `⚠️ <#${parentChannelId}> 在這期間被停用了，沒有建立 session。`
        );
        return;
      }

      // Name the thread from its first prompt when /new already carries one;
      // otherwise a timestamp holds the slot until the first message arrives.
      // No ordinal prefix: Discord orders a channel's threads by creation
      // (verified live 2026-07-28), so a number would only eat sidebar width.
      const promptOption = interaction.options.getString("prompt");
      const stamp = new Date().toISOString().slice(5, 16).replace("T", " ");
      const threadName = (promptOption ? deriveThreadTitle(promptOption) : "") || `copilot ${stamp}`;

      let thread;
      try {
        thread = await (parent as TextChannel).threads.create({
          name: threadName.slice(0, THREAD_NAME_MAX),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        });
      } catch (err) {
        // Almost always a missing Create Public Threads / Send Messages in
        // Threads permission in a newly enabled channel. Say so here rather than
        // leaving the deferred reply spinning forever.
        await interaction.editReply(
          `⚠️ 無法在 <#${parentChannelId}> 建立討論串：${err instanceof Error ? err.message : String(err)}\n` +
            "常見原因是 bot 在該頻道缺少 `Create Public Threads` 或 `Send Messages in Threads`。"
        );
        return;
      }
      // Best-effort cleanup of the just-created thread on any abort path below,
      // so a failed /new doesn't litter empty threads.
      const dropThread = async (): Promise<void> => {
        await (thread as unknown as { delete?: () => Promise<unknown> }).delete?.().catch(() => {});
      };
      // Reserve-before-create (P2): durably record a `creating` row with a
      // caller-assigned session id BEFORE calling createSession, so a crash
      // between the two leaves an identifiable id on disk rather than a live
      // runtime session nobody knows about.
      const sessionId = randomUUID();
      const generation = this.store.nextGeneration();
      const fileDeliveryBytes = 0;

      // Every new session is isolated. `local` is reachable only through an
      // explicit `/repo dev local` in the thread — a config key that made it the
      // default for every new thread would be the same hazard with a longer
      // fuse, since it silently opts every future session into editing the
      // operator's own checkout.
      const devMode: DevMode = "worktree";
      const branch = worktreeBranch(thread.id);
      const requestedWorkDir = worktreePath(worktreeRoot(), repoPath, thread.id);
      let worktreeCreated = false;
      await pruneWorktrees(repoPath);
      try {
        await addWorktree(repoPath, requestedWorkDir, branch);
        worktreeCreated = true;
      } catch (err) {
        await dropThread();
        await interaction.editReply(
          `⚠️ 無法為這個 session 建立 git worktree（${err instanceof Error ? err.message : String(err)}）。未建立 session。`
        );
        return;
      }
      // Every abort path from here on must undo the worktree too, or the
      // operator is told "未建立 session" while a full checkout (and a branch)
      // is left on disk with no command able to reach it — /end only works on a
      // LIVE session. Safe to call unconditionally: a worktree that was just
      // created is clean by construction, so nothing can be lost.
      const dropWorktree = async (): Promise<void> => {
        if (!worktreeCreated) return;
        await removeWorktreeIfClean(repoPath, requestedWorkDir, branch).catch(() => "failed" as const);
      };
      const abort = async (msg: string): Promise<void> => {
        await dropWorktree();
        await dropThread();
        await interaction.editReply(msg);
      };

      // On Windows capture first, then prove the handle-bound validation path.
      // POSIX starts a normal session without a root capability because the SDK
      // only accepts a mutable cwd pathname; it therefore exposes no file tool.
      let captured;
      try {
        captured = await this.captureValidatedRoot({
          repoPath,
          workDir: requestedWorkDir,
          devMode,
          branch,
        });
      } catch (err) {
        await abort(
          `⚠️ 無法安全開啟工作目錄（${err instanceof Error ? err.message : String(err)}）。未建立 session。`
        );
        return;
      }
      if (!captured.ok) {
        await abort(
          `⚠️ 無法確認工作目錄歸屬（${describeBindingProblem(captured.verdict.problem)}：${captured.verdict.detail}）。未建立 session。`
        );
        return;
      }
      const trustedRoot = captured.trustedRoot;
      const workDir = captured.binding.workDir;
      const approvalKey = captured.approvalKey;

      // LAST authorization check before anything durable exists. The window from
      // the first check to here spans a thread creation, a `git worktree add`
      // and a binding proof — easily seconds — and `/channel disable` cannot see
      // this session until the record below exists. Checking here is what makes
      // "a disabled channel never gains a session" true rather than likely.
      if (!stillEnabled()) {
        await trustedRoot?.close().catch(() => {});
        await abort(`⚠️ <#${parentChannelId}> 在這期間被停用了，已回復（討論串與 worktree 都已移除）。`);
        return;
      }

      const reserved = this.store.reserve({
        threadId: thread.id,
        sessionId,
        generation,
        repoPath,
        guildId: this.config.DISCORD_GUILD_ID,
        parentChannelId,
        workDir,
        devMode,
        fileDeliveryBytes,
        branch,
      });
      if (!reserved) {
        await trustedRoot?.close().catch(() => {});
        await abort("⚠️ 無法持久化 session 狀態（寫入磁碟失敗），未建立新的 session。請檢查磁碟／權限後重試。");
        return;
      }

      const broker = new PendingInteractionBroker();
      let actor: SessionActor;
      try {
        actor = await SessionActor.create(this.copilot, {
          sessionKey: thread.id,
          ...(trustedRoot ? { trustedRoot } : {}),
          workingDirectory: workDir,
          approvalKey,
          model: this.config.DEFAULT_MODEL,
          contextTier: this.config.DEFAULT_CONTEXT_TIER,
          broker,
          transport: this.transport,
          policy: this.approvals,
          generation,
          createSessionId: sessionId,
          ...this.fileDeliveryQuotaOptions(thread.id, fileDeliveryBytes, sessionId, generation),
          ...this.skillSourceOptions(),
        });
      } catch (err) {
        // Create failed. The RPC may or may not have created the assigned id, so
        // best-effort DELETE it to remove any dormant runtime session (it has no
        // actor and can never receive a turn, so it can't contend for the tree,
        // but we don't want it lingering). The record stays `creating` (→
        // orphaned on restart, fail-closed); no live actor exists, so /new can be
        // retried.
        await withTimeout(
          ((this.copilot as unknown as { deleteSession?: (id: string) => Promise<unknown> }).deleteSession?.(
            sessionId
          ) ?? Promise.resolve()) as Promise<unknown>,
          TEARDOWN_TIMEOUT_MS
        ).catch(() => {});
        // The record stays `creating` (→ orphaned on restart, fail-closed), so
        // keep the worktree: an orphaned row is the operator's to inspect, and
        // deleting the tree would remove the only evidence of what happened.
        await dropThread();
        await interaction.editReply(
          `⚠️ 建立 session 失敗（${err instanceof Error ? err.message : String(err)}）。請重試 /new。`
        );
        return;
      }
      // Promote creating→active. A failed commit means the record isn't durable,
      // so we must NOT run as active. Try a bounded disconnect of the just-created
      // actor; if that fails the runtime may still be live, so RETAIN the actor as
      // a fence (registered) rather than losing track of a live runtime session.
      if (!this.store.commit(thread.id)) {
        let disconnected = false;
        try {
          await withTimeout(actor.disconnect(), TEARDOWN_TIMEOUT_MS);
          disconnected = true;
        } catch {
          disconnected = false;
        }
        if (disconnected) {
          await abort("⚠️ 無法持久化 session 狀態（commit 失敗），已取消啟動。請檢查磁碟／權限後重試。");
        } else {
          // Fence: keep the (maybe-live) actor registered so it is still tracked.
          this.sessions.set(thread.id, {
            actor,
            broker,
            running: false,
            titled: true,
            titleEpoch: 0,
            queue: [],
            workDir,
            repoPath,
            devMode,
            branch,
            parentChannelId,
            hasRunTurn: true,
          });
          await interaction.editReply(
            "⚠️ 無法持久化 session 狀態，且無法確認前述 runtime 已關閉。已保留為屏障——請重啟 bot。"
          );
        }
        return;
      }
      const session: Session = {
        actor,
        broker,
        running: false,
        titled: false,
        titleEpoch: 0,
        queue: [],
        workDir,
        repoPath,
        devMode,
        branch,
        parentChannelId,
        hasRunTurn: false,
      };
      this.sessions.set(thread.id, session);
      const live = this.sessions.size;
      await interaction.editReply(
        `Started a session in <#${thread.id}>. Send prompts there.` +
          (live > 1 ? `（目前有 ${live} 個 session 同時進行）` : "") +
          `\n📁 repo：\`${path.basename(repoPath)}\`` +
          `\n🌿 這個 session 有自己的 git worktree（分支 \`${branch}\`），與其他 session 的檔案互相隔離。` +
          `\n（想直接在 repo 本體上開發，在該討論串用 \`/repo dev local\`。）`
      );

      if (promptOption) {
        // Title this the same way a first thread message is titled — the thread
        // was created with the local heuristic so it is never nameless, and the
        // model's shorter name replaces it a few seconds later.
        this.startTitling(thread.id, session, promptOption);
        void this.runTurn(thread.id, promptOption).catch(() => {});
      }
    } finally {
      this.creating = false;
    }
  }

  /**
   * `/end` — close THIS thread's session and leave every other one running.
   *
   * With concurrent sessions, `/new` no longer ends anything, so without this
   * sessions would only ever accumulate. The worktree is removed **only when git
   * reports it clean**: uncommitted work belongs to the operator, and deleting
   * it to tidy up would be the worst possible trade.
   */
  private async cmdEnd(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policyNow())) {
      await this.refuseUnauthorized(interaction);
      return;
    }
    const explicit = interaction.options.getString("thread")?.trim();
    // Claim the target for the WHOLE command, both forms of it. The in-thread
    // form tears a live session down and only then awaits git — a window in
    // which the thread stops being live while its record still exists, and the
    // retry loop must not treat that as an invitation. Counted, because the
    // stale path below claims again.
    const release = this.claimEnd(explicit || interaction.channelId);
    try {
      await this.cmdEndClaimed(interaction, explicit);
    } finally {
      release();
    }
  }

  /** Claim a thread for an explicit teardown. Re-entrant: nested claims from the
   *  same command must not release each other's. */
  private claimEnd(threadId: string): () => void {
    this.endClaims.set(threadId, (this.endClaims.get(threadId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.endClaims.get(threadId) ?? 1) - 1;
      if (remaining > 0) this.endClaims.set(threadId, remaining);
      else this.endClaims.delete(threadId);
    };
  }

  private async cmdEndClaimed(
    interaction: ChatInputCommandInteraction,
    explicit: string | undefined
  ): Promise<void> {
    // A record whose thread was DELETED is the commonest leftover, and it is
    // exactly the one you cannot type `/end` inside. `thread:` makes it
    // reachable from the parent channel; without it those worktrees were
    // unreclaimable no matter what /sessions claimed.
    if (explicit) {
      if (this.sessions.has(explicit)) {
        await interaction.reply({
          content: `<#${explicit}> 仍有進行中的 session，請到該討論串內執行 \`/end\`。`,
          ...EPHEMERAL,
        });
        return;
      }
      await this.endStaleRecord(interaction, explicit);
      return;
    }
    const threadId = interaction.channelId;
    const session = this.sessions.get(threadId);
    if (!session) {
      // No LIVE session — but the thread may still own a durable record that
      // reconcile marked `blocked`/`orphaned`. Those keep a full worktree and a
      // branch that no other command can reach: /sessions only lists live ones
      // and /new never touches them. Without this the only way to reclaim the
      // disk was to edit the store by hand.
      await this.endStaleRecord(interaction, threadId);
      return;
    }
    // Claim the exact object BEFORE the first await. `applyRebindInner` can be
    // suspended in git or SDK work while this actor remains in the map; without
    // this fence it could later reserve and install a replacement after `/end`.
    this.endedSessions.add(session);
    // A replacement whose stale row could not persist may be held solely by a
    // target `creating` reservation. Change its retry plan before the first
    // await: `/end` wins, so a later confirmed replacement teardown may remove
    // that exact reservation but must never restore this session's record.
    this.markFallbackPrimaryEnded(threadId);
    // Once rebind has reserved its durable old-incarnation companion, `/end`
    // must finish that companion rather than treating the mutable main record
    // (which may already be the target reservation) as if it described this
    // old actor.
    const pendingOld = this.pendingRebindOlds.get(session);
    await interaction.deferReply({ ...EPHEMERAL });
    session.currentAbort?.abort();
    session.queue = [];
    let closed = true;
    try {
      await withTimeout(session.actor.disconnect(), TEARDOWN_TIMEOUT_MS);
    } catch {
      closed = false; // runtime may still be live — keep the record, say so
    }
    if (!closed) {
      if (pendingOld) this.retainStaleRebindActor(pendingOld);
      // A replacement can have been swapped in before this `/end`; it does not
      // excuse the old incarnation from cleanup merely because ending the
      // replacement timed out too.
      await this.retryStaleRebindActorsForThread(threadId);
      await interaction.editReply(
        "⚠️ 無法確認 runtime 已關閉，這個 session 保留為屏障（不會再接受訊息）。請重啟 bot。"
      );
      return;
    }
    this.sessions.delete(threadId);
    this.approvals.clearSession(threadId);
    this.transport.dispose(threadId);
    if (pendingOld) {
      this.pendingRebindOlds.delete(session);
      // The rebind's target reservation/worktree belongs to its own rollback
      // path. Touching `reclaim(threadId, old...)` here would delete or retire
      // that target row by thread id and lose the exact old pointer we just
      // proved stopped. The companion cleanup owns only the old incarnation.
      const tracked = this.staleRebindActors.get(pendingOld.actor) === pendingOld;
      let outcome: StaleRebindTeardown;
      if (tracked) {
        outcome = await this.disconnectStaleRebindActor(pendingOld);
      } else {
        const cleanup = await pendingOld.cleanupPlan();
        outcome = { confirmed: true, cleaned: cleanup.ok, tail: cleanup.tail };
      }
      // A failed pre-swap replacement may already be tracked behind the target
      // primary reservation. `/end` changed its plan to removal above; retry it
      // now that the command has won, rather than leaving an already-confirmed
      // target actor waiting for some unrelated later lifecycle event.
      await this.retryStaleRebindActorsForThread(threadId);
      this.releaseRetiredLocalLease(threadId, session.repoPath);
      const fallbackPending = [...this.staleRebindActors.values()].some(
        (entry) => entry.threadId === threadId && entry.fallbackPrimary !== undefined
      );
      await interaction.editReply(
        `${outcome.confirmed && outcome.cleaned ? "✅" : "⚠️"} 這個 session 已結束。${outcome.tail}` +
          (fallbackPending
            ? "\n⚠️ replacement 的安全屏障仍未能安全對帳；其 actor 擁有權與記錄均已保留，請稍後重試。"
            : "")
      );
      return;
    }
    // A post-swap `/end` owns BOTH the current replacement and every detached
    // old actor for this thread. Joining their teardown before removing the
    // replacement row keeps an unconfirmed old actor's terminal pointer
    // durable, while a confirmed one can release its clean worktree now.
    await this.retryStaleRebindActorsForThread(threadId);
    const outcome = await this.reclaim(threadId, session.repoPath, session.workDir, session.branch);
    const left = this.sessions.size;
    const stale = this.store.staleRebindsForThread(threadId).length;
    await interaction.editReply(
      `${outcome.ok ? "✅" : "⚠️"} 這個 session 已結束。${left ? `其他 ${left} 個 session 仍在執行。` : "目前沒有其他 session。"}${outcome.tail}` +
        (stale ? "\n⚠️ 舊 incarnation 尚未確認停止；其 worktree 記錄已保留，可稍後用 `/end` 重試。" : "")
    );
  }

  /**
   * Retire a stopped session's durable record and worktree **together**.
   *
   * The two must move as one, and each ordering strands the other half:
   * dropping the record first leaves a kept worktree that nothing lists and no
   * command can reach; dropping the worktree first leaves, on a failed write, a
   * record pointing at a directory that is gone. So the worktree's fate is
   * decided FIRST, and the record follows it:
   *
   * - gone (removed, or already absent) → drop the record
   * - kept  → keep the record, but retire it to `blocked` so the next boot does
   *   not try to resume a session we just stopped, `/sessions` still shows the
   *   disk it holds, and `/end thread:<id>` can retry once the operator has
   *   dealt with whatever we refused to touch.
   */
  private async reclaim(
    threadId: string,
    repoPath: string,
    workDir: string,
    branch: string | undefined
  ): Promise<{ ok: boolean; tail: string }> {
    let tail = "";
    // A local checkout remains exclusively claimed until the record is
    // durably removed or terminalized. Releasing first lets another thread
    // claim it while a failed write leaves this session's active record behind.
    const retainLocalLease = (): void => {
      const record = this.store.get(threadId);
      if (record?.devMode === "local") this.acquireLocalLease(record.repoPath, threadId);
    };
    // A worktree is exactly "there is a branch and the work dir is not the repo".
    // The owning repo comes from the RECORD, not from a single configured repo:
    // with many repos, `git worktree remove` run in the wrong one simply fails.
    if (branch && workDir !== repoPath) {
      const r = await removeWorktreeIfClean(repoPath, workDir, branch);
      tail = this.worktreeOutcomeText(r, workDir, branch);
      if (r !== "removed" && r !== "already-absent") {
        if (!this.retire(threadId)) {
          retainLocalLease();
          return {
            ok: false,
            tail: `${tail}\n⚠️ 且**無法寫入磁碟**更新記錄，請檢查磁碟／權限後重啟 bot。`,
          };
        }
        this.releaseLocalLease(threadId);
        return { ok: false, tail: `${tail}\n記錄保留，\`/sessions\` 才看得到還有東西在磁碟上。` };
      }
    }
    if (!this.store.remove(threadId)) {
      retainLocalLease();
      // Only an `active` record would be resumed next boot; a terminal one is
      // retained untouched, so promising a resume attempt there would be false.
      const willResume = this.store.get(threadId)?.state === "active";
      return {
        ok: false,
        tail:
          `${tail}\n⚠️ 但**無法寫入磁碟**移除記錄。請檢查磁碟／權限後重啟 bot` +
          (willResume ? "（否則下次啟動會嘗試復原這個 session）。" : "，記錄仍會留著。"),
      };
    }
    this.releaseLocalLease(threadId);
    return { ok: true, tail };
  }

  /** Reclaim the durable companion of a detached rebind incarnation. It shares
   * `reclaim()`'s proof-before-delete rule, but never touches the main
   * thread→replacement record: the two can coexist after a map swap. */
  private async reclaimStaleRebind(
    binding: SessionRecord,
    preflightClean: boolean,
    removeRecord = true
  ): Promise<{ ok: boolean; tail: string }> {
    let tail = "";
    if (binding.branch && binding.workDir !== binding.repoPath) {
      // Rebind already refused a dirty/detached/unknown old tree. Keep the
      // captured preflight as an additional transaction fence, then ask git
      // again immediately before delete because a runtime may have written
      // between the two checks.
      if (!preflightClean) {
        const kept = this.store.retainStaleRebind(binding, "rebind-worktree-kept");
        return {
          ok: false,
          tail:
            "\n🌿 舊的 worktree **保留**：改綁前未能證明它可安全移除。" +
            (kept ? "" : "\n⚠️ 且無法寫入磁碟保留清理記錄。"),
        };
      }
      const outcome = await removeWorktreeIfClean(binding.repoPath, binding.workDir, binding.branch).catch(
        () => "failed" as const
      );
      tail = this.worktreeOutcomeText(outcome, binding.workDir, binding.branch);
      if (outcome !== "removed" && outcome !== "already-absent") {
        const kept = this.store.retainStaleRebind(binding, "rebind-worktree-kept");
        return {
          ok: false,
          tail:
            `${tail}\n記錄保留，\`/sessions\` 才看得到還有東西在磁碟上。` +
            (kept ? "" : "\n⚠️ 且無法寫入磁碟更新記錄，請檢查磁碟／權限。"),
        };
      }
    }
    // A fallback primary must be reconciled with this stale row in ONE store
    // mutation. Removing the stale half first would turn a later CAS/write
    // failure into an actor whose only durable barrier no longer says why it
    // exists.
    if (!removeRecord) return { ok: true, tail };
    if (!this.store.removeStaleRebind(binding.threadId, binding.sessionId, binding.generation)) {
      return {
        ok: false,
        tail: `${tail}\n⚠️ 但無法寫入磁碟移除舊 incarnation 記錄，請檢查磁碟／權限後重試。`,
      };
    }
    return { ok: true, tail };
  }

  /**
   * Retire a record whose worktree we refused to remove: terminal, so the next
   * boot does not try to resume a session we already stopped, but still listed
   * and still reapable.
   *
   * The existing `reason` is preserved when it already says why the thread is
   * unreachable. `setState` overwrites `reason`, and the startup announcement
   * keys on those `thread-*` values — overwriting one would drop the record out
   * of the announcement AND out of the stray-directory list (which skips any
   * directory a record mentions), i.e. the single leftover you cannot reach from
   * its own thread would go silent for ever. It also destroys the diagnosis.
   */
  private retire(threadId: string): boolean {
    const cur = this.store.get(threadId)?.reason;
    const keep = cur && cur.startsWith("thread-") ? cur : "worktree-kept";
    return this.store.setState(threadId, "blocked", keep);
  }
  /** One honest sentence per worktree-cleanup outcome. */
  private worktreeOutcomeText(
    r: "removed" | "already-absent" | "kept-dirty" | "kept-detached" | "failed",
    dir: string,
    branch: string
  ): string {
    switch (r) {
      case "removed":
        return `\n🌿 worktree 已清除（分支 \`${branch}\` 保留）。`;
      case "already-absent":
        return `\n🌿 worktree \`${dir}\` 已經不存在了（分支 \`${branch}\` 保留）。`;
      case "kept-dirty":
        return `\n🌿 worktree **保留**：\`${dir}\` 還有未提交／未追蹤／被忽略的內容（分支 \`${branch}\`）。確認後可自行 \`git worktree remove\`，再用 \`/end thread:<id>\` 重試清除記錄。`;
      case "kept-detached":
        return `\n🌿 worktree **保留**：\`${dir}\` 的 HEAD 不是 \`${branch}\`（detached 或換了分支），裡面可能有沒有任何分支指向的 commit。請自行確認後再移除。`;
      default:
        return `\n⚠️ 無法移除 worktree \`${dir}\`，請自行檢查。`;
    }
  }

  /** `/end` where no live session exists: reap a genuinely terminal record and
   *  its worktree. Deliberately narrow — "not in the live map" is not the same
   *  as "dead", and the two states that differ are exactly the ones whose
   *  deletion loses work. */
  private async endStaleRecord(
    interaction: ChatInputCommandInteraction,
    threadId: string
  ): Promise<void> {
    // Claim the thread BEFORE the first await. Everything below — the deferral,
    // the git proof, the store write — is awaited, and the access-retry loop is
    // free to run in those gaps: without this claim it could resume and register
    // a session that this command then leaves live with no durable record, and
    // with its local lease released. The claim makes `/end` win from its first
    // instruction rather than from its last.
    const release = this.claimEnd(threadId);
    try {
      await this.endStaleRecordClaimed(interaction, threadId);
    } finally {
      // Released either way: a failed `/end` leaves the record `active`, and it
      // must stay eligible for the loop that is supposed to bring it back.
      release();
    }
  }

  private async endStaleRecordClaimed(
    interaction: ChatInputCommandInteraction,
    threadId: string
  ): Promise<void> {
    // Join a resume that was already in flight when the claim landed. It is
    // going to discard itself (`resumeOwnershipLost` sees the claim), and
    // waiting for that means its actor is torn down BEFORE this command starts
    // proving worktrees removable, instead of racing it. Bounded, because a
    // wedged runtime must not make `/end` unusable — and if the bound expires
    // the answer is a refusal, never "carry on as if nothing were running".
    if (!(await this.joinAccessResume(threadId))) {
      await interaction.reply({
        content:
          "⚠️ 這個討論串正在自動復原中，**還沒結束**，所以不能現在清除（可能會把它正在用的 worktree 抽掉）。請稍後再試一次。",
        ...EPHEMERAL,
      });
      return;
    }
    // That discard may not have been confirmable. A worktree must never be
    // deleted out from under a process that might still be writing to it, so
    // one more bounded attempt — and, failing that, the same honest refusal
    // `/end` already gives when a live session's runtime will not confirm.
    if (!(await this.retryUnconfirmedResume(threadId))) {
      await interaction.reply({
        content:
          "⚠️ 這個討論串剛才有一次自動復原，但**無法確認該 runtime 已關閉**。記錄與 worktree 都保留（不會被清除），請重啟 bot 後再試。",
        ...EPHEMERAL,
      });
      return;
    }
    const hasFallbackOwnership = (): boolean =>
      [...this.staleRebindActors.values()].some(
        (entry) => entry.threadId === threadId && entry.fallbackPrimary !== undefined
      );
    // A confirmed replacement can still be retained only because its primary
    // fallback CAS/write failed. Do not let a later `/end` with no live map
    // entry reap that barrier: retry the owned actor first and refuse while the
    // conditional reconciliation remains unresolved.
    if (hasFallbackOwnership()) {
      await this.retryStaleRebindActorsForThread(threadId);
      if (hasFallbackOwnership()) {
        await interaction.reply({
          content:
            "⚠️ replacement 的安全屏障仍未能安全對帳；其 actor 擁有權與記錄均已保留，請稍後重試或重啟 bot。",
          ...EPHEMERAL,
        });
        return;
      }
    }
    const rec = this.store.get(threadId);
    const stale = this.store.staleRebindsForThread(threadId);
    if (!rec && stale.length) {
      // If this process still owns the old actor, an explicit `/end` is a
      // retry, not permission to delete a worktree underneath an unconfirmed
      // runtime. A later restart has no retained actor/root, so the terminal
      // row is deliberately visible to an operator for the existing
      // proof-before-delete reclaim path.
      await this.retryStaleRebindActorsForThread(threadId);
      const stillLive = [...this.staleRebindActors.values()].some((entry) => entry.threadId === threadId);
      if (stillLive) {
        await interaction.reply({
          content: "⚠️ 舊 runtime 仍未確認停止；其 worktree 記錄已保留，請稍後重試或重啟 bot。",
          ...EPHEMERAL,
        });
        return;
      }
      const remaining = this.store.staleRebindsForThread(threadId);
      if (!remaining.length) {
        await interaction.reply({ content: "✅ 舊 incarnation 已確認清理。", ...EPHEMERAL });
        return;
      }
      await interaction.deferReply({ ...EPHEMERAL });
      const outcomes: Array<{ ok: boolean; tail: string }> = [];
      for (const binding of remaining) outcomes.push(await this.reclaimStaleRebind(binding, true));
      await interaction.editReply(
        outcomes.every((outcome) => outcome.ok)
          ? `✅ 已清除這個討論串的 ${outcomes.length} 個舊 incarnation 記錄。${outcomes.map((o) => o.tail).join("")}`
          : `⚠️ 有舊 incarnation 記錄保留。${outcomes.map((o) => o.tail).join("")}`
      );
      return;
    }
    if (!rec) {
      await interaction.reply({ content: "這個討論串沒有進行中的 session。", ...EPHEMERAL });
      return;
    }
    const disposition = classifyRecordDisposition(rec.state, this.sessions.has(threadId), this.creating);
    if (disposition === "live") {
      // Defensive: the callers check this synchronously first, but falling
      // through to the destructive path if that ever changes would tear down a
      // running session's worktree.
      await interaction.reply({
        content: "這個討論串仍有進行中的 session，請直接用 `/end`（不加參數）。",
        ...EPHEMERAL,
      });
      return;
    }
    if (disposition === "in-flight") {
      await interaction.reply({
        content: "⏳ 這個討論串的 `/new` 還在建立中，現在清除會把它的 worktree 抽掉。請等它完成後再試。",
        ...EPHEMERAL,
      });
      return;
    }
    if (disposition === "retry-pending" && rec.reason !== "thread-no-access") {
      // reconcile kept this record ON PURPOSE after a transient failure. Its
      // sessionId is the only pointer to the Copilot conversation.
      await interaction.reply({
        content:
          "ℹ️ 這個記錄仍是 `active`：復原時只是暫時失敗，**重新啟動 bot 會再試一次**。\n" +
          "現在清除會永久丟掉這段對話紀錄，所以不做。若確定不要了，重啟後它會變成 `orphaned`／`blocked`，屆時再 `/end`。",
        ...EPHEMERAL,
      });
      return;
    }
    await interaction.deferReply({ ...EPHEMERAL });
    const outcome = await this.reclaim(threadId, rec.repoPath, rec.workDir, rec.branch);
    // Re-read: reclaim may have retired the record, so the captured `rec.state`
    // would be stale in the failure message.
    const now = this.store.get(threadId)?.state ?? rec.state;
    await interaction.editReply(
      outcome.ok
        ? `✅ 已清除這個討論串的殘留記錄（原狀態：${rec.state}）。${outcome.tail}`
        : `記錄**保留**（狀態：${now}）。${outcome.tail}`
    );
  }

  /** `/sessions` — what is live right now, and where each one is working. */
  private async cmdSessions(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policyNow())) {
      await this.refuseUnauthorized(interaction);
      return;
    }
    const rows = [...this.sessions.entries()].map(([id, s]) => {
      const state = s.running ? "執行中" : "閒置";
      const q = s.queue.length ? ` · 佇列 ${s.queue.length}` : "";
      const repo = `\`${path.basename(s.repoPath)}\``;
      const where =
        s.devMode === "worktree" ? ` · 🌿 \`${s.branch ?? "?"}\`` : " · 📍 local（直接在 repo 上）";
      return `• <#${id}> — ${repo} · ${state}${q}${where}`;
    });
    // Records with no live actor still own a worktree and a branch. Surface
    // them, or the disk they hold is invisible. Split by what may actually be
    // done with each: telling someone to `/end` a record that /end will refuse
    // is worse than not listing it.
    const reapable: string[] = [];
    const noAccess: string[] = [];
    const pending: string[] = [];
    for (const r of this.store.all()) {
      const d = classifyRecordDisposition(r.state, this.sessions.has(r.threadId), this.creating);
      if (d === "live") continue;
      const line = `• <#${r.threadId}> — \`${path.basename(r.repoPath)}\` · ${r.state}${r.reason ? `（${r.reason}）` : ""}${r.branch ? ` · \`${r.branch}\`` : ""}`;
      if (d === "reapable") reapable.push(`${line} · id \`${r.threadId}\``);
      else if (r.reason === "thread-no-access") noAccess.push(`${line} · id \`${r.threadId}\``);
      else pending.push(line);
    }
    // A rebind can retain an OLD terminal binding while the same thread has a
    // live replacement. It cannot live in the main store map (that map is
    // keyed by mutable thread id), so show this durable companion explicitly
    // rather than misreporting its worktree as an untracked stray after restart.
    const staleRebinds = this.store.staleRebinds();
    const staleRows = staleRebinds.map(
      (r) =>
        `• <#${r.threadId}> — 舊 incarnation \`${r.sessionId}\` · ${r.reason ?? "rebind-cleanup-pending"}` +
        `${r.branch ? ` · \`${r.branch}\`` : ""} · \`${r.workDir}\``
    );
    const leases = [...this.localLeases.entries()].map(
      ([repo, tid]) => `\`${path.basename(repo)}\` → <#${tid}>`
    );
    const header =
      `目前 ${rows.length}/${MAX_LIVE_SESSIONS} 個 session（repos 根目錄：\`${this.reposRoot}\`）` +
      (leases.length ? `\nlocal 模式佔用中：${leases.join("、")}` : "");
    const body = rows.length ? `${header}\n${rows.join("\n")}` : `${header}\n（沒有進行中的 session）`;
    // The commonest leftover is a DELETED thread, which you cannot type inside —
    // hence `/end thread:<id>`, usable from this channel.
    const tail =
      (reapable.length
        ? `\n\n可清除的殘留記錄（在該討論串用 \`/end\`；討論串已刪除時用 \`/end thread:<id>\`）：\n${reapable.join("\n")}`
        : "") +
      (noAccess.length
        ? `\n\nDiscord 暫時無法存取、**恢復權限後會自動再試**（不必重啟；約 15 秒起、最長 5 分鐘掃一次）的記錄；確定不要對話時可用 \`/end thread:<id>\` 清除：\n${noAccess.join("\n")}`
        : "") +
      (pending.length ? `\n\n暫時無法復原、**重啟後會再試**的記錄（不會被清除）：\n${pending.join("\n")}` : "") +
      (staleRows.length
        ? `\n\n改綁後保留的舊 incarnation（runtime 未確認停止或 worktree 尚待確認）：\n${staleRows.join("\n")}`
        : "");
    await interaction.reply({
      content: (body + tail).slice(0, 1900),
      ...EPHEMERAL,
    });
  }

  /**
   * `/channel enable | disable | list` — which channels this bot answers in.
   *
   * The ONE command gated on `isOwner` rather than `isAuthorized`: it must work
   * in a channel that is not enabled yet, or no channel could ever be added.
   * Nothing else may follow it — a button or autocomplete accepted on `isOwner`
   * would let a click from an unrelated channel drive a session.
   *
   * Note this only moves the BOT's gate. Whether Discord even offers the command
   * in a channel is a separate, admin-only setting (a bot token cannot set
   * command permissions at all), so a locked-down server may hide `/channel` in
   * the very channel the operator is standing in — hence the `channel:` option,
   * which also lets a DELETED channel be removed by id.
   */
  private async cmdChannel(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isOwner(ctxOf(interaction), this.policyNow())) {
      await interaction.reply({ content: "Not authorized.", ...EPHEMERAL });
      return;
    }
    const sub = interaction.options.getSubcommand();
    if (sub === "list") {
      await this.channelList(interaction);
      return;
    }
    const raw = interaction.options.getString("channel");
    const explicit = parseChannelRef(raw);
    // An unparseable value must NOT silently fall back to "here": that would
    // enable or disable a different channel than the one the operator named.
    if ((raw ?? "").trim() && !explicit) {
      await interaction.reply({
        content: "`channel:` 只接受頻道 ID 或 `#頻道` 提及（例如 `123456789012345678` 或 `<#123…>`）。",
        ...EPHEMERAL,
      });
      return;
    }
    const target = explicit ?? interaction.channelId;
    if (sub === "enable") await this.channelEnable(interaction, target);
    else if (sub === "disable") await this.channelDisable(interaction, target);
  }

  private async channelList(interaction: ChatInputCommandInteraction): Promise<void> {
    const counts = new Map<string, number>();
    for (const s of this.sessions.values()) {
      counts.set(s.parentChannelId, (counts.get(s.parentChannelId) ?? 0) + 1);
    }
    const entries = this.channels.entries();
    const rows = await Promise.all(
      entries.map(async (entry) => {
        const result = await fetchChannelSafe(this.discord, entry.id);
        let visibility: string;
        if (result.kind === "ok") {
          const channel = result.channel as {
            guild?: { members?: { me?: unknown } };
          };
          visibility = botCanViewChannel(channel, channel.guild?.members?.me)
            ? "✅ 可見"
            : "⚠️ 已授權但看不到";
        } else if (result.kind === "transient") {
          visibility = "⚠️ 暫時無法稽核";
        } else {
          visibility = "⚠️ 已授權但看不到";
        }
        const source =
          entry.addedBy === CONFIG_SEED_ADDED_BY
            ? "首次啟動預設值"
            : `由 <@${entry.addedBy}> 啟用`;
        return `• <#${entry.id}>（\`${entry.id}\`）· ${visibility} · ${counts.get(entry.id) ?? 0} 個 session · ${source}`;
      })
    );
    const visibleButDisabled: string[] = [];
    for (const channel of this.discord.channels.cache.values()) {
      const candidate = channel as unknown as {
        id: string;
        type?: number;
        guildId?: string;
        guild?: { members?: { me?: unknown } };
      };
      if (
        candidate.guildId === this.config.DISCORD_GUILD_ID &&
        candidate.type === ChannelType.GuildText &&
        !this.channels.has(candidate.id) &&
        botCanViewChannel(candidate, candidate.guild?.members?.me)
      ) {
        visibleButDisabled.push(candidate.id);
      }
    }
    const drift =
      visibleButDisabled.length > 0
        ? `\n\n⚠️ bot 看得到、但尚未在程式內啟用的文字頻道：${visibleButDisabled
            .slice(0, 20)
            .map((id) => `<#${id}>`)
            .join("、")}${visibleButDisabled.length > 20 ? `（另有 ${visibleButDisabled.length - 20} 個）` : ""}`
        : "";
    await interaction.reply(
      ephemeralReply(
        (
          `這個 bot 的頻道白名單與可見度：\n${rows.join("\n") || "（白名單是空的）"}` +
          drift +
          "\n\n只有「已啟用 + bot 可見」的私密文字頻道才能正常工作。見 `docs/CHANNEL-ACCESS.md`。"
        ).slice(0, 1900)
      )
    );
  }

  /**
   * Enable a channel. Widening, so it follows the same ack-before-allow ordering
   * as `/yolo`: acknowledge FIRST, apply only after Discord confirms, and only
   * if nothing else moved the registry meanwhile. A reply that never lands must
   * not leave the bot answering somewhere the operator was never told about.
   */
  private async channelEnable(
    interaction: ChatInputCommandInteraction,
    target: string
  ): Promise<void> {
    await interaction.deferReply({ ...EPHEMERAL });
    if (this.channels.has(target)) {
      await interaction.editReply(`<#${target}> 已經是啟用狀態了。`);
      return;
    }
    const check = await this.inspectChannelTarget(target);
    if (check.error) {
      await interaction.editReply(check.error);
      return;
    }
    const warn = check.missing.length
      ? `\n⚠️ bot 在該頻道缺少這些權限：${check.missing.join("、")}。` +
        `\n仍然可以啟用（Discord 的互動不受頻道權限影響，照樣會送到 bot），但實際發文會失敗。`
      : "";
    // The acknowledgement. If it throws, nothing below runs and the channel
    // stays disabled — the failure direction that is safe.
    await interaction.editReply(
      `正在啟用 <#${target}>，之後這個頻道就能用 \`/new\` 開 session。${warn}`
    );
    // A concurrent enable of THIS target is a harmless durable no-op; a change
    // for a DIFFERENT target is irrelevant. The former is reported by
    // `ChannelRegistry.enable()` as success, and the latter must not make this
    // operator retry a request whose target is still disabled.
    const ok = this.channels.enable(target, interaction.user.id);
    await interaction
      .editReply(
        ok
          ? `✅ 已啟用 <#${target}>。${warn}\n` +
            "請把工作頻道保持為私密，並只把這個 bot app 加進它自己的工作頻道。見 `docs/CHANNEL-ACCESS.md`。"
          : `⚠️ 無法寫入頻道清單，**沒有**啟用 <#${target}>（詳見 bot 的日誌）。`
      )
      .catch(() => {});
  }

  /**
   * Disable a channel. Narrowing, so it persists FIRST and only then reports —
   * a revocation that cannot be written must be reported as a failure, never as
   * success.
   *
   * Refused while the channel still owns work. `blocked` is terminal
   * (`reconcile.ts`), so letting a disable strand live sessions would destroy
   * conversations to tidy up a list; `/end` is the command that is allowed to
   * decide a session is over.
   */
  private async channelDisable(
    interaction: ChatInputCommandInteraction,
    target: string
  ): Promise<void> {
    if (!this.channels.has(target)) {
      await interaction.reply({
        content: `<#${target}> 本來就沒有啟用。`,
        ...EPHEMERAL,
      });
      return;
    }
    const held = this.channelHolders(target);
    if (held.length) {
      await interaction.reply({
        content:
          `⚠️ <#${target}> 底下還有 ${held.length} 個 session（或建立中的記錄），先用 \`/end\` 結束它們再停用：\n` +
          held
            .slice(0, 10)
            .map((t) => `• <#${t}> — \`/end\`，討論串已刪除時用 \`/end thread:${t}\``)
            .join("\n") +
          (held.length > 10 ? `\n…另有 ${held.length - 10} 個（用 \`/sessions\` 查看）。` : ""),
        ...EPHEMERAL,
      });
      return;
    }
    const ok = this.channels.disable(target);
    await interaction.reply({
      content: ok
        ? `✅ 已停用 <#${target}>。bot 不會再回應那裡；若也要讓 bot 從該私密頻道消失，請在頻道權限中移除它。`
        : `⚠️ 無法寫入頻道清單，<#${target}> **仍然是啟用狀態**（詳見 bot 的日誌）。`,
      ...EPHEMERAL,
    });
  }

  /** Threads that still tie work to `channelId` — live actors plus records that
   *  reconcile would still try to resume or that a `/new` is mid-way through. */
  private channelHolders(channelId: string): string[] {
    const out = new Set<string>();
    for (const [threadId, s] of this.sessions) {
      if (s.parentChannelId === channelId) out.add(threadId);
    }
    for (const r of this.store.all()) {
      if (r.parentChannelId !== channelId) continue;
      if (r.state === "active" || r.state === "creating") out.add(r.threadId);
    }
    return [...out];
  }

  /** Validate an enable target and report which working permissions the bot is
   *  missing there. Missing permissions are advisory, not a refusal: a
   *  permission is not an authorization, and Discord delivers interactions to
   *  the bot either way. */
  private async inspectChannelTarget(
    target: string
  ): Promise<{ error?: string; missing: string[] }> {
    const result = await fetchChannelSafe(this.discord, target);
    if (result.kind !== "ok") {
      return {
        missing: [],
        error:
          result.kind === "gone"
            ? `找不到頻道 \`${target}\`。請確認 ID 正確，並先把 bot 加進該私密頻道。`
            : result.kind === "no-access"
              ? privateChannelAccessGuidance(target)
              : `無法讀取頻道 \`${target}\`：${
                  result.error instanceof Error ? result.error.message : String(result.error)
                }`,
      };
    }
    const c = result.channel as {
      type?: number;
      guildId?: string;
      permissionsFor?: (m: unknown) => { has: (p: bigint) => boolean } | null;
      guild?: { members?: { me?: unknown } };
    };
    if (isObfuscatedChannel(c)) {
      return { missing: [], error: privateChannelAccessGuidance(target) };
    }
    if (c.guildId !== this.config.DISCORD_GUILD_ID) {
      return { missing: [], error: `\`${target}\` 不在設定的伺服器裡，拒絕啟用。` };
    }
    if (c.type !== ChannelType.GuildText) {
      return {
        missing: [],
        error:
          `\`${target}\` 不是一般文字頻道（討論串、論壇、公告、語音都不行）。` +
          "session 是「文字頻道底下的討論串」，所以父層必須是文字頻道。",
      };
    }
    const me = c.guild?.members?.me;
    if (!me || typeof c.permissionsFor !== "function") {
      return {
        missing: [],
        error: `無法確認 bot 在頻道 \`${target}\` 的 View Channel 權限，拒絕啟用。`,
      };
    }
    const perms = c.permissionsFor(me);
    if (!perms?.has(PermissionFlagsBits.ViewChannel)) {
      return { missing: [], error: privateChannelAccessGuidance(target) };
    }
    const missing = REQUIRED_CHANNEL_PERMISSIONS.filter(
      (p) => (!p.fileDeliveryOnly || this.fileDeliveryAvailable()) && !perms.has(p.flag)
    ).map((p) => p.label);
    return { missing };
  }

  // ------------------------------------------------------------ /repo -------

  /**
   * Autocomplete for repo names. Auth-gated: the choice list names every project
   * on the operator's disk, so an unauthorized user must not be able to
   * enumerate it by opening the command picker.
   *
   * `respond()` is the only valid reply to an autocomplete interaction — it is
   * NOT repliable, so `reply()` throws and the client is left spinning. An empty
   * list is always a safe answer.
   */
  private async onAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const respond = async (choices: Array<{ name: string; value: string }>): Promise<void> => {
      await interaction.respond(choices.slice(0, 25)).catch(() => {});
    };
    if (this.phase !== "ready" || !isAuthorized(ctxOf(interaction), this.policyNow())) {
      await respond([]);
      return;
    }
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "repo" && focused.name !== "name") {
      await respond([]);
      return;
    }
    const q = focused.value.trim().toLowerCase();
    const names = listRepos(this.reposRoot).filter((n) => !q || n.toLowerCase().includes(q));
    await respond(names.map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) })));
  }

  private async cmdRepo(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policyNow())) {
      await this.refuseUnauthorized(interaction);
      return;
    }
    const sub = interaction.options.getSubcommand();
    if (sub === "list") {
      const names = listRepos(this.reposRoot);
      const held = new Map([...this.localLeases].map(([k, v]) => [k, v]));
      const lines = names.map((n) => {
        const holder = held.get(this.leaseKey(join(this.reposRoot, n)));
        return `• \`${n}\`${holder ? ` — 🔒 local 模式由 <#${holder}> 佔用中` : ""}`;
      });
      await interaction.reply({
        content:
          `📁 \`${this.reposRoot}\` 底下的 repo（${names.length}）：\n` +
          (lines.length ? lines.join("\n") : "（沒有。用 `/repo clone` 或 `/repo new` 建立。）"),
        ...EPHEMERAL,
      });
      return;
    }
    if (sub === "show") {
      const s = this.sessions.get(interaction.channelId);
      if (!s) {
        await interaction.reply({
          content: "這個討論串沒有進行中的 session。",
          ...EPHEMERAL,
        });
        return;
      }
      await interaction.reply({
        content:
          `📁 repo：\`${path.basename(s.repoPath)}\`（\`${s.repoPath}\`）\n` +
          `🛠️ 模式：\`${s.devMode}\`${s.branch ? ` · 分支 \`${s.branch}\`` : ""}\n` +
          `📂 完整工作目錄：\`${s.workDir}\``,
        ...EPHEMERAL,
      });
      return;
    }
    if (sub === "set") {
      const name = interaction.options.getString("name", true);
      let repoPath: string;
      try {
        repoPath = this.repoByName(name);
      } catch (err) {
        await interaction.reply({
          content: `⚠️ ${err instanceof Error ? err.message : String(err)}`,
          ...EPHEMERAL,
        });
        return;
      }
      await this.beginRebind(interaction, { repoPath });
      return;
    }
    if (sub === "clone" || sub === "new") {
      await this.cmdProvision(interaction, sub);
      return;
    }
    // sub === "dev"
    const mode = interaction.options.getString("mode", true) as DevMode;
    await this.beginRebind(interaction, { devMode: mode });
  }

  /**
   * `/repo clone` and `/repo new` — create a repo under REPOS_ROOT, then bind
   * this thread to it through the same rebind path as `/repo set`.
   *
   * Provisioning runs OUTSIDE the rebind: a clone can take minutes, and holding
   * a confirmation card open across it would guarantee the post-click
   * revalidation fails. So the repo is created first (a new folder harms
   * nothing), and only then is the operator asked whether to move this thread
   * onto it.
   */
  private async cmdProvision(
    interaction: ChatInputCommandInteraction,
    kind: "clone" | "new"
  ): Promise<void> {
    const threadId = interaction.channelId;
    if (this.provisioning.has(threadId)) {
      await interaction.reply({
        content: "⏳ 這個討論串正在建立 repo，請等它完成。",
        ...EPHEMERAL,
      });
      return;
    }
    await interaction.deferReply({ ...EPHEMERAL });
    this.provisioning.add(threadId);
    try {
      let result;
      if (kind === "new") {
        result = await this.provisioner().init(interaction.options.getString("name", true));
      } else {
        result = await this.provisioner().clone(
          interaction.options.getString("source", true),
          interaction.options.getString("name") ?? undefined,
          {
            hostPolicy: this.config.REPO_CLONE_HOST_POLICY,
            allowedHosts: this.config.REPO_CLONE_ALLOWED_HOSTS,
          }
        );
      }
      const made = `✅ 已建立 \`${result.name}\`\n📂 \`${result.path}\``;
      // Bind it if this thread has a session; otherwise the repo simply exists
      // and `/new repo:<name>` can pick it up.
      if (!this.sessions.has(threadId)) {
        await interaction.editReply({
          content: `${made}\n（這個討論串沒有 session，用 \`/new repo:${result.name}\` 開一個。）`,
          ...NO_MENTIONS,
        });
        return;
      }
      await interaction.editReply({ content: made, ...NO_MENTIONS });
      await this.beginRebind(interaction, { repoPath: result.path }, { alreadyReplied: true });
    } catch (err) {
      // The message can quote a REMOTE git server's own words. `RepoProvisioner`
      // already runs them through `sanitizeForInlineCode`; `NO_MENTIONS` closes
      // the other half.
      await interaction.editReply({
        content: `⚠️ ${err instanceof Error ? err.message : String(err)}`,
        ...NO_MENTIONS,
      });
    } finally {
      this.provisioning.delete(threadId);
    }
  }

  /**
   * The ONE provisioner for this process.
   *
   * It must be a single instance: its destination lease ("this name is being
   * created right now", "one clone at a time") lives in an instance field, so
   * constructing a fresh one per command — as the first version did — made every
   * one of those guards unreachable, since each invocation started with an empty
   * set. The atomic rename still prevented a same-name clobber, but nothing
   * bounded how many clones ran at once.
   */
  private provisioner(): RepoProvisioner {
    this.repoProvisioner ??= new RepoProvisioner({
      reposRoot: this.reposRoot,
      timeoutMs: this.config.REPO_CLONE_TIMEOUT_MS,
    });
    return this.repoProvisioner;
  }

  /**
   * Start a rebind: check what can be checked NOW, then either do it (no history
   * to lose) or put a confirmation in front of it.
   *
   * The pre-checks are deliberately repeated after the click (`applyRebind`).
   * Anything decided here is stale by the time a button is pressed: a plain
   * message starts a turn, `/queue` starts one when idle, and neither knows a
   * rebind is pending. What is checked here is only to fail fast and to say
   * something useful.
   */
  private async beginRebind(
    interaction: ChatInputCommandInteraction,
    want: { repoPath?: string; devMode?: DevMode },
    opts: { alreadyReplied?: boolean } = {}
  ): Promise<void> {
    const threadId = interaction.channelId;
    const session = this.sessions.get(threadId);
    const say = async (content: string, components?: ActionRowBuilder<ButtonBuilder>[]): Promise<void> => {
      // `/repo clone` has already deferred AND edited its reply, so a further
      // `reply()` would throw "already acknowledged"; a follow-up is the only
      // way to add the confirmation card to that same interaction.
      const body = { content, ...NO_MENTIONS, ...(components ? { components } : {}) };
      if (opts.alreadyReplied) {
        await interaction.followUp({ ...body, ...EPHEMERAL });
        return;
      }
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(body);
        return;
      }
      await interaction.reply({ ...body, ...EPHEMERAL });
    };
    if (!session) {
      await say("這個討論串沒有進行中的 session，請先用 `/new`。");
      return;
    }
    const target = {
      repoPath: want.repoPath ?? session.repoPath,
      devMode: want.devMode ?? session.devMode,
    };
    if (target.repoPath === session.repoPath && target.devMode === session.devMode) {
      await say(`已經是這個設定了（\`${path.basename(target.repoPath)}\` · \`${target.devMode}\`），沒有變更。`);
      return;
    }
    if (!opts.alreadyReplied && !interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ...EPHEMERAL });
    }
    const blocked = await this.rebindBlocker(threadId, session, target);
    if (blocked) {
      await say(blocked);
      return;
    }
    // Nothing to lose ⇒ no confirmation. A session that has never run a turn has
    // no conversation to discard, and making the operator confirm the discarding
    // of nothing is how confirmations stop being read.
    if (!session.hasRunTurn) {
      await say(await this.applyRebind(threadId, target));
      return;
    }
    const nonce = this.publishRebindConfirm(threadId, session, target);
    await say(
      `⚠️ 這個討論串已經有對話紀錄。切換到 \`${path.basename(target.repoPath)}\` · \`${target.devMode}\` ` +
        `必須建立新的 Copilot session，**目前的對話歷史會消失**（Copilot SDK 只在建立 session 時接受工作目錄）。\n` +
        // Provisioning happens BEFORE this card on purpose — a clone can take
        // minutes, and a confirmation held open across it would be stale by the
        // time it was answered. The cost is that "取消" does not undo the clone,
        // so say so rather than let the operator infer it.
        (opts.alreadyReplied ? "（取消只會維持原本的綁定；剛剛建立的 repo 會留在 `REPOS_ROOT` 底下。）\n" : "") +
        `要繼續嗎？`,
      [rebindButtons(nonce)]
    );
  }

  /**
   * Everything that must be true for a rebind, or a message saying what is not.
   *
   * Called BOTH before the confirmation is shown and again after the click,
   * because every one of these can change while a button sits on screen: a plain
   * message starts a turn (`onMessage`), `/queue` starts one when idle, and
   * another thread can take the local lease.
   */
  private async rebindBlocker(
    threadId: string,
    session: Session,
    target: { repoPath: string; devMode: DevMode }
  ): Promise<string | undefined> {
    if (
      [...this.staleRebindActors.values()].some(
        (entry) => entry.threadId === threadId && entry.fallbackPrimary !== undefined
      )
    ) {
      return "⚠️ 前一次改綁的安全屏障仍在清理／對帳中。為避免把目標建立預留誤認為舊 session，請稍後再試。";
    }
    // The in-memory tracker is intentionally not restart-durable: it owns a
    // local actor/root. If a process ends before reconciliation, the retained
    // primary `creating` row is still a fail-closed barrier rather than a valid
    // predecessor for another rebind.
    if (this.store.get(threadId)?.state === "creating") {
      return "⚠️ 這個討論串有未完成的 session 建立預留，無法安全改綁。請先處理／結束該預留後再試。";
    }
    if (session.running) {
      return "⏳ 這個 session 正在執行中。請等它結束，或先用 `/stop`，再改綁。";
    }
    if (session.queue.length) {
      return `⏳ 佇列中還有 ${session.queue.length} 則訊息。請先 \`/queue clear:true\`，或等它跑完。`;
    }
    if (target.devMode === "local") {
      const holder = this.localHolder(target.repoPath);
      if (holder !== undefined && holder !== threadId) {
        return (
          `🔒 \`${path.basename(target.repoPath)}\` 已經被 <#${holder}> 以 local 模式佔用。\n` +
          "同一個 repo 同時只能有一個 local session——兩個 agent 改同一份 checkout 會互相覆蓋，" +
          "其中一個 `git checkout` 就會毀掉另一個未提交的工作。請改用 `worktree` 模式，或先結束那個討論串。"
        );
      }
    }
    // The CURRENT worktree is about to be left behind. Refuse rather than orphan
    // it: after a rebind nothing points at it any more — `/end` acts on the
    // session's NEW binding — so a tree with uncommitted work would become
    // unreachable from every command.
    if (session.devMode === "worktree" && session.branch) {
      const condition = await inspectWorktree(session.workDir, session.branch);
      if (condition === "dirty") {
        return (
          `🌿 目前的 worktree \`${session.workDir}\` 還有未提交／未追蹤／被忽略的內容。\n` +
          "改綁之後就沒有任何記錄指向它了，所以這裡不動它。請先 commit／push 或自行處理後再試。"
        );
      }
      if (condition === "detached") {
        return (
          `🌿 目前 worktree 的 HEAD 不是 \`${session.branch}\`（detached 或換了分支），` +
          "裡面可能有沒有任何分支指向的 commit。請自行確認後再改綁。"
        );
      }
      if (condition === "unknown") {
        return "🌿 無法確認目前 worktree 是否乾淨（git 沒有回應），為安全起見不改綁。";
      }
    }
    return undefined;
  }

  /**
   * Register the confirmation with the session's own broker and return its nonce.
   *
   * Reusing `PendingInteractionBroker` rather than inventing a second
   * confirmation mechanism buys the whole set of properties it already
   * guarantees, for free: settle-exactly-once, a cryptographic nonce, the
   * cross-thread guard in `onButton`, the "此互動已失效" reply for an expired
   * card, and — the important one — `/stop`, disconnect and shutdown already
   * abort every pending entry with its SAFE default. Here that default is
   * `cancel`, so a rebind can never outlive the session being stopped.
   */
  private publishRebindConfirm(
    threadId: string,
    session: Session,
    target: { repoPath: string; devMode: DevMode }
  ): string {
    // Supersede any card already on screen for this thread. Without this, two
    // `/repo set` commands leave TWO live nonces on the same broker, both
    // settleable, and each `.then` calls `applyRebind` — the loser's SDK session
    // then exists with nothing referencing it. Cancelling first is friendlier
    // than refusing and keeps "the last thing you asked for is what happens".
    const previousNonce = this.rebindCards.get(threadId);
    if (previousNonce) session.broker.settle<RebindAction>(previousNonce, "cancel");

    const { nonce, promise } = session.broker.register<RebindDecision>({
      sessionKey: threadId,
      generation: session.actor.generationOf(),
      kind: "repo-rebind",
      timeoutMs: REBIND_CONFIRM_TIMEOUT_MS,
      onDefault: () => "cancel",
    });
    this.rebindCards.set(threadId, nonce);
    void promise.then(async (decision) => {
      if (this.rebindCards.get(threadId) === nonce) this.rebindCards.delete(threadId);
      if (this.endedSessions.has(session) || this.sessions.get(threadId) !== session) return;
      if (decision !== "confirm") {
        await this.transport.notice(threadId, "↩️ 取消改綁，維持原本的 repo／模式。").catch(() => {});
        return;
      }
      const msg = await this.applyRebind(threadId, target);
      const current = this.sessions.get(threadId);
      if (this.endedSessions.has(session) || !current || this.endedSessions.has(current)) return;
      await this.transport.notice(threadId, msg).catch(() => {});
    });
    return nonce;
  }

  /**
   * Perform the rebind, in the order that leaves nothing stranded on any failure.
   *
   * Mirrors the discipline in `cmdNew` and `reclaim`: prepare the new resource
   * before touching the old one, persist before creating, and keep a fence
   * rather than lose track of a runtime that might still be live.
   *
   *  1. re-check everything (the pre-click checks are stale by now)
   *  2. build the TARGET worktree — the old one is not touched yet
   *  3. prove the new binding with git before an agent is pointed at it
   *  4. reserve the new record durably
   *  5. create the new SDK session
   *  6. commit, swap the in-memory session, take/release the local lease
   *  7. disconnect the old actor (report honestly if that cannot be confirmed)
   *  8. only now let go of the old worktree
   */
  private async applyRebind(
    threadId: string,
    target: { repoPath: string; devMode: DevMode }
  ): Promise<string> {
    // One rebind per thread at a time. Everything below is a long chain of
    // awaits (git subprocesses, then an SDK create), and two runs would each
    // build a worktree, each reserve+commit over the other's record, and each
    // `sessions.set` — after which the loser's SessionActor is live, referenced
    // by nothing, invisible to `stop()`, holding a worktree the store does not
    // mention. Mirrors the `this.creating` guard on `/new`.
    if (this.rebinding.has(threadId)) {
      return "⏳ 這個討論串已經有一個改綁在進行中，這次沒有執行。";
    }
    this.rebinding.add(threadId);
    try {
      return await this.applyRebindInner(threadId, target);
    } finally {
      this.rebinding.delete(threadId);
    }
  }

  /** Build the one ownership object shared by normal rebind completion, `/end`
   * and shutdown. The durable record is made before the main record is
   * overwritten; this in-memory entry keeps the actor's trusted root fenced
   * until the same cleanup plan sees a confirmed disconnect. */
  private staleRebindActor(
    actor: SessionActor,
    binding: SessionRecord,
    preflightClean: boolean
  ): StaleRebindActor {
    const immutableBinding = { ...binding };
    let entry!: StaleRebindActor;
    entry = {
      actor,
      threadId: immutableBinding.threadId,
      binding: immutableBinding,
      // A fallback plan is installed only after the stale-row write fails.
      // Read it at cleanup time rather than capturing its initial absence:
      // otherwise a later confirmed retry would delete that row before the
      // primary fallback can be atomically reconciled.
      cleanupPlan: () =>
        this.reclaimStaleRebind(immutableBinding, preflightClean, entry.fallbackPrimary === undefined),
    };
    return entry;
  }

  private fallbackPrimaryPlan(
    target: SessionRecord,
    original?: SessionRecord,
    canRestore?: () => boolean,
    afterRestore?: () => void,
    resumeFileDelivery?: () => void
  ): FallbackPrimaryReconciliationPlan {
    return {
      expectedTarget: {
        threadId: target.threadId,
        sessionId: target.sessionId,
        generation: target.generation,
      },
      action: original ? "restore" : "remove",
      ...(original
        ? {
            original: { ...original },
            canRestore,
            afterRestore,
            resumeFileDelivery,
          }
        : {}),
    };
  }

  /** `/end` wins before it awaits either actor. Any fallback tracker created
   * by the failed rebind must therefore remove its exact target reservation,
   * never restore the old record after the command has ended it. */
  private markFallbackPrimaryEnded(threadId: string): void {
    for (const entry of this.staleRebindActors.values()) {
      const fallback = entry.fallbackPrimary;
      if (!fallback || entry.threadId !== threadId) continue;
      this.setFallbackPrimaryRemoval(fallback);
    }
  }

  /** Once `/end` owns the thread, a fallback may only remove its exact target.
   * Clear every restore-only callback before any teardown await, because a
   * retry can otherwise observe the old plan after the owner has gone away. */
  private setFallbackPrimaryRemoval(fallback: FallbackPrimaryReconciliationPlan): void {
    fallback.action = "remove";
    fallback.original = undefined;
    fallback.canRestore = undefined;
    fallback.afterRestore = undefined;
    fallback.resumeFileDelivery = undefined;
  }

  /** Persist and strongly retain an actor that has already failed a disconnect
   * attempt. The durable row uses existing `blocked` semantics, so reconcile
   * cannot accidentally resume this old conversation. Callers that would
   * otherwise remove or restore its primary reservation must use the returned
   * result as a durability gate. */
  private retainStaleRebindActor(
    entry: StaleRebindActor,
    reason = "rebind-teardown-unconfirmed",
    fallbackPrimary?: FallbackPrimaryReconciliationPlan
  ): boolean {
    const persisted = this.store.retainStaleRebind(entry.binding, reason);
    if (!persisted) {
      // The pre-swap intent was persisted before this method is reachable for
      // an old actor. Keep the root in memory even if a reason refresh loses a
      // transient disk race; silently releasing it would be worse.
      console.warn(`rebind: could not persist stale actor ${entry.binding.sessionId} (${reason})`);
      if (fallbackPrimary) entry.fallbackPrimary = fallbackPrimary;
    }
    this.staleRebindActors.set(entry.actor, entry);
    this.scheduleStaleRebindRetry(entry);
    return persisted;
  }

  private scheduleStaleRebindRetry(entry: StaleRebindActor): void {
    queueMicrotask(() => {
      if (this.staleRebindActors.get(entry.actor) === entry) {
        void this.retryStaleRebindActor(entry.actor);
      }
    });
  }

  /** Retry one actor. A concurrent normal rebind completion or `/end` joins the
   * same `disconnecting` promise below, so retry never creates competing SDK
   * teardowns for one root. */
  private async retryStaleRebindActor(actor: SessionActor): Promise<void> {
    const entry = this.staleRebindActors.get(actor);
    if (!entry) return;
    await this.disconnectStaleRebindActor(entry);
  }

  /** Explicit cleanup (and shutdown) is per owning Discord thread, not merely
   * per current map entry: after a map swap there can be both a replacement and
   * its old incarnation. */
  private async retryStaleRebindActorsForThread(threadId: string): Promise<void> {
    const entries = [...this.staleRebindActors.values()].filter((entry) => entry.threadId === threadId);
    for (const entry of entries) await this.retryStaleRebindActor(entry.actor);
  }

  /** Complete the primary side of a fallback only after the actor is confirmed
   * gone and its worktree cleanup plan succeeded. A mismatch or write failure
   * deliberately leaves both the target barrier and this actor tracker in
   * place: neither a newer record nor a possibly-live runtime is ours to drop. */
  private reconcileFallbackPrimary(entry: StaleRebindActor): { ok: boolean; tail: string } {
    const fallback = entry.fallbackPrimary;
    if (!fallback) return { ok: true, tail: "" };

    if (fallback.action === "restore" && (!fallback.original || !fallback.canRestore?.())) {
      // This catches `/end` even if it raced immediately before this retry.
      // Removing is safe only under the target CAS; restoring is not.
      fallback.action = "remove";
      fallback.original = undefined;
      fallback.canRestore = undefined;
      fallback.afterRestore = undefined;
      fallback.resumeFileDelivery = undefined;
    }

    const targetStale: SessionIdentity = {
      threadId: entry.binding.threadId,
      sessionId: entry.binding.sessionId,
      generation: entry.binding.generation,
    };
    const result =
      fallback.action === "restore" && fallback.original
        ? this.store.reconcileFallbackPrimary(fallback.expectedTarget, {
            kind: "restore",
            original: fallback.original,
            staleRebinds: [
              targetStale,
              {
                threadId: fallback.original.threadId,
                sessionId: fallback.original.sessionId,
                generation: fallback.original.generation,
              },
            ],
          })
        : this.store.reconcileFallbackPrimary(fallback.expectedTarget, {
            kind: "remove",
            staleRebinds: [targetStale],
          });
    if (!result.ok) {
      console.warn(
        `rebind: fallback primary ${fallback.expectedTarget.sessionId} did not conditionally reconcile; retaining barrier and actor ownership`
      );
      return {
        ok: false,
        tail:
          "\n⚠️ 已確認 replacement runtime 停止，但無法安全對帳其建立預留；安全屏障與清理擁有權均保留，請稍後重試。",
      };
    }
    if (fallback.action === "restore") {
      fallback.afterRestore?.();
      if (!result.quotaAdvanced) fallback.resumeFileDelivery?.();
    }
    return { ok: true, tail: "" };
  }

  /** Make exactly one bounded disconnect attempt for a stale incarnation. On
   * success its cleanup plan rechecks the worktree before deletion; on failure
   * the `blocked` durable row and strong actor/root reference both remain. */
  private async disconnectStaleRebindActor(
    entry: StaleRebindActor
  ): Promise<StaleRebindTeardown> {
    if (entry.disconnecting) return entry.disconnecting;
    const attempt = (async (): Promise<StaleRebindTeardown> => {
      try {
        await withTimeout(entry.actor.disconnect(), TEARDOWN_TIMEOUT_MS);
      } catch {
        if (!this.store.retainStaleRebind(entry.binding, "rebind-teardown-unconfirmed")) {
          console.warn(`rebind: could not mark stale actor ${entry.binding.sessionId} unconfirmed`);
        }
        this.staleRebindActors.set(entry.actor, entry);
        return {
          confirmed: false,
          cleaned: false,
          tail: "\n⚠️ 無法確認舊的 runtime 已關閉，建議稍後重啟 bot。",
        };
      }
      const cleanup = await entry.cleanupPlan();
      const fallback = cleanup.ok ? this.reconcileFallbackPrimary(entry) : { ok: true, tail: "" };
      const cleaned = cleanup.ok && fallback.ok;
      if (cleaned && this.staleRebindActors.get(entry.actor) === entry) {
        this.staleRebindActors.delete(entry.actor);
      }
      return { confirmed: true, cleaned, tail: `${cleanup.tail}${fallback.tail}` };
    })();
    entry.disconnecting = attempt;
    try {
      return await attempt;
    } finally {
      if (entry.disconnecting === attempt) entry.disconnecting = undefined;
    }
  }

  private async applyRebindInner(
    threadId: string,
    target: { repoPath: string; devMode: DevMode }
  ): Promise<string> {
    const session = this.sessions.get(threadId);
    if (!session) return "⚠️ 這個討論串已經沒有進行中的 session，未改綁。";
    if (this.endedSessions.has(session)) return "⚠️ 這個討論串已結束，改綁未執行。";
    const ownsOldSession = (): boolean =>
      this.sessions.get(threadId) === session && !this.endedSessions.has(session);
    const endedRebind = "⚠️ 這個討論串已結束，改綁已取消。";
    // Fence old attachments synchronously, before rebindBlocker or any git/SDK
    // await. A stale actor must not reserve or send against the replacement
    // record while this transaction is in flight.
    const fileDeliveryFence = session.actor.suspendFileDelivery();
    const restoreOldFileDelivery = (): void => {
      if (ownsOldSession()) {
        session.actor.resumeFileDeliveryIfCurrent(fileDeliveryFence);
      }
    };
    const stale = await this.rebindBlocker(threadId, session, target);
    if (!ownsOldSession()) return endedRebind;
    if (stale) {
      restoreOldFileDelivery();
      return `${stale}\n（在你確認的這段時間內狀態改變了，因此未改綁。）`;
    }

    const old = { ...session };
    const branch = target.devMode === "worktree" ? worktreeBranch(threadId) : undefined;
    const requestedWorkDir =
      target.devMode === "worktree"
        ? worktreePath(worktreeRoot(), target.repoPath, threadId)
        : target.repoPath;

    let createdWorktree = false;
    let trustedRoot: TrustedRoot | undefined;
    let reservedIdentity: { sessionId: string; generation: number } | undefined;
    let replacementActor: SessionActor | undefined;
    let replacementBinding: SessionRecord | undefined;
    let oldStale: StaleRebindActor | undefined;
    let targetLeaseHeld = false;
    if (target.devMode === "worktree" && branch) {
      try {
        await pruneWorktrees(target.repoPath);
        if (!ownsOldSession()) return endedRebind;
        await addWorktree(target.repoPath, requestedWorkDir, branch);
        createdWorktree = true;
        if (!ownsOldSession()) {
          await removeWorktreeIfClean(target.repoPath, requestedWorkDir, branch).catch(() => "failed" as const);
          return endedRebind;
        }
      } catch (err) {
        if (!ownsOldSession()) return endedRebind;
        restoreOldFileDelivery();
        return `⚠️ 無法建立目標 worktree（${err instanceof Error ? err.message : String(err)}）。未改綁，原本的設定不變。`;
      }
    }
    const undoWorktree = async (): Promise<void> => {
      if (createdWorktree) {
        await removeWorktreeIfClean(target.repoPath, requestedWorkDir, branch).catch(() => "failed" as const);
      }
    };
    const releaseTargetLease = (): void => {
      if (!targetLeaseHeld) return;
      const key = this.leaseKey(target.repoPath);
      if (this.localLeases.get(key) === threadId) this.localLeases.delete(key);
      targetLeaseHeld = false;
    };
    /** Dispose resources that were prepared after `/end` claimed the old
     * session. Crucially this never restores the old record or file fence:
     * `/end` is the winner, not a failed rebind rollback. */
    const abandonEndedRebind = async (): Promise<string> => {
      // The first commit-failure disconnect may have raced `/end` before its
      // fallback tracker was registered. Flip an existing plan synchronously;
      // a plan created below is removal-only as well.
      this.markFallbackPrimaryEnded(threadId);
      const trackedReplacement =
        replacementActor === undefined ? undefined : this.staleRebindActors.get(replacementActor);
      if (trackedReplacement?.fallbackPrimary) {
        // The fallback owns BOTH the primary reservation and the terminal
        // tracker. Its cleanup must run through one CAS transaction: removing
        // the primary here would strand the tracker if its later reconciliation
        // loses the target or cannot persist.
        const teardown = await this.disconnectStaleRebindActor(trackedReplacement);
        releaseTargetLease();
        return `${endedRebind}${teardown.tail}`;
      }

      let replacementClosed = true;
      let replacementDurablyRetained = true;
      let fallbackPrimaryRetained = false;
      if (replacementActor) {
        try {
          await withTimeout(replacementActor.disconnect(), TEARDOWN_TIMEOUT_MS);
        } catch {
          replacementClosed = false;
          // Retain the actor and root fence until a retry can CONFIRM teardown;
          // do not let a timed-out `/end` turn it into an invisible writer.
          if (replacementBinding) {
            const fallback = this.fallbackPrimaryPlan(replacementBinding);
            this.setFallbackPrimaryRemoval(fallback);
            const stale = this.staleRebindActor(replacementActor, replacementBinding, true);
            replacementDurablyRetained = this.retainStaleRebindActor(
              stale,
              "rebind-teardown-unconfirmed",
              // `/end` already claimed the old session. If persistence fails,
              // retry may remove only this exact target reservation.
              fallback
            );
            fallbackPrimaryRetained = stale.fallbackPrimary !== undefined;
          } else {
            // This should be unreachable: a replacement actor is created only
            // after reserve has produced its immutable binding. Do not close a
            // root we cannot durably describe.
            console.warn("rebind: replacement actor lost its durable binding before teardown");
            replacementDurablyRetained = false;
          }
        }
      } else {
        await trustedRoot?.close().catch(() => {});
      }
      // If the terminal stale row could not be written, the target reservation
      // is the only crash-surviving pointer to this possibly-live replacement.
      // Never remove it until teardown is durably represented elsewhere.
      if (!fallbackPrimaryRetained) {
        if (reservedIdentity && (replacementClosed || replacementDurablyRetained)) {
          this.store.removeIfCurrent(threadId, reservedIdentity.sessionId, reservedIdentity.generation);
        } else if (reservedIdentity) {
          console.warn(
            `rebind: retaining target reservation ${reservedIdentity.sessionId} as fallback after stale ownership write failure`
          );
        }
      }
      releaseTargetLease();
      if (replacementClosed) await undoWorktree();
      if (!replacementClosed && !replacementDurablyRetained) {
        return (
          `${endedRebind}\n` +
          "⚠️ 無法持久化新 runtime 的終止記錄；目標 session 記錄已保留為安全屏障，未完成清理。請重啟 bot 或稍後重試。"
        );
      }
      return endedRebind;
    };

    let captured;
    try {
      captured = await this.captureValidatedRoot({
        repoPath: target.repoPath,
        workDir: requestedWorkDir,
        devMode: target.devMode,
        branch,
      });
    } catch (err) {
      if (!ownsOldSession()) return abandonEndedRebind();
      restoreOldFileDelivery();
      await undoWorktree();
      return `⚠️ 無法安全開啟目標工作目錄（${err instanceof Error ? err.message : String(err)}）。未改綁。`;
    }
    if (!ownsOldSession()) {
      if (captured.ok) trustedRoot = captured.trustedRoot;
      return abandonEndedRebind();
    }
    if (!captured.ok) {
      restoreOldFileDelivery();
      await undoWorktree();
      return `⚠️ 目標綁定無法通過驗證（${describeBindingProblem(captured.verdict.problem)}：${captured.verdict.detail}）。未改綁。`;
    }
    trustedRoot = captured.trustedRoot;
    const workDir = captured.binding.workDir;
    const approvalKey = captured.approvalKey;

    // Take the lease BEFORE the new session exists, so a concurrent
    // `/repo dev local` in another thread cannot slip in between check and create.
    // Release the OLD one first: a local→local move to a DIFFERENT repo would
    // otherwise leave this thread holding the repo it just left, blocking every
    // other thread from it for ever.
    if (target.devMode === "local") {
      if (!ownsOldSession()) return abandonEndedRebind();
      this.releaseLocalLease(threadId);
      const lease = this.acquireLocalLease(target.repoPath, threadId);
      if (!lease.ok) {
        await trustedRoot?.close().catch(() => {});
        trustedRoot = undefined;
        if (!ownsOldSession()) return abandonEndedRebind();
        restoreOldFileDelivery();
        this.restoreLeaseFor(threadId, old);
        await undoWorktree();
        return `🔒 \`${path.basename(target.repoPath)}\` 剛剛被 <#${lease.holder}> 取走 local 佔用，未改綁。`;
      }
      targetLeaseHeld = true;
      if (!ownsOldSession()) return abandonEndedRebind();
    }

    if (!ownsOldSession()) return abandonEndedRebind();
    const sessionId = randomUUID();
    const generation = this.store.nextGeneration();
    const previous = this.store.get(threadId);
    if (!previous) {
      // A live actor without its persist-first record is already an unsafe
      // state. Do not overwrite the only possible durable pointer with a
      // replacement whose rollback could not describe the old root.
      await trustedRoot?.close().catch(() => {});
      trustedRoot = undefined;
      restoreOldFileDelivery();
      this.restoreLeaseFor(threadId, old);
      await undoWorktree();
      return "⚠️ 找不到目前 session 的耐久記錄，為避免遺失舊 runtime／worktree 擁有權，未改綁。";
    }
    // A rebind replaces the SDK conversation but not the Discord thread that
    // owns this outbound capability, so retain its conservative quota.
    const fileDeliveryBytes = previous.fileDeliveryBytes;
    if (!ownsOldSession()) return abandonEndedRebind();
    // Persist the old incarnation BEFORE `reserve()` replaces the mutable
    // thread slot. If `/end` wins during target create, this is the durable
    // pointer it terminalizes; it is never a resumable second session.
    oldStale = this.staleRebindActor(old.actor, previous, true);
    if (!this.store.retainStaleRebind(previous, "rebind-cleanup-pending")) {
      await trustedRoot?.close().catch(() => {});
      trustedRoot = undefined;
      restoreOldFileDelivery();
      this.restoreLeaseFor(threadId, old);
      await undoWorktree();
      return "⚠️ 無法持久化舊 session 的改綁清理記錄，未改綁。請檢查磁碟／權限後重試。";
    }
    this.pendingRebindOlds.set(session, oldStale);
    const reserved = this.store.reserve({
      threadId,
      sessionId,
      generation,
      repoPath: target.repoPath,
      guildId: this.config.DISCORD_GUILD_ID,
      // The thread does not MOVE when its repo is rebound, so its parent is
      // whatever it already was. Writing the configured seed channel here (as
      // this did) silently relocated every rebound session onto the seed: a
      // session started in any other enabled channel then failed `bindingOk` on
      // the next restart and was marked `blocked` — terminal.
      parentChannelId: session.parentChannelId,
      workDir,
      devMode: target.devMode,
      fileDeliveryBytes,
      branch,
    });
    if (!reserved) {
      await trustedRoot?.close().catch(() => {});
      trustedRoot = undefined;
      if (!ownsOldSession()) return abandonEndedRebind();
      this.pendingRebindOlds.delete(session);
      this.store.removeStaleRebind(previous.threadId, previous.sessionId, previous.generation);
      restoreOldFileDelivery();
      this.restoreLeaseFor(threadId, old);
      await undoWorktree();
      return "⚠️ 無法持久化 session 狀態（寫入磁碟失敗），未改綁。請檢查磁碟／權限後重試。";
    }
    reservedIdentity = { sessionId, generation };
    replacementBinding = this.store.get(threadId);

    const broker = new PendingInteractionBroker();
    let actor: SessionActor;
    try {
      if (!ownsOldSession()) return abandonEndedRebind();
      actor = await SessionActor.create(this.copilot, {
        sessionKey: threadId,
        ...(trustedRoot ? { trustedRoot } : {}),
        workingDirectory: workDir,
        approvalKey,
        model: this.config.DEFAULT_MODEL,
        contextTier: this.config.DEFAULT_CONTEXT_TIER,
        broker,
        transport: this.transport,
        policy: this.approvals,
        generation,
        createSessionId: sessionId,
        ...this.fileDeliveryQuotaOptions(threadId, fileDeliveryBytes, sessionId, generation),
        ...this.skillSourceOptions(),
      });
      replacementActor = actor;
      trustedRoot = undefined; // ownership transferred to the returned actor
    } catch (err) {
      // `SessionActor.create` owns and closes the captured root on every throw.
      trustedRoot = undefined;
      if (!ownsOldSession()) return abandonEndedRebind();
      // The OLD session is still live and registered — nothing has been swapped
      // yet — restore only the row this attempt reserved. Preserving a larger
      // total keeps a late replacement reservation monotonic, at the cost of
      // leaving old file delivery fenced when its in-memory total is stale.
      const rollback = this.store.restoreIfCurrent(previous, sessionId, generation);
      if (rollback.ok) {
        this.pendingRebindOlds.delete(session);
        this.store.removeStaleRebind(previous.threadId, previous.sessionId, previous.generation);
      }
      if (rollback.ok && !rollback.quotaAdvanced) restoreOldFileDelivery();
      this.restoreLeaseFor(threadId, old);
      await undoWorktree();
      return (
        `⚠️ 建立新的 Copilot session 失敗（${err instanceof Error ? err.message : String(err)}）。未改綁，原本的對話仍在。` +
        (rollback.ok && !rollback.quotaAdvanced
          ? ""
          : "\n⚠️ 為避免覆寫較新的檔案配額，原 session 的檔案傳送保持停用。")
      );
    }
    if (!ownsOldSession()) return abandonEndedRebind();
    if (!this.store.commit(threadId)) {
      let replacementClosed = true;
      let replacementDurablyRetained = true;
      try {
        await withTimeout(actor.disconnect(), TEARDOWN_TIMEOUT_MS);
      } catch {
        replacementClosed = false;
        // A failed commit means this actor never enters `sessions`; retain it
        // until a confirmed retry releases its root, and only then remove its
        // target worktree. Otherwise a live SDK process could become invisible
        // while its working directory is deleted underneath it.
        if (replacementBinding) {
          const fallback = this.fallbackPrimaryPlan(
            replacementBinding,
            previous,
            ownsOldSession,
            () => {
              if (oldStale && this.pendingRebindOlds.get(session) === oldStale) {
                this.pendingRebindOlds.delete(session);
              }
            },
            restoreOldFileDelivery
          );
          // `/end` can claim the old actor while the initial teardown await is
          // pending. Install the removal plan BEFORE retain schedules a retry,
          // so that retry never sees a stale restore callback.
          if (!ownsOldSession()) this.setFallbackPrimaryRemoval(fallback);
          replacementDurablyRetained = this.retainStaleRebindActor(
            this.staleRebindActor(actor, replacementBinding, true),
            "rebind-teardown-unconfirmed",
            // The old actor is still current here. If this terminal row cannot
            // persist, a later confirmed retry may restore only this snapshot
            // under the target reservation's exact CAS.
            fallback
          );
        } else {
          console.warn("rebind: commit-failed replacement lost its durable binding before teardown");
          replacementDurablyRetained = false;
        }
      }
      if (!ownsOldSession()) return abandonEndedRebind();
      // A failed terminal-row write leaves the target reservation as the only
      // durable pointer to the replacement. Restoring `previous` would erase
      // it, so hold that primary barrier until a confirmed retry can clean it.
      const holdTargetReservation = !replacementClosed && !replacementDurablyRetained;
      let rollback = { ok: false, quotaAdvanced: false };
      if (!holdTargetReservation) {
        rollback = this.store.restoreIfCurrent(previous, sessionId, generation);
        if (rollback.ok) {
          this.pendingRebindOlds.delete(session);
          this.store.removeStaleRebind(previous.threadId, previous.sessionId, previous.generation);
        }
      } else {
        console.warn(
          `rebind: retaining target reservation ${sessionId} as fallback after stale ownership write failure`
        );
      }
      if (rollback.ok && !rollback.quotaAdvanced) restoreOldFileDelivery();
      this.restoreLeaseFor(threadId, old);
      if (replacementClosed) await undoWorktree();
      return (
        "⚠️ 無法持久化 session 狀態（commit 失敗），未改綁。請檢查磁碟／權限後重試。" +
        (rollback.ok && !rollback.quotaAdvanced
          ? ""
          : "\n⚠️ 為避免覆寫較新的檔案配額，原 session 的檔案傳送保持停用。") +
        (replacementClosed
          ? ""
          : holdTargetReservation
            ? "\n⚠️ 無法持久化新 runtime 的終止記錄；目標 session 記錄已保留為安全屏障，未完成清理。請重啟 bot 或稍後重試。"
            : "\n⚠️ 無法確認新 runtime 已停止；目標 worktree 暫時保留，會在確認停止後再清理。")
      );
    }

    // Swap. From here the new session owns the thread.
    if (!ownsOldSession()) return abandonEndedRebind();
    const replacement: Session = {
      actor,
      broker,
      running: false,
      titled: session.titled,
      titleEpoch: session.titleEpoch,
      queue: [],
      workDir,
      repoPath: target.repoPath,
      devMode: target.devMode,
      branch,
      parentChannelId: session.parentChannelId,
      hasRunTurn: false,
    };
    this.sessions.set(threadId, replacement);
    replacementActor = undefined; // now owned by the live-session map
    targetLeaseHeld = false; // now owned by the replacement, not this rollback
    if (target.devMode !== "local") this.releaseLocalLease(threadId);
    // Session-scoped approvals are grants for THIS conversation in THIS repo;
    // carrying them into a different repo would widen a grant the operator never
    // made there.
    this.approvals.clearSession(threadId);
    const ownsReplacement = (): boolean =>
      this.sessions.get(threadId) === replacement && !this.endedSessions.has(replacement);

    // The old actor is no longer in `sessions`, so ownership transfers to the
    // stale tracker BEFORE its first disconnect await. `/end` can now join this
    // exact operation rather than delete the replacement and leave the old
    // root/worktree unowned.
    const detachedOld = oldStale;
    if (!detachedOld) {
      // This can only happen after a broken in-memory mutation; fail closed by
      // leaving the replacement active rather than pretending its predecessor
      // was retired.
      return "⚠️ 舊 session 的改綁清理擁有權遺失，為安全起見未完成改綁。請重啟 bot。";
    }
    this.pendingRebindOlds.delete(session);
    this.staleRebindActors.set(detachedOld.actor, detachedOld);
    const oldTeardown = await this.disconnectStaleRebindActor(detachedOld);
    if (!oldTeardown.confirmed) this.scheduleStaleRebindRetry(detachedOld);
    // Cleanup happened (or its durable unconfirmed record was installed)
    // BEFORE this fence. Thus a winning `/end` cannot skip old cleanup merely
    // because it removed the replacement from the map while we were awaiting.
    if (!ownsReplacement()) return endedRebind;
    let tail = oldTeardown.tail;
    if (
      !oldTeardown.confirmed &&
      old.devMode === "worktree" &&
      old.branch &&
      old.workDir !== old.repoPath
    ) {
      tail += `\n🌿 舊的 worktree **保留**：\`${old.workDir}\`（分支 \`${old.branch}\`）—— 無法確認舊 runtime 已停止，不在此時移除。`;
    }
    return (
      `✅ 已改綁到 \`${path.basename(target.repoPath)}\` · \`${target.devMode}\`` +
      (branch ? `（分支 \`${branch}\`）` : "（直接在 repo 本體上開發）") +
      `\n📂 工作目錄：\`${workDir}\`\n🧠 這是一段全新的對話，先前的歷史不再沿用。` +
      (target.devMode === "local"
        ? "\n⚠️ local 模式：agent 會直接改這個 repo 的工作區，`/end` 沒有東西可以清除。"
        : "") +
      tail
    );
  }

  /** Put the local lease back where it was after a failed rebind. */
  private restoreLeaseFor(threadId: string, previous: Session): void {
    this.releaseLocalLease(threadId);
    if (previous.devMode === "local") this.acquireLocalLease(previous.repoPath, threadId);
  }
  private startTitling(threadId: string, session: Session, text: string): void {
    if (session.titled || !text) return;
    session.titled = true;
    const epoch = session.titleEpoch;
    void this.titleThreadFromFirstMessage(
      threadId,
      text,
      () => this.sessions.get(threadId) === session && session.titleEpoch === epoch
    ).catch(() => {});
  }

  /** Rename a session thread. Never throws: a rename is cosmetic and must not
   *  be able to fail a turn. Discord rate-limits channel renames, and discord.js
   *  queues rather than rejects, so this is always fire-and-forget from the turn
   *  path. */
  private async retitleThread(threadId: string, title: string): Promise<boolean> {
    if (!title) return false;
    const result = await fetchChannelSafe(this.discord, threadId);
    if (result.kind !== "ok") {
      if (result.kind === "transient") {
        console.warn(
          `⚠️  could not rename thread ${threadId}: ${
            result.error instanceof Error ? result.error.message : String(result.error)
          }`
        );
      }
      return false;
    }
    const thread = result.channel as { name?: string; setName?: (n: string) => Promise<unknown> };
    if (!thread.setName) return false;
    const next = title.slice(0, THREAD_NAME_MAX);
    if (next === thread.name) return false;
    try {
      await thread.setName(next);
      return true;
    } catch (err) {
      console.warn(`⚠️  could not rename thread ${threadId}: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /**
   * Name a thread from its first message, once.
   *
   * The title comes from a SMALL model in a THROWAWAY session — not from the
   * user's own session, which would pollute its history and burn its context —
   * because a raw first line makes a poor thread name: it is often far longer
   * than the sidebar shows, and the interesting part is rarely at the start.
   * The local heuristic remains the fallback for every failure path (model not
   * available, RPC error, timeout, junk reply), so a thread is never left
   * nameless and a turn is never blocked. Exactly ONE rename happens either way,
   * which keeps this clear of Discord's channel-rename rate limit.
   *
   * `epoch` fences the write: `/rename` bumps the session's title epoch, so an
   * explicit name the operator just chose can never be overwritten seconds later
   * by a titler that was already in flight.
   */
  private async titleThreadFromFirstMessage(
    threadId: string,
    firstMessage: string,
    isCurrent: () => boolean
  ): Promise<void> {
    const heuristic = deriveThreadTitle(firstMessage);
    const generated = await this.generateTitle(firstMessage);
    if (!isCurrent()) return; // superseded by /rename (or the session is gone)
    await this.retitleThread(threadId, generated || heuristic);
  }

  /** Ask a small model for a thread title. Returns "" on ANY failure — this is
   *  cosmetic and must never surface an error to the user. */
  private async generateTitle(firstMessage: string): Promise<string> {
    if (this.config.TITLE_MODEL === "off") return "";
    // Resolve against every model the runtime listed, NOT `modelIds` — that is
    // truncated to Discord's 25-choice cap for the /model command, so a title
    // model past index 24 would silently never be picked.
    const model = pickTitleModel([...this.modelEfforts.keys()], this.config.TITLE_MODEL);
    if (!model) return "";
    // `withTimeout` does not cancel the underlying call, and the SDK registers
    // the session in its client map before the create RPC — so a create that
    // lands AFTER we gave up would otherwise be live in the runtime with no
    // reference to it anywhere here (a permanent leak, once per timed-out
    // title). Attach the salvage ONLY on the timeout path: a flag checked inside
    // a handler attached up front is racy, because that handler runs before the
    // `await` continuation that would have set it — which disposes the session
    // the instant it is created.
    const creating = this.copilot.createSession({
      // A neutral temp dir: the titler reads ONE string, has no tools at all
      // (see below) and must not be implicitly attached to any repo.
      workingDirectory: tmpdir(),
      model,
      streaming: false,
      // The titler reads ONE string and must never touch the machine. Denying
      // permissions is NOT enough: only tools that ASK are stopped that way, and
      // the default (copilot-cli) tool set is ambient. `availableTools: []`
      // leaves it with no tools at all — verified against the runtime: 0 tool
      // invocations and 0 permission requests, vs glob/view/powershell by
      // default.
      availableTools: [],
      enableFileHooks: false,
      enableConfigDiscovery: false,
      enableSkills: false,
      skipCustomInstructions: true,
      onPermissionRequest: () => ({ kind: "user-not-available" }),
    } as never) as unknown as Promise<TitlerSession>;
    try {
      const session = await withTimeout(creating, TITLE_TIMEOUT_MS).catch((err: unknown) => {
        void creating.then(
          (s) => this.disposeTitler(s),
          () => {}
        );
        throw err;
      });
      try {
        let text = "";
        session.on("assistant.message", (e) => {
          const d = (e as { data?: Record<string, unknown> })?.data ?? {};
          const c = d["content"] ?? d["text"];
          if (typeof c === "string" && c.trim()) text = c;
        });
        const idle = new Promise<void>((resolve) => session.on("session.idle", () => resolve()));
        await session.send({ prompt: buildTitlePrompt(firstMessage) });
        await withTimeout(idle, TITLE_TIMEOUT_MS);
        return cleanModelTitle(text);
      } finally {
        await this.disposeTitler(session);
      }
    } catch (err) {
      console.warn(`⚠️  title model failed: ${err instanceof Error ? err.message : err}`);
      return "";
    }
  }

  /** Tear a throwaway titler session down: disconnect (releases handlers and
   *  stops any still-running turn) then delete it from the runtime's session
   *  list. Both bounded, both best effort — a titler must never be able to stall
   *  or fail anything. */
  private async disposeTitler(session: TitlerSession): Promise<void> {
    await withTimeout(session.disconnect?.() ?? Promise.resolve(), TEARDOWN_TIMEOUT_MS).catch(() => {});
    const id = session.sessionId;
    if (!id) return;
    await withTimeout(
      ((this.copilot as unknown as { deleteSession?: (i: string) => Promise<unknown> }).deleteSession?.(id) ??
        Promise.resolve()) as Promise<unknown>,
      TEARDOWN_TIMEOUT_MS
    ).catch(() => {});
  }

  /** Reconcile every persisted session on startup (P2). Runs while `phase` is
   *  "reconciling" (input rejected), so resumed sessions are registered before
   *  any /new. `deps.classifyThread` is injectable for tests. Throws on a corrupt
   *  store so startup fails closed rather than silently starting fresh. */
  private async reconcileOnStartup(deps?: {
    classifyThread?: (threadId: string, expectedParentChannelId: string) => Promise<ThreadStatus>;
    validateBinding?: typeof validateBinding;
  }): Promise<void> {
    const classify =
      deps?.classifyThread ??
      ((id: string, parent: string, opts?: { force?: boolean }) => this.classifyThread(id, parent, opts));
    this.reconcileClassify = classify;
    this.bindingCheck = deps?.validateBinding ?? validateBinding;
    // BEFORE anything reads or writes a record. A registry that could not be
    // trusted would resolve to "configured default only", every record under another
    // channel would fail `bindingOk`, and reconcile would mark them `blocked` —
    // a TERMINAL state that re-enabling the channel does not undo. Checked here
    // as well as in `start()` so the ordering invariant survives a refactor.
    this.assertChannelRegistryUsable();
    if (this.store.isCorrupt()) {
      // Checked once, for the whole file: a corrupt store says nothing reliable
      // about ANY session, so per-record handling would be guesswork.
      planReconcile({ corrupt: true });
      throw new Error(
        `session store at ${sessionStorePath()} is corrupt; refusing to start. Inspect/remove it and restart.`
      );
    }
    // Reserve every local-mode repo BEFORE the first resume attempt.
    //
    // A lease cannot be taken as a side effect of a successful resume: a
    // TRANSIENT resume failure deliberately leaves the record `active` so the
    // next restart retries it (and `/end` refuses to reap it for the same
    // reason). If that record's repo were left unheld, another thread could bind
    // it in local mode meanwhile, and the following restart would face two
    // durable claimants on one checkout with no principled way to choose.
    // Holding the lease from the moment the record is READ costs nothing when
    // the resume succeeds and is the only thing that keeps the invariant true
    // when it does not.
    for (const rec of this.store.all()) {
      if (rec.devMode !== "local" || rec.state !== "active") continue;
      if (!this.bindingOk(rec)) continue; // a record we will refuse to resume holds nothing
      const lease = this.acquireLocalLease(rec.repoPath, rec.threadId);
      if (!lease.ok) {
        console.warn(
          `reconcile: ${rec.threadId} wants ${rec.repoPath} in local mode, already claimed by ${lease.holder}; blocking.`
        );
        // A failed persist here must NOT fall through to resuming the record —
        // that would put a second agent into a checkout we just decided it may
        // not have. Fail startup instead, as with every other required
        // transition.
        if (!this.store.setState(rec.threadId, "blocked", "local-conflict")) {
          throw new FatalReconcileError(
            `reconcile: could not persist local-conflict for ${rec.threadId} at ${sessionStorePath()}`
          );
        }
      }
    }
    // Resume sequentially: each resume is a runtime RPC, and a burst of them on
    // startup competes with the reconnect the runtime is already doing.
    for (const rec of this.store.all()) {
      try {
        await this.reconcileRecord(rec, classify);
      } catch (err) {
        // One unusable record must not stop the others from coming back.
        if (err instanceof FatalReconcileError) throw err;
        console.warn(
          `reconcile: ${rec.threadId} failed (${err instanceof Error ? err.message : String(err)}); continuing.`
        );
      }
    }
    await this.announceUnreachableRecords();
  }

  // -------------------------------------------- access-restoration retry --

  /**
   * Arm the one retry loop, after reconciliation and once `phase` is "ready".
   *
   * Started here and not earlier for the same reason input is gated: a tick
   * resumes sessions, and a resume that raced the startup pass could register a
   * second live actor for one thread.
   */
  private startAccessRetryLoop(): void {
    this.accessRetryBackoff = 0;
    this.accessRetryIdle = false;
    this.scheduleAccessRetry();
  }

  /** Re-arm the single wake-up. Always clears first: two armed timers is the
   *  concrete shape a double-resume bug would take. */
  private scheduleAccessRetry(): void {
    this.clearAccessRetryTimer();
    if (this.shuttingDown) return;
    const last = ACCESS_RETRY_DELAYS_MS.length - 1;
    const ms =
      (this.accessRetryIdle
        ? ACCESS_RETRY_DELAYS_MS[last]
        : ACCESS_RETRY_DELAYS_MS[this.accessRetryBackoff]) ?? ACCESS_RETRY_DELAYS_MS[0];
    this.accessRetryTimer = this.accessRetryScheduler.set(() => {
      this.accessRetryTimer = undefined;
      this.runAccessRetryTick();
    }, ms);
  }

  private clearAccessRetryTimer(): void {
    if (this.accessRetryTimer === undefined) return;
    this.accessRetryScheduler.clear(this.accessRetryTimer);
    this.accessRetryTimer = undefined;
  }

  /** Start one tick unless one is already running, and re-arm afterwards. The
   *  re-arm lives here (not in the tick) so it happens exactly once per tick,
   *  including when the tick throws. */
  private runAccessRetryTick(): void {
    if (this.accessRetryTickPromise) return; // no overlapping tick
    const attempt = this.accessRetryTick().catch((err: unknown) => {
      console.warn(
        `access-retry: tick failed (${err instanceof Error ? err.message : String(err)}); continuing.`
      );
    });
    this.accessRetryTickPromise = attempt;
    void attempt.then(() => {
      if (this.accessRetryTickPromise === attempt) this.accessRetryTickPromise = undefined;
      this.scheduleAccessRetry();
    });
  }

  /**
   * One pass over the records ADR-0002 promised would come back by themselves.
   *
   * Deliberately re-reads each record immediately before acting on it: `/end`
   * may have cleared it, or a previous candidate's resume may have changed the
   * world, while this pass was awaiting the runtime.
   */
  private async accessRetryTick(): Promise<void> {
    if (this.shuttingDown || this.phase !== "ready") return;
    const candidates = this.store.all().filter((r) => this.isAccessRetryCandidate(r));
    if (!candidates.length) {
      // Nothing to recover: idle at the longest delay rather than waking every
      // 15s for the life of the process. Only reconciliation writes
      // `thread-no-access`, so a new candidate cannot appear mid-run today —
      // this stays a poll, rather than disarming, so that remains a performance
      // assumption instead of a correctness one.
      this.accessRetryIdle = true;
      return;
    }
    if (this.accessRetryIdle) {
      this.accessRetryIdle = false;
      this.accessRetryBackoff = 0;
    }
    let resumed = false;
    for (const candidate of candidates) {
      if (this.shuttingDown || this.phase !== "ready") return;
      // An explicit teardown that is mid-flight owns this thread. Skipping here
      // is the cheap half of the handshake; `resumeOwnershipLost` is the half
      // that holds when the claim lands after this point.
      if (this.endClaims.has(candidate.threadId)) continue;
      const rec = this.store.get(candidate.threadId);
      if (!rec || !this.isAccessRetryCandidate(rec)) continue;
      // Published BEFORE the attempt's FIRST await — which is the barrier retry
      // below, not the classification. A caller that joins this thread has to
      // cover every await this attempt makes, including the SDK disconnect the
      // barrier retry issues.
      let settle: () => void = () => {};
      this.accessResumeSettled.set(
        rec.threadId,
        new Promise<void>((resolve) => {
          settle = resolve;
        })
      );
      // Captured here for the same reason: `phase` and `shuttingDown` are only
      // read BEFORE these awaits, and this is what makes a late-resolving
      // classification unable to act on behalf of a process that has since given
      // up ownership of its state.
      const epoch = this.accessRetryEpoch;
      const cancelled = (): string | undefined => {
        if (this.accessRetryEpoch !== epoch) return "this process gave up ownership of its state";
        if (this.shuttingDown) return "shutdown started";
        return undefined;
      };
      try {
        // A previous attempt on this thread left a runtime we could not prove
        // stopped. Resuming again would create a SECOND runtime for the same
        // session and worktree, and its discard would overwrite the strong
        // reference that is the first one's only fence. Retry the barrier first;
        // only a CONFIRMED teardown earns another attempt.
        if (this.unconfirmedResumes.has(rec.threadId)) {
          if (!(await this.retryUnconfirmedResume(rec.threadId))) {
            console.warn(
              `access-retry: ${rec.threadId} still has an unconfirmed runtime from an earlier attempt; ` +
                `not resuming it again this wake-up.`
            );
            continue;
          }
        }
        // Do not START new external work after cancellation. The token below
        // would refuse to act on its result anyway; issuing a forced REST fetch,
        // a git rebuild and a runtime resume that nobody may use is pure cost —
        // and cost that keeps the single-instance lock held (see `stop()`).
        const stale = cancelled();
        if (stale) {
          console.warn(`access-retry: not starting work for ${rec.threadId} — ${stale}`);
          continue;
        }
        // The SAME reconcile path startup uses: it re-validates the binding and
        // re-classifies the thread, and only a `valid` classification resumes.
        // A record that has meanwhile become genuinely terminal under those
        // existing rules gets the existing terminal outcome persisted.
        //
        // `force` is not optional here: the cached channel object for a thread
        // the bot lost access to is the obfuscated stub, so an unforced
        // re-check can report "hidden" for ever (see `fetchChannelSafe`).
        await this.reconcileRecord(
          rec,
          (id, parent) => this.reconcileClassify(id, parent, { force: true }),
          { via: "access-retry", cancelled }
        );
      } catch (err) {
        // Startup turns a failed terminal transition into a failed startup. A
        // running bot has no such lever, and one record's unwritable transition
        // is not a reason to abandon the others: log it and keep the record
        // `active`, which is the direction that cannot lose a conversation.
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof FatalReconcileError) console.error(`access-retry: ${msg}`);
        else console.warn(`access-retry: ${rec.threadId} failed (${msg}); continuing.`);
      } finally {
        this.accessResumeSettled.delete(rec.threadId);
        settle();
      }
      if (this.sessions.has(rec.threadId)) resumed = true;
    }
    this.accessRetryBackoff = resumed
      ? 0
      : Math.min(this.accessRetryBackoff + 1, ACCESS_RETRY_DELAYS_MS.length - 1);
  }

  /**
   * A record this loop owns: still `active`, still parked on missing access,
   * and with no live session of its own. Never times out into a terminal
   * state — ADR-0002's whole point is that access loss is reversible.
   *
   * `MAX_LIVE_SESSIONS` is deliberately NOT applied. That cap gates `/new`,
   * i.e. asking for MORE work; this loop only finishes recovering a record that
   * already existed and that the startup pass would have resumed unconditionally
   * had the permission been present one minute earlier. Refusing it would strand
   * a conversation on a limit its owner never crossed, and there is no queue to
   * put it in.
   *
   * An unconfirmed-teardown barrier is deliberately NOT excluded here either:
   * that would make the record stop being a candidate, the loop would go idle,
   * and nothing would ever retry the barrier. It stays a candidate and the tick
   * clears the barrier first — see `accessRetryTick`.
   */
  private isAccessRetryCandidate(rec: SessionRecord): boolean {
    return rec.state === "active" && rec.reason === "thread-no-access" && !this.sessions.has(rec.threadId);
  }

  /**
   * Report leftovers whose own thread can no longer receive a notice.
   *
   * Every other reconcile message is posted into `rec.threadId` — which is
   * precisely what is unusable when the thread was deleted, made inaccessible,
   * or archived beyond unarchiving. Those records hold a full checkout each and
   * would otherwise accumulate in total silence, discoverable only by someone
   * who happened to run `/sessions`. Posted to the parent channel, once per
   * startup, and only when there is something to say.
   */
  private async announceUnreachableRecords(): Promise<void> {
    const unreachable = new Set([
      "thread-gone",
      "thread-inaccessible",
      "thread-archived",
      "worktree-kept",
      "rebind-cleanup-pending",
      "rebind-teardown-unconfirmed",
      "rebind-worktree-kept",
      // `bindingOk` rejects a disabled/changed parent BEFORE it attempts to
      // fetch the thread. If the thread is ALSO gone, its direct `notice()` is
      // silently undeliverable; route this config mismatch to the parent/seed
      // fallback too rather than leaving a disk-holding record unannounced.
      "config-mismatch",
    ]);
    const records = this.store.all();
    const staleRebinds = this.store.staleRebinds();
    const byParent = new Map<string, string[]>();
    for (const r of records) {
      if (
        classifyRecordDisposition(r.state, this.sessions.has(r.threadId), this.creating) !== "reapable" ||
        !r.reason ||
        !unreachable.has(r.reason)
      ) {
        continue;
      }
      const lines = byParent.get(r.parentChannelId) ?? [];
      lines.push(
        `• \`${r.threadId}\`（${r.reason}）${r.branch ? ` · 分支 \`${r.branch}\`` : ""} — \`${r.workDir}\``
      );
      byParent.set(r.parentChannelId, lines);
    }
    for (const r of staleRebinds) {
      // A live replacement can report this through `/sessions`; a terminal old
      // binding with no live thread cannot, so route it through the existing
      // parent/seed fallback rather than silently leaving its worktree on disk.
      if (this.sessions.has(r.threadId) || !r.reason || !unreachable.has(r.reason)) continue;
      const lines = byParent.get(r.parentChannelId) ?? [];
      lines.push(
        `• \`${r.threadId}\`（舊 incarnation：${r.reason}）${r.branch ? ` · 分支 \`${r.branch}\`` : ""} — \`${r.workDir}\``
      );
      byParent.set(r.parentChannelId, lines);
    }
    // The other direction: /new creates the worktree BEFORE it persists the
    // record, so a crash in between leaves a checkout that no record mentions —
    // invisible to /sessions and to /end alike. Same for a store file replaced
    // by hand. Listing both directions is what makes "nothing is silently
    // holding disk" actually true.
    //
    // Two layouts have to be walked: `<root>/<repoSlug>/<threadId>` for anything
    // created since multi-repo, and the flat `<root>/<threadId>` that older
    // records still legitimately point at (they are never migrated, because
    // moving a checkout is exactly the operation that loses uncommitted work).
    const known = new Set([...records, ...staleRebinds].map((r) => this.leaseKey(r.workDir)));
    const stray = this.strayWorktreeDirs(known).map(
      (d) => `• \`${d}\`（沒有對應的 session 記錄）`
    );
    if (!byParent.size && !stray.length) return;

    // Record-less worktrees have no trustworthy home channel, so the configured
    // first-run default remains their stable reporting fallback even when it
    // has since been disabled in the runtime registry.
    // their report. All recorded work stays grouped by the precise parent that
    // owned it — one blob sent to the seed would be both noisy and useless to an
    // operator who deliberately separates repos/channels.
    if (stray.length) {
      const seedLines = byParent.get(this.config.DISCORD_PARENT_CHANNEL_ID) ?? [];
      seedLines.push(...stray);
      byParent.set(this.config.DISCORD_PARENT_CHANNEL_ID, seedLines);
    }

    for (const [parentChannelId, lines] of byParent) {
      const direct = this.channels.has(parentChannelId)
        ? parentChannelId
        : this.config.DISCORD_PARENT_CHANNEL_ID;
      const text = this.formatUnreachableNotice(
        lines,
        parentChannelId === this.config.DISCORD_PARENT_CHANNEL_ID && stray.length > 0
      );
      let delivered = await this.transport.noticeDelivered(direct, text).catch(() => false);
      // `notice()` used to turn an inaccessible channel into a quiet apparent
      // success, which meant this report could never try the parent fallback.
      // `noticeDelivered()` makes the second attempt real rather than cosmetic.
      if (!delivered && direct !== this.config.DISCORD_PARENT_CHANNEL_ID) {
        delivered = await this.transport
          .noticeDelivered(this.config.DISCORD_PARENT_CHANNEL_ID, text)
          .catch(() => false);
      }
      if (!delivered) {
        console.warn(
          `reconcile: could not deliver ${lines.length} leftover-worktree notice(s) ` +
            `for parent ${parentChannelId}, including the seed fallback`
        );
      }
    }
  }

  /** Build ONE parent group's leftover notice. The length budget has to be
   *  recalculated for every group: a fixed item count can cut off the very ids
   *  this message exists to make reclaimable. */
  private formatUnreachableNotice(lines: readonly string[], hasStray: boolean): string {
    const head = `🧹 有 ${lines.length} 項殘留仍佔著磁碟：\n`;
    const foot =
      "\n討論串已無法使用，請在本頻道用 `/end thread:<id>` 清除（有未提交內容的 worktree 會保留）。" +
      (hasStray ? "\n沒有記錄的目錄請自行確認後 `git worktree remove`。" : "");
    const budget = 1850 - head.length - foot.length - 40; // room for omission line
    const shown: string[] = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > budget) break;
      shown.push(line);
      used += line.length + 1;
    }
    const omitted = lines.length - shown.length;
    return (
      head +
      shown.join("\n") +
      (omitted > 0 ? `\n…另有 ${omitted} 項未列出（用 \`/sessions\` 查看）。` : "") +
      foot
    );
  }

  /**
   * Directories under the worktree root that no record accounts for.
   *
   * Walks BOTH layouts: a directory that itself looks like a worktree (the flat
   * `<root>/<threadId>` older records use) and one level deeper for the current
   * `<root>/<repoSlug>/<threadId>`. A repo-slug directory is not itself a
   * leftover, so it is only reported through its children.
   *
   * `leaseKey` does the comparison so the case rules match everywhere else —
   * lowercasing unconditionally would make two distinct directories look like
   * the same one on Linux, and a stray tree would go unreported.
   */
  private strayWorktreeDirs(known: ReadonlySet<string>): string[] {
    const root = worktreeRoot();
    const out: string[] = [];
    let top: Dirent[];
    try {
      top = readdirSync(root, { withFileTypes: true });
    } catch {
      return out; // no worktree root yet — nothing to report
    }
    for (const entry of top) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      if (existsSync(join(dir, ".git"))) {
        // Flat legacy layout: this IS a worktree.
        if (!known.has(this.leaseKey(dir))) out.push(dir);
        continue;
      }
      let inner: Dirent[];
      try {
        inner = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of inner) {
        if (!child.isDirectory()) continue;
        const childDir = join(dir, child.name);
        if (!known.has(this.leaseKey(childDir))) out.push(childDir);
      }
    }
    return out;
  }

  private async reconcileRecord(
    rec: SessionRecord,
    classify: (threadId: string, expectedParentChannelId: string) => Promise<ThreadStatus>,
    opts: ReconcileAttemptOpts = {}
  ): Promise<void> {
    const retry = opts.via === "access-retry";
    let bindingOk: boolean | undefined;
    let threadStatus: ThreadStatus | undefined;
    if (rec.state === "active") {
      bindingOk = this.bindingOk(rec);
      if (bindingOk) threadStatus = await classify(rec.threadId, rec.parentChannelId);
    }
    // The one await above can outlive this process's ownership of its own state.
    // Everything below writes to disk, releases a lease or posts to Discord, so
    // the token is checked HERE, once, covering every branch of the switch.
    const abandoned = opts.cancelled?.();
    if (abandoned) {
      console.warn(`reconcile: abandoning ${rec.threadId} — ${abandoned}`);
      return;
    }

    const action = planReconcile({ corrupt: false, state: rec.state, bindingOk, threadStatus });
    switch (action.kind) {
      case "fail-corrupt":
      case "fresh":
      case "retain":
        return;
      case "orphan-interrupted":
        // A required terminal transition: if it can't be persisted, that's a disk
        // problem — fail startup rather than run with a non-durable state.
        if (!this.store.setState(rec.threadId, "orphaned", "interrupted-create")) {
          throw new FatalReconcileError(`reconcile: could not persist orphaned state at ${sessionStorePath()}`);
        }
        return;
      case "skip": {
        // In retry mode a `skip` means only "still cannot confirm this thread",
        // and it must change NOTHING. Persisting the new reason looks harmless
        // and is not: `thread-no-access` is both this loop's candidate filter
        // and the key `/end thread:<id>` uses for ADR-0002's escape hatch, so a
        // single 429/5xx blip would park the record — un-retryable until a
        // restart, and un-clearable by its owner — which is precisely the
        // "no-access never times out into a dead end" promise being broken.
        // (A record that is genuinely terminal takes the `block` branch below,
        // in retry mode exactly as at startup.)
        if (retry) return;
        if (!this.store.setState(rec.threadId, "active", action.reason)) {
          throw new FatalReconcileError(
            `reconcile: could not persist retry reason for ${rec.threadId} at ${sessionStorePath()}`
          );
        }
        console.warn(
          `reconcile: not resuming ${rec.threadId} this boot (${action.reason}); active record retained for retry.`
        );
        // One notice used to serve all three skip reasons and promised every one
        // of them that restoring Discord access would bring it back. Only
        // `thread-no-access` has those semantics — it is the sole reason the
        // runtime retry loop takes as a candidate — so a `transient` fetch
        // failure was told to fix a permission that was never the problem, and
        // to expect an automatic recovery that is not coming. `/sessions`
        // already draws this line; this notice now draws the same one.
        await this.transport
          .notice(
            rec.threadId,
            action.reason === "thread-no-access"
              ? "⚠️ 啟動時無法存取這個討論串（Discord 權限）。session 記錄已保留——" +
                  "**恢復 bot 對該頻道的存取權後會自動復原，不必重啟**（約 15 秒起、最長 5 分鐘掃一次）。" +
                  "確定不要這段對話時，可在上層頻道用 `/end thread:<id>` 清除。"
              : `⚠️ 啟動時暫時無法確認此執行緒狀態（${action.reason}），本次未復原。session 記錄已保留——` +
                  "**重新啟動 bot 會再試一次**；執行中不會自動重試（自動重試只適用於 Discord 存取權問題）。"
          )
          .catch(() => {});
        return;
      }
      case "block":
        // A record leaving `active` for a terminal state gives up its repo. The
        // reconcile PRE-SCAN took a lease for every local+active record before
        // any thread was classified, so a thread that turns out to be gone would
        // otherwise hold its repo for the life of the process — and the only
        // command that can reap the record (`/end thread:<id>`) never touched
        // the lease either, so `/repo dev local` would report a phantom holder
        // with a deleted thread, permanently.
        if (!this.store.setState(rec.threadId, "blocked", action.reason)) {
          throw new FatalReconcileError(`reconcile: could not persist blocked state at ${sessionStorePath()}`);
        }
        this.releaseLocalLease(rec.threadId);
        await this.transport
          .notice(rec.threadId, `⚠️ 無法復原此 session（${action.reason}）。請用 /new 開新的。`)
          .catch(() => {});
        return;
      case "resume":
        await this.resumeRecord(rec, opts);
        return;
    }
  }

  /** Resume the SDK session for an active record; register it and post an honest
   *  recovery notice. A resume failure is classified session-lost (definitive →
   *  orphaned, terminal) vs transient (record LEFT ACTIVE so a later restart
   *  retries — never dropping recoverable history). */
  private async resumeRecord(
    rec: SessionRecord,
    opts: ReconcileAttemptOpts = {}
  ): Promise<void> {
    // BEFORE the first side effect, not just before registration. The retry loop
    // reaches here after awaiting the thread classification, and `/end` or
    // shutdown can have claimed the record in that window — at which point
    // rebuilding its worktree below would put a checkout on disk that no record
    // points at, which is exactly the leftover `/end` had just finished
    // removing. `resumeOwnershipLost` is synchronous and the `addWorktree` call
    // is the next statement's first await, so nothing can land between them.
    const claimedBefore = this.resumeOwnershipLost(rec, opts);
    if (claimedBefore) {
      console.warn(`resume: not resuming ${rec.threadId} — ${claimedBefore}`);
      return;
    }
    // The worktree may be gone (hand-deleted, disk cleaned). Recreate it from
    // the branch, which git still has. Without this the resume fails, gets
    // classified `transient`, and the record is retried on EVERY boot forever —
    // unrecoverable without hand-editing the store, since /end refuses a thread
    // with no live session.
    if (rec.devMode === "worktree" && rec.branch && !existsSync(rec.workDir)) {
      try {
        await addWorktree(rec.repoPath, rec.workDir, rec.branch);
        console.warn(`reconcile: recreated missing worktree for ${rec.threadId} at ${rec.workDir}`);
      } catch (err) {
        // Terminal, not transient: retrying every boot cannot fix a tree we
        // just failed to rebuild — but only if this attempt still speaks for
        // the process. `addWorktree` was an await like any other.
        const abandoned = this.resumeOwnershipLost(rec, opts);
        if (abandoned) {
          console.warn(`resume: not terminalizing ${rec.threadId} after a failed rebuild — ${abandoned}`);
          return;
        }
        if (!this.store.setState(rec.threadId, "blocked", "worktree-missing")) {
          throw new FatalReconcileError(`reconcile: could not persist blocked state for ${rec.threadId}`);
        }
        this.releaseLocalLease(rec.threadId);
        await this.transport
          .notice(
            rec.threadId,
            `⚠️ 無法復原：這個 session 的工作目錄不存在，且重建失敗（${err instanceof Error ? err.message : String(err)}）。` +
              `分支 \`${rec.branch}\` 仍在，請用 /new 開新的。`
          )
          .catch(() => {});
        return;
      }
      // `addWorktree` is itself an await, so `/end` or shutdown can land WHILE
      // the checkout is being built — the pre-check above cannot cover that.
      // Undo our own side effect rather than leave a checkout no record points
      // at. Failing to undo it is not fatal: it is retained (never deleted
      // without git's proof) and the startup stray-worktree scan reports it.
      const claimedDuring = this.resumeOwnershipLost(rec, opts);
      if (claimedDuring) {
        console.warn(
          `resume: ${rec.threadId} was claimed while its worktree was rebuilt (${claimedDuring}); removing it again.`
        );
        const undone = await removeWorktreeIfClean(rec.repoPath, rec.workDir, rec.branch).catch(
          () => "failed" as const
        );
        if (undone !== "removed" && undone !== "already-absent") {
          console.warn(`resume: could not remove the rebuilt worktree at ${rec.workDir} (${undone})`);
        }
        return;
      }
    }
    // Windows captures before git sees the path. The persisted JSON pathname is
    // mutable; Git proves the retained handle's validation path, while the same
    // capability and its final display path transfer to the resumed actor.
    // POSIX resumes normally without file-delivery machinery.
    //
    // Checked before STARTING it, not only before acting on its result: a root
    // capture opens a real handle and the resume behind it is a runtime RPC.
    // Neither can be recalled once issued, and both keep the single-instance
    // lock held through shutdown (see `stop()`).
    const beforeCapture = this.resumeOwnershipLost(rec, opts);
    if (beforeCapture) {
      console.warn(`resume: not capturing a root for ${rec.threadId} — ${beforeCapture}`);
      return;
    }
    let captured;
    try {
      captured = await this.captureValidatedRoot({
        repoPath: rec.repoPath,
        workDir: rec.workDir,
        devMode: rec.devMode,
        branch: rec.branch,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`reconcile: transient trusted-root capture failure for ${rec.threadId}: ${msg}`);
      const abandoned = this.resumeOwnershipLost(rec, opts);
      if (!abandoned) await this.noticeTransientResumeFailure(rec.threadId, msg, opts);
      return;
    }
    if (!captured.ok) {
      console.warn(`reconcile: refusing to resume ${rec.threadId} — ${captured.verdict.detail}`);
      const abandoned = this.resumeOwnershipLost(rec, opts);
      if (abandoned) {
        console.warn(`resume: not persisting a binding refusal for ${rec.threadId} — ${abandoned}`);
        return;
      }
      if (!this.store.setState(rec.threadId, "blocked", `binding-${captured.verdict.problem}`)) {
        throw new FatalReconcileError(`reconcile: could not persist blocked state for ${rec.threadId}`);
      }
      this.releaseLocalLease(rec.threadId);
      await this.transport
        .notice(
          rec.threadId,
          `⚠️ 無法復原：${describeBindingProblem(captured.verdict.problem)}。請用 /new 開新的。`
        )
        .catch(() => {});
      return;
    }
    const trustedRoot = captured.trustedRoot;
    const workDir = captured.binding.workDir;
    const approvalKey = captured.approvalKey;
    const broker = new PendingInteractionBroker();
    let actor: SessionActor;
    // Last gate before the longest, least recallable await in this method.
    const beforeCreate = this.resumeOwnershipLost(rec, opts);
    if (beforeCreate) {
      console.warn(`resume: not creating a session for ${rec.threadId} — ${beforeCreate}`);
      // The capability is open and nothing is going to take it over. Every other
      // way out of this method after a successful capture either hands it to an
      // actor (which owns it from then on, including closing it when
      // `SessionActor.create` itself fails) or closes it; this path is the one
      // that used to just return, leaving a Windows root handle held for the
      // life of the process against a worktree nobody is using.
      await captured.trustedRoot?.close().catch(() => {});
      return;
    }
    try {
      actor = await SessionActor.create(this.copilot, {
        sessionKey: rec.threadId,
        // Back into the SAME directory this session was created in — resuming a
        // worktree session into another tree would run one thread's conversation
        // against another thread's files.
        ...(trustedRoot ? { trustedRoot } : {}),
        workingDirectory: workDir,
        approvalKey,
        model: this.config.DEFAULT_MODEL,
        contextTier: this.config.DEFAULT_CONTEXT_TIER,
        broker,
        transport: this.transport,
        policy: this.approvals,
        generation: rec.generation,
        resumeSessionId: rec.sessionId,
        ...this.fileDeliveryQuotaOptions(rec.threadId, rec.fileDeliveryBytes, rec.sessionId, rec.generation),
        ...this.skillSourceOptions(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // `SessionActor.create` is the longest await in this method; a shutdown
      // can easily complete inside it. Nothing below may run on behalf of a
      // process that has surrendered its state.
      const abandoned = this.resumeOwnershipLost(rec, opts);
      if (abandoned) {
        console.warn(`resume: dropping the resume failure for ${rec.threadId} (${msg}) — ${abandoned}`);
        return;
      }
      if (classifyResumeError(msg) === "session-lost") {
        // Definitive: the session id is gone. Mark terminal; a failed persist of
        // that transition is a disk problem we must surface (fail startup).
        // Terminal ⇒ the repo it held in local mode is free again.
        if (!this.store.setState(rec.threadId, "orphaned", "session-lost")) {
          throw new FatalReconcileError(`reconcile: could not persist orphaned state for ${rec.threadId}`);
        }
        this.releaseLocalLease(rec.threadId);
        await this.transport
          .notice(rec.threadId, "⚠️ 無法復原（session 已遺失）。請用 /new 開新的。")
          .catch(() => {});
      } else {
        // Transient (network/RPC/unknown): leave the record ACTIVE so the next
        // restart retries. Do NOT lie that it's blocked. The thread is un-resumed
        // for THIS boot; the bot still comes up so /new remains usable.
        console.warn(`reconcile: transient resume failure for ${rec.threadId}: ${msg}`);
        await this.noticeTransientResumeFailure(rec.threadId, msg, opts);
      }
      return;
    }
    // A resumed thread was already named by the run that created it — never
    // re-title it from whatever the user happens to type first after a restart.
    //
    // Everything above this point awaited git and the runtime, and the retry
    // loop runs those awaits while `/end` and shutdown are live. Re-prove
    // ownership of the exact record we resumed BEFORE registering it: from here
    // to `sessions.set` there is no await, so this check and the registration
    // are one atomic step that a concurrent command cannot slip inside.
    const lost = this.resumeOwnershipLost(rec, opts);
    if (lost) {
      await this.discardResumedActor(rec, actor, lost);
      return;
    }
    // Make the record say "recovered" BEFORE registering the session, and treat
    // a failed write as a failed resume. `commit()` is persist-first, so a false
    // return means the record on disk (and in memory) still says
    // `thread-no-access` — registering anyway would put a live session behind a
    // durable record that denies it exists, which is the same "live session with
    // no usable record" hazard the `/end` handshake exists to prevent. The
    // record and its lease are left exactly as they were, so the next wake-up
    // (or the next boot) simply tries again.
    if (!this.store.commit(rec.threadId)) {
      console.error(
        `reconcile: could not persist the recovered state for ${rec.threadId} at ${sessionStorePath()}; ` +
          `discarding the resumed session and leaving the record for a later retry.`
      );
      await this.discardResumedActor(rec, actor, "the recovered state could not be written to disk");
      await this.noticeTransientResumeFailure(rec.threadId, "無法寫入磁碟更新 session 記錄", opts);
      return;
    }
    this.sessions.set(rec.threadId, {
      actor,
      broker,
      running: false,
      titled: true,
      titleEpoch: 0,
      queue: [],
      workDir,
      repoPath: rec.repoPath,
      devMode: rec.devMode,
      branch: rec.branch,
      parentChannelId: rec.parentChannelId,
      // A resumed session carries conversation history by definition — that is
      // what resume is FOR — so a rebind must always confirm before discarding it.
      hasRunTurn: true,
    });
    await this.transport
      .notice(
        rec.threadId,
        (opts.via === "access-retry"
          ? "♻️ Discord 存取權已恢復，已復原此對話（歷史保留）。"
          : "♻️ 已從重啟復原此對話（歷史保留）。") +
          "上一個回合已中斷且**不會自動續跑**；" +
          "先前若有指令可能已部分或完全執行，請先確認 repo／程序狀態，再決定是否重送。" +
          "\n🛡️ YOLO 模式已重置為 **OFF**（不會跨重啟保留）。"
      )
      .catch(() => {});
  }

  /**
   * Why a just-resumed session must NOT be registered, or `undefined`.
   *
   * Every one of these means something else won the record while the resume was
   * in flight, and registering anyway would either double-register a thread or
   * resurrect a record its owner deliberately cleared. `/end` and shutdown are
   * both allowed to win outright; this is how they do it without having to
   * cancel work they cannot see.
   */
  private resumeOwnershipLost(rec: SessionRecord, opts: ReconcileAttemptOpts = {}): string | undefined {
    if (this.shuttingDown) return "shutdown started";
    // The attempt's own cancellation token. `shuttingDown` above catches the
    // common case; this catches an attempt that was cancelled for any other
    // reason (an epoch bump) without having to enumerate them here.
    const cancelled = opts.cancelled?.();
    if (cancelled) return cancelled;
    // Checked before the store, because `/end` claims the thread several awaits
    // BEFORE it removes the record; without this the resume would win a race it
    // has already lost and leave a live session no record points at.
    if (this.endClaims.has(rec.threadId)) return "an explicit /end claimed this thread";
    // A runtime from an earlier attempt that we could not prove stopped may
    // still hold this working tree. Registering a second one over it is exactly
    // what the barrier exists to prevent, so this is a hard refusal even though
    // the tick already checks it — the tick's check is several awaits old here.
    if (this.unconfirmedResumes.has(rec.threadId)) {
      return "an earlier resume for this thread was never confirmed stopped";
    }
    if (this.sessions.has(rec.threadId)) return "another session is already registered for this thread";
    const now = this.store.get(rec.threadId);
    if (!now) return "the durable record was removed (/end)";
    if (now.state !== "active") return `the record is now ${now.state}${now.reason ? ` (${now.reason})` : ""}`;
    if (now.sessionId !== rec.sessionId || now.generation !== rec.generation) {
      return "the record now points at a different session/generation";
    }
    return undefined;
  }

  /** Wait, boundedly, for an in-flight access retry on this thread to settle.
   *  Reports whether it actually did: a caller that is about to delete a
   *  checkout may not treat "I stopped waiting" as "it finished". */
  private async joinAccessResume(threadId: string): Promise<boolean> {
    const settled = this.accessResumeSettled.get(threadId);
    if (!settled) return true;
    await withTimeout(settled, this.accessResumeJoinTimeoutMs).catch(() => {});
    return !this.accessResumeSettled.has(threadId);
  }

  /**
   * The "couldn't resume it this time" notice, told truthfully per caller.
   *
   * On the startup path this is one message per boot and a restart really is
   * what retries it. On the retry path neither half held: the loop wakes up
   * again on its own — so "restart the bot" is wrong — and it wakes up
   * repeatedly, so posting each time turns a transient runtime hiccup into an
   * indefinite drip of identical warnings in the thread. It is posted ONCE per
   * thread per process instead, and says what will actually happen.
   */
  private async noticeTransientResumeFailure(
    threadId: string,
    msg: string,
    opts: { via?: "startup" | "access-retry" }
  ): Promise<void> {
    if (opts.via !== "access-retry") {
      await this.transport
        .notice(
          threadId,
          `⚠️ 暫時無法復原此對話（${msg}）。session 記錄已保留——重新啟動 bot 可再嘗試復原；或用 /new 重新開始。`
        )
        .catch(() => {});
      return;
    }
    if (this.accessRetryNoticed.has(threadId)) return;
    this.accessRetryNoticed.add(threadId);
    await this.transport
      .notice(
        threadId,
        `⚠️ 已可存取這個討論串，但暫時無法復原對話（${msg}）。session 記錄已保留，**會自動持續重試**` +
          "（不必重啟；之後不會再重複貼這則訊息）。"
      )
      .catch(() => {});
  }

  /**
   * Throw away a session we resumed but may not register.
   *
   * A confirmed disconnect ends it: the runtime is gone and the object can be
   * dropped. An UNCONFIRMED one may not be, and simply logging it was the bug —
   * dropping the last reference releases the Windows root capability that is
   * the only fence stopping a possibly-live runtime from being handed a renamed
   * or deleted working tree.
   *
   * It is deliberately NOT handed to the stale-rebind companion machinery. That
   * writes a SECOND durable claim on one worktree, and here the main record is
   * usually still present and still naming this exact session — two claimants
   * would let one of them delete the tree the other still points at. Instead the
   * actor is retained under its thread, exactly as `/end`'s own unconfirmed
   * teardown keeps a spent session as a barrier, and `/end` and `stop()` both
   * retry it before anything is allowed to reclaim that checkout.
   */
  private async discardResumedActor(
    rec: SessionRecord,
    actor: SessionActor,
    why: string
  ): Promise<void> {
    console.warn(`resume: discarding the resumed session for ${rec.threadId} — ${why}`);
    // Registered BEFORE the attempt, not after it fails. From the instant this
    // actor exists a runtime may be holding the checkout, and a caller that
    // looks while the disconnect is still in flight must see the barrier — not
    // an empty map that reads as "nothing is running here".
    //
    // NEVER overwritten: an existing entry is an OLDER runtime that was never
    // proved stopped, and its strong reference is the only thing keeping its
    // root capability alive. Replacing it would drop that fence while the thing
    // it fences may still be running.
    if (!this.unconfirmedResumes.has(rec.threadId)) {
      this.unconfirmedResumes.set(rec.threadId, { actor, binding: rec });
    }
    try {
      await withTimeout(actor.disconnect(), this.resumeTeardownTimeoutMs);
      // Only drop the barrier if it is THIS actor's; an older unconfirmed one
      // is not made safe by a newer actor's clean exit.
      if (this.unconfirmedResumes.get(rec.threadId)?.actor === actor) {
        this.unconfirmedResumes.delete(rec.threadId);
      }
    } catch {
      console.warn(
        `resume: could not confirm the discarded runtime for ${rec.threadId} stopped; ` +
          `retaining it as a barrier over ${rec.workDir} until a retry or restart confirms it.`
      );
    }
  }

  /**
   * Make one more bounded attempt to stop a retained discarded runtime.
   *
   * Returns true when nothing (any more) may be holding that checkout — which is
   * the precondition for reclaiming it. A failure keeps the barrier: a worktree
   * must never be deleted out from under a process that might still write to it.
   */
  private async retryUnconfirmedResume(threadId: string): Promise<boolean> {
    const entry = this.unconfirmedResumes.get(threadId);
    if (!entry) return true;
    try {
      await withTimeout(entry.actor.disconnect(), this.resumeTeardownTimeoutMs);
    } catch {
      return false;
    }
    if (this.unconfirmedResumes.get(threadId) === entry) this.unconfirmedResumes.delete(threadId);
    return true;
  }

  // ----------------------------------------------------------- local leases --

  /** Canonical key a local-mode lease is held under. Case-folded on Windows
   *  only — on Linux two paths differing in case are different directories. */
  private leaseKey(repoPath: string): string {
    const p = canonicalPathOr(repoPath);
    return process.platform === "win32" ? p.toLowerCase() : p;
  }

  /** Thread currently holding `repoPath` in local mode, if any. */
  private localHolder(repoPath: string): string | undefined {
    return this.localLeases.get(this.leaseKey(repoPath));
  }

  /**
   * Take the exclusive local-mode lease on a repo, or report who has it.
   *
   * Synchronous and check-and-set in ONE step, deliberately: interaction
   * handlers run concurrently, so a check followed by an `await` followed by a
   * set is a race that ends with two agents in one checkout — the exact failure
   * worktrees exist to prevent.
   */
  private acquireLocalLease(repoPath: string, threadId: string): { ok: true } | { ok: false; holder: string } {
    const key = this.leaseKey(repoPath);
    const holder = this.localLeases.get(key);
    if (holder !== undefined && holder !== threadId) return { ok: false, holder };
    this.localLeases.set(key, threadId);
    return { ok: true };
  }

  /** Drop whatever lease `threadId` holds. Safe to call when it holds none. */
  private releaseLocalLease(threadId: string): void {
    for (const [key, holder] of this.localLeases) {
      if (holder === threadId) this.localLeases.delete(key);
    }
  }

  /** After `/end` joins a pre-swap rebind, keep the old checkout leased only
   * while its exact durable local binding still exists. A replacement worktree
   * row needs no local lease; a creating local replacement on the same checkout
   * does, so it must not be released as collateral. */
  private releaseRetiredLocalLease(threadId: string, repoPath: string): void {
    const key = this.leaseKey(repoPath);
    if (this.localLeases.get(key) !== threadId) return;
    const record = this.store.get(threadId);
    const stillClaimsCheckout =
      record?.devMode === "local" &&
      record.state !== "blocked" &&
      record.state !== "orphaned" &&
      this.leaseKey(record.repoPath) === key;
    if (!stillClaimsCheckout) this.localLeases.delete(key);
  }

  /**
   * Whether the stored binding still matches this bot's configuration.
   *
   * Structural half only — the repo must live under THIS `REPOS_ROOT` and the
   * Discord binding must be unchanged. Proving that `workDir` really belongs to
   * `repoPath` needs git and happens in `resumeRecord` via `validateBinding`;
   * doing it here would make this async for the sake of one caller and would
   * still have to be re-checked before the session is created.
   *
   * A mismatch (e.g. REPOS_ROOT or the guild changed between runs) must NOT
   * resume — it would run one repo's conversation against another.
   *
   * The parent channel is checked for MEMBERSHIP of the enabled set, not against
   * one configured id: sessions legitimately live under any channel the operator
   * enabled. A channel that has since been disabled therefore blocks its records
   * — which is why `/channel disable` refuses while any of them are still alive,
   * since `blocked` is terminal.
   */
  private bindingOk(rec: SessionRecord): boolean {
    const wd = rec.workDir;
    const workDirOk =
      rec.devMode === "local"
        ? pathRelation(wd, rec.repoPath) === "same"
        : isStrictlyInside(wd, worktreeRoot());
    return (
      isStrictlyInside(rec.repoPath, this.reposRoot) &&
      workDirOk &&
      rec.guildId === this.config.DISCORD_GUILD_ID &&
      this.channels.has(rec.parentChannelId)
    );
  }

  /** Classify the Discord thread a record is bound to. Distinguishes definitive
   *  absence/inaccessibility from a transient fetch failure so a startup blip
   *  can't drop a recoverable session. Unarchives an archived thread if possible.
   *
   *  `expectedParentChannelId` is the parent the RECORD claims. It must match the
   *  thread's real parent exactly — "sits under any enabled channel" would let a
   *  record naming channel A resume a thread that actually lives under channel B,
   *  which is the whole point of storing the parent per record. */
  private async classifyThread(
    threadId: string,
    expectedParentChannelId: string,
    opts: { force?: boolean } = {}
  ): Promise<ThreadStatus> {
    const result = await fetchChannelSafe(this.discord, threadId, opts);
    if (result.kind === "gone") return "gone";
    if (result.kind === "no-access") return "no-access";
    if (result.kind === "transient") return "transient";
    const anyCh = result.channel as {
      isThread?: () => boolean;
      guildId?: string;
      parentId?: string | null;
      archived?: boolean | null;
      setArchived?: (v: boolean) => Promise<unknown>;
      sendable?: boolean;
    };
    if (typeof anyCh.isThread === "function" && !anyCh.isThread()) return "inaccessible";
    if (anyCh.guildId !== this.config.DISCORD_GUILD_ID) return "inaccessible";
    if (!this.channels.has(expectedParentChannelId)) return "inaccessible";
    if (anyCh.parentId !== expectedParentChannelId) return "inaccessible";
    if (anyCh.archived) {
      try {
        await anyCh.setArchived?.(false);
      } catch {
        return "archived-unarchivable";
      }
    }
    if (typeof anyCh.sendable === "boolean" && !anyCh.sendable) return "archived-unarchivable";
    return "valid";
  }

  private async cmdStop(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policyNow())) {
      await this.refuseUnauthorized(interaction);
      return;
    }
    const session = this.sessions.get(interaction.channelId);
    if (!session) {
      await interaction.reply({
        content: "No active session in this thread.",
        ...EPHEMERAL,
      });
      return;
    }
    // Cancel a turn that's still reserved but not yet sent (e.g. downloading an
    // image), then stop any in-flight SDK turn. Both are safe/idempotent.
    // Defer BEFORE the abort: it is a JSON-RPC round trip to a runtime that may
    // be wedged, and this is the one command that has to work precisely then.
    // Without the defer a >3s abort expires the interaction token and the
    // operator sees "the application did not respond" with no idea whether the
    // abort landed.
    await interaction.deferReply({ ...EPHEMERAL });
    // Drop anything queued FIRST, so a slow abort can't let drainQueue start the
    // next prompt while the operator is watching this one stop. "Stop" has to
    // mean the session goes quiet, not "stop this one and start the next".
    const dropped = session.queue.length;
    session.queue = [];
    const ok = await this.stopSession(session);
    const tail = dropped ? ` 已同時丟棄佇列中的 ${dropped} 則。` : "";
    await interaction.editReply({
      content:
        (ok ? "Abort requested for the current turn." : "Abort attempted but the runtime reported an error.") +
        tail,
    });
  }

  /** The core of /stop: abort a still-reserved (pre-send) turn so an in-flight
   *  attachment download is cancelled and never reaches the agent, then stop any
   *  live SDK turn. Extracted so the /stop wiring is unit-testable end to end. */
  private async stopSession(session: Session): Promise<boolean> {
    session.currentAbort?.abort();
    return session.actor.stop();
  }

  /** /model, /effort, /context — reconfigure the current thread's session. */
  private async cmdReconfigure(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policyNow())) {
      await this.refuseUnauthorized(interaction);
      return;
    }
    const session = this.sessions.get(interaction.channelId);
    if (!session) {
      await interaction.reply({
        content: "Run this inside a session thread (start one with /new).",
        ...EPHEMERAL,
      });
      return;
    }
    const change: { model?: string; effort?: string; context?: "default" | "long_context"; resetEffort?: boolean } = {};
    const cur = session.actor.config();
    if (interaction.commandName === "model") {
      const id = interaction.options.getString("id", true);
      if (this.modelIds.length && !this.modelIds.includes(id)) {
        await interaction.reply({ content: `Unknown model \`${id}\`.`, ...EPHEMERAL });
        return;
      }
      change.model = id;
      // If the new model doesn't support the currently-set effort, drop it rather
      // than sending an unsupported effort the runtime would reject. Unknown
      // model (not in snapshot) leaves the effort untouched.
      if (shouldResetEffort(cur.effort, this.modelEfforts.get(id))) {
        change.resetEffort = true;
      }
    } else if (interaction.commandName === "effort") {
      const level = interaction.options.getString("level", true);
      const check = validateEffort(cur.model, level, this.modelEfforts.get(cur.model ?? ""));
      if (!check.ok) {
        await interaction.reply({ content: check.message, ...EPHEMERAL });
        return;
      }
      change.effort = level;
    } else {
      change.context = interaction.options.getString("tier", true) as "default" | "long_context";
    }
    await interaction.deferReply({ ...EPHEMERAL });
    try {
      await session.actor.reconfigure(change);
      const c = session.actor.config();
      await interaction.editReply(
        `Updated. model=\`${c.model ?? "?"}\` effort=\`${c.effort ?? "default"}\` context=\`${c.context ?? "default"}\` (takes effect next message).`
      );
    } catch (err) {
      await interaction.editReply(`Could not update: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async cmdUsage(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policyNow())) {
      await this.refuseUnauthorized(interaction);
      return;
    }
    const session = this.sessions.get(interaction.channelId);
    if (!session) {
      await interaction.reply({
        content: "Run this inside a session thread.",
        ...EPHEMERAL,
      });
      return;
    }
    // Report the RUNTIME's view, not what discord-copilot-sdk asked for. Echoing the local
    // cache made /usage useless as evidence: after a resume it would show this
    // process's startup defaults, and a setModel that the runtime quietly
    // ignored would still read back as applied. Falls back to the cache when the
    // RPC is unavailable.
    await interaction.deferReply({ ...EPHEMERAL });
    await session.actor.syncConfigFromRuntime();
    const u = session.actor.usage();
    const c = session.actor.config();
    const yolo = session.actor.isYolo() ? "\n⚡ **YOLO: ON** — every permission is auto-approved (`/yolo mode:off`)" : "";
    // `effort` is genuinely UNSET on most sessions (the runtime picks per model);
    // calling that "default" invited reading it as a level named "default".
    const header = `model=\`${c.model ?? "?"}\` effort=\`${c.effort ?? "(unset)"}\` context=\`${c.context ?? "default"}\``;
    const pct = u && u.tokenLimit > 0 ? Math.round((u.currentTokens / u.tokenLimit) * 100) : undefined;
    const body = u
      ? `\ntokens: ${u.currentTokens.toLocaleString()} / ${u.tokenLimit.toLocaleString()}${pct !== undefined ? ` (${pct}%)` : ""}`
      : "\n(no usage reported yet — send a message first)";
    await interaction.editReply({ content: header + body + yolo });
  }

  /** `/yolo on|off` — blanket permission auto-approval for THIS session.
   *
   *  Safety ordering mirrors the ack-before-allow invariant used for buttons:
   *  turning YOLO **on** happens only AFTER Discord has acknowledged the reply,
   *  so a failed reply can never leave the session silently unguarded. Turning
   *  it **off** happens FIRST, because a failure there must still be safe. */
  private async cmdYolo(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policyNow())) {
      await this.refuseUnauthorized(interaction);
      return;
    }
    const session = this.sessions.get(interaction.channelId);
    if (!session) {
      await interaction.reply({
        content: "Run this inside a session thread.",
        ...EPHEMERAL,
      });
      return;
    }
    const on = interaction.options.getString("mode", true) === "on";
    const fileDeliveryAvailable = this.fileDeliveryAvailable();
    const warning = yoloOnWarning(session.actor.hasRepoSkills(), fileDeliveryAvailable);
    await applyYoloToggle(
      on,
      () =>
        interaction.reply({
          content: on ? warning : "🛡️ YOLO **OFF** — permissions will prompt again.",
          ...EPHEMERAL,
        }),
      {
        epoch: () => session.actor.yoloEpochValue(),
        disable: () => session.actor.setYolo(false),
        enableIfCurrent: (e) => session.actor.enableYoloIfCurrent(e),
      }
    ).then(async (enabled) => {
      // Only announce when the enable actually took effect (a concurrent
      // `/yolo off` may have superseded it).
      if (enabled) {
        await this.transport
          .notice(
            interaction.channelId,
            fileDeliveryAvailable
              ? "⚡ **YOLO mode ON** — other permissions are now auto-approved for this session; `discord_send_file` is fast-denied, so use `/file path:<file>` to deliver files."
              : "⚡ **YOLO mode ON** — other permissions are now auto-approved for this session; outbound Discord file delivery is unavailable on this platform."
          )
          .catch(() => {});
      }
    });
  }

  private async cmdApprovals(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policyNow())) {
      await this.refuseUnauthorized(interaction);
      return;
    }
    const clear = interaction.options.getBoolean("clear") ?? false;
    // Act on every LIVE session, not just this channel — /approvals is usable
    // from the parent channel, where scoping to the channel silently skipped the
    // in-memory rules while still claiming they were revoked.
    const scope = approvalScopeKeys(this.sessions.keys());
    const sessionRules = [...new Set(scope.flatMap((k) => this.approvals.sessionApprovals(k)))];
    // Show the CURRENT thread's repo rules when there is one, else everything.
    const here = this.sessions.get(interaction.channelId);
    const hereKey = here ? await this.displayApprovalKeyFor(here.repoPath) : undefined;
    const repoRules = hereKey
      ? this.approvals.repoApprovals(hereKey)
      : [...new Set(this.approvals.repoKeys().flatMap((k) => this.approvals.repoApprovals(k)))];
    if (clear) {
      for (const key of scope) this.approvals.clearSession(key);
      // ALL repos, not just the live ones. A rule survives in three places a
      // live-session sweep would miss: a `retry-pending` record that will resume
      // on the next boot, a blocked record that may yet be rebound, and a
      // persisted grant with no record at all. This command's own comment says a
      // false revocation claim is worse than having no command, and "cleared"
      // has to mean cleared.
      const durable = this.approvals.clearAllRepos();
      const tail = durable
        ? "Future commands will prompt again."
        : "⚠️ 已在記憶體中清除（本次執行不會再自動核准），但寫入磁碟失敗 — 重啟後 repo 規則可能重現，請檢查檔案權限。";
      await interaction.reply({
        content:
          `Cleared approvals for ALL repos — session: ${fmtList(sessionRules)} · repo: ${fmtList(repoRules)}. ` + tail,
        ...EPHEMERAL,
      });
      return;
    }
    await interaction.reply({
      content:
        `Approved (auto-run, no prompt):\n• session: ${fmtList(sessionRules)}\n` +
        `• ${hereKey ? `this repo (\`${path.basename(hereKey)}\`)` : "all repos"}: ${fmtList(repoRules)}`,
      ...EPHEMERAL,
    });
  }

  private async cmdDiff(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policyNow())) {
      await this.refuseUnauthorized(interaction);
      return;
    }
    const staged = interaction.options.getBoolean("staged") ?? false;
    await interaction.deferReply({ ...EPHEMERAL });
    // Diff the tree THIS session actually works in. With worktree isolation the
    // controlled repo's own checkout is never modified — diffing it would report
    // "no changes" for a session that has changed plenty, which is the one
    // answer this command must never give.
    const session = this.sessions.get(interaction.channelId);
    if (!session) {
      // No fallback to "some repo": with many repos there is no meaningful
      // default, and diffing the wrong tree is exactly the wrong answer.
      await interaction.editReply({
        content: "這個討論串沒有進行中的 session，無法判斷要 diff 哪個工作目錄。",
      });
      return;
    }
    const dir = session.workDir;
    const where = session.branch ? `（分支 \`${session.branch}\`）` : `（\`${path.basename(session.repoPath)}\` · local）`;
    try {
      const summary = await gitDiffSummary(dir, staged);
      await interaction.editReply({ content: (where ? where + "\n" : "") + summary });
    } catch (err) {
      await interaction.editReply({
        content: `⚠️ 無法取得 git diff：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private fileRefusalMessage(reason: OutboundRefusal): string {
    switch (reason) {
      case "unavailable":
        return "檔案傳送在此平台無法使用（僅支援 Windows）。";
      case "outside-workdir":
        return "無法傳送這個檔案：路徑不在這個 session 的工作目錄內。";
      case "not-found":
        return "找不到指定檔案。";
      case ".git-internal":
        return "不能傳送 Git 內部檔案。";
      case "not-regular-file":
        return "指定路徑不是一般檔案。";
      case "empty-file":
        return "不能傳送空檔案。";
      case "too-large":
        return "檔案太大，無法傳送到 Discord。";
      case "unsafe-filename":
        return "檔名不安全，無法傳送。";
      case "disallowed-extension":
        return "這種檔案類型不允許直接傳送。";
      case "unreadable":
      default:
        return "無法讀取這個檔案。";
    }
  }

  private async cmdFile(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policyNow())) {
      await this.refuseUnauthorized(interaction);
      return;
    }
    await interaction.deferReply({ ...EPHEMERAL });
    const threadId = interaction.channelId;
    const session = this.sessions.get(threadId);
    if (!session) {
      await interaction.editReply({ content: "這個討論串沒有進行中的 session，無法傳送檔案。" });
      return;
    }
    if (!this.fileDeliveryAvailable()) {
      await interaction.editReply({ content: this.fileRefusalMessage("unavailable") });
      return;
    }
    const canSend = (): boolean =>
      this.sessions.get(threadId) === session && session.actor.canDeliverFiles();
    const requestedPath = interaction.options.getString("path", true);
    let resolved: Awaited<ReturnType<SessionActor["resolveFileForDelivery"]>>;
    try {
      resolved = await session.actor.resolveFileForDelivery(requestedPath, "operator");
    } catch {
      if (!canSend()) {
        await interaction.editReply({ content: "檔案傳送已取消。" });
        return;
      }
      await interaction.editReply({ content: this.fileRefusalMessage("unreadable") });
      return;
    }
    if (!canSend()) {
      await interaction.editReply({ content: "檔案傳送已取消。" });
      return;
    }
    if (!resolved.ok) {
      await interaction.editReply({ content: this.fileRefusalMessage(resolved.reason) });
      return;
    }
    let sent: SendFileResult;
    try {
      sent = await this.transport.sendFile(threadId, resolved.file, undefined, { canSend });
    } catch {
      await interaction.editReply({
        content: "⚠️ Discord 檔案上傳的結果不明；附件可能已被接受，且仍可能在這個討論串中看見。",
      });
      return;
    }
    if (!sent.ok && sent.reason === "upload-outcome-unknown") {
      await interaction.editReply({
        content: "⚠️ Discord 檔案上傳的結果不明；附件可能已被接受，且仍可能在這個討論串中看見。",
      });
      return;
    }
    if (!sent.ok && sent.reason === "retraction-unconfirmed") {
      await interaction.editReply({
        content:
          "⚠️ 檔案傳送已取消，但 Discord 接受附件後無法確認已收回；附件可能仍可在這個討論串中看見。",
      });
      return;
    }
    if (!canSend()) {
      await interaction.editReply({
        content: sent.ok
          ? "⚠️ Discord 可能已在取消前接受附件；附件可能仍可在這個討論串中看見。"
          : "檔案傳送已取消。",
      });
      return;
    }
    if (!sent.ok) {
      await interaction.editReply({
        content: sent.reason === "cancelled" ? "檔案傳送已取消。" : "檔案已解析，但傳送到 Discord 失敗。",
      });
      return;
    }
    await interaction.editReply({ content: "已將檔案傳送到這個討論串。" });
  }

  private async cmdTodos(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policyNow())) {
      await this.refuseUnauthorized(interaction);
      return;
    }
    const session = this.sessions.get(interaction.channelId);
    if (!session) {
      await interaction.reply({ content: "Run this inside a session thread.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply({ ...EPHEMERAL });
    const rows = await session.actor.readTodos();
    if (rows === undefined) {
      // Distinguish "the read failed" from "there are none" — reporting a broken
      // read as an empty list hides the failure behind a plausible answer.
      await interaction.editReply({ content: "⚠️ 無法讀取待辦清單（session 尚未建立 plan 資料或 RPC 失敗）。" });
      return;
    }
    const rendered = formatTodos(rows);
    await interaction.editReply({ content: (rendered || "目前沒有待辦事項。").slice(0, 1900) });
  }

  /** /rename — retitle the current session thread. */
  private async cmdRename(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policyNow())) {
      await this.refuseUnauthorized(interaction);
      return;
    }
    const session = this.sessions.get(interaction.channelId);
    if (!session) {
      await interaction.reply({ content: "Run this inside a session thread.", ...EPHEMERAL });
      return;
    }
    const title = deriveThreadTitle(interaction.options.getString("title") ?? "");
    if (!title) {
      await interaction.reply({ content: "標題是空的（或只有符號），沒有改名。", ...EPHEMERAL });
      return;
    }
    // Discord queues renames behind its channel-update bucket, so this can take
    // noticeably longer than the 3s interaction token allows.
    await interaction.deferReply({ ...EPHEMERAL });
    const ok = await this.retitleThread(interaction.channelId, title);
    // An explicit rename also counts as "titled" either way, so a later first
    // message can't silently overwrite what the operator just chose — and the
    // epoch bump invalidates a titler that is ALREADY in flight, which would
    // otherwise land seconds later and undo this.
    session.titled = true;
    session.titleEpoch++;
    await interaction.editReply({
      content: ok ? `已改名為 **${title}**。` : "⚠️ 改名失敗（權限或 Discord 速率限制）。稍後再試。",
    });
  }

  /**
   * `/queue` — hold a prompt until the current turn finishes.
   *
   * The queue lives HERE, not in the runtime. The SDK does offer
   * `send({mode:"enqueue"})`, but `session.abort()` does NOT drain the runtime's
   * queue (verified: a queued message still ran after an abort), which would
   * make `/stop` a lie. Holding it locally keeps "stop means stop".
   *
   * Volatile by design, like YOLO: a restart drops the queue rather than
   * resurrecting work the operator has long forgotten about.
   */
  private async cmdQueue(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policyNow())) {
      await this.refuseUnauthorized(interaction);
      return;
    }
    const session = this.sessions.get(interaction.channelId);
    if (!session) {
      await interaction.reply({ content: "Run this inside a session thread.", ...EPHEMERAL });
      return;
    }
    const reply = (content: string): Promise<unknown> =>
      interaction.reply({ content, ...EPHEMERAL });

    if (interaction.options.getBoolean("clear")) {
      const n = session.queue.length;
      session.queue = [];
      await reply(n ? `🗑️ 已清空佇列（丟棄 ${n} 則）。` : "佇列本來就是空的。");
      return;
    }
    const text = (interaction.options.getString("message") ?? "").trim();
    if (!text) {
      // No message + no clear = show what's pending.
      if (!session.queue.length) await reply("佇列是空的。用 `/queue message:…` 排入下一則。");
      else {
        const list = session.queue.map((q, i) => `${i + 1}. ${q.slice(0, 120)}`).join("\n");
        await reply(`📋 佇列中的 ${session.queue.length} 則（重啟不保留）：\n${list}`.slice(0, 1900));
      }
      return;
    }
    if (session.queue.length >= QUEUE_MAX) {
      await reply(`⚠️ 佇列已滿（上限 ${QUEUE_MAX} 則）。先讓它跑完，或用 \`/queue clear:true\` 清空。`);
      return;
    }
    session.queue.push(text);
    if (!session.running) {
      // Nothing to wait for — reply first (the interaction token is short), then
      // start it. drainQueue is the single place a queued item is consumed.
      await reply("▶️ 目前沒有在執行，直接開始這一則。");
      void this.drainQueue(interaction.channelId).catch(() => {});
      return;
    }
    await reply(`📥 已排入佇列（第 ${session.queue.length} 位，會在目前回合結束後執行）。`);
  }

  // ---- input surface: thread messages -----------------------------------

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    const session = this.sessions.get(message.channelId);
    if (!session) {
      await this.hintEndedSession(message);
      return; // not a live session thread
    }
    if (!isAuthorized(ctxOf(message), this.policyNow())) return; // silent for non-owners
    // Startup gate, checked AFTER the thread+author checks so it can never spam
    // unrelated channels. resumeRecord registers the session and posts its
    // recovery notice while `phase` is still "reconciling", so a user replying
    // to that notice immediately would otherwise have their prompt vanish with
    // no trace. Slash commands already answer with the same courtesy.
    if (this.phase !== "ready") {
      await this.transport
        .notice(message.channelId, "⏳ 啟動中（正在復原對話），請稍候重試。")
        .catch(() => {});
      return;
    }
    const text = message.content.trim();
    const hasAttachments = message.attachments.size > 0;
    // A pending freeform ask_user expects a TEXT answer. Route on the ORIGINAL
    // attachment presence (not download success) so a failed/oversized image
    // can't have its text silently answer the ask.
    if (!hasAttachments && text && session.actor.tryConsumeFreeform(text)) return;
    if (hasAttachments && session.actor.isAwaitingFreeform()) {
      await this.transport
        .notice(message.channelId, "⚠️ 正在等你回答上一個提問，請用文字回覆（圖片無法作為答案）。")
        .catch(() => {});
      return;
    }
    if (!text && !hasAttachments) {
      await this.transport.notice(
        message.channelId,
        "Empty message — is the Message Content intent enabled for this bot?"
      );
      return;
    }
    // Name the thread after its first real prompt, exactly once.
    this.startTitling(message.channelId, session, text);
    // Reserve the turn (via the running guard in runTurn) BEFORE any network I/O,
    // so image downloads serialize with message arrival and two quick image
    // messages can't reorder. The download happens inside runTurn.
    await this.runTurn(message.channelId, text, message);
  }

  /** Tell an authorized operator that the thread they just typed into is a spent
   *  session, instead of silently swallowing the message. Once per thread per
   *  process, and only in threads this bot opened under an enabled channel —
   *  see `isOurEndedThread`. Never throws: this is a courtesy, not a feature. */
  private async hintEndedSession(message: Message): Promise<void> {
    try {
      if (this.endedHinted.has(message.channelId)) return;
      if (!isAuthorized(ctxOf(message), this.policyNow())) return; // silent for non-owners
      const ch = message.channel as unknown as {
        isThread?: () => boolean;
        parentId?: string | null;
        ownerId?: string | null;
      };
      const ours = isOurEndedThread({
        channelIsThread: ch.isThread?.() === true,
        threadParentId: ch.parentId ?? undefined,
        threadOwnerId: ch.ownerId ?? undefined,
        enabledParentChannelIds: this.channels.enabledSet(),
        botUserId: this.discord.user?.id,
      });
      if (!ours) return;
      this.endedHinted.add(message.channelId);
      await this.transport
        .notice(
          message.channelId,
          "💤 這個討論串的 session 已經結束（可能是你用了 `/end`，或它在啟動時無法復原），訊息不會送出。" +
            "用 `/sessions` 看還有哪些在跑，或在父頻道用 `/new` 開一個新的。"
        )
        .catch(() => {});
    } catch {
      /* a courtesy notice must never affect message handling */
    }
  }

  /** Download a message's image attachments as base64 blobs for the SDK. Only
   *  image/* is accepted (P5 = images); non-images and over-limit files are
   *  skipped with a notice. Bounded by count, per-file size AND a cumulative
   *  total, with a fetch timeout and a streaming byte cap, so a huge or stalled
   *  upload can't blow the prompt budget or memory. */
  private async collectImageAttachments(message: Message, signal?: AbortSignal): Promise<BlobAttachment[]> {
    const MAX_IMAGES = 4;
    const MAX_BYTES = 8 * 1024 * 1024; // 8 MiB per image
    const MAX_TOTAL_BYTES = 24 * 1024 * 1024; // cap across all images in one message
    const all = [...message.attachments.values()];
    if (all.length === 0) return [];
    const out: BlobAttachment[] = [];
    let skipped = 0;
    let total = 0;
    for (const att of all) {
      if (signal?.aborted) break; // /stop during download: bail immediately
      if (out.length >= MAX_IMAGES) {
        skipped++;
        continue;
      }
      const mime = (att.contentType ?? "").split(";")[0]!.trim().toLowerCase();
      if (!mime.startsWith("image/")) {
        skipped++;
        continue;
      }
      // Cheap pre-check on Discord's declared size before any download.
      if (typeof att.size === "number" && att.size > MAX_BYTES) {
        skipped++;
        continue;
      }
      const remaining = Math.min(MAX_BYTES, MAX_TOTAL_BYTES - total);
      if (remaining <= 0) {
        skipped++;
        continue;
      }
      const buf = await downloadBounded(att.url, remaining, 15_000, signal);
      if (!buf) {
        skipped++;
        continue;
      }
      total += buf.byteLength;
      out.push({
        type: "blob",
        data: buf.toString("base64"),
        mimeType: mime,
        displayName: att.name ?? "image",
      });
    }
    // Suppress the skip notice on an abort — the turn is being cancelled anyway.
    if (skipped > 0 && !signal?.aborted) {
      await this.transport
        .notice(
          message.channelId,
          `ℹ️ 已略過 ${skipped} 個附件（僅支援圖片，每張上限 8MB、單則最多 ${MAX_IMAGES} 張且總量 24MB；下載逾時或失敗也會略過）。`
        )
        .catch(() => {});
    }
    return out;
  }

  /** Run one prompt to real completion (session.idle), guarding against
   *  overlapping sends per thread. `running` stays set for the WHOLE turn, so
   *  attachment downloads (done here, after the guard) serialize with arrival. */
  private async runTurn(threadId: string, text: string, message?: Message): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    if (session.actor.isFaulted()) {
      await this.transport.notice(
        threadId,
        "This session has faulted and can't accept more prompts. Start a new one with /new."
      );
      return;
    }
    if (session.running) {
      // A message arriving mid-turn STEERS the running turn rather than being
      // dropped. `mode: "immediate"` lands at the next tool boundary (measured:
      // a run of 8 sequential commands stopped after 4) and jumps ahead of
      // anything already queued; during a single long generation it runs
      // straight after instead, which is the best achievable without throwing
      // away in-flight work. Attachments are deliberately NOT downloaded here:
      // steering must be immediate, and a slow download would defeat the point.
      try {
        await session.actor.steer(text);
        await this.transport
          .notice(threadId, "↪️ 已插入目前回合（steer）。工具執行到下一個段落時才會轉向。")
          .catch(() => {});
      } catch (err) {
        await this.transport
          .notice(
            threadId,
            `⚠️ 無法插入目前回合（${err instanceof Error ? err.message : String(err)}）。` +
              "可用 `/queue` 排到這一輪之後，或 `/stop` 中止。"
          )
          .catch(() => {});
      }
      return;
    }
    session.running = true;
    // A turn is about to run, so from now on this thread has conversation
    // history worth confirming before a rebind discards it. Set BEFORE the send:
    // an aborted or failed turn still consumed context in the runtime.
    session.hasRunTurn = true;
    const ac = new AbortController();
    session.currentAbort = ac;
    this.transport.resetTurn(threadId);
    try {
      const outcome = await sendUnlessAborted(
        ac.signal,
        // prepare: download attachments (may be slow) while /stop can still abort.
        async () => {
          const images = message ? await this.collectImageAttachments(message, ac.signal) : [];
          const prompt = text || (images.length ? "請看我附上的圖片。" : "");
          return { images, prompt };
        },
        // send: only reached when NOT aborted during the download above.
        async ({ images, prompt }) => {
          if (!prompt) {
            // Had attachments but none were usable, and there was no text to send.
            await this.transport
              .notice(threadId, "⚠️ 附件都無法使用（僅支援圖片），且訊息沒有文字，已略過。")
              .catch(() => {});
            return;
          }
          // Committing to the SDK turn: from here a /stop must go through
          // actor.stop(), not the pre-send abort. No await between this and the
          // send, so /stop can't interleave and start a turn we meant to cancel.
          session.currentAbort = undefined;
          await session.actor.runTurn(prompt, undefined, images);
        }
      );
      if (outcome === "aborted") {
        await this.transport.notice(threadId, "🛑 已在送出前取消，未啟動這一輪。").catch(() => {});
      }
    } catch (err) {
      await this.transport
        .notice(threadId, `⚠️ ${err instanceof Error ? err.message : String(err)}`)
        .catch(() => {});
    } finally {
      if (session.currentAbort === ac) session.currentAbort = undefined;
      await this.transport.flush(threadId).catch(() => {});
      session.running = false;
    }
    // Drain ONE queued prompt, outside the `finally` so a queued item can never
    // interfere with this turn's cleanup, and one at a time so each drained turn
    // gets the same guards (fault check, /stop, steering) as any other.
    await this.drainQueue(threadId);
  }

  /** Start the next `/queue`d prompt, if any. `/stop` empties the queue, so a
   *  stopped turn never resurrects work the operator asked to abandon. */
  private async drainQueue(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session || session.running || session.queue.length === 0) return;
    const next = session.queue.shift()!;
    const left = session.queue.length;
    // NOTHING may await between the guard above and `runTurn` claiming the turn,
    // or two callers (a finishing turn and a `/queue` on an idle session) both
    // pass the guard, both shift, and the second lands as a steer into the turn
    // the first just started. So the notice is fire-and-forget.
    void this.transport
      .notice(threadId, `▶️ 開始執行佇列中的訊息${left ? `（還有 ${left} 則）` : ""}：\n> ${next.slice(0, 300)}`)
      .catch(() => {});
    await this.runTurn(threadId, next);
  }

  // ---- shutdown ----------------------------------------------------------

  private installSignalHandlers(): void {
    const handler = (signal: string): void => void this.onTerminationSignal(signal);
    // `once` per signal, deliberately: a SECOND Ctrl-C has no listener left and
    // Node's default terminates immediately. That is the operator's explicit
    // force-quit, and it stays available. A different signal (SIGTERM after
    // SIGINT) still lands here and joins the same single-flight teardown.
    process.once("SIGINT", () => handler("SIGINT"));
    process.once("SIGTERM", () => handler("SIGTERM"));
  }

  /**
   * What a termination signal does.
   *
   * Deliberately does NOT call `process.exit`. Forcing an exit truncates exactly
   * what shutdown just arranged: `stop()`'s wait is bounded, so a `git worktree
   * add` or an SDK child may still be running under this pid, and the lock
   * release may have been deferred until that work settles. Killing the process
   * orphans the child and abandons the deferred release. Setting `exitCode` and
   * letting the event loop drain means the process exits once nothing is holding
   * it open — which is the same condition the deferred release waits for.
   *
   * A failed teardown is reported and exits non-zero. The previous handler
   * chained a forced exit onto `stop()`'s fulfilment only, so a rejection became
   * an unhandled rejection AND the process never exited — the two worst answers.
   */
  private async onTerminationSignal(signal: string): Promise<void> {
    try {
      await this.stop();
      process.exitCode = 0;
    } catch (err) {
      console.error(
        `shutdown: ${signal} teardown failed (${err instanceof Error ? err.message : String(err)}); ` +
          `exiting non-zero. Some state may not have been cleaned up.`
      );
      process.exitCode = 1;
    }
  }

  /**
   * Reverse-order teardown; the single-instance lock is released LAST.
   *
   * Single-flight: a second signal, a bootstrap failure path racing a signal, or
   * a test calling it twice all JOIN the first teardown. Returning early instead
   * would let a caller believe cleanup had finished while it was still half done
   * — and `stop()` is precisely where "half done" means a live SDK child and an
   * unreleased lock.
   */
  stop(): Promise<void> {
    // Not `async`: callers must get the IDENTICAL promise, so a second signal
    // joins the first teardown rather than awaiting a fresh wrapper around it.
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    this.shuttingDown = true;
    this.phase = "shuttingDown"; // reject any late input while tearing down
    // Disarm before the teardown loop. `shuttingDown` also stops a tick that is
    // already in flight from registering anything (`resumeOwnershipLost`), so
    // no session can appear behind this loop's back and survive it.
    this.clearAccessRetryTimer();
    // Cancel every in-flight attempt's token BEFORE waiting for it. This is the
    // fence that matters: the wait below is bounded, so an attempt CAN outlive
    // it, and it must not still be able to write a terminal state, drop a repo
    // lease or post a message once the lock below is released.
    this.accessRetryEpoch++;
    // Then JOIN it. Disarming only prevents the NEXT tick; one already inside
    // git or the runtime can still be mid-transition. Bounded, so a wedged
    // runtime cannot make shutdown hang.
    const pendingTick = this.accessRetryTickPromise;
    const quiesced = pendingTick
      ? await withTimeout(pendingTick, this.accessResumeJoinTimeoutMs).then(
          () => true,
          () => false
        )
      : true;
    for (const [threadId, session] of this.sessions) {
      // Rebind can be suspended in its prepare phase while shutdown starts.
      // Mark first so it cannot install a replacement after this loop clears
      // the map or hand a newly-created root/worktree to an ending process.
      this.endedSessions.add(session);
      // Cancel a turn that is reserved but not yet sent (e.g. still downloading
      // an attachment). `/stop` and `/end` both do this; shutdown only got it
      // via `endAllSessions`, which existed for the shared-checkout mode and is
      // gone — without it a SIGTERM leaves a download running against an actor
      // that is about to be disconnected.
      session.currentAbort?.abort();
      session.broker.abort();
      // Bound the disconnect: a retained fence's disconnect can be permanently
      // hung, and shutdown must not block forever on it.
      await withTimeout(session.actor.disconnect(), TEARDOWN_TIMEOUT_MS).catch(() => {});
      this.transport.dispose(threadId);
    }
    this.sessions.clear();
    // Rebind replacements that lost ownership during `/end` are intentionally
    // not in `sessions`, but may still hold a Windows root fence. Give each one
    // the same bounded shutdown retry; a failed retry remains retained until
    // process exit rather than being silently dropped.
    for (const actor of [...this.staleRebindActors.keys()]) {
      await withTimeout(this.retryStaleRebindActor(actor), TEARDOWN_TIMEOUT_MS).catch(() => {});
    }
    // Same courtesy for a retry-discarded runtime we could not confirm: one last
    // bounded attempt. A still-unconfirmed one stays retained until the process
    // exits, which is the point — it is a barrier, not a leak.
    for (const threadId of [...this.unconfirmedResumes.keys()]) {
      await this.retryUnconfirmedResume(threadId).catch(() => false);
    }
    try {
      this.discord.destroy();
    } catch {
      /* best effort */
    }
    await this.copilot.stop().catch(() => {});
    await clearStartupReady().catch(() => {});
    // The single-instance lock is the LAST thing released, and only once no
    // attempt of ours can still be doing external work.
    //
    // The cancellation epoch stops this app from mutating anything further, but
    // it cannot un-issue a REST call, a `git worktree add` or an
    // `SessionActor.create` that has already been handed to the runtime. Those
    // finish on their own schedule, against the same state directory and the
    // same checkouts. Releasing the lock while one is in flight invites a
    // successor instance to start reconciling the very records and worktrees
    // this process is still touching — a cross-process race no in-process fence
    // can cover.
    //
    // So a shutdown that could not join its retry attempt does not release the
    // lock here; it releases it when that attempt finally settles. If it never
    // settles, the lock file simply stays until this process exits, and the
    // successor reclaims it then: `acquireSingleInstanceLock` treats a lock
    // whose holder pid is no longer alive as stale, and `releaseIfOwner` refuses
    // to delete a lock that a successor has already taken over. Holding it is
    // therefore honest — this pid really is still working — and self-healing.
    if (quiesced || !pendingTick) {
      await this.lock.release().catch(() => {});
      return;
    }
    console.warn(
      "shutdown: an access-retry attempt is still running (cancelled, but its in-flight " +
        `REST/git/runtime work cannot be recalled). Holding the single-instance lock at ` +
        `${this.lock.path} until it settles; if this process exits first, the next start ` +
        `reclaims the lock as stale.`
    );
    void pendingTick.then(
      () => void this.lock.release().catch(() => {}),
      () => void this.lock.release().catch(() => {})
    );
  }
}

function ctxOf(source: {
  user?: { id: string };
  author?: { id: string };
  guildId: string | null;
  channelId: string | null;
  channel: unknown;
}): AuthContext {
  const ch = source.channel as { isThread?: () => boolean; parentId?: string | null } | null;
  const isThread = ch?.isThread?.() ?? false;
  return {
    userId: source.user?.id ?? source.author?.id ?? "",
    guildId: source.guildId,
    channelId: source.channelId ?? "",
    parentId: isThread ? ch?.parentId ?? null : null,
  };
}

/** Warn (not fail) if the configured default model isn't currently available. */
async function preflightModel(copilot: CopilotClient, model: string): Promise<void> {
  try {
    const models = await copilot.listModels();
    if (!models.some((m) => m.id === model)) {
      console.warn(
        `⚠️  DEFAULT_MODEL "${model}" is not in the ${models.length} available models; ` +
          `sessions may fall back to the account default.`
      );
    }
  } catch (err) {
    console.warn(`⚠️  Could not list models for preflight: ${err instanceof Error ? err.message : err}`);
  }
}
