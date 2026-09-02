import {
  Client,
  GatewayIntentBits,
  Events,
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
import { SessionStore, type SessionRecord } from "./core/session-store.js";
import {
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
  removeWorktreeIfClean,
  pruneWorktrees,
  worktreeBranch,
  worktreeOutcomeText,
  worktreePath,
} from "./core/worktree.js";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import { sendUnlessAborted } from "./core/turn-gate.js";
import { shouldResetEffort, validateEffort } from "./core/effort.js";
import { createCopilotClient, checkSdkCompat, stopCopilotClient } from "./copilot/sdk.js";
import { PendingInteractionBroker, type PendingView } from "./core/broker.js";
import {
  SessionActor,
  type BlobAttachment,
  type SessionActorCreateDependencies,
  type SessionActorOpts,
  formatTodos,
} from "./copilot/session-actor.js";
import { ApprovalPolicy } from "./core/approval-policy.js";
import type { AuditSink } from "./core/audit-log.js";
import { DiscordTransport, NO_MENTIONS } from "./platforms/discord/discord-transport.js";
import { fetchChannelSafe } from "./platforms/discord/channel-fetch.js";
import {
  handleChannelCommand,
  inspectChannelTarget as inspectChannelEnableTarget,
  type ChannelTargetInspection,
} from "./platforms/discord/channel-command.js";
import {
  decodePermissionId,
  decodeChoiceId,
  decodePlanId,
  decodeRepoId,
  encodeRepoId,
  type RebindAction,
} from "./platforms/discord/custom-id.js";
import { isAuthorized, isOwner, type AuthContext, type AuthPolicy } from "./platforms/discord/auth.js";
import { registerCommands } from "./platforms/discord/commands.js";
import { ChannelRegistry } from "./core/channel-registry.js";
import type { Decision, SendFileResult, Transport } from "./core/transport.js";
import { captureTrustedRoot, type SecureOpenBackend, type TrustedRoot } from "./core/secure-open.js";
import { isFileDeliveryAvailable } from "./core/file-delivery-availability.js";
import {
  createLifecycleOwnership,
  type LifecycleOwnership,
  createLifecycleOwnershipForTest,
  type LifecycleOwnershipOptions,
  type OwnedScope,
  type OwnershipInspector,
  type TeardownScope,
  confirmStopped,
  withTimeout,
} from "./core/lifecycle-ownership.js";
import {
  ReconciliationEngine,
  runtimeObligationKey,
  type ReconcileAttemptOpts,
  type ReconciliationPorts,
  type ReconcileStartupOverrides,
  type ResumeActorInput,
  type ResumedRuntime,
} from "./core/reconciliation-engine.js";
import { RebindCoordinator, type RebindHostPorts } from "./core/rebind-coordinator.js";
import type { Session } from "./core/session.js";

export type { Session } from "./core/session.js";

/** The subset of an SDK session the throwaway titler uses. */
interface TitlerSession {
  sessionId?: string;
  on(ev: string, h: (e: unknown) => void): void;
  send(o: Record<string, unknown>): Promise<unknown>;
  disconnect?: () => Promise<unknown>;
}

/** Every new session is isolated. `local` is reachable only through an explicit
 *  `/repo dev local` in the thread — a config key that made it the default for
 *  every new thread would be the same hazard with a longer fuse, since it
 *  silently opts every future session into editing the operator's own checkout. */
const NEW_SESSION_DEV_MODE: DevMode = "worktree";

/** The fixed inputs of `/new`'s owned transaction, decided by `cmdNew`'s guards
 *  before the first phase runs. Carried as ONE value so no phase can re-derive a
 *  different parent or repo than the guards approved. */
interface NewSessionRequest {
  interaction: ChatInputCommandInteraction;
  /** The inbound claim every phase re-asks before it creates anything. */
  scope: OwnedScope;
  parentChannelId: string;
  repoPath: string;
  /** `/new prompt:` — names the thread up front and runs the first turn at the
   *  end, so it crosses the whole transaction. */
  promptOption: string | null;
}

/** The Discord thread `/new` has already created, together with the best-effort
 *  rollback that undoes it. The two travel as one value because from the moment
 *  the thread exists, no later phase may abandon it silently. */
interface NewSessionThread {
  id: string;
  drop: () => Promise<void>;
}

/** The caller-assigned durable identity, allocated BEFORE the worktree and the
 *  runtime so a crash between reservation and creation leaves an identifiable id
 *  on disk rather than a live runtime session nobody knows about. */
interface NewSessionIdentity {
  sessionId: string;
  generation: number;
  fileDeliveryBytes: number;
}

/** This session's own checkout, plus the ONLY rollback later phases may use:
 *  `abort` undoes the worktree AND the thread and then answers the operator.
 *  Nothing below may drop the worktree on its own — a checkout the operator was
 *  told does not exist is unreachable, since `/end` only works on a LIVE
 *  session. */
interface NewSessionWorktree {
  branch: string;
  workDir: string;
  abort: (msg: string) => Promise<void>;
}

/** What survives capture → binding proof → final gates → durable reservation.
 *  `workDir` is the proven display path that gets persisted and handed to the
 *  SDK; `trustedRoot` is a live OS capability on Windows whose ownership now
 *  belongs to the caller — it must reach `SessionActor.create()` or be closed. */
interface NewSessionReservation {
  trustedRoot?: TrustedRoot;
  workDir: string;
  approvalKey: string;
}

function ephemeralReply(content: string): {
  content: string;
  flags: MessageFlags.Ephemeral;
  allowedMentions: typeof NO_MENTIONS.allowedMentions;
} {
  return { content, ...EPHEMERAL, ...NO_MENTIONS };
}

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

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

/** Startup was told to stop before it finished. Distinct so the failure reads as
 *  a deliberate abandonment rather than a crash. */
export class StartupAbandonedError extends Error {}

/** Test-only seams on the real `start()` path. Production passes none, so the
 *  production flow is exactly the flow under test minus these hooks. */
export interface StartDependencies {
  /** Runs after the app is constructed and published, before the gateway login
   *  installs signal handlers. Lets a test stand at that exact point. */
  beforeLogin?(app: DiscordCopilotApp): Promise<void>;
}

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

/** The whole of process startup is owned work: it constructs the runtime, then
 *  mutates the store for every persisted record, and finally opens the phase
 *  gate. A signal arriving in the middle used to be able to complete a shutdown
 *  and release the lock while all of that was still happening. Held as an
 *  exclusive scope, it gates the release structurally rather than by checking. */
const PROCESS_STARTUP_KEY = "<process-startup>";

/**
 * Key for ONE inbound operation.
 *
 * Deliberately NOT the thread id. `runExclusive` is used here for OWNERSHIP,
 * not mutual exclusion: two commands in one thread are independent operations
 * today, so keying them by thread would silently serialize them, and would make
 * an `/end` teardown claim decline unrelated commands in the same thread. A
 * Discord interaction or message id is unique per operation, so the concurrency
 * semantics are exactly what they were — the difference is only that the
 * single-instance lock now waits for the operation to settle or roll back.
 *
 * `/end` and rebind are NOT wrapped: they are teardowns and already run under
 * `runTeardown`, which claims the thread. Wrapping them here as well would nest
 * an exclusive scope inside their own claim and deadlock the join.
 */
const inboundOperationKey = (kind: string, id: string): string => `inbound:${kind}:${id}`;

/** What a declined inbound operation says. Shutdown had already begun before
 *  the handler ran, so nothing was done and nothing was half-done. */
const INBOUND_DECLINED =
  "⚠️ bot 正在關閉中，這次沒有執行。請等它重新啟動後再試。";

/** Format an executable list for a compact reply. */
function fmtList(items: string[]): string {
  return items.length ? items.map((e) => `\`${e}\``).join(", ") : "(none)";
}

// `withTimeout` and `confirmStopped` live in `core/lifecycle-ownership.ts` now:
// the reconciliation engine has to answer "did this runtime actually stop?"
// exactly the way shutdown does, and two copies of that answer would drift.

/** Ack the Discord button interaction BEFORE settling the decision. On ack *  success the user's decision is delivered; on ack failure the SAFE default
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
 * Every collaborator `createForTest` would otherwise DEFAULT to a real
 * home-backed one.
 *
 * These fields are required, and deliberately so. The defaults they replace all
 * resolve through `os.homedir()`. A test that forgot one used to read — and in
 * several cases create — the state of whoever ran the
 * suite. Vitest now redirects `HOME`/`USERPROFILE` for the whole run, but that
 * is one process-wide setting away from being removed or broken, and it fails
 * open: nothing about it makes the omission visible. Making these required makes
 * the omission a COMPILE error instead, which is the only form of the rule that
 * cannot silently regress. Do not give any of them a default here.
 */
export interface DiscordCopilotAppTestDependencies {
  /** Durable thread↔session records. Real default: `~/.discord-copilot-sdk`. */
  store: SessionStore;
  /** Enabled-channel registry. Real default: `~/.discord-copilot-sdk`. */
  channels: ChannelRegistry;
  /** Approval memory. Real default: `~/.discord-copilot-sdk/approvals.json`. */
  approvals: ApprovalPolicy;
  /** Audit sink handed to EVERY actor this app creates. Real default:
   *  `~/.discord-copilot-sdk/<instance>.audit.jsonl`. */
  actorAuditLog: AuditSink;
  /** Skills home handed to every actor. Real default: the `~/.copilot/skills`
   *  of whoever runs the suite. */
  actorSkillsHomeDirectory: string;
  /** Where this app believes per-session worktrees live. A path, or a provider
   *  for a suite whose root is only known later. Real default:
   *  `~/.discord-copilot-sdk-worktrees`, which this app both SCANS for strays
   *  and creates session checkouts under. */
  worktreeRoot: string | (() => string);
  /** Teardown's readiness-marker cleanup. Real default: `clearStartupReady()`,
   *  which resolves — and creates — `~/.discord-copilot-sdk/startup-ready`. */
  clearStartupReady: () => Promise<void>;
  /** Not home-backed: the platform whose file-delivery rules apply. */
  fileDeliveryPlatform?: NodeJS.Platform;
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
  /** Shared approval memory (session + persisted repo rules) across sessions.
   *  Assigned in the constructor rather than initialized here: the real default
   *  loads (and creates the directory of) `~/.discord-copilot-sdk/approvals.json`
   *  as a side effect of merely EXISTING, which is exactly what a test that only
   *  builds an app must not do. */
  private readonly approvals: ApprovalPolicy;
  /** Where this app believes per-session worktrees live. Production resolves the
   *  real `worktreeRoot()` on every call — it is a pure path helper, and reading
   *  it once would freeze a value the uninstaller and the validators derive
   *  independently. A test injects a suite-scoped root, so a stray-worktree scan
   *  never reads (and a session checkout never lands in) a real home. */
  private readonly worktreeRootOf: () => string;
  /** Teardown's readiness-marker cleanup. Production is `clearStartupReady`,
   *  which resolves — and creates — a directory under the state directory, so a
   *  test that merely drives `stop()` used to leave one behind. */
  private readonly clearStartupReadyOnTeardown: () => Promise<void>;
  /** Home-backed collaborators EVERY actor this app creates must be handed.
   *  Undefined in production, where the actor applies its own real defaults;
   *  `createForTest` always sets it, so no creation path can quietly fall back
   *  to the audit log or skills home of whoever runs the suite. */
  private readonly actorHomeDependencies?: Pick<
    SessionActorOpts,
    "auditLog" | "skillsHomeDirectory"
  >;
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
   *  `validateBinding`; the reconciliation engine's startup overrides let a test
   *  inject one so the reconcile state machine can be exercised without building
   *  real repos on disk for every case. Shared with `/new` and rebind, which is
   *  why it stays here rather than moving into the engine. */
  private bindingCheck: typeof validateBinding = validateBinding;
  /** Startup and access-restoration reconciliation, and every piece of retry
   *  state that used to sit here beside it: the armed wake-up, the in-flight
   *  tick, backoff/idle, the noticed-thread set and the per-record resume
   *  fences. The app keeps the phase gate, the sessions map, the leases, the
   *  store and the capture/actor helpers this engine calls back into. */
  private readonly reconciliation: ReconciliationEngine;
  /** Only createForTest/useOwnershipForTest set this: a read-only view of the
   *  coordinator's three sets, for the race tests that must assert on them. */
  private ownershipInspector?: OwnershipInspector;
  /** The process-startup scope, while startup is running. onReady consults it
   *  after every await: a signal can complete a shutdown mid-startup, and none
   *  of the mutations below — least of all opening the phase gate — may happen
   *  on behalf of a process that has been told to stop. */
  private startupScope?: OwnedScope;
  /** The lock a test asked the coordinator to observe, kept across rebuilds. */
  private ownershipLockForTest: InstanceLock = { path: "(test)", release: async () => {} };
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
  /** The repo-rebind transaction and everything that exists only because one can
   *  fail halfway: the per-thread admission set, the detached incarnations this
   *  process could not prove stopped, and the pre-swap durable companion `/end`
   *  has to finish. The app keeps the confirmation card, the sessions map, the
   *  leases, the store and the capture/actor helpers this coordinator calls back
   *  into. */
  private readonly rebind: RebindCoordinator;
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
    private ownership: LifecycleOwnership,
    transportOverride?: Transport,
    testDependencies?: DiscordCopilotAppTestDependencies
  ) {
    this.discord = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.transport = transportOverride ?? new DiscordTransport(this.discord);
    this.store = testDependencies?.store ?? new SessionStore(sessionStorePath());
    this.channels =
      testDependencies?.channels ??
      new ChannelRegistry(
        this.config.DISCORD_PARENT_CHANNEL_ID,
        this.config.DISCORD_GUILD_ID,
        channelRegistryPath()
      );
    this.approvals = testDependencies?.approvals ?? new ApprovalPolicy();
    const injectedWorktreeRoot = testDependencies?.worktreeRoot;
    this.worktreeRootOf =
      injectedWorktreeRoot === undefined
        ? worktreeRoot
        : typeof injectedWorktreeRoot === "function"
          ? injectedWorktreeRoot
          : (): string => injectedWorktreeRoot;
    this.clearStartupReadyOnTeardown = testDependencies?.clearStartupReady ?? clearStartupReady;
    if (testDependencies) {
      this.actorHomeDependencies = {
        auditLog: testDependencies.actorAuditLog,
        skillsHomeDirectory: testDependencies.actorSkillsHomeDirectory,
      };
    }
    this.allowedUserIds = new Set(this.config.DISCORD_ALLOWED_USER_IDS);
    this.reconciliation = new ReconciliationEngine(this.reconciliationPorts());
    this.rebind = new RebindCoordinator(this.rebindPorts());
  }

  /**
   * What the reconciliation engine may reach back into.
   *
   * Every callback is LATE-BOUND on purpose. `useOwnershipForTest` rebuilds the
   * coordinator, `createForTest` replaces the store, and several suites patch
   * `bindingCheck`/`captureValidatedRoot`/`classifyThread` on the app object
   * after it exists — a port that captured any of those at construction time
   * would silently keep talking to the collaborator they replaced.
   */
  private reconciliationPorts(): ReconciliationPorts {
    return {
      process: {
        shuttingDown: () => this.shuttingDown,
        phaseIsReady: () => this.phase === "ready",
        runExclusive: (threadId, body) => this.ownership.runExclusive(threadId, body),
      },
      inventory: {
        store: () => this.store,
        hasSession: (threadId) => this.sessions.has(threadId),
        bindingOk: (rec) => this.bindingOk(rec),
        acquireLocalLease: (repoPath, threadId) => this.acquireLocalLease(repoPath, threadId),
        releaseLocalLease: (threadId) => this.releaseLocalLease(threadId),
        assertChannelRegistryUsable: () => this.assertChannelRegistryUsable(),
        useBindingCheck: (check) => {
          this.bindingCheck = check;
        },
      },
      world: {
        classifyThread: (threadId, parentChannelId, opts) =>
          this.classifyThread(threadId, parentChannelId, opts),
        captureValidatedRoot: (binding) => this.captureValidatedRoot(binding),
        resumeActor: (rec, input) => this.resumeActor(rec, input),
        registerResumedSession: (rec, runtime, workDir) =>
          this.registerResumedSession(rec, runtime, workDir),
        notice: (threadId, text) => this.transport.notice(threadId, text),
        announceUnreachableRecords: () => this.announceUnreachableRecords(),
        runtimeTeardownTimeoutMs: TEARDOWN_TIMEOUT_MS,
      },
    };
  }

  /**
   * What the rebind coordinator may reach back into.
   *
   * LATE-BOUND for the same reason the reconciliation ports are: `createForTest`
   * replaces the store, `useOwnershipForTest` rebuilds the lifecycle
   * coordinator, and several suites patch `bindingCheck`/`captureValidatedRoot`
   * after the app exists. A port that captured any of those at construction
   * time would silently keep talking to the collaborator they replaced.
   *
   * `createReplacementActor` stays HERE, not in the coordinator: it is the third
   * `SessionActor.create` site, and every one of them must spread the same
   * `actorSourceOptions()` and `fileDeliveryQuotaOptions()` so a rebind cannot
   * load a different skill/audit/quota configuration than `/new` or resume.
   */
  private rebindPorts(): RebindHostPorts {
    return {
      process: {
        runTeardown: (threadId, body) => this.ownership.runTeardown(threadId, body),
      },
      inventory: {
        store: () => this.store,
        session: (threadId) => this.sessions.get(threadId),
        installSession: (threadId, session) => {
          this.sessions.set(threadId, session);
        },
        isEnded: (session) => this.endedSessions.has(session),
        acquireLocalLease: (repoPath, threadId) => this.acquireLocalLease(repoPath, threadId),
        releaseLocalLease: (threadId) => this.releaseLocalLease(threadId),
        releaseLocalLeaseHeldBy: (repoPath, threadId) => {
          const key = this.leaseKey(repoPath);
          if (this.localLeases.get(key) === threadId) this.localLeases.delete(key);
        },
        localHolder: (repoPath) => this.localHolder(repoPath),
      },
      world: {
        captureValidatedRoot: (binding) => this.captureValidatedRoot(binding),
        worktreeRoot: () => this.worktreeRootOf(),
        guildId: () => this.config.DISCORD_GUILD_ID,
        createReplacementActor: (input) =>
          SessionActor.create(this.copilot, {
            sessionKey: input.threadId,
            ...(input.trustedRoot ? { trustedRoot: input.trustedRoot } : {}),
            workingDirectory: input.workDir,
            approvalKey: input.approvalKey,
            model: this.config.DEFAULT_MODEL,
            contextTier: this.config.DEFAULT_CONTEXT_TIER,
            broker: input.broker,
            transport: this.transport,
            policy: this.approvals,
            generation: input.generation,
            createSessionId: input.sessionId,
            ...this.fileDeliveryQuotaOptions(
              input.threadId,
              input.fileDeliveryBytes,
              input.sessionId,
              input.generation
            ),
            ...this.actorSourceOptions(),
          }),
        clearSessionApprovals: (threadId) => this.approvals.clearSession(threadId),
        runtimeTeardownTimeoutMs: TEARDOWN_TIMEOUT_MS,
      },
    };
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

  /** Keep every SessionActor creation path on the same skill-source policy AND
   *  the same audit/skills home.
   *
   *  These are deliberately ONE method. Duplicating the skill conversions at
   *  /new, /repo rebind and resume would let a restart silently load a different
   *  trust boundary than a fresh session, and a per-path audit/skills spread is
   *  how one of three creation sites would keep the real home-backed defaults
   *  after `createForTest` injected test ones. Every path spreads this; adding a
   *  fourth path that forgets it is the failure this shape prevents. */
  private actorSourceOptions(): Pick<
    SessionActorOpts,
    "enableRepoSkills" | "enableUserSkills" | "auditLog" | "skillsHomeDirectory"
  > {
    return {
      enableRepoSkills: this.config.ENABLE_REPO_SKILLS === "true",
      enableUserSkills: this.config.ENABLE_USER_SKILLS === "true",
      ...(this.actorHomeDependencies ?? {}),
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
        worktreeRoot: this.worktreeRootOf(),
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

  /** Test-only seam: construct the app with an injected transport and an
   *  explicit set of home-backed dependencies (and fake copilot/lock), skipping
   *  the lock/SDK/login startup, so unit tests can drive the real
   *  runTurn/stop/reconcile wiring without a live Discord connection. Not used in
   *  production (start() is the only production entry).
   *
   *  `reposRoot` is set directly rather than resolved: the filesystem checks in
   *  `resolveReposRoot` are covered by their own tests, and requiring a real
   *  directory here would make every app-level test build one.
   *
   *  `dependencies` is REQUIRED and has no defaults — see
   *  `DiscordCopilotAppTestDependencies`. Every one of its fields replaces a
   *  default that resolves through the home directory of whoever runs the suite,
   *  and an optional parameter is a fallback that reaches exactly that state the
   *  day a test forgets one. */
  static createForTest(
    config: Config,
    reposRoot: string,
    copilot: CopilotClient,
    transport: Transport,
    dependencies: DiscordCopilotAppTestDependencies
  ): DiscordCopilotApp {
    const noopLock: InstanceLock = { path: "(test)", release: async () => {} };
    const built = createLifecycleOwnershipForTest(noopLock);
    const app = new DiscordCopilotApp(
      config,
      copilot,
      built.ownership,
      transport,
      dependencies
    );
    app.reposRoot = reposRoot;
    app.actorCreateDependencies = createForTestActorDependencies(
      dependencies.fileDeliveryPlatform ?? "win32"
    );
    app.approvalKeyForTest = async (validationPath) => validationPath;
    app.ownershipInspector = built.inspect;
    app.ownershipLockForTest = noopLock;
    // The arm production does, so a test that drives `stop()` exercises the same
    // teardown path rather than a shortcut.
    app.ownership.arm((scope) => app.teardownResources(scope));
    return app;
  }

  /** Test-only: rebuild the coordinator around a lock the test can observe, or
   *  around different bounds. Re-arms, because a fresh coordinator has nothing
   *  armed, and keeps its inspector so a test can see the three sets the release
   *  conclusion is drawn from. */
  private useOwnershipForTest(lock?: InstanceLock, options?: LifecycleOwnershipOptions): void {
    // Keep whatever lock is already being observed: a test that first injects an
    // observable lock and then narrows a bound must not silently lose the lock
    // it is asserting on.
    this.ownershipLockForTest = lock ?? this.ownershipLockForTest;
    const built = createLifecycleOwnershipForTest(this.ownershipLockForTest, options ?? {});
    this.ownership = built.ownership;
    this.ownershipInspector = built.inspect;
    this.ownership.arm((scope) => this.teardownResources(scope));
  }

  /** Fully start after bootstrap has already acquired the instance lock and
   *  wrapped it in the one thing allowed to release it. */
  static async start(
    config: Config,
    ownership: LifecycleOwnership,
    deps: StartDependencies = {}
  ): Promise<DiscordCopilotApp> {
    // The ENTIRE startup runs as owned work, published before its first await.
    // Everything inside constructs runtimes, mutates the store for every
    // persisted record and finally opens the phase gate; a signal arriving in
    // the middle used to complete a shutdown and release the lock while all of
    // that carried on. Holding a scope makes the release wait structurally,
    // rather than depending on each step remembering to ask.
    let built: DiscordCopilotApp | undefined;
    let failure: unknown;
    // The PARTIALLY constructed app, published the moment it exists. `built` is
    // assigned only on full success, so a failure path that tested it could
    // never see an app — and would call the coordinator directly, tearing the
    // app down with its phase gate still open.
    const partial: { app?: DiscordCopilotApp } = {};
    const outcome = await ownership.runExclusive(PROCESS_STARTUP_KEY, async (scope) => {
      try {
        built = await DiscordCopilotApp.startInScope(config, ownership, scope, partial, deps);
      } catch (err) {
        failure = err;
      }
    });
    // Both teardown paths run OUTSIDE the scope: `shutdown()` joins exclusive
    // scopes, so calling it from within this one would stall on itself.
    if (failure !== undefined) {
      const app = built ?? partial.app;
      // Once the app exists, `stop()` is the door: it closes the phase gate
      // SYNCHRONOUSLY before the teardown runs. Only a failure from before
      // construction has nothing to gate.
      if (app) await app.stop().catch(() => {});
      else await ownership.shutdown().catch(() => {});
      throw failure;
    }
    if (!outcome.ran) throw new Error(`refusing to start: ${outcome.reason}`);
    if (!built) throw new Error("refusing to start: startup produced no app");
    return built;
  }

  private static async startInScope(
    config: Config,
    ownership: LifecycleOwnership,
    scope: OwnedScope,
    partial: { app?: DiscordCopilotApp },
    deps: StartDependencies
  ): Promise<DiscordCopilotApp> {
    // INSIDE the try, both of them: a throw that escaped it used to leave the
    // lock held by nobody. These two are the earliest things that can fail — a
    // REPOS_ROOT that does not exist or overlaps the trust store, and an SDK
    // version mismatch.
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
    // Constructed and armed INSIDE the startup scope, which is what makes the
    // arm meaningful: the scope prevents any release until it settles, so there
    // is no window in which the lock is gone but the client exists unarmed.
    const copilot = createCopilotClient();
    // NARROW arm, before `copilot.start()` rather than after: the client exists
    // from here, so from here it is something shutdown must put down. Failure is
    // NOT swallowed — an unclosed client is exactly the kind of thing that must
    // gate the lock rather than be logged.
    if (!ownership.arm(() => stopCopilotClient(copilot))) {
      await stopCopilotClient(copilot).catch((err: unknown) => {
        console.error("startup: the Copilot client could not be stopped cleanly", err);
      });
      throw new Error("shutdown began before the Copilot client could be armed for teardown");
    }
    await copilot.start();
    const lostAfterStart = scope.lostReason();
    if (lostAfterStart) throw new Error(`refusing to start: ${lostAfterStart}`);
    await preflightModel(copilot, config.DEFAULT_MODEL);
    const app = new DiscordCopilotApp(config, copilot, ownership);
    // Published the INSTANT it exists. From here a failure must be answered by
    // `app.stop()`, which closes the phase gate synchronously — not by the
    // coordinator alone, which would tear the app down with that gate open.
    partial.app = app;
    app.reposRoot = reposRoot;
    app.startupScope = scope;
    // Before the gateway, not after: a registry we cannot trust must not reach
    // a state where the bot is online and answering with the wrong channel set.
    app.assertChannelRegistryUsable();
    // WIDER arm, before signal handlers are installed by `login()`: from the
    // moment a signal can arrive, shutdown must already know how to put down
    // everything this app owns, not just the client.
    if (!ownership.arm((teardown) => app.teardownResources(teardown))) {
      throw new Error("shutdown began before the app could be armed for teardown");
    }
    // The last checkpoint before the gateway. `login()` installs the signal
    // handlers and opens the connection, so a shutdown that began while the app
    // was being built must stop HERE — bringing a gateway up for a process that
    // is already tearing down is how a bot ends up online with no resources.
    await deps.beforeLogin?.(app);
    const lostBeforeLogin = scope.lostReason();
    if (lostBeforeLogin) {
      throw new StartupAbandonedError(`startup: abandoning before login — ${lostBeforeLogin}`);
    }
    await app.login();
    return app;
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
      `channel registry at ${this.channels.path()} cannot be trusted: ${this.channels.corruptReason()}. ` +
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
    this.discord.on(Events.MessageCreate, (m) => void this.runOwnedMessage(m));
    this.installSignalHandlers();
    await new Promise<void>((resolve, reject) => {
      this.discord.once(Events.ClientReady, (c) => {
        this.onReady(c.user.id).then(resolve, reject);
      });
      this.discord.login(this.config.DISCORD_BOT_TOKEN).catch(reject);
    });
  }

  /** Has this process been told to stop while startup was still running? Every
   *  await in `onReady` is followed by this: a signal can complete a shutdown
   *  in any of those gaps, and nothing below one may then mutate the store,
   *  announce success, or open the phase gate. */
  private startupLost(where: string): void {
    const lost = this.startupScope?.lostReason();
    if (!lost) return;
    // THROWS rather than returning quietly. A quiet return let `onReady` resolve
    // normally, `login()` resolve, `start()` succeed and `publishReady()` write
    // a readiness marker for a process that had been torn down mid-startup. The
    // failure has to propagate so `startBot` takes its failure path.
    throw new StartupAbandonedError(`startup: abandoning ${where} — ${lost}`);
  }

  private async onReady(clientId: string): Promise<void> {    await this.loadModels();
    await this.warnOperatorsWithoutCommandAccess();
    await registerCommands({
      botToken: this.config.DISCORD_BOT_TOKEN,
      clientId,
      guildId: this.config.DISCORD_GUILD_ID,
      modelIds: this.modelIds,
    });
    // Reconcile persisted sessions BEFORE accepting input (phase gate), so a
    // /new can't race startup resume and double-register a thread.
    this.phase = "reconciling";
    this.startupLost("before reconciliation");
    await this.reconcileOnStartup();
    this.startupLost("after reconciliation");
    // Clear scratch left by a clone that died mid-flight. Safe here: nothing is
    // provisioning yet, and only directories carrying our own marker are swept.
    await sweepStaleStaging(this.reposRoot);
    // The gate is opened LAST, and only if this process is still the one that
    // was asked to start. Declaring readiness after a shutdown would admit
    // commands into an app whose resources are already being torn down.
    this.startupLost("before opening the phase gate");
    this.phase = "ready";
    // ADR-0002's other half: a `thread-no-access` record must also come back
    // WITHOUT a restart, once the permission is restored. Armed only now, so a
    // tick can never race the startup pass for the same thread.
    this.reconciliation.arm();
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

  // ---- input surface: interactions (slash + buttons) --------------------

  /**
   * Run one MUTATING inbound operation as owned work.
   *
   * The phase gate is a synchronous check at the top of `onInteraction`; it says
   * only that shutdown had not begun when the event arrived. Everything after it
   * is awaits — a channel fetch, a `git worktree add`, an SDK create, a store
   * write — and a signal landing in any of those gaps used to let the
   * coordinator conclude that nothing was in flight and release the
   * single-instance lock while a `/new` was still creating a worktree.
   *
   * Holding a scope makes the release wait for this operation to settle or roll
   * back, and gives the handler a `lostReason()` to check after each await so it
   * stops rather than finishing into a process that is going away. A decline is
   * synchronous and happens before the body's first instruction, so the
   * interaction is definitely unacknowledged and `reply()` is the right answer.
   *
   * Read-only handlers (`/sessions`, `/diff`, `/todos`, `/usage`, autocomplete)
   * deliberately do NOT go through this: they mutate nothing, so there is
   * nothing for the lock to wait for.
   */
  private async runOwnedCommand(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
    body: (scope: OwnedScope) => Promise<void>
  ): Promise<void> {
    const kind = interaction.isButton() ? "button" : "command";
    const outcome = await this.ownership.runExclusive(
      inboundOperationKey(kind, interaction.id),
      body
    );
    if (!outcome.ran) {
      await interaction.reply(ephemeralReply(INBOUND_DECLINED)).catch(() => {});
    }
  }

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
                  this.phase === "shuttingDown"
                    ? INBOUND_DECLINED
                    : "⏳ 啟動中，請稍候重試；啟動完成後若仍看到「頻道尚未啟用」，再執行 `/channel enable`。"
                )
              )
              .catch(() => {});
          }
          return;
        }
        if (interaction.isRepliable()) {
          // Two different states, two different answers. "啟動中，請稍候重試"
          // tells an operator to wait for something that is coming back; during
          // shutdown nothing is coming back, and retrying is exactly the wrong
          // advice.
          await interaction
            .reply(
              ephemeralReply(
                this.phase === "shuttingDown" ? INBOUND_DECLINED : "⏳ 啟動中，請稍候重試。"
              )
            )
            .catch(() => {});
        }
        return;
      }
      if (interaction.isButton()) {
        await this.runOwnedCommand(interaction, (scope) => this.onButton(interaction, scope));
        return;
      }
      if (interaction.isChatInputCommand()) {
        const c = interaction.commandName;
        const owned = (body: (scope: OwnedScope) => Promise<void>): Promise<void> =>
          this.runOwnedCommand(interaction, body);
        // MUTATING commands run as owned work; read-only ones do not. `/end` is
        // absent from the owned list on purpose: it is a teardown and claims its
        // thread through `runTeardown`, and an exclusive scope around it would
        // deadlock against its own join.
        if (c === "new") await owned((s) => this.cmdNew(interaction, s));
        else if (c === "stop") await owned((s) => this.cmdStop(interaction, s));
        else if (c === "model" || c === "effort" || c === "context")
          await owned((s) => this.cmdReconfigure(interaction, s));
        else if (c === "usage") await this.cmdUsage(interaction);
        else if (c === "approvals") await owned((s) => this.cmdApprovals(interaction, s));
        else if (c === "diff") await this.cmdDiff(interaction);
        else if (c === "file") await owned((s) => this.cmdFile(interaction, s));
        else if (c === "todos") await this.cmdTodos(interaction);
        else if (c === "yolo") await owned((s) => this.cmdYolo(interaction, s));
        else if (c === "rename") await owned((s) => this.cmdRename(interaction, s));
        else if (c === "queue") await owned((s) => this.cmdQueue(interaction, s));
        else if (c === "end") await this.cmdEnd(interaction);
        else if (c === "sessions") await this.cmdSessions(interaction);
        else if (c === "repo") await owned((s) => this.cmdRepo(interaction, s));
        // `/channel` is the ONLY command gated on `isOwner` instead of
        // `isAuthorized` — see cmdChannel.
        else if (c === "channel") await owned((s) => this.cmdChannel(interaction, s));
      }
    } catch (err) {
      console.error("interaction error:", err);
    }
  }

  private async onButton(interaction: ButtonInteraction, scope: OwnedScope): Promise<void> {
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
          // The ack is a network round trip and shutdown can land inside it.
          // Delivering the operator's Allow then would hand the SDK a shell
          // command to start while teardown is walking the sessions — so the
          // same safe default an ack failure produces applies here.
          if (scope.lostReason()) {
            this.transport.deliverDecision(perm.nonce, "deny", uid);
            return;
          }
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
    // Losing ownership across the ack has the same answer as a failed ack: the
    // SAFE default. A choice is left pending and times out to it; a plan is
    // rejected; a rebind is cancelled. None of them may start new work here.
    const settleable = acked && !scope.lostReason();
    if (choice) {
      // ack failure ⇒ leave the ask pending; it times out to the safe default.
      if (settleable) this.transport.deliverChoice(choice.nonce, choice.index, uid);
    } else if (plan) {
      // ack failure ⇒ safe default is reject.
      this.transport.deliverPlan(plan.nonce, settleable ? plan.action : "reject", uid);
    } else if (repo) {
      // Same ack-before-act rule as every other card: an unacknowledged click
      // must not discard a conversation. Settling on the OWNING session's broker
      // (`decisionBindsToChannel` above already proved the click came from it)
      // keeps the exactly-once and generation guarantees.
      const owner = this.sessions.get(interaction.channelId);
      owner?.broker.settle<RebindAction>(repo.nonce, settleable ? repo.action : "cancel");
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

  private async cmdNew(interaction: ChatInputCommandInteraction, scope: OwnedScope): Promise<void> {
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
      await this.createNewSession({
        interaction,
        scope,
        parentChannelId,
        repoPath,
        promptOption: interaction.options.getString("prompt"),
      });
    } finally {
      this.creating = false;
    }
  }

  /** Whether THIS parent channel is still enabled, asked again before the thread
   *  is created and again before the record is reserved.
   *
   *  Everything inside `/new`'s transaction crosses several awaits, and
   *  `/channel disable` can land in any of those gaps: it checks for live
   *  sessions, sees none (this one has no record yet), and revokes. Without the
   *  rechecks this session could be created under a channel the operator had
   *  already revoked and become terminally `blocked` on the next restart.
   *
   *  This deliberately does NOT use the registry's GLOBAL epoch. An enable or
   *  disable for a completely unrelated channel must not abort a valid `/new`,
   *  then falsely tell the operator THIS channel was disabled. The authorization
   *  question is only whether THIS parent is enabled now. */
  private newSessionParentEnabled(parentChannelId: string): boolean {
    return this.channels.has(parentChannelId);
  }

  /**
   * `/new`'s owned transaction, run with the global `creating` single-flight
   * held: parent proof → thread → durable identity → worktree → binding proof
   * and reservation → runtime, promotion and first turn.
   *
   * Each phase answers the operator itself and returns `undefined` when the flow
   * stops, because from the thread onwards stopping means rolling back what that
   * phase owns. Alongside the channel question `newSessionParentEnabled` asks,
   * every phase re-asks `scope.lostReason()` — the same question about the
   * PROCESS. `/new` builds a Discord thread, a git worktree, a root capability,
   * an SDK session and a durable record, and a signal can land in any of those
   * gaps: without it `/new` would finish building all of that into a process
   * that is going away, leaving a thread, a checkout and a `creating` row nobody
   * is left to reconcile.
   */
  private async createNewSession(req: NewSessionRequest): Promise<void> {
    const parent = await this.resolveNewSessionParent(req);
    if (!parent) return;
    const thread = await this.openNewSessionThread(req, parent);
    if (!thread) return;
    // Reserve-before-create (P2): durably record a `creating` row with a
    // caller-assigned session id BEFORE calling createSession, so a crash
    // between the two leaves an identifiable id on disk rather than a live
    // runtime session nobody knows about.
    const identity: NewSessionIdentity = {
      sessionId: randomUUID(),
      generation: this.store.nextGeneration(),
      fileDeliveryBytes: 0,
    };
    const worktree = await this.createNewSessionWorktree(req, thread);
    if (!worktree) return;
    const reservation = await this.reserveNewSession(req, thread, worktree, identity);
    if (!reservation) return;
    await this.startReservedSession(req, thread, worktree, identity, reservation);
  }

  /** Prove the parent channel exists, is visible, is a text channel and is still
   *  enabled. Nothing has been created yet, so every stop path here only has to
   *  answer the deferred reply. */
  private async resolveNewSessionParent(req: NewSessionRequest): Promise<TextChannel | undefined> {
    const { interaction, parentChannelId, scope } = req;
    const parentResult = await fetchChannelSafe(this.discord, parentChannelId);
    if (scope.lostReason()) {
      await interaction.editReply(INBOUND_DECLINED);
      return undefined;
    }
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
      return undefined;
    }
    const parent = parentResult.channel as { type?: number };
    if (!parent || parent.type !== ChannelType.GuildText) {
      await interaction.editReply("Parent channel is not a text channel.");
      return undefined;
    }
    if (!this.newSessionParentEnabled(parentChannelId)) {
      await interaction.editReply(
        `⚠️ <#${parentChannelId}> 在這期間被停用了，沒有建立 session。`
      );
      return undefined;
    }
    return parent as TextChannel;
  }

  /** Create the session's thread and hand back the rollback that undoes it. The
   *  thread is the first thing `/new` leaves behind, so this phase is also where
   *  losing ownership starts costing something. */
  private async openNewSessionThread(
    req: NewSessionRequest,
    parent: TextChannel
  ): Promise<NewSessionThread | undefined> {
    const { interaction, parentChannelId, promptOption, scope } = req;
    // Name the thread from its first prompt when /new already carries one;
    // otherwise a timestamp holds the slot until the first message arrives.
    // No ordinal prefix: Discord orders a channel's threads by creation
    // (verified live 2026-07-28), so a number would only eat sidebar width.
    const stamp = new Date().toISOString().slice(5, 16).replace("T", " ");
    const threadName = (promptOption ? deriveThreadTitle(promptOption) : "") || `copilot ${stamp}`;

    let created;
    try {
      created = await parent.threads.create({
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
      return undefined;
    }
    // Best-effort cleanup of the just-created thread on any abort path below,
    // so a failed /new doesn't litter empty threads.
    const drop = async (): Promise<void> => {
      await (created as unknown as { delete?: () => Promise<unknown> }).delete?.().catch(() => {});
    };
    // The thread exists now, so from here losing ownership must undo it.
    if (scope.lostReason()) {
      await drop();
      await interaction.editReply(INBOUND_DECLINED);
      return undefined;
    }
    return { id: created.id, drop };
  }

  /** Give the session its own git worktree, and build the rollback every later
   *  phase aborts through. */
  private async createNewSessionWorktree(
    req: NewSessionRequest,
    thread: NewSessionThread
  ): Promise<NewSessionWorktree | undefined> {
    const { interaction, repoPath, scope } = req;
    const branch = worktreeBranch(thread.id);
    const requestedWorkDir = worktreePath(this.worktreeRootOf(), repoPath, thread.id);
    let worktreeCreated = false;
    await pruneWorktrees(repoPath);
    try {
      await addWorktree(repoPath, requestedWorkDir, branch);
      worktreeCreated = true;
    } catch (err) {
      await thread.drop();
      await interaction.editReply(
        `⚠️ 無法為這個 session 建立 git worktree（${err instanceof Error ? err.message : String(err)}）。未建立 session。`
      );
      return undefined;
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
      await thread.drop();
      await interaction.editReply(msg);
    };
    // A checkout on disk is the most expensive thing this command creates and
    // the one a shutdown most easily orphans: nothing else can reach it, since
    // `/end` only works on a LIVE session. `abort` is the existing rollback.
    if (scope.lostReason()) {
      await abort(INBOUND_DECLINED);
      return undefined;
    }
    return { branch, workDir: requestedWorkDir, abort };
  }

  /** Capture the root, prove the binding, ask both authorization questions one
   *  last time, and only then write the durable `creating` row.
   *
   *  Kept as ONE phase on purpose: the captured capability is a live OS handle
   *  that this method still owns, so every failure between the capture and a
   *  successful reservation must close it AND abort. Splitting the gates from
   *  the reservation would either duplicate that close or move it away from the
   *  proof it fences. */
  private async reserveNewSession(
    req: NewSessionRequest,
    thread: NewSessionThread,
    worktree: NewSessionWorktree,
    identity: NewSessionIdentity
  ): Promise<NewSessionReservation | undefined> {
    const { interaction, parentChannelId, repoPath, scope } = req;
    // On Windows capture first, then prove the handle-bound validation path.
    // POSIX starts a normal session without a root capability because the SDK
    // only accepts a mutable cwd pathname; it therefore exposes no file tool.
    let captured;
    try {
      captured = await this.captureValidatedRoot({
        repoPath,
        workDir: worktree.workDir,
        devMode: NEW_SESSION_DEV_MODE,
        branch: worktree.branch,
      });
    } catch (err) {
      await worktree.abort(
        `⚠️ 無法安全開啟工作目錄（${err instanceof Error ? err.message : String(err)}）。未建立 session。`
      );
      return undefined;
    }
    if (!captured.ok) {
      await worktree.abort(
        `⚠️ 無法確認工作目錄歸屬（${describeBindingProblem(captured.verdict.problem)}：${captured.verdict.detail}）。未建立 session。`
      );
      return undefined;
    }
    const trustedRoot = captured.trustedRoot;
    const workDir = captured.binding.workDir;
    const approvalKey = captured.approvalKey;

    // LAST authorization check before anything durable exists. The window from
    // the first check to here spans a thread creation, a `git worktree add`
    // and a binding proof — easily seconds — and `/channel disable` cannot see
    // this session until the record below exists. Checking here is what makes
    // "a disabled channel never gains a session" true rather than likely.
    if (!this.newSessionParentEnabled(parentChannelId)) {
      await trustedRoot?.close().catch(() => {});
      await worktree.abort(
        `⚠️ <#${parentChannelId}> 在這期間被停用了，已回復（討論串與 worktree 都已移除）。`
      );
      return undefined;
    }
    // …and the same question about the process, at the same point and with the
    // same rollback. The capture is a real OS handle on Windows; dropping the
    // reference without closing it would keep the root fenced for the rest of
    // the process's life.
    if (scope.lostReason()) {
      await trustedRoot?.close().catch(() => {});
      await worktree.abort(INBOUND_DECLINED);
      return undefined;
    }

    const reserved = this.store.reserve({
      threadId: thread.id,
      sessionId: identity.sessionId,
      generation: identity.generation,
      repoPath,
      guildId: this.config.DISCORD_GUILD_ID,
      parentChannelId,
      workDir,
      devMode: NEW_SESSION_DEV_MODE,
      fileDeliveryBytes: identity.fileDeliveryBytes,
      branch: worktree.branch,
    });
    if (!reserved) {
      await trustedRoot?.close().catch(() => {});
      await worktree.abort(
        "⚠️ 無法持久化 session 狀態（寫入磁碟失敗），未建立新的 session。請檢查磁碟／權限後重試。"
      );
      return undefined;
    }
    return { ...(trustedRoot ? { trustedRoot } : {}), workDir, approvalKey };
  }

  /** Create the runtime against the reservation, promote creating→active,
   *  register the live session and start its first turn.
   *
   *  The runtime EXISTS from the moment `SessionActor.create()` resolves, so
   *  unlike every phase above this one cannot simply return: an unconfirmable
   *  disconnect becomes an OBLIGATION. */
  private async startReservedSession(
    req: NewSessionRequest,
    thread: NewSessionThread,
    worktree: NewSessionWorktree,
    identity: NewSessionIdentity,
    reservation: NewSessionReservation
  ): Promise<void> {
    const { interaction, parentChannelId, promptOption, repoPath, scope } = req;
    const { approvalKey, trustedRoot, workDir } = reservation;
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
        generation: identity.generation,
        createSessionId: identity.sessionId,
        ...this.fileDeliveryQuotaOptions(
          thread.id,
          identity.fileDeliveryBytes,
          identity.sessionId,
          identity.generation
        ),
        ...this.actorSourceOptions(),
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
          identity.sessionId
        ) ?? Promise.resolve()) as Promise<unknown>,
        TEARDOWN_TIMEOUT_MS
      ).catch(() => {});
      // The record stays `creating` (→ orphaned on restart, fail-closed), so
      // keep the worktree: an orphaned row is the operator's to inspect, and
      // deleting the tree would remove the only evidence of what happened.
      await thread.drop();
      await interaction.editReply(
        `⚠️ 建立 session 失敗（${err instanceof Error ? err.message : String(err)}）。請重試 /new。`
      );
      return;
    }
    // Ownership can be lost between the reservation and the runtime, so ask
    // once more before promoting anything to `active`. The runtime EXISTS by
    // now, so this cannot simply return: an unconfirmable disconnect must
    // become an obligation, exactly as it does everywhere else, or the lock
    // would be released over a checkout an SDK session may still be in.
    // The runtime EXISTS from here, so no failure below may simply return.
    // Registered as an OBLIGATION before the attempt — a concurrent `stop()`
    // must see it — and attempted once: a confirmed disconnect discharges it,
    // an unconfirmable one keeps holding the actor, the root capability and
    // the process lock until a later attempt or a restart confirms it.
    //
    // This replaced a `sessions.set()` "fence" on the commit-failure path. A
    // map entry gates nothing: the coordinator cannot see it, so the lock was
    // released over a checkout a live SDK session might still have been in,
    // and it made the live map the only record of a session with no durable
    // row. The obligation carries the actor itself, so there is one place that
    // knows, and it is the place the release conclusion is drawn from.
    const retireCreatedRuntime = async (): Promise<boolean> => {
      const handle = scope.retain(runtimeObligationKey(thread.id), {
        describe: () => `a half-created session runtime for ${thread.id} over ${workDir}`,
        attempt: () => confirmStopped(actor.disconnect(), TEARDOWN_TIMEOUT_MS, () => handle),
      });
      return handle.attempt();
    };
    const RETAINED_RUNTIME_NOTICE =
      "⚠️ 無法確認剛建立的 runtime 已關閉。記錄與 worktree 都已保留，" +
      "bot 也會持續持有單一實例鎖直到確認為止——請重啟 bot。";
    if (scope.lostReason()) {
      if (await retireCreatedRuntime()) {
        // Nothing durable was promoted, the runtime is proved gone, and the
        // reservation stays `creating` — fail-closed, reconciled on the next
        // boot. Keep the worktree with it for the same reason the create
        // failure above does: the row is the operator's only evidence.
        await thread.drop();
        await interaction.editReply(INBOUND_DECLINED);
      } else {
        await interaction.editReply(`${INBOUND_DECLINED}\n${RETAINED_RUNTIME_NOTICE}`);
      }
      return;
    }
    // Promote creating→active. A failed commit means the record isn't durable,
    // so we must NOT run as active — the same situation as above, answered the
    // same way.
    if (!this.store.commit(thread.id)) {
      if (await retireCreatedRuntime()) {
        await worktree.abort(
          "⚠️ 無法持久化 session 狀態（commit 失敗），已取消啟動。請檢查磁碟／權限後重試。"
        );
      } else {
        await interaction.editReply(
          `⚠️ 無法持久化 session 狀態（commit 失敗）。${RETAINED_RUNTIME_NOTICE}`
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
      devMode: NEW_SESSION_DEV_MODE,
      branch: worktree.branch,
      parentChannelId,
      hasRunTurn: false,
    };
    this.sessions.set(thread.id, session);
    const live = this.sessions.size;
    await interaction.editReply(
      `Started a session in <#${thread.id}>. Send prompts there.` +
        (live > 1 ? `（目前有 ${live} 個 session 同時進行）` : "") +
        `\n📁 repo：\`${path.basename(repoPath)}\`` +
        `\n🌿 這個 session 有自己的 git worktree（分支 \`${worktree.branch}\`），與其他 session 的檔案互相隔離。` +
        `\n（想直接在 repo 本體上開發，在該討論串用 \`/repo dev local\`。）`
    );

    if (promptOption) {
      // The reply above is a Discord round trip, and both calls below start
      // BACKGROUND work: `startTitling` creates its own Copilot session, and
      // `runTurn` starts an SDK turn. A signal landing in that gap used to
      // spawn both into a process that was going away — a titler runtime
      // nobody would tear down, and a turn shutdown would abort a moment
      // later. The session itself is already registered and durable, so
      // stopping here leaves nothing half-done: it is simply a session that
      // has not run its first turn, exactly as if the prompt had been sent one
      // instant later.
      if (scope.lostReason()) return;
      // Title this the same way a first thread message is titled — the thread
      // was created with the local heuristic so it is never nameless, and the
      // model's shorter name replaces it a few seconds later.
      this.startTitling(thread.id, session, promptOption);
      void this.runTurn(thread.id, promptOption).catch(() => {});
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
    // retry loop must not treat that as an invitation. The claim is counted by
    // the coordinator, so the stale path below may claim again.
    const outcome = await this.ownership.runTeardown(explicit || interaction.channelId, (scope) =>
      this.cmdEndClaimed(interaction, explicit, scope)
    );
    // Declined ⇒ shutdown began. Answer honestly rather than silently doing
    // nothing: Discord shows an unanswered command as a broken bot.
    if (!outcome.ran) {
      await interaction.reply({
        content: "⚠️ bot 正在關閉中，這次沒有執行。請等它重新啟動後再試。",
        ...EPHEMERAL,
      });
    }
  }

  private async cmdEndClaimed(
    interaction: ChatInputCommandInteraction,
    explicit: string | undefined,
    scope: TeardownScope
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
    // Claim the exact object BEFORE the first await. The rebind transaction can
    // be suspended in git or SDK work while this actor remains in the map;
    // without this fence it could later reserve and install a replacement after
    // `/end`.
    this.endedSessions.add(session);
    // …and claim this thread's rebind state in the same synchronous step: a
    // fallback tracker held only by a target `creating` reservation must flip to
    // removal before any await, and the pre-swap durable companion must be read
    // while it is still unambiguously this session's.
    const rebindEnd = this.rebind.claimEnd(threadId, session);
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
      await rebindEnd.retainUnconfirmed(scope);
      await interaction.editReply(
        "⚠️ 無法確認 runtime 已關閉，這個 session 保留為屏障（不會再接受訊息）。請重啟 bot。"
      );
      return;
    }
    this.sessions.delete(threadId);
    this.approvals.clearSession(threadId);
    this.transport.dispose(threadId);
    // A pre-swap rebind's durable companion, if this thread had one: `/end` must
    // finish THAT rather than treat the mutable main record (which may already
    // be the target reservation) as if it described this old actor.
    const settledOld = await rebindEnd.settlePendingOld();
    if (settledOld) {
      this.releaseRetiredLocalLease(threadId, session.repoPath);
      await interaction.editReply(
        `${settledOld.confirmed && settledOld.cleaned ? "✅" : "⚠️"} 這個 session 已結束。${settledOld.tail}` +
          (settledOld.fallbackPending
            ? "\n⚠️ replacement 的安全屏障仍未能安全對帳；其 actor 擁有權與記錄均已保留，請稍後重試。"
            : "")
      );
      return;
    }
    // A post-swap `/end` owns BOTH the current replacement and every detached
    // old actor for this thread. Joining their teardown before removing the
    // replacement row keeps an unconfirmed old actor's terminal pointer
    // durable, while a confirmed one can release its clean worktree now.
    await this.rebind.settleDetached(threadId);
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
      tail = worktreeOutcomeText(r, workDir, branch);
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
    // instruction rather than from its last, and it is counted, so the outer
    // `cmdEnd` claim is not released by this one.
    const outcome = await this.ownership.runTeardown(threadId, (scope) =>
      this.endStaleRecordClaimed(interaction, threadId, scope)
    );
    if (!outcome.ran) {
      await interaction.reply({
        content: "⚠️ bot 正在關閉中，這次沒有執行。請等它重新啟動後再試。",
        ...EPHEMERAL,
      });
    }
  }

  private async endStaleRecordClaimed(
    interaction: ChatInputCommandInteraction,
    threadId: string,
    scope: TeardownScope
  ): Promise<void> {
    // Defer FIRST. Both waits below are bounded in SECONDS — joining an
    // in-flight resume, then attempting a barrier disconnect — and Discord
    // invalidates an unanswered interaction after 3s, showing "the application
    // did not respond". That reads as a broken bot at exactly the moment this
    // command is being careful on the operator's behalf. Deferring costs
    // nothing: every branch below answers through `editReply`.
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ...EPHEMERAL });
    }
    // Join a resume that was already in flight when the claim landed. It is
    // going to discard itself (its scope reports the claim), and waiting for
    // that means its actor is torn down BEFORE this command starts proving
    // worktrees removable, instead of racing it. Bounded, because a wedged
    // runtime must not make `/end` unusable — and if the bound expires the
    // answer is a refusal, never "carry on as if nothing were running".
    if (!(await scope.joinExclusive(threadId))) {
      await interaction.editReply({
        content:
          "⚠️ 這個討論串正在自動復原中，**還沒結束**，所以不能現在清除（可能會把它正在用的 worktree 抽掉）。請稍後再試一次。",
      });
      return;
    }
    // That discard may not have been confirmable. A worktree must never be
    // deleted out from under a process that might still be writing to it, so
    // one more bounded attempt — and, failing that, the same honest refusal
    // `/end` already gives when a live session's runtime will not confirm.
    const barrier = scope.obligation(runtimeObligationKey(threadId));
    if (barrier && !(await barrier.attempt())) {
      await interaction.editReply({
        content:
          "⚠️ 這個討論串剛才有一次自動復原，但**無法確認該 runtime 已關閉**。記錄與 worktree 都保留（不會被清除），請重啟 bot 後再試。",
      });
      return;
    }
    // A confirmed replacement can still be retained only because its primary
    // fallback CAS/write failed. Do not let a later `/end` with no live map
    // entry reap that barrier: retry the owned actor first and refuse while the
    // conditional reconciliation remains unresolved.
    if (this.rebind.hasUnreconciledFallback(threadId)) {
      await this.rebind.settleDetached(threadId);
      if (this.rebind.hasUnreconciledFallback(threadId)) {
        await interaction.editReply({
          content:
            "⚠️ replacement 的安全屏障仍未能安全對帳；其 actor 擁有權與記錄均已保留，請稍後重試或重啟 bot。",
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
      await this.rebind.settleDetached(threadId);
      if (this.rebind.hasDetachedIncarnations(threadId)) {
        await interaction.editReply({
          content: "⚠️ 舊 runtime 仍未確認停止；其 worktree 記錄已保留，請稍後重試或重啟 bot。",
        });
        return;
      }
      const remaining = this.store.staleRebindsForThread(threadId);
      if (!remaining.length) {
        await interaction.editReply({ content: "✅ 舊 incarnation 已確認清理。" });
        return;
      }
      // Already deferred at the top of this method.
      const outcomes = await this.rebind.reclaimAbandonedRecords(remaining);
      await interaction.editReply(
        outcomes.every((outcome) => outcome.ok)
          ? `✅ 已清除這個討論串的 ${outcomes.length} 個舊 incarnation 記錄。${outcomes.map((o) => o.tail).join("")}`
          : `⚠️ 有舊 incarnation 記錄保留。${outcomes.map((o) => o.tail).join("")}`
      );
      return;
    }
    if (!rec) {
      await interaction.editReply({ content: "這個討論串沒有進行中的 session。" });
      return;
    }
    const disposition = classifyRecordDisposition(rec.state, this.sessions.has(threadId), this.creating);
    if (disposition === "live") {
      // Defensive: the callers check this synchronously first, but falling
      // through to the destructive path if that ever changes would tear down a
      // running session's worktree.
      await interaction.editReply({
        content: "這個討論串仍有進行中的 session，請直接用 `/end`（不加參數）。",
      });
      return;
    }
    if (disposition === "in-flight") {
      await interaction.editReply({
        content: "⏳ 這個討論串的 `/new` 還在建立中，現在清除會把它的 worktree 抽掉。請等它完成後再試。",
      });
      return;
    }
    if (disposition === "retry-pending" && rec.reason !== "thread-no-access") {
      // reconcile kept this record ON PURPOSE after a transient failure. Its
      // sessionId is the only pointer to the Copilot conversation.
      await interaction.editReply({
        content:
          "ℹ️ 這個記錄仍是 `active`：復原時只是暫時失敗，**重新啟動 bot 會再試一次**。\n" +
          "現在清除會永久丟掉這段對話紀錄，所以不做。若確定不要了，重啟後它會變成 `orphaned`／`blocked`，屆時再 `/end`。",
      });
      return;
    }
      // Already deferred at the top of this method.
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
   * The behaviour lives in `platforms/discord/channel-command.ts`; this is only
   * the dependency wiring. What stays true here: it is the ONE command gated on
   * `isOwner` rather than `isAuthorized`, because it must work in a channel that
   * is not enabled yet, or no channel could ever be added. Nothing else may
   * follow it — a button or autocomplete accepted on `isOwner` would let a click
   * from an unrelated channel drive a session.
   */
  private async cmdChannel(interaction: ChatInputCommandInteraction, scope: OwnedScope): Promise<void> {
    await handleChannelCommand(interaction, scope, {
      // The module applies isOwner itself rather than trusting this call site's
      // authorization conclusion.
      authContext: ctxOf(interaction),
      authPolicy: this.policyNow(),
      channels: this.channels,
      sessions: this.sessions,
      // A callback, not a snapshot: the disable check must see the records as
      // they are at the check, not as they were when the interaction arrived.
      records: () => this.store.all(),
      discord: this.discord,
      guildId: this.config.DISCORD_GUILD_ID,
      fileDeliveryAvailable: () => this.fileDeliveryAvailable(),
      inboundDeclined: INBOUND_DECLINED,
      // Through the method, so the ownership suite can keep fault-injecting a
      // shutdown at exactly this seam.
      inspectTarget: (target) => this.inspectChannelTarget(target),
    });
  }

  /** Validate an enable target and report which working permissions the bot is
   *  missing there. A one-line delegate kept as a METHOD on purpose: it is the
   *  long await between "the operator asked" and the durable registry write, and
   *  the ownership suite fault-injects a shutdown at exactly this seam. */
  private inspectChannelTarget(target: string): Promise<ChannelTargetInspection> {
    return inspectChannelEnableTarget(target, {
      discord: this.discord,
      guildId: this.config.DISCORD_GUILD_ID,
      fileDeliveryAvailable: () => this.fileDeliveryAvailable(),
    });
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

  private async cmdRepo(interaction: ChatInputCommandInteraction, scope: OwnedScope): Promise<void> {
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
      await this.cmdProvision(interaction, sub, scope);
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
    kind: "clone" | "new",
    scope: OwnedScope
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
      // A clone can take MINUTES. The repo on disk is harmless and stays, but
      // entering a rebind now would build an SDK session and a worktree into a
      // process that is going away — and `beginRebind`'s own `runTeardown` would
      // decline anyway, leaving the operator a confirmation card that does
      // nothing when clicked.
      if (scope.lostReason()) {
        await interaction.editReply({ content: `${made}\n${INBOUND_DECLINED}`, ...NO_MENTIONS });
        return;
      }
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
    const blocked = await this.rebind.blockers(threadId, session, target);
    if (blocked) {
      await say(blocked);
      return;
    }
    // Nothing to lose ⇒ no confirmation. A session that has never run a turn has
    // no conversation to discard, and making the operator confirm the discarding
    // of nothing is how confirmations stop being read.
    if (!session.hasRunTurn) {
      await say(await this.rebind.apply(threadId, target));
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
      const msg = await this.rebind.apply(threadId, target);
      const current = this.sessions.get(threadId);
      if (this.endedSessions.has(session) || !current || this.endedSessions.has(current)) return;
      await this.transport.notice(threadId, msg).catch(() => {});
    });
    return nonce;
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

  /** Reconcile every persisted session on startup (P2) — a thin delegate to the
   *  reconciliation engine, which owns the pass and every piece of retry state
   *  that follows it. The app has already set `phase` to "reconciling" (input
   *  rejected), so resumed sessions are registered before any /new, and
   *  `deps.classifyThread`/`deps.validateBinding` stay injectable for the suites
   *  that drive the state machine without real repos on disk. */
  private reconcileOnStartup(deps?: ReconcileStartupOverrides): Promise<void> {
    return this.reconciliation.reconcileStartup(deps);
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
    const root = this.worktreeRootOf();
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

  /** Resume the SDK session for an active record — a thin delegate. Several
   *  suites drive this directly after injecting `bindingCheck` or
   *  `captureValidatedRoot` on the app; the engine owns the resume itself, its
   *  ownership fences and everything it persists. */
  private resumeRecord(rec: SessionRecord, opts?: ReconcileAttemptOpts): Promise<void> {
    return this.reconciliation.resumeRecord(rec, opts);
  }

  /** Build the actor a resume needs. Kept here because the actor options (which
   *  `/new` and rebind share), the transport, the approval policy and the
   *  file-delivery quota are all app state; the engine owns WHEN this may be
   *  called and what a failure means. */
  private async resumeActor(rec: SessionRecord, input: ResumeActorInput): Promise<ResumedRuntime> {
    const broker = new PendingInteractionBroker();
    const actor = await SessionActor.create(this.copilot, {
      sessionKey: rec.threadId,
      // Back into the SAME directory this session was created in — resuming a
      // worktree session into another tree would run one thread's conversation
      // against another thread's files.
      ...(input.trustedRoot ? { trustedRoot: input.trustedRoot } : {}),
      workingDirectory: input.workDir,
      approvalKey: input.approvalKey,
      model: this.config.DEFAULT_MODEL,
      contextTier: this.config.DEFAULT_CONTEXT_TIER,
      broker,
      transport: this.transport,
      policy: this.approvals,
      generation: rec.generation,
      resumeSessionId: rec.sessionId,
      ...this.fileDeliveryQuotaOptions(rec.threadId, rec.fileDeliveryBytes, rec.sessionId, rec.generation),
      ...this.actorSourceOptions(),
    });
    return { actor, broker };
  }

  /** Register a resumed runtime as this thread's live session. Synchronous on
   *  purpose: the engine re-proves ownership immediately before calling it, and
   *  an await in between would reopen the very race that check closes. */
  private registerResumedSession(rec: SessionRecord, runtime: ResumedRuntime, workDir: string): void {
    this.sessions.set(rec.threadId, {
      actor: runtime.actor,
      broker: runtime.broker,
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
        : isStrictlyInside(wd, this.worktreeRootOf());
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

  private async cmdStop(interaction: ChatInputCommandInteraction, scope: OwnedScope): Promise<void> {
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
    // `stopSession` is a JSON-RPC round trip. Shutdown may have begun inside it,
    // and shutdown aborts every session anyway — but the answer must not claim
    // a turn was stopped for a session this process no longer owns.
    if (scope.lostReason()) {
      await interaction.editReply({ content: INBOUND_DECLINED }).catch(() => {});
      return;
    }
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
  private async cmdReconfigure(interaction: ChatInputCommandInteraction, scope: OwnedScope): Promise<void> {
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
    // The deferral is a round trip, and `reconfigure` below is an RPC that
    // changes the runtime's model/effort. Neither is worth doing into a process
    // that is going away, and the answer must not claim a change that will be
    // torn down a moment later.
    if (scope.lostReason()) {
      await interaction.editReply(INBOUND_DECLINED).catch(() => {});
      return;
    }
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
  private async cmdYolo(interaction: ChatInputCommandInteraction, scope: OwnedScope): Promise<void> {
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
        // The ack was a round trip. Enabling YOLO removes the last card gate on
        // this session's permissions, so a shutdown in that window must undo it
        // rather than leave the session wide open while teardown runs.
        if (scope.lostReason()) {
          session.actor.setYolo(false);
          return;
        }
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

  private async cmdApprovals(interaction: ChatInputCommandInteraction, scope: OwnedScope): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policyNow())) {
      await this.refuseUnauthorized(interaction);
      return;
    }
    const clear = interaction.options.getBoolean("clear") ?? false;
    // Act on every LIVE session, not just this channel — /approvals is usable
    // from the parent channel, where scoping to the channel silently skipped the
    // in-memory rules while still claiming they were revoked.
    const approvalKeys = approvalScopeKeys(this.sessions.keys());
    const sessionRules = [...new Set(approvalKeys.flatMap((k) => this.approvals.sessionApprovals(k)))];
    // Show the CURRENT thread's repo rules when there is one, else everything.
    const here = this.sessions.get(interaction.channelId);
    const hereKey = here ? await this.displayApprovalKeyFor(here.repoPath) : undefined;
    // `displayApprovalKeyFor` canonicalises a path on disk. Clearing approvals
    // below writes `approvals.json`, and a durable revocation written by a
    // process that is going away would be reported as done here while the reply
    // never reaches the operator.
    if (scope.lostReason()) {
      await interaction.reply(ephemeralReply(INBOUND_DECLINED)).catch(() => {});
      return;
    }
    const repoRules = hereKey
      ? this.approvals.repoApprovals(hereKey)
      : [...new Set(this.approvals.repoKeys().flatMap((k) => this.approvals.repoApprovals(k)))];
    if (clear) {
      for (const key of approvalKeys) this.approvals.clearSession(key);
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

  private async cmdFile(interaction: ChatInputCommandInteraction, scope: OwnedScope): Promise<void> {
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
    // TWO different questions, deliberately not merged.
    //
    // `canSend` is SESSION CURRENTNESS, and it is the only one the transport is
    // given — it re-asks it AFTER Discord has accepted the upload, and answers
    // "no" by RETRACTING the message. That is right for a rebind or an `/end`
    // (the file belongs to a session that no longer exists), and wrong for a
    // shutdown: the operator asked for this file, Discord delivered it, and
    // deleting it because a SIGTERM arrived destroys a deliberate action.
    //
    // Ownership is asked separately, and only BEFORE the send starts.
    const canSend = (): boolean =>
      this.sessions.get(threadId) === session && session.actor.canDeliverFiles();
    const owned = (): boolean => scope.lostReason() === undefined;
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
    // The LAST point at which a shutdown can stop this without destroying
    // anything: nothing has been uploaded yet.
    if (!owned()) {
      await interaction.editReply({ content: INBOUND_DECLINED });
      return;
    }
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
  private async cmdRename(interaction: ChatInputCommandInteraction, scope: OwnedScope): Promise<void> {
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
    // Discord already has the new name; the in-memory title fence below is the
    // only part left, and setting it for a session that is being torn down would
    // just be a write into a map that is about to be cleared.
    if (scope.lostReason()) {
      await interaction.editReply({ content: INBOUND_DECLINED }).catch(() => {});
      return;
    }
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
  private async cmdQueue(interaction: ChatInputCommandInteraction, scope: OwnedScope): Promise<void> {
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
      // The reply is a round trip, and `drainQueue` starts a real SDK turn.
      // Starting one now would be new agent work in a process that is going
      // away; the queue is volatile by design, so dropping THIS prompt is the
      // honest outcome. Remove the exact entry that was appended, by position —
      // filtering on equality also deleted every identical prompt the operator
      // had queued earlier, which is other people's work.
      if (scope.lostReason()) {
        const appended = session.queue.lastIndexOf(text);
        if (appended !== -1) session.queue.splice(appended, 1);
        return;
      }
      void this.drainQueue(interaction.channelId).catch(() => {});
      return;
    }
    await reply(`📥 已排入佇列（第 ${session.queue.length} 位，會在目前回合結束後執行）。`);
  }

  // ---- input surface: thread messages -----------------------------------

  /**
   * Run one inbound message as owned work.
   *
   * A message is the heaviest inbound operation there is: it downloads
   * attachments, retitles the thread and runs a full SDK turn. All of that is
   * awaits, and a signal in any gap used to let the coordinator conclude nothing
   * was in flight. No decline notice: a message that arrives as the bot is
   * stopping gets the same silence a message arriving one instant later does,
   * and posting into a thread during teardown is exactly what shutdown is
   * trying to stop.
   */
  private async runOwnedMessage(message: Message): Promise<void> {
    try {
      const outcome = await this.ownership.runExclusive(
        inboundOperationKey("message", message.id),
        (scope) => this.onMessage(message, scope)
      );
      if (!outcome.ran) {
        console.warn(`message ${message.id} was not handled — ${outcome.reason}`);
      }
    } catch (err) {
      // `onMessage` awaits transport notices and a whole SDK turn, any of which
      // can reject. This is the top of a `void`ed event handler, so an escaping
      // rejection is an unhandled one — which on Node 20+ terminates the
      // process, taking the bot down over a failed Discord write.
      console.error(`message ${message.id} failed:`, err);
    }
  }

  private async onMessage(message: Message, scope: OwnedScope): Promise<void> {
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
    // The gate before ANY new work. It sits above `startTitling` on purpose:
    // titling is fire-and-forget and creates its own Copilot session, so a
    // shutdown landing here used to spawn a runtime nobody would ever tear down
    // and rename a thread for a process that was going away. Starting an SDK
    // turn (which downloads attachments first) is the same bargain a moment
    // later — the operator sees a prompt accepted and then nothing.
    if (scope.lostReason()) return;
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
    // Independently of `stop()` clearing the queues: this is the one place a
    // finished turn starts the NEXT one, and it is reached from a `void`ed
    // continuation that no scope covers. A drain admitted during teardown starts
    // agent work the coordinator is already waiting to put down.
    if (this.shuttingDown || this.phase !== "ready") return;
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
   * Ask for shutdown, and get back the ONE teardown.
   *
   * Single-flight lives in the coordinator now: a second signal, a bootstrap
   * failure racing a signal, or a test calling it twice all join the identical
   * promise. Returning early instead would let a caller believe cleanup had
   * finished while it was still half done — and here "half done" means a live
   * SDK child and an unreleased lock.
   */
  stop(): Promise<void> {
    // Synchronous, before any await: input is rejected and every in-flight scope
    // learns it has lost the thread the instant a caller asks for shutdown.
    this.shuttingDown = true;
    this.phase = "shuttingDown";
    // …and every queued prompt is dropped in the same synchronous step. The
    // coordinator's bounded join waits for an in-flight turn to finish, and the
    // FIRST thing that turn does when it completes is `drainQueue`. A queue left
    // populated therefore started the NEXT prompt during shutdown — new agent
    // work in a process that is going away, and a turn shutdown then aborts.
    // The queue is volatile by design, so dropping it loses nothing durable.
    for (const session of this.sessions.values()) session.queue = [];
    // The armed callback is `teardownResources`, never this method: shutdown
    // CALLS the armed teardown, so arming `stop()` would deadlock its own
    // single-flight.
    return this.ownership.shutdown();
  }

  /**
   * Everything this process must put down, minus the lock.
   *
   * This is what `stop()` arms the coordinator with — never `stop()` itself,
   * which would re-enter the single-flight that is calling it. It deliberately
   * does not release the lock: what it does instead, when it cannot prove an
   * attempt finished, is hand the coordinator an OBLIGATION, and the lock stays
   * held until that obligation is discharged or this process exits.
   */
  private async teardownResources(scope: TeardownScope): Promise<void> {
    // Disarm the loop. Everything else the retry machinery needs at shutdown is
    // the coordinator's job now: it joins the in-flight exclusive scope and
    // sweeps the outstanding obligations BEFORE calling this, and it declines to
    // release while either is unresolved. There is no epoch to bump, no tick
    // promise to race and no barrier map to walk, because there is no longer a
    // second place where any of that is recorded.
    void scope;
    this.reconciliation.disarm();
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
      // Registered BEFORE the attempt, and carrying the actor. An ordinary live
      // session whose disconnect throws or hangs used to be swallowed here: the
      // loop moved on, `sessions.clear()` dropped the last reference to a
      // possibly-live runtime (and, on Windows, its root capability), the armed
      // teardown reported success and the lock was released — handing a
      // successor instance the very checkout that runtime might still be in.
      // Now it gates the release exactly like every other unconfirmed runtime,
      // and only a CONFIRMED disconnect discharges it.
      // First-wins is right about which runtime owns the key and wrong as an
      // answer for the loser: if an older unconfirmed runtime already holds it,
      // `retain` would hand back ITS handle, and attempting that one leaves THIS
      // live actor dropped by `sessions.clear()` below with nobody holding it.
      // The loser gets its own key, so it is disconnected and, failing that,
      // retained and gating like any other.
      const primaryTaken = scope.obligation(runtimeObligationKey(threadId))?.retained === true;
      const key = primaryTaken
        ? this.reconciliation.supersededRuntimeKey(threadId)
        : runtimeObligationKey(threadId);
      const handle = scope.retain(key, {
        describe: () => `a live session runtime for ${threadId} over ${session.workDir}`,
        attempt: () => confirmStopped(session.actor.disconnect(), TEARDOWN_TIMEOUT_MS, () => handle),
      });
      if (!(await handle.attempt())) {
        console.warn(
          `shutdown: could not confirm the runtime for ${threadId} stopped; holding the ` +
            `single-instance lock over ${session.workDir} until it is confirmed or this process exits.`
        );
      }
      this.transport.dispose(threadId);
    }
    this.sessions.clear();
    // Rebind replacements that lost ownership during `/end` are intentionally
    // not in `sessions`, but may still hold a Windows root fence. The rebind
    // coordinator gives each one the same bounded shutdown retry; a failed retry
    // remains retained until process exit rather than being silently dropped.
    await this.rebind.sweepDetachedOnShutdown();
    try {
      this.discord.destroy();
    } catch {
      /* best effort */
    }
    // A REPORTED cleanup failure is a failure. `CopilotClient.stop()` fulfils
    // with the errors it hit, so awaiting it for the side effect let a dirty
    // stop claim success — and the armed teardown's success is exactly what the
    // coordinator's release conclusion is drawn from. The readiness marker is
    // still cleared first: that part did work, and leaving it behind would tell
    // the next start a dead process was ready.
    let clientStopFailure: unknown;
    await stopCopilotClient(this.copilot).catch((err: unknown) => {
      clientStopFailure = err;
    });
    await this.clearStartupReadyOnTeardown().catch(() => {});
    if (clientStopFailure !== undefined) throw clientStopFailure;
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
