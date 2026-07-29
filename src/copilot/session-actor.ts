import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { PendingInteractionBroker } from "../core/broker.js";
import { TurnRenderer } from "../core/turn-render.js";
import type { Decision, Transport } from "../core/transport.js";
import { normalizeSdkEvent } from "./normalize.js";
import { sanitizeForCodeBlock, sanitizeForInlineCode, hasBidiOrControls } from "../core/text-safety.js";
import { ApprovalPolicy, commandExecutable } from "../core/approval-policy.js";

const PERMISSION_TIMEOUT_MS = 5 * 60_000;
const TURN_WATCHDOG_MS = 15 * 60_000;
/** After the watchdog aborts, how long to wait for the real session.idle before
 *  declaring the session faulted and destroying it. */
const FAULT_GRACE_MS = 15_000;
/** Cap on how long the fault-path disconnect may take before we give up on it
 *  (so a hung disconnect RPC can't make a turn hang forever). */
const FAULT_DISCONNECT_MS = 5_000;
/** Max SANITIZED (display) length of a permission summary we will show. The
 *  card lives in a Discord embed description (≤4096). Beyond this we auto-deny
 *  rather than show a partial/undisplayable command. */
const MAX_CARD_LEN = 3900;
/** Debounce window for the signal-only session.todos_changed event: the agent
 *  may write its todos table many times per turn, so we coalesce bursts. */
const TODOS_DEBOUNCE_MS = 700;

/** Safe-default permission result (deny). Used for timeout/abort and for
 *  permission kinds discord-copilot-sdk has no UI for (fail-closed). */
const DENY_UNAVAILABLE = { kind: "user-not-available" } as const;
const DENIED_BY_USER = { kind: "denied-interactively-by-user" } as const;
const APPROVE_ONCE = { kind: "approve-once" } as const;
/** Sentinel settled for an ask_user with no operator answer (timeout/abort/card
 *  failure). The handler throws on it so the ask_user tool FAILS rather than the
 *  agent acting on a fabricated answer. Identity-compared, never returned. */
const NO_ANSWER = Symbol("no-answer");

/** Metadata captured at request time so a later decision can record the right
 *  approval rule. `executable` is the single command's executable (empty when a
 *  wider scope isn't offerable); `canOfferSession` gates the wider buttons. */
interface PendingPermMeta {
  executable: string;
  canOfferSession: boolean;
}

export interface SessionActorOpts {
  sessionKey: string;
  workingDirectory: string;
  /** Identity that "always allow for this repo" rules are stored under. With
   *  per-session worktrees the working directory differs for every session, so
   *  keying approvals on it would silently re-prompt for a command the operator
   *  already trusted in this repository. Defaults to `workingDirectory`. */
  approvalKey?: string;
  model?: string;
  contextTier?: "default" | "long_context";
  broker: PendingInteractionBroker;
  transport: Transport;
  /** discord-copilot-sdk-side approval memory (session + persisted repo rules). */
  policy: ApprovalPolicy;
  /** Session incarnation (P1: always 1; P2 resume will vary this). */
  generation?: number;
  /** P2: resume an existing SDK session by id instead of creating a new one. */
  resumeSessionId?: string;
  /** P2: caller-assigned id for a NEW session (reserve-before-create), so a crash
   *  between reserve and create leaves a resumable/identifiable id on disk. */
  createSessionId?: string;
}

/** A raw-bytes attachment for send() — Discord images become blobs (P5). */
export interface BlobAttachment {
  type: "blob";
  data: string; // base64
  mimeType: string;
  displayName?: string;
}

/**
 * Owns one live Copilot SDK session and bridges it to a chat Transport:
 * SDK events → renderer → transport; the SDK's interactive callbacks →
 * PendingInteractionBroker → transport UI → user decision → back to the SDK.
 *
 * P1 scope: shell permission has real approve/deny UI; every other permission
 * kind and the other callbacks (ask_user / exit-plan / elicitation) fail closed
 * with the safe default so a missing UI can never wedge or silently auto-approve.
 *
 * The ONE deliberate exception is YOLO mode (`setYolo`), an explicit per-session
 * opt-in that auto-approves every PERMISSION request without a card. It never
 * applies to ask_user (which must not fabricate an answer) or exit-plan (which
 * selects control flow, not permission), and the abort guard still wins.
 */
export class SessionActor {
  private session!: CopilotSession;
  private renderer = new TurnRenderer();
  private readonly generation: number;
  /** See `SessionActorOpts.approvalKey`. */
  private get approvalKey(): string {
    return this.opts.approvalKey ?? this.opts.workingDirectory;
  }
  private idleWaiters: Array<() => void> = [];
  /** Actor lifecycle. `faulted`/`closed` are terminal; `closing` means a
   *  disconnect RPC is in flight (not yet confirmed). The actor refuses new
   *  turns once it leaves `active`, so a dead/tearing-down session can never
   *  accept work. */
  private lifecycle: "active" | "closing" | "closed" | "faulted" = "active";
  /** In-flight disconnect (single-flight), so concurrent/retried disconnects
   *  share one RPC instead of re-hitting a possibly-hung endpoint. */
  private disconnectPromise?: Promise<void>;
  /** Per-nonce request metadata for building session/location approvals. */
  private readonly pendingPerms = new Map<string, PendingPermMeta>();
  /** True while a /stop abort is in flight — new permissions fail closed. */
  private aborting = false;
  /** YOLO mode: auto-approve EVERY SDK permission request for this session.
   *  Deliberately actor-local and volatile — it is never persisted, so a crash,
   *  restart or P2 resume always comes back with it OFF (fail-safe). It does NOT
   *  touch the shared ApprovalPolicy, so the executable-rule engine keeps all of
   *  its fail-closed invariants. */
  private yolo = false;
  /** Monotonic toggle counter fencing DEFERRED YOLO enables. `/yolo on` may only
   *  take effect after Discord acknowledges the warning, so a `/yolo off` issued
   *  while that ack is in flight would otherwise be overwritten by the late
   *  enable — leaving the operator looking at an "OFF" confirmation while
   *  permissions are auto-approved. Every toggle bumps this; a deferred enable
   *  applies only if its snapshot is still current. */
  private yoloEpoch = 0;
  /** Serializes YOLO audit notices so they can't interleave/reorder with each
   *  other. Kept OFF the approval path (never awaited there). */
  private auditChain: Promise<void> = Promise.resolve();
  private unsubscribeDecision?: () => void;
  private unsubscribeChoice?: () => void;
  private unsubscribePlan?: () => void;
  /** Per-nonce ask_user metadata (choices for index→answer mapping). */
  private readonly pendingAsk = new Map<string, { choices: string[] }>();
  /** Nonce of an ask_user awaiting a FREEFORM answer via a thread message. */
  private freeformAskNonce?: string;
  /** One interactive request (ask_user / exit_plan) at a time per actor —
   *  overlapping ones fail closed (the single freeform slot can't hold two). */
  private interactiveActive = false;
  /** Live session config (for /model /effort /context + display). */
  private currentModel?: string;
  private currentEffort?: string;
  private currentContext?: "default" | "long_context";
  /** Latest usage snapshot from session.usage_info (for /usage). */
  private lastUsage?: { currentTokens: number; tokenLimit: number };
  /** Debounce timer + last rendered checklist for session.todos_changed (P5). */
  private todosTimer?: ReturnType<typeof setTimeout>;
  private lastTodosRender?: string;
  /** Per-nonce exit-plan metadata (actions for index→action mapping). */
  private readonly pendingPlan = new Map<string, { actions: string[] }>();

  private constructor(private readonly opts: SessionActorOpts) {
    this.generation = opts.generation ?? 1;
    this.currentModel = opts.model;
    this.currentContext = opts.contextTier;
  }

  static async create(client: CopilotClient, opts: SessionActorOpts): Promise<SessionActor> {
    const actor = new SessionActor(opts);
    await actor.init(client);
    return actor;
  }

  private async init(client: CopilotClient): Promise<void> {
    const config: Record<string, unknown> = {
      streaming: true, // required for delta events
      workingDirectory: this.opts.workingDirectory,
      // Defense-in-depth: stop the controlled repo from influencing the agent's
      // trust boundary. enableFileHooks:false is SAFETY-critical — a repo
      // `.github/hooks` permission hook can set resolvedByHook and bypass our
      // Discord approval entirely (SDK session.js short-circuits before
      // onPermissionRequest). Config/skill discovery are disabled for the same
      // reason (a repo shouldn't reconfigure the agent).
      enableFileHooks: false,
      enableConfigDiscovery: false,
      enableSkills: false,
      // enableConfigDiscovery:false is NOT sufficient. The SDK states that
      // "custom instruction files (.github/copilot-instructions.md, AGENTS.md,
      // etc.) are always loaded from the working directory regardless of this
      // setting" (types.d.ts). discord-copilot-sdk points the agent at a repo it does not
      // trust, so a repo shipping an AGENTS.md could otherwise inject standing
      // instructions — the same trust-boundary hole enableFileHooks:false closes
      // for permission hooks.
      skipCustomInstructions: true,
      onPermissionRequest: (req: unknown) => this.handlePermission(req),
      // Interactive UIs (P3): ask_user → choice buttons + freeform; exit-plan →
      // action buttons + reject. Elicitation stays fail-closed (cancel) with a
      // notice until it has its own UI. (onAutoModeSwitchRequest/onMcpAuthRequest
      // are left unset — their SDK defaults are already conservative, MCP off.)
      onUserInputRequest: (req: unknown) => this.handleUserInput(req),
      onExitPlanModeRequest: (req: unknown) => this.handleExitPlan(req),
      onElicitationRequest: async () => {
        await this.opts.transport
          .notice(this.opts.sessionKey, "ℹ️ Cancelled a structured input request (not supported yet).")
          .catch(() => {});
        return { action: "cancel" };
      },
    };
    if (this.opts.model) config["model"] = this.opts.model;
    if (this.opts.contextTier) config["contextTier"] = this.opts.contextTier;

    // The SDK's SessionConfig is a large generic; we pass a validated subset.
    const c = client as unknown as {
      createSession(o: Record<string, unknown>): Promise<CopilotSession>;
      resumeSession(id: string, o: Record<string, unknown>): Promise<CopilotSession>;
    };
    // Create/resume FIRST. If this throws we haven't wired any transport
    // subscriptions yet, so a failed create can't leak decision/choice/plan
    // handlers (the actor is discarded by the caller).
    if (this.opts.resumeSessionId) {
      // Resume preserves conversation history. continuePendingWork:false = treat
      // any tool/permission work that was pending at crash time as INTERRUPTED
      // (no auto-retry of side-effectful work); suppressResumeEvent avoids
      // resume-related side effects on a silent reconnect.
      //
      // model/contextTier are deliberately STRIPPED here: the resumed session
      // already carries whatever the operator selected with /model, /effort and
      // /context before the restart, and re-sending this process's startup
      // defaults would silently downgrade that choice. The real values are read
      // back from the runtime below.
      const { model: _m, contextTier: _c, ...resumeConfig } = config;
      this.session = await c.resumeSession(this.opts.resumeSessionId, {
        ...resumeConfig,
        continuePendingWork: false,
        suppressResumeEvent: true,
      });
      // Keep the constructor's defaults only as a last resort: if the runtime
      // can't tell us, showing the configured default is better than showing
      // nothing (and `reconfigure` needs SOME model to merge onto).
      await this.syncConfigFromRuntime();
    } else {
      // Reserve-before-create uses a caller-assigned id so a crash between the
      // durable reserve and this create leaves an identifiable id on disk.
      if (this.opts.createSessionId) config["sessionId"] = this.opts.createSessionId;
      this.session = await c.createSession(config);
    }
    this.unsubscribeDecision = this.opts.transport.onDecision((nonce, decision) =>
      this.onDecision(nonce, decision)
    );
    this.unsubscribeChoice = this.opts.transport.onChoice((nonce, index) =>
      this.onChoice(nonce, index)
    );
    this.unsubscribePlan = this.opts.transport.onPlan((nonce, action) => this.onPlan(nonce, action));
    this.wireEvents();
  }

  private wireEvents(): void {
    const s = this.session as unknown as {
      on(event: string, handler: (e: unknown) => void): void;
    };
    const handle =
      (type: string) =>
      (e: unknown): void => {
        const norm = normalizeSdkEvent(type, e);
        if (!norm) return;
        this.renderer.apply(norm);
        void this.opts.transport.render(this.opts.sessionKey, this.renderer.state());
      };
    const data = (e: unknown): Record<string, unknown> =>
      (e as { data?: Record<string, unknown> })?.data ?? {};
    const str = (v: unknown): string => (typeof v === "string" ? v : "");

    s.on("assistant.message_delta", handle("assistant.message_delta"));
    s.on("assistant.message", handle("assistant.message"));
    s.on("tool.execution_start", handle("tool.execution_start"));
    s.on("tool.execution_complete", handle("tool.execution_complete"));
    s.on("session.idle", () => {
      this.aborting = false; // a real idle means any in-flight abort has settled
      this.releaseIdleWaiters();
    });
    s.on("session.error", (e) => {
      const d = data(e);
      void this.opts.transport
        .notice(this.opts.sessionKey, `⚠️ ${str(d["message"]) || "session error"}`)
        .catch(() => {});
    });
    s.on("session.usage_info", (e) => {
      const d = data(e);
      const cur = d["currentTokens"];
      const lim = d["tokenLimit"];
      if (typeof cur === "number" && typeof lim === "number") {
        this.lastUsage = { currentTokens: cur, tokenLimit: lim };
      }
    });
    // Signal-only: the agent wrote its todos table. Debounce, fetch, and post a
    // checklist only when the rendered content actually changed (avoid spam).
    s.on("session.todos_changed", () => this.scheduleTodosRefresh());
  }

  private scheduleTodosRefresh(): void {
    if (this.todosTimer) clearTimeout(this.todosTimer);
    this.todosTimer = setTimeout(() => {
      this.todosTimer = undefined;
      // Fire-and-forget: a transient Discord send failure (thread archived, rate
      // limit, network blip) must NOT become an unhandled rejection that crashes
      // the process. refreshTodos swallows its own post failure too (defense in
      // depth); this catch also covers a formatTodos throw.
      void this.refreshTodos().catch(() => {});
    }, TODOS_DEBOUNCE_MS);
  }

  private async refreshTodos(): Promise<void> {
    if (this.lifecycle !== "active") return;
    const rows = await this.readTodos();
    if (this.lifecycle !== "active") return; // may have changed during the async read
    // A FAILED read is not "the list is now empty" — treating it as empty would
    // record an empty render and suppress the next real update.
    if (rows === undefined) return;
    const rendered = formatTodos(rows);
    if (rendered === this.lastTodosRender) return; // no change (also dedupes empty→empty)
    if (!rendered) {
      // Cleared to nothing: record the empty state so a later reappearance of the
      // SAME list posts again (A → empty → A must not be suppressed), but there's
      // nothing to show, so don't post.
      this.lastTodosRender = rendered;
      return;
    }
    try {
      await this.opts.transport.notice(this.opts.sessionKey, rendered);
      // Mark as sent ONLY after a successful post, so a failed send retries on the
      // next event instead of being silently deduped away.
      this.lastTodosRender = rendered;
    } catch {
      /* leave lastTodosRender unchanged so the next todos_changed retries */
    }
  }

  /** Change model / reasoning effort / context tier on the LIVE session (takes
   *  effect next message; history preserved). Any subset may be provided; the
   *  rest keep their current values. `resetEffort` clears effort (e.g. when the
   *  new model doesn't support the current one). */
  async reconfigure(opts: {
    model?: string;
    effort?: string;
    context?: "default" | "long_context";
    resetEffort?: boolean;
  }): Promise<void> {
    if (this.lifecycle !== "active") throw new Error(`session is ${this.lifecycle}`);
    const model = opts.model ?? this.currentModel;
    if (!model) throw new Error("no model set for this session");
    const effort = opts.resetEffort ? undefined : opts.effort ?? this.currentEffort;
    const context = opts.context ?? this.currentContext;
    const s = this.session as unknown as {
      setModel(m: string, o?: { reasoningEffort?: string; contextTier?: string }): Promise<unknown>;
    };
    await s.setModel(model, {
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(context ? { contextTier: context } : {}),
    });
    this.currentModel = model;
    this.currentEffort = effort;
    this.currentContext = context;
  }

  /** Current session config for display (/model /effort /context). Reflects the
   *  last known runtime state — call `syncConfigFromRuntime()` first when the
   *  value is about to be shown to a human. */
  config(): { model?: string; effort?: string; context?: string } {
    return { model: this.currentModel, effort: this.currentEffort, context: this.currentContext };
  }

  /**
   * Replace the cached config with the RUNTIME's own view
   * (`session.rpc.model.getCurrent`, which the SDK documents as restored from
   * the session journal on resume).
   *
   * Two reasons this is not optional:
   * - after a RESUME the cache would otherwise hold this process's startup
   *   defaults, not the model/effort/tier the user actually selected before the
   *   restart;
   * - `/usage` would otherwise report what discord-copilot-sdk *asked for* rather than
   *   what the session is on, which is not evidence of anything.
   *
   * A fresh session legitimately answers `{}` (nothing explicitly selected, so
   * the runtime default applies) — that is not a failure, and it must not wipe a
   * value we set locally in the same process. Never throws: display code must
   * degrade to the cache, not error.
   */
  async syncConfigFromRuntime(): Promise<boolean> {
    try {
      const rpc = (this.session as unknown as {
        rpc?: { model?: { getCurrent?: () => Promise<Record<string, unknown>> } };
      }).rpc;
      const fn = rpc?.model?.getCurrent;
      if (!fn) return false;
      const cur = (await fn.call(rpc!.model)) ?? {};
      const str = (v: unknown): string | undefined =>
        typeof v === "string" && v.length > 0 ? v : undefined;
      const model = str(cur["modelId"]);
      if (!model) return false; // `{}` = nothing selected yet; keep what we know
      this.currentModel = model;
      this.currentEffort = str(cur["reasoningEffort"]);
      const tier = str(cur["contextTier"]);
      this.currentContext = tier === "long_context" || tier === "default" ? tier : undefined;
      return true;
    } catch {
      return false;
    }
  }

  /** Latest token usage snapshot, if any (/usage). */
  usage(): { currentTokens: number; tokenLimit: number } | undefined {
    return this.lastUsage;
  }

  /** Seal the current assistant message before posting an interaction card so
   *  the card appears in chronological order and any output produced AFTER it
   *  (e.g. a tool result once approved) starts in a NEW message below the card
   *  — not edited into the message created before the card. */
  private async beginInteractionCard(): Promise<void> {
    await this.opts.transport.flush(this.opts.sessionKey).catch(() => {});
    this.opts.transport.resetTurn(this.opts.sessionKey);
    this.renderer = new TurnRenderer();
  }

  private async handlePermission(req: unknown): Promise<unknown> {
    const r = (req ?? {}) as Record<string, unknown>;
    const kind = typeof r["kind"] === "string" ? (r["kind"] as string) : "unknown";
    if (this.aborting) return DENY_UNAVAILABLE; // tearing down — fail closed
    // YOLO: blanket approval for this session. Checked SYNCHRONOUSLY right after
    // the abort guard so the decision can't interleave with a concurrent
    // `/yolo off`, and placed before every other gate — the kind/bidi/length
    // gates all exist to protect the human reading the approval card, and under
    // YOLO there is no card. The audit notice is best effort and must never gate
    // the result (a Discord outage may not block tool execution).
    if (this.yolo) {
      // Building the descriptor must never break the approval path (a hostile
      // request object could throw from a property getter), so it is guarded and
      // degrades to a generic entry.
      let detail = `\`${kind}\``;
      try {
        detail = describePermissionTarget(r, kind);
      } catch {
        /* keep the generic fallback */
      }
      this.postAudit(`⚡ YOLO auto-approved — ${detail}`);
      return APPROVE_ONCE;
    }
    if (kind !== "shell") {
      await this.opts.transport.notice(
        this.opts.sessionKey,
        `Auto-denied an unsupported permission (${kind}) — P1 supports shell only.`
      );
      return DENY_UNAVAILABLE;
    }
    const summary = summarizePermission(r);
    if (hasBidiOrControls(summary)) {
      // Bidirectional/control characters have no legitimate use in a shell
      // command and are a spoofing signal (the card would have to strip them,
      // making it differ from what actually runs). Deny outright — never
      // auto-approve a spoofing-laden command even if its executable is trusted.
      await this.opts.transport.notice(
        this.opts.sessionKey,
        "Auto-denied: the command contains bidirectional/control characters (possible spoofing)."
      );
      return DENY_UNAVAILABLE;
    }
    // Executables of every parsed command PLUS the fullCommandText's own first
    // token. For a `simple` command the latter is authoritative, so including it
    // defends against a hypothetical SDK mislabel (commands[] says `git` while
    // fullCommandText is `rm …`): both must be trusted to auto-approve.
    const fullCommandText = typeof r["fullCommandText"] === "string" ? (r["fullCommandText"] as string) : "";
    const cmdExec = commandExecutable(fullCommandText);
    const executables = dedupe(
      [cmdExec, ...extractCommandIdentifiers(r).map(commandExecutable)].filter((e) => e.length > 0)
    );
    // A command is eligible for auto-approve / a wider scope only when it is a
    // SIMPLE command (no shell metacharacters that could chain/pipe/redirect/
    // substitute a different command) AND every executable is a safe, specific
    // name (not a shell/runtime/wrapper/exec-launcher). This keeps discord-copilot-sdk
    // from trusting the runtime's command parse blindly.
    const simple = isSimpleCommand(fullCommandText);
    const allSafe = executables.length > 0 && executables.every(isSafeExecutable);
    if (simple && allSafe && this.opts.policy.isApproved(this.opts.sessionKey, this.approvalKey, executables)) {
      await this.opts.transport.notice(
        this.opts.sessionKey,
        `✓ Auto-approved (existing rule): ${executables.map((e) => `\`${e}\``).join(", ")}`
      );
      return APPROVE_ONCE;
    }
    if (sanitizeForCodeBlock(summary).length > MAX_CARD_LEN) {
      // Gate on the SANITIZED (display) length: escaping can expand the text,
      // and a card we can't render in full could hide a dangerous suffix.
      await this.opts.transport.notice(
        this.opts.sessionKey,
        "Auto-denied a shell command too long to display in full for approval. " +
          "Run it from a terminal if intended."
      );
      return DENY_UNAVAILABLE;
    }
    // Offer session/always only for a SINGLE, simple, safe command whose sole
    // executable is the fullCommandText's own — chained/multi-command requests,
    // shells, runtimes and launchers stay per-request.
    const canOfferSession =
      simple && executables.length === 1 && cmdExec !== "" && isSafeExecutable(cmdExec);
    const singleExec = canOfferSession ? cmdExec : "";
    const { nonce, promise } = this.opts.broker.register<unknown>({
      sessionKey: this.opts.sessionKey,
      generation: this.generation,
      kind,
      timeoutMs: PERMISSION_TIMEOUT_MS,
      onDefault: () => DENY_UNAVAILABLE,
    });
    this.pendingPerms.set(nonce, { executable: singleExec, canOfferSession });
    try {
      try {
        await this.beginInteractionCard();
        await this.opts.transport.showPermission({
          nonce,
          sessionKey: this.opts.sessionKey,
          kind,
          summary,
          supported: true,
          canOfferSession,
          scopeCommands: canOfferSession ? [singleExec] : executables,
        });
      } catch {
        // Couldn't post the card (e.g. embed rejected) — settle deny now rather
        // than leave the SDK callback pending until the broker timeout. Guard
        // the notice so a second failure can't skip the finally cleanup below.
        this.opts.broker.settle(nonce, DENY_UNAVAILABLE, this.generation);
        await this.opts.transport
          .notice(this.opts.sessionKey, "Auto-denied: could not render the approval card.")
          .catch(() => {});
      }
      return await promise;
    } finally {
      this.pendingPerms.delete(nonce);
    }
  }

  private onDecision(nonce: string, decision: Decision): void {
    this.opts.broker.settle(nonce, this.buildDecision(nonce, decision), this.generation);
  }

  /** Map a UI decision to the SDK response, recording discord-copilot-sdk-side approval
   *  rules for the wider scopes. The SDK's native session/location approval is
   *  not honored in this CLI setup (verified), so session/always store a
   *  discord-copilot-sdk rule and return approve-once; future matching commands are
   *  auto-approved before a card is shown. Fail-closed: a wider decision the
   *  request didn't authorize denies. */
  private buildDecision(nonce: string, decision: Decision): unknown {
    if (decision === "deny") return DENIED_BY_USER;
    if (decision === "once") return APPROVE_ONCE;
    const meta = this.pendingPerms.get(nonce);
    if (!meta || !meta.canOfferSession || !meta.executable) return DENIED_BY_USER;
    if (decision === "session") {
      this.opts.policy.approveForSession(this.opts.sessionKey, meta.executable);
      return APPROVE_ONCE;
    }
    // decision === "always"
    const durable = this.opts.policy.approveForRepo(this.approvalKey, meta.executable);
    if (!durable) {
      // The rule is live for THIS process but did not reach disk. Say so:
      // "Always (this repo)" promises it survives a restart.
      this.postAudit(
        `⚠️ 「Always」規則 \`${sanitizeForInlineCode(meta.executable, YOLO_TARGET_MAX)}\` 寫入磁碟失敗 — ` +
          "本次執行仍有效，但重啟後會消失。請檢查 `~/.discord-copilot-sdk` 的權限。"
      );
    }
    return APPROVE_ONCE;
  }

  // ---- ask_user (P3) ----------------------------------------------------

  private async handleUserInput(req: unknown): Promise<unknown> {
    const r = (req ?? {}) as Record<string, unknown>;
    const question = typeof r["question"] === "string" ? (r["question"] as string) : "Copilot needs your input.";
    const choices = Array.isArray(r["choices"])
      ? (r["choices"] as unknown[]).filter((c): c is string => typeof c === "string")
      : [];
    const allowFreeform = r["allowFreeform"] !== false; // default true
    // Fail closed while aborting or when another interactive request is already
    // in flight (freeformAskNonce is a single slot; overlapping asks are unsafe).
    if (this.aborting || this.interactiveActive) {
      throw new Error("ask_user is not available right now (session busy/aborting).");
    }
    this.interactiveActive = true;
    const { nonce, promise } = this.opts.broker.register<unknown>({
      sessionKey: this.opts.sessionKey,
      generation: this.generation,
      kind: "ask_user",
      timeoutMs: PERMISSION_TIMEOUT_MS,
      onDefault: () => NO_ANSWER, // timeout/abort ⇒ the ask_user tool fails (below)
    });
    this.pendingAsk.set(nonce, { choices });
    try {
      let posted = false;
      try {
        await this.beginInteractionCard();
        await this.opts.transport.showUserInput({
          nonce,
          sessionKey: this.opts.sessionKey,
          question,
          choices,
          allowFreeform,
        });
        posted = true;
      } catch {
        this.opts.broker.settle(nonce, NO_ANSWER, this.generation);
      }
      // Arm freeform ONLY after the card is actually published, so a message
      // sent before the card can't settle an unseen question.
      if (posted && allowFreeform) this.freeformAskNonce = nonce;
      const result = await promise;
      if (result === NO_ANSWER) {
        // No operator answer (timeout/abort/card-failure). Fail the ask_user
        // tool rather than fabricating an answer the agent would act on.
        throw new Error("ask_user: no response from the operator.");
      }
      return result;
    } finally {
      this.pendingAsk.delete(nonce);
      if (this.freeformAskNonce === nonce) this.freeformAskNonce = undefined;
      this.interactiveActive = false;
    }
  }

  private onChoice(nonce: string, index: number): void {
    const meta = this.pendingAsk.get(nonce);
    if (!meta || index < 0 || index >= meta.choices.length) return;
    this.opts.broker.settle(nonce, { answer: meta.choices[index]!, wasFreeform: false }, this.generation);
  }

  /** Consume a thread message as the freeform answer to a pending ask_user, if
   *  one is awaiting freeform. Returns true if the message was consumed. */
  tryConsumeFreeform(text: string): boolean {
    const nonce = this.freeformAskNonce;
    if (!nonce) return false;
    const settled = this.opts.broker.settle(
      nonce,
      { answer: text, wasFreeform: true },
      this.generation
    );
    if (settled) this.freeformAskNonce = undefined;
    return settled;
  }

  /** True when a freeform ask_user is awaiting a TEXT answer via a thread
   *  message. Used to reject image-only messages that can't answer the ask. */
  isAwaitingFreeform(): boolean {
    return this.freeformAskNonce !== undefined;
  }

  // ---- exit-plan (P3) ---------------------------------------------------

  private async handleExitPlan(req: unknown): Promise<unknown> {
    const r = (req ?? {}) as Record<string, unknown>;
    const summary = typeof r["summary"] === "string" ? (r["summary"] as string) : "Copilot proposes to proceed.";
    const planContent = typeof r["planContent"] === "string" ? (r["planContent"] as string) : undefined;
    const actions = Array.isArray(r["actions"])
      ? (r["actions"] as unknown[]).filter((a): a is string => typeof a === "string")
      : [];
    const recommendedAction =
      typeof r["recommendedAction"] === "string" ? (r["recommendedAction"] as string) : actions[0] ?? "";
    const declined = { approved: false, feedback: "Not approved." };
    if (this.aborting || this.interactiveActive) return declined; // fail closed
    this.interactiveActive = true;
    const { nonce, promise } = this.opts.broker.register<unknown>({
      sessionKey: this.opts.sessionKey,
      generation: this.generation,
      kind: "exit_plan",
      timeoutMs: PERMISSION_TIMEOUT_MS,
      onDefault: () => ({ approved: false, feedback: "No response from the operator." }),
    });
    this.pendingPlan.set(nonce, { actions });
    try {
      try {
        await this.beginInteractionCard();
        await this.opts.transport.showPlan({
          nonce,
          sessionKey: this.opts.sessionKey,
          summary,
          actions,
          recommendedAction,
          ...(planContent ? { planContent } : {}),
        });
      } catch {
        // Couldn't fully publish the plan (e.g. a chunk failed to post) — do not
        // let the operator approve a plan they can't see. Settle as not approved.
        this.opts.broker.settle(
          nonce,
          { approved: false, feedback: "Could not present the full plan." },
          this.generation
        );
      }
      return await promise;
    } finally {
      this.pendingPlan.delete(nonce);
      this.interactiveActive = false;
    }
  }

  private onPlan(nonce: string, action: number | "reject"): void {
    if (action === "reject") {
      this.opts.broker.settle(nonce, { approved: false, feedback: "Rejected via Discord." }, this.generation);
      return;
    }
    const meta = this.pendingPlan.get(nonce);
    if (!meta || action < 0 || action >= meta.actions.length) return; // invalid index → stays pending
    this.opts.broker.settle(
      nonce,
      { approved: true, selectedAction: meta.actions[action]! },
      this.generation
    );
  }

  /** Send a user prompt (with optional blob attachments, e.g. images from
   *  Discord), starting a fresh turn's render state. Rejects once the actor is
   *  closed/faulted so a dead session can't accept new work. */
  async send(prompt: string, attachments: BlobAttachment[] = []): Promise<void> {
    if (this.lifecycle !== "active") {
      throw new Error(`session is ${this.lifecycle} and cannot accept new prompts`);
    }
    // A new user-initiated turn is the boundary at which any earlier abort stops
    // applying. This is NOT belt-and-braces: probing the runtime (2026-07-28)
    // showed abort() with no turn in flight resolves successfully but emits no
    // `session.idle`, and `session.idle` is the only other thing that clears the
    // flag. Without this reset a stray /stop on an idle session silently
    // auto-denies EVERY permission of the next turn with no card and no notice.
    this.aborting = false;
    this.renderer = new TurnRenderer();
    const payload: Record<string, unknown> = { prompt };
    if (attachments.length) payload["attachments"] = attachments;
    await (this.session as unknown as { send(o: Record<string, unknown>): Promise<unknown> }).send(payload);
  }

  /**
   * Inject a prompt into the turn that is ALREADY running ("steer").
   *
   * Uses the runtime's `mode: "immediate"` delivery. Measured behaviour
   * (2026-07-28, probes):
   * - during a TOOL LOOP it lands at the next tool boundary and genuinely
   *   redirects the agent (a run of 8 sequential commands stopped after 4);
   * - during a single long generation it does NOT interrupt — it runs straight
   *   after, which is the best achievable without discarding in-flight work;
   * - it jumps ahead of anything already queued in the runtime;
   * - the whole busy period still emits exactly ONE `session.idle`, so the
   *   original `runTurn` keeps waiting and no second turn must be started.
   *
   * Unlike `send()` this must NOT clear `aborting`: a steer racing a `/stop`
   * has to lose. It also seals the current render block so the agent's output
   * after the steer starts a NEW message below the user's, instead of being
   * edited into the message that was already in flight.
   */
  async steer(prompt: string, attachments: BlobAttachment[] = []): Promise<void> {
    if (this.lifecycle !== "active") {
      throw new Error(`session is ${this.lifecycle} and cannot accept new prompts`);
    }
    if (this.aborting) throw new Error("session is aborting; steering is not available");
    await this.beginInteractionCard(); // flush + reset the render block
    const payload: Record<string, unknown> = { prompt, mode: "immediate" };
    if (attachments.length) payload["attachments"] = attachments;
    await (this.session as unknown as { send(o: Record<string, unknown>): Promise<unknown> }).send(payload);
    this.refreshWatchdog();
  }

  /** Read the agent's current todos. Returns `undefined` when the read FAILED
   *  (RPC error / namespace absent), which the caller must not present as "no
   *  todos" — an empty list and a broken read are different answers, and quietly
   *  showing "目前沒有待辦事項" for a failure hides a real problem. An empty array
   *  means genuinely none. The plan RPC namespace lives at `session.rpc.plan`
   *  (NOT `session.plan`). */
  async readTodos(): Promise<Array<{ id?: string; title?: string; status?: string }> | undefined> {
    try {
      const rpc = (this.session as unknown as {
        rpc?: { plan?: { readSqlTodosWithDependencies?: () => Promise<{ rows?: unknown[] }> } };
      }).rpc;
      const fn = rpc?.plan?.readSqlTodosWithDependencies;
      if (!fn) return undefined; // no plan namespace: a read we could not perform
      const res = await fn.call(rpc!.plan);
      const rows = res?.rows;
      return Array.isArray(rows) ? (rows as Array<{ id?: string; title?: string; status?: string }>) : [];
    } catch {
      return undefined;
    }
  }

  /** True once the actor has faulted (needs a fresh /new; can't be reused). */
  isFaulted(): boolean {
    return this.lifecycle === "faulted";
  }

  /** The underlying SDK session id (stable across resume) — persisted by the app
   *  so a restart can resume this exact session. */
  get sessionId(): string {
    return (this.session as unknown as { sessionId: string }).sessionId;
  }

  private clearTodosTimer(): void {
    if (this.todosTimer) {
      clearTimeout(this.todosTimer);
      this.todosTimer = undefined;
    }
  }

  /**
   * Run one prompt to completion. The idle waiter is armed BEFORE `send` so a
   * fast `session.idle` cannot be missed (lost-wakeup). Completion is driven by
   * the real `session.idle` event. If a turn runs past `watchdogMs`, the
   * watchdog ABORTS it (which makes the session go idle → normal completion,
   * reported as a timeout). If even the abort doesn't yield idle within a grace
   * window, the session is destroyed (faulted) so it is never reused mid-turn.
   */
  async runTurn(prompt: string, watchdogMs = TURN_WATCHDOG_MS, attachments: BlobAttachment[] = []): Promise<void> {
    const idle = this.nextIdle();
    await this.send(prompt, attachments);
    const outcome = await this.awaitTurnEnd(idle, watchdogMs);
    if (outcome === "watchdog") {
      await this.opts.transport.notice(
        this.opts.sessionKey,
        "⏱️ Turn exceeded the time limit and was aborted."
      );
    } else if (outcome === "faulted") {
      await this.opts.transport.notice(
        this.opts.sessionKey,
        "⚠️ Turn did not stop cleanly; the session was reset. Start a new one with /new."
      );
    }
  }

  /** Resolve when the turn truly ends. Order of finalization:
   *  - real `session.idle` → "idle" (or "watchdog" if the watchdog aborted it);
   *  - abort didn't produce idle within the grace window → "faulted" (session
   *    destroyed). Never fabricates idle. */
  private awaitTurnEnd(
    idle: Promise<void>,
    watchdogMs: number
  ): Promise<"idle" | "watchdog" | "faulted"> {
    return new Promise((resolve) => {
      let settled = false;
      let watchdogFired = false;
      let wd: ReturnType<typeof setTimeout>;
      let hard: ReturnType<typeof setTimeout>;
      const done = (r: "idle" | "watchdog" | "faulted"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(wd);
        clearTimeout(hard);
        this.refreshWatchdog = () => {};
        resolve(r);
      };
      void idle.then(() => done(watchdogFired ? "watchdog" : "idle"));
      const arm = (): void => {
        wd = setTimeout(() => {
          watchdogFired = true;
          void this.stop(); // abort; expect session.idle to follow
        }, watchdogMs);
        hard = setTimeout(() => {
          // Permanently fault the actor (it will refuse new turns) and best-effort
          // destroy the runtime session, but never let a hung disconnect RPC keep
          // the turn pending — cap it and resolve "faulted" regardless.
          void this.markFaulted().finally(() => done("faulted"));
        }, watchdogMs + FAULT_GRACE_MS);
        (wd as { unref?: () => void }).unref?.();
        (hard as { unref?: () => void }).unref?.();
      };
      // A steer extends the same busy period (the runtime emits ONE idle for all
      // of it), so without restarting the clock a prompt injected late in a long
      // turn could be killed by a watchdog that started before the user asked
      // for it. Cleared on settle by `done`.
      this.refreshWatchdog = () => {
        if (settled) return;
        clearTimeout(wd);
        clearTimeout(hard);
        arm();
      };
      arm();
    });
  }

  /** Restart the running turn's watchdog, if there is one. Replaced for the
   *  lifetime of each `awaitTurnEnd`; a no-op when no turn is in flight. */
  private refreshWatchdog: () => void = () => {};

  /** A promise that resolves the next time the session goes idle. */
  private nextIdle(): Promise<void> {
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /** Abort the current turn and settle any pending prompts (deny). New
   *  permissions fail closed until either the real `session.idle` arrives or the
   *  user starts the next turn (`send()` clears the flag) — the runtime does NOT
   *  emit `session.idle` when there was no turn to abort, so without that second
   *  release a stray /stop would latch fail-closed forever. Returns whether the
   *  abort call itself succeeded. */
  async stop(): Promise<boolean> {
    this.aborting = true;
    this.opts.broker.abortSession(this.opts.sessionKey);
    const s = this.session as unknown as { abort?: () => Promise<unknown> };
    try {
      await s.abort?.();
      return true;
    } catch {
      return false;
    }
  }

  /** Enable/disable YOLO (blanket permission approval) for THIS session only.
   *  Volatile by design — see the `yolo` field. Every call bumps the toggle
   *  epoch, which invalidates any deferred enable still awaiting its ack. */
  setYolo(on: boolean): void {
    this.yoloEpoch++;
    this.yolo = on;
  }

  /** Whether YOLO is currently on for this session. */
  isYolo(): boolean {
    return this.yolo;
  }

  /** Snapshot of the toggle epoch, taken BEFORE awaiting a Discord ack. */
  yoloEpochValue(): number {
    return this.yoloEpoch;
  }

  /** Apply a deferred enable, but ONLY if no other toggle happened since
   *  `epoch`. Returns whether it was applied (false ⇒ superseded, stays as-is). */
  enableYoloIfCurrent(epoch: number): boolean {
    if (epoch !== this.yoloEpoch) return false;
    this.yolo = true;
    return true;
  }

  /** Queue an out-of-band audit/warning notice (YOLO auto-approvals, a
   *  non-durable "Always" rule). Fire-and-forget for the caller (never awaited
   *  on the approval path, so a Discord outage cannot gate tool execution) but
   *  serialized per session so entries stay in order. */
  private postAudit(text: string): void {
    this.auditChain = this.auditChain
      .then(() => this.opts.transport.notice(this.opts.sessionKey, text))
      .then(
        () => {},
        () => {}
      );
  }

  state() {
    return this.renderer.state();
  }

  async disconnect(): Promise<void> {
    if (this.lifecycle === "closed") return; // confirmed torn down — no-op
    if (this.lifecycle === "faulted") {
      // A prior teardown failed: never report success (which would let /new
      // delete the fence over a maybe-live runtime). Stay a fence.
      throw new Error("session has faulted; disconnect cannot be confirmed");
    }
    if (this.disconnectPromise) return this.disconnectPromise; // single-flight
    this.lifecycle = "closing";
    this.aborting = true;
    this.opts.broker.abortSession(this.opts.sessionKey);
    this.opts.policy.clearSession(this.opts.sessionKey);
    this.unsubscribeDecision?.();
    this.unsubscribeChoice?.();
    this.unsubscribePlan?.();
    this.clearTodosTimer();
    // Transition to `closed` ONLY after the RPC confirms; on failure become a
    // permanent fault fence and rethrow, so a retry can't masquerade as success.
    this.disconnectPromise = this.session.disconnect().then(
      () => {
        this.lifecycle = "closed";
        // Release anyone waiting for a `session.idle` that can no longer arrive
        // (e.g. /new tore this session down mid-turn). Without this the old
        // runTurn sits until its watchdog fires and then posts a bogus
        // "did not stop cleanly" notice into a thread the user has left.
        this.releaseIdleWaiters();
      },
      (err) => {
        this.lifecycle = "faulted";
        this.disconnectPromise = undefined;
        this.releaseIdleWaiters();
        throw err;
      }
    );
    return this.disconnectPromise;
  }

  /** Resolve every pending `nextIdle()` waiter. Used on teardown, where the
   *  runtime will never emit another `session.idle`. */
  private releaseIdleWaiters(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /** Terminal fault path: mark the actor faulted (rejects further turns) and
   *  best-effort destroy the runtime session, bounded so a hung disconnect RPC
   *  can't stall the caller. */
  private async markFaulted(): Promise<void> {
    if (this.lifecycle !== "active") return;
    this.lifecycle = "faulted";
    this.aborting = true;
    this.opts.broker.abortSession(this.opts.sessionKey);
    this.opts.policy.clearSession(this.opts.sessionKey);
    this.unsubscribeDecision?.();
    this.unsubscribeChoice?.();
    this.unsubscribePlan?.();
    this.clearTodosTimer();
    const timeout = new Promise<void>((res) => {
      const t = setTimeout(res, FAULT_DISCONNECT_MS);
      (t as { unref?: () => void }).unref?.();
    });
    await Promise.race([
      (this.session.disconnect() as Promise<unknown>).catch(() => {}),
      timeout,
    ]);
  }
}

/** Render the agent's todos as a compact Discord checklist. Returns "" when
 *  there are no titled todos (so callers can skip posting). Status maps to an
 *  icon; unknown statuses fall back to a pending box. Order is preserved. */
export function formatTodos(
  rows: Array<{ id?: string; title?: string; status?: string }>
): string {
  const items = rows
    .map((r) => {
      const title = typeof r.title === "string" ? r.title.trim() : "";
      if (!title) return undefined;
      const status = (typeof r.status === "string" ? r.status : "").trim().toLowerCase();
      const icon =
        status === "done" || status === "completed" || status === "complete"
          ? "✅"
          : status === "in_progress" || status === "in-progress" || status === "active" || status === "running"
            ? "🔄"
            : status === "blocked" || status === "cancelled" || status === "canceled"
              ? "🚫"
              : "⬜";
      return `${icon} ${title}`;
    })
    .filter((s): s is string => s !== undefined);
  if (items.length === 0) return "";
  const done = items.filter((s) => s.startsWith("✅")).length;
  return `📋 **待辦進度** (${done}/${items.length})\n${items.join("\n")}`;
}

/** Executables that must NEVER get a session/repo "always" scope, because
 *  approving them would auto-run essentially arbitrary code: generic shells,
 *  language runtimes that execute arbitrary programs, and wrappers/dispatchers
 *  that launch OTHER commands. These stay per-request. */
const UNSAFE_EXECUTABLES = new Set([
  // shells / interpreters
  "powershell", "powershell.exe", "pwsh", "pwsh.exe", "cmd", "cmd.exe",
  "bash", "sh", "zsh", "dash", "ksh", "fish", "wsl", "wsl.exe",
  // language runtimes (run arbitrary code)
  "python", "python3", "py", "node", "nodejs", "ruby", "perl", "php", "deno", "bun",
  // wrappers / dispatchers + exec-launchers (launch other commands, often with
  // metacharacter-free payloads: find -exec, ssh ProxyCommand, tar --to-command)
  "env", "sudo", "doas", "su", "npx", "xargs", "nice", "timeout", "watch",
  "time", "nohup", "command", "exec", "eval", "start", "call",
  "find", "ssh", "scp", "sftp", "rsync", "tar", "docker", "podman", "awk", "cmake",
]);

function isUnsafeExecutable(exe: string): boolean {
  return UNSAFE_EXECUTABLES.has(exe.trim().toLowerCase());
}

/** A safe, specific executable name we may offer a wider scope for: a bare
 *  identifier (no path separators, quotes or spaces) that isn't a shell/runtime/
 *  wrapper. Rejects mis-derived tokens like `"C:\Program` (path with space). */
function isSafeExecutable(exe: string): boolean {
  return /^[A-Za-z0-9._+-]+$/.test(exe) && !isUnsafeExecutable(exe);
}

/** A command is "simple" (safe to auto-approve / offer a wider scope for) only
 *  if it has NO shell metacharacters that could chain, pipe, redirect, or
 *  substitute a DIFFERENT command in — since discord-copilot-sdk trusts the runtime's
 *  `commands[]` parse and a false negative there would run untrusted code. When
 *  any of these appear, the request always shows a per-request card instead. */
function isSimpleCommand(fullCommandText: string): boolean {
  return fullCommandText.length > 0 && !/[;&|<>`$()\r\n]/.test(fullCommandText);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** Max length of the target shown in a YOLO audit notice. */
const YOLO_TARGET_MAX = 200;
/** Max length of the permission KIND shown in a YOLO audit notice (the SDK could
 *  introduce a long or hostile kind string; it is untrusted input like any other). */
const YOLO_KIND_MAX = 40;

/**
 * A SHORT, bounded, sanitized descriptor of what a permission request targets,
 * for the YOLO audit notice. Deliberately generic (YOLO covers every permission
 * kind, including ones added by future SDK versions) and deliberately NOT a dump
 * of the request: payload-bearing fields (file contents, diffs, MCP arguments,
 * memory facts) may be huge or sensitive, so only identifying fields are shown.
 *
 * Under YOLO this notice is the ONLY record of what was auto-approved, and both
 * `kind` and the target are attacker-influenceable (a filename or command the
 * model was steered into producing). Both are therefore sanitized for INLINE
 * code — a stray backtick would close the span and let the rest render as
 * markdown, which could forge a convincing fake audit line.
 */
function describePermissionTarget(r: Record<string, unknown>, kind: string): string {
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = r[k];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    return "";
  };
  const safeKind = sanitizeForInlineCode(kind, YOLO_KIND_MAX) || "unknown";
  // Field names verified against a live runtime probe (2026-07-28):
  //   shell → fullCommandText | write → fileName (NOT `path`)
  // The legacy `path`/`filePath`/`file` keys are kept as a tail fallback for
  // kinds we have not probed, but `fileName` must come first or every write
  // audit degrades to a bare `write` with no record of WHAT was written.
  const target =
    kind === "shell"
      ? pick("fullCommandText", "command")
      : pick("fileName", "path", "filePath", "file", "url", "uri", "tool", "toolName", "server", "name");
  if (!target) return `\`${safeKind}\``;
  return `\`${safeKind}\`: \`${sanitizeForInlineCode(target, YOLO_TARGET_MAX)}\``;
}

/** Pull parsed command identifiers (e.g. ["git"]) from a shell permission
 *  request, used to scope session/location approvals. */
function extractCommandIdentifiers(r: Record<string, unknown>): string[] {
  const cmds = r["commands"];
  if (!Array.isArray(cmds)) return [];
  const ids = cmds
    .map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>)["identifier"] : undefined))
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  return [...new Set(ids)];
}

/**
 * Build the COMPLETE human-readable request summary for a shell permission
 * card. Surfaces every risk-relevant structured field the SDK provides
 * (PermissionRequestShell) so the operator approves what will actually run —
 * intention, full command, warnings, sandbox-bypass request, write
 * redirection, and touched paths. The "SANDBOX BYPASS" marker is detected by
 * the transport to escalate the card's styling.
 */
function summarizePermission(r: Record<string, unknown>): string {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const parts: string[] = [];
  const intention = str(r["intention"]);
  if (intention) parts.push(`intent: ${intention}`);
  const cmd = str(r["fullCommandText"]);
  if (cmd) parts.push(`$ ${cmd}`);
  const warning = str(r["warning"]);
  if (warning) parts.push(`⚠️ WARNING: ${warning}`);
  if (r["requestSandboxBypass"] === true) {
    const reason = str(r["requestSandboxBypassReason"]);
    parts.push(`⚠️ SANDBOX BYPASS requested${reason ? `: ${reason}` : ""}`);
  }
  if (r["hasWriteFileRedirection"] === true) parts.push("• writes files via redirection (>)");
  const strList = (key: string): string[] =>
    (Array.isArray(r[key]) ? (r[key] as unknown[]) : []).filter((p): p is string => typeof p === "string");
  const pathList = strList("possiblePaths");
  if (pathList.length) parts.push(`• paths: ${pathList.join(", ")}`);
  // Hosts the command may contact. Verified present on real shell requests
  // (live probe, 2026-07-28). Risk-relevant on its own: the command text can
  // hide the destination behind a variable, so without this an approver cannot
  // see that a command exfiltrates to (or fetches from) a remote host.
  const urlList = strList("possibleUrls");
  if (urlList.length) parts.push(`• urls: ${urlList.join(", ")}`);
  if (parts.length === 0) {
    // Unknown shape — show the raw request rather than approve blind.
    try {
      parts.push(JSON.stringify(r));
    } catch {
      parts.push(String(r));
    }
  }
  return parts.join("\n");
}
