import fs from "node:fs";
import path from "node:path";
import { isDevMode, type DevMode } from "./binding.js";

/** Lifecycle state of a persisted session record.
 *  Absent record = tombstone (nothing to resume). */
export type SessionState = "creating" | "active" | "orphaned" | "blocked";

/** v1 stored ONE bare record at the top level. v2 stores many, plus a
 *  generation high-water mark. v3 adds `devMode`, because it can no longer be
 *  inferred (see `asRecord`). v4 adds the conservatively reserved file-delivery
 * byte total. v5 adds terminal stale-rebind records, so an old incarnation can
 * remain durably visible while its replacement owns the logical thread. Older
 * files are migrated on read. */
const SCHEMA_VERSION = 5;

export interface SessionRecord {
  schemaVersion: number;
  threadId: string;
  sessionId: string;
  generation: number;
  /** The repo this session is bound to — a git working-tree root under
   *  `REPOS_ROOT`. Was the single controlled repo before multi-repo. */
  repoPath: string;
  guildId: string;
  parentChannelId: string;
  /** Directory the agent actually works in. Equals `repoPath` in `local` mode;
   *  a per-session git worktree in `worktree` mode. Absent in v1 records, which
   *  predate isolation — migrated to `repoPath`. */
  workDir: string;
  /** How this session gets its working directory. See `asRecord` for why this
   *  is persisted rather than inferred from `branch`. */
  devMode: DevMode;
  /** Bytes durably reserved for agent-initiated attachment delivery in this
   *  logical Discord thread. Reservations are intentionally not rolled back
   *  after a transport failure, so a restart cannot reopen this quota. */
  fileDeliveryBytes: number;
  /** Git branch checked out in `workDir`, when it is a worktree we created. */
  branch?: string;
  state: SessionState;
  reason?: string;
  updatedAt: number;
}

/** Fields a caller supplies to reserve/commit a session (the store fills in
 *  schemaVersion, state and updatedAt). */
export interface SessionBinding {
  threadId: string;
  sessionId: string;
  generation: number;
  repoPath: string;
  guildId: string;
  parentChannelId: string;
  workDir: string;
  devMode: DevMode;
  /** Omit only for a fresh logical thread; it starts with zero reserved bytes.
   *  Rebind must explicitly carry the prior record's total forward. */
  fileDeliveryBytes?: number;
  branch?: string;
}

/** Result of replacing a freshly reserved rebind row with its prior record. */
export interface ConditionalRestoreResult {
  ok: boolean;
  /** A replacement actor reserved bytes before rollback. The prior identity was
   * restored, but its file delivery must stay suspended because its local total
   * is now stale. */
  quotaAdvanced: boolean;
}

/** Immutable identity for either a primary reservation or a stale-rebind row.
 * A Discord thread id alone is mutable during rebind and is never a sufficient
 * ownership check. */
export interface SessionIdentity {
  threadId: string;
  sessionId: string;
  generation: number;
}

/** The only two safe resolutions for a primary `creating` row retained as the
 * fallback pointer for an unconfirmed replacement actor. */
export type FallbackPrimaryAction =
  | {
      kind: "restore";
      original: SessionRecord;
      /** Stale rows paired with this recovery transaction. They are removed
       * only when the target primary reservation still matches. */
      staleRebinds: SessionIdentity[];
    }
  | {
      kind: "remove";
      /** The replacement's terminal row, if it was later persisted during a
       * retry, must disappear with its fallback primary reservation. */
      staleRebinds: SessionIdentity[];
    };

interface StoreFile {
  schemaVersion: number;
  generationHighWater: number;
  sessions: SessionRecord[];
  /** Old rebind incarnations are terminal (`blocked`) records keyed by their
   * immutable session identity. They deliberately do not share the main
   * thread-id map: a live replacement and an unconfirmed old actor can coexist
   * for one Discord thread. */
  staleRebinds: SessionRecord[];
}

/**
 * Durable store for the thread↔session mappings, so a bot restart can resume
 * live Discord threads instead of orphaning them.
 *
 * Persisted as JSON at a per-instance path under `~/.discord-copilot-sdk`.
 *
 * Safety properties (P2), all preserved from the single-session version:
 * - **Atomic**: writes go to a temp file then rename over the target, so a crash
 *   mid-write can't leave a torn file.
 * - **Persist-first**: in-memory state is updated ONLY after the disk write
 *   succeeds, so the store never reports a state that isn't durable. Every
 *   mutation returns a boolean; false = the write failed and nothing changed.
 * - **Corrupt != absent**: a present-but-unparseable file sets `isCorrupt()` so
 *   startup can fail closed rather than silently start fresh (which could drop a
 *   recoverable session).
 *
 * Multi-session note: `generationHighWater` is persisted rather than derived
 * from the live records, because deleting records would otherwise let a
 * generation be REUSED — and generations are what fence a stale actor's
 * decisions from a newer incarnation of the same thread.
 */
export class SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private staleRebindRecords = new Map<string, SessionRecord>();
  private highWater = 0;
  private corrupt = false;

  constructor(private readonly file: string) {
    this.load();
  }

  /** Every persisted record, in insertion order. */
  all(): SessionRecord[] {
    return [...this.sessions.values()].map((r) => ({ ...r }));
  }

  /** Terminal old incarnations retained while rebind teardown was unconfirmed.
   * They are intentionally separate from `all()`: reconcile must never resume
   * them, while `/sessions` and explicit cleanup can still make their worktree
   * visible and reclaimable. */
  staleRebinds(): SessionRecord[] {
    return [...this.staleRebindRecords.values()].map((r) => ({ ...r }));
  }

  staleRebindsForThread(threadId: string): SessionRecord[] {
    return this.staleRebinds().filter((r) => r.threadId === threadId);
  }

  /** One record by thread id, or undefined. */
  get(threadId: string): SessionRecord | undefined {
    const r = this.sessions.get(threadId);
    return r ? { ...r } : undefined;
  }

  /** Persist a blocked old incarnation independently of the current thread
   * record. `threadId` alone is mutable during rebind, so the tuple including
   * session id and generation is the ownership fence. */
  retainStaleRebind(record: SessionRecord, reason: string): boolean {
    if (
      !record.threadId ||
      !record.sessionId ||
      !Number.isSafeInteger(record.generation) ||
      record.generation < 1 ||
      !isFileDeliveryBytes(record.fileDeliveryBytes) ||
      !reason.startsWith("rebind-")
    ) {
      return false;
    }
    const key = staleRebindKey(record.threadId, record.sessionId, record.generation);
    return this.mutate((_, highWater, stale) => {
      const prior = stale.get(key);
      const fileDeliveryBytes = Math.max(prior?.fileDeliveryBytes ?? 0, record.fileDeliveryBytes);
      stale.set(key, {
        ...this.toRecord({ ...record, fileDeliveryBytes }),
        state: "blocked",
        reason,
        updatedAt: Date.now(),
      });
      return Math.max(highWater, record.generation);
    });
  }

  /** Forget a terminal stale incarnation only after its actor has confirmed
   * teardown and its cleanup plan has safely dealt with the recorded worktree. */
  removeStaleRebind(threadId: string, sessionId: string, generation: number): boolean {
    const key = staleRebindKey(threadId, sessionId, generation);
    if (!this.staleRebindRecords.has(key)) return true;
    return this.mutate((_, highWater, stale) => {
      stale.delete(key);
      return highWater;
    });
  }

  /** True when the on-disk file existed but could not be parsed/validated.
   *  Startup should treat this as fatal, not as "no sessions". */
  isCorrupt(): boolean {
    return this.corrupt;
  }

  /** The generation to assign to the next incarnation. Monotonic across the
   *  whole store and never reused, even after records are removed. */
  nextGeneration(): number {
    return this.highWater + 1;
  }

  /** Reserve a session as `creating` BEFORE createSession, using a caller-assigned
   *  session id. Returns durability. */
  reserve(b: SessionBinding): boolean {
    if (!isFileDeliveryBytes(b.fileDeliveryBytes ?? 0)) return false;
    return this.mutate((m, hw) => {
      m.set(b.threadId, { ...this.toRecord(b), state: "creating" });
      return Math.max(hw, b.generation);
    });
  }

  /** Promote a reserved record creating→active (or refresh `updatedAt` for an
   *  already-active one). No-op (false) when the thread has no record. */
  commit(threadId: string): boolean {
    if (!this.sessions.has(threadId)) return false;
    return this.mutate((m, hw) => {
      const cur = m.get(threadId)!;
      m.set(threadId, { ...cur, state: "active", updatedAt: Date.now() });
      return hw;
    });
  }

  /** Atomically compare-and-reserve the next total for agent file delivery.
   *  This is persist-first: false means the in-memory total was NOT changed,
   *  so callers must fail closed before any attachment leaves the process. The
   *  record identity AND expected total fence an old actor after rebind: a
   *  thread id alone names a mutable slot, not the actor that owns it. */
  reserveFileDeliveryBytes(
    threadId: string,
    expectedSessionId: string,
    expectedGeneration: number,
    expectedTotal: number,
    nextTotal: number
  ): boolean {
    if (
      typeof expectedSessionId !== "string" ||
      expectedSessionId.length === 0 ||
      !Number.isSafeInteger(expectedGeneration) ||
      expectedGeneration < 1 ||
      !isFileDeliveryBytes(expectedTotal) ||
      !isFileDeliveryBytes(nextTotal) ||
      nextTotal <= expectedTotal
    ) {
      return false;
    }
    const current = this.sessions.get(threadId);
    if (
      !current ||
      current.sessionId !== expectedSessionId ||
      current.generation !== expectedGeneration ||
      current.fileDeliveryBytes !== expectedTotal
    ) {
      return false;
    }
    return this.mutate((m, hw) => {
      const record = m.get(threadId)!;
      m.set(threadId, { ...record, fileDeliveryBytes: nextTotal, updatedAt: Date.now() });
      return hw;
    });
  }

  /** Transition a record's state (e.g. active→orphaned/blocked). No-op (false)
   *  when the thread has no record. */
  setState(threadId: string, state: SessionState, reason?: string): boolean {
    if (!this.sessions.has(threadId)) return false;
    return this.mutate((m, hw) => {
      const cur = m.get(threadId)!;
      m.set(threadId, { ...cur, state, reason, updatedAt: Date.now() });
      return hw;
    });
  }

  /** Tombstone one session. Returns durability of the removal. */
  remove(threadId: string): boolean {
    return this.mutate((m, hw) => {
      m.delete(threadId);
      return hw;
    });
  }

  /** Tombstone a record only if the same immutable incarnation still owns the
   * thread slot. A failed rebind must never erase a later replacement. */
  removeIfCurrent(threadId: string, expectedSessionId: string, expectedGeneration: number): boolean {
    const current = this.sessions.get(threadId);
    if (
      !current ||
      current.sessionId !== expectedSessionId ||
      current.generation !== expectedGeneration
    ) {
      return false;
    }
    return this.mutate((m, hw) => {
      m.delete(threadId);
      return hw;
    });
  }

  /** Forget every primary thread record. Terminal stale-rebind records remain:
   * a generic reset must not erase the only durable pointer to an unconfirmed
   * actor/worktree. The file is KEPT (holding at least the generation
   * high-water mark) so generations still never repeat — see `mutate`. */
  clear(): boolean {
    return this.mutate((m, hw) => {
      m.clear();
      return hw;
    });
  }

  /** Write a record back only when its incarnation still owns the slot. A
   *  generic restore is used by recovery tooling; it must not let an old record
   *  replace a newer session or lower a newer reservation. */
  restore(rec: SessionRecord): boolean {
    const current = this.sessions.get(rec.threadId);
    if (
      current &&
      (current.sessionId !== rec.sessionId || current.generation !== rec.generation)
    ) {
      return false;
    }
    const fileDeliveryBytes = Math.max(current?.fileDeliveryBytes ?? 0, rec.fileDeliveryBytes);
    return this.mutate((m, hw) => {
      m.set(rec.threadId, {
        ...this.toRecord({ ...rec, fileDeliveryBytes }),
        state: rec.state,
        ...(rec.reason ? { reason: rec.reason } : {}),
      });
      return Math.max(hw, rec.generation);
    });
  }

  /** Replace exactly the record installed by this rebind attempt with the
   * previous record. If that replacement accumulated a reservation, preserve
   * its larger total and report that the restored old actor cannot safely resume
   * file delivery. */
  restoreIfCurrent(
    rec: SessionRecord,
    expectedSessionId: string,
    expectedGeneration: number
  ): ConditionalRestoreResult {
    const current = this.sessions.get(rec.threadId);
    if (
      !current ||
      current.sessionId !== expectedSessionId ||
      current.generation !== expectedGeneration
    ) {
      return { ok: false, quotaAdvanced: false };
    }
    const fileDeliveryBytes = Math.max(rec.fileDeliveryBytes, current.fileDeliveryBytes);
    const quotaAdvanced = fileDeliveryBytes !== rec.fileDeliveryBytes;
    const ok = this.mutate((m, hw) => {
      m.set(rec.threadId, {
        ...this.toRecord({ ...rec, fileDeliveryBytes }),
        state: rec.state,
        ...(rec.reason ? { reason: rec.reason } : {}),
      });
      return Math.max(hw, rec.generation);
    });
    return { ok, quotaAdvanced };
  }

  /** Reconcile the primary fallback pointer left by a replacement whose
   * terminal stale row could not be persisted. The expected target must still
   * be the exact `creating` reservation: otherwise a newer incarnation may own
   * the mutable thread slot, and this method leaves every row untouched.
   *
   * Primary and stale-row changes share one persist-first `mutate()` call. A
   * failed write therefore preserves both the fallback barrier and every
   * durable tracker, rather than half-completing teardown. */
  reconcileFallbackPrimary(
    expectedTarget: SessionIdentity,
    action: FallbackPrimaryAction
  ): ConditionalRestoreResult {
    if (
      !isSessionIdentity(expectedTarget) ||
      !Array.isArray(action.staleRebinds) ||
      !action.staleRebinds.every(
        (identity) =>
          isSessionIdentity(identity) && identity.threadId === expectedTarget.threadId
      )
    ) {
      return { ok: false, quotaAdvanced: false };
    }
    const current = this.sessions.get(expectedTarget.threadId);
    if (
      !current ||
      current.sessionId !== expectedTarget.sessionId ||
      current.generation !== expectedTarget.generation ||
      current.state !== "creating"
    ) {
      return { ok: false, quotaAdvanced: false };
    }
    if (
      action.kind === "restore" &&
      (!isSessionIdentity(action.original) ||
        action.original.threadId !== expectedTarget.threadId ||
        !isFileDeliveryBytes(action.original.fileDeliveryBytes))
    ) {
      return { ok: false, quotaAdvanced: false };
    }

    const fileDeliveryBytes =
      action.kind === "restore"
        ? Math.max(action.original.fileDeliveryBytes, current.fileDeliveryBytes)
        : 0;
    const quotaAdvanced =
      action.kind === "restore" && fileDeliveryBytes !== action.original.fileDeliveryBytes;
    const ok = this.mutate((m, highWater, stale) => {
      if (action.kind === "restore") {
        m.set(expectedTarget.threadId, {
          ...this.toRecord({ ...action.original, fileDeliveryBytes }),
          state: action.original.state,
          ...(action.original.reason ? { reason: action.original.reason } : {}),
        });
      } else {
        m.delete(expectedTarget.threadId);
      }
      for (const identity of action.staleRebinds) {
        stale.delete(staleRebindKey(identity.threadId, identity.sessionId, identity.generation));
      }
      return highWater;
    });
    return { ok, quotaAdvanced: ok && quotaAdvanced };
  }

  private toRecord(b: SessionBinding): SessionRecord {
    return {
      schemaVersion: SCHEMA_VERSION,
      threadId: b.threadId,
      sessionId: b.sessionId,
      generation: b.generation,
      repoPath: b.repoPath,
      guildId: b.guildId,
      parentChannelId: b.parentChannelId,
      workDir: b.workDir,
      devMode: b.devMode,
      fileDeliveryBytes: b.fileDeliveryBytes ?? 0,
      ...(b.branch ? { branch: b.branch } : {}),
      state: "active",
      updatedAt: Date.now(),
    };
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      // Only a genuinely-absent file is "no sessions". Any OTHER read error
      // (permissions, a directory in the way, sharing violation) is treated as
      // corrupt so startup fails closed rather than silently starting fresh and
      // dropping recoverable sessions.
      if ((err as { code?: string })?.code === "ENOENT") return;
      this.corrupt = true;
      return;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      const records = readRecords(parsed);
      if (!records) {
        this.corrupt = true; // present but invalid → fail closed at startup
        return;
      }
      for (const r of records.sessions) this.sessions.set(r.threadId, r);
      for (const r of records.staleRebinds) {
        this.staleRebindRecords.set(staleRebindKey(r.threadId, r.sessionId, r.generation), r);
      }
      this.highWater = records.highWater;
    } catch {
      this.corrupt = true;
    }
  }

  /**
   * Apply `f` to a COPY of the state, persist it, and only then adopt it
   * (persist-first). Returns false — never throws — when the write fails, in
   * which case nothing changed in memory either.
   *
   * The file is written even when it holds ZERO sessions: it still carries the
   * generation high-water mark, and deleting it would let a generation be
   * reused after the last session ends — which is exactly what generations
   * exist to prevent.
   */
  private mutate(
    f: (m: Map<string, SessionRecord>, highWater: number, stale: Map<string, SessionRecord>) => number
  ): boolean {
    const next = new Map(this.sessions);
    const nextStale = new Map(this.staleRebindRecords);
    const nextHw = f(next, this.highWater, nextStale);
    const candidate: StoreFile = {
      schemaVersion: SCHEMA_VERSION,
      generationHighWater: nextHw,
      sessions: [...next.values()].map((record) => this.canonicalizeRecord(record)),
      staleRebinds: [...nextStale.values()].map((record) => this.canonicalizeRecord(record)),
    };
    if (!this.write(candidate)) return false;
    this.sessions = next;
    this.staleRebindRecords = nextStale;
    this.highWater = nextHw;
    this.corrupt = false;
    return true;
  }

  private canonicalizeRecord(record: SessionRecord): SessionRecord {
    return {
      ...this.toRecord(record),
      state: record.state,
      ...(record.reason ? { reason: record.reason } : {}),
      updatedAt: record.updatedAt,
    };
  }

  /** Atomically write the file. Returns false (and logs) on any I/O error —
   *  callers' fail-closed handling depends on it never throwing. */
  private write(candidate: StoreFile): boolean {
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(candidate, null, 2), "utf8");
      this.renameWithRetry(tmp, this.file);
      return true;
    } catch (err) {
      // Best-effort temp cleanup — must NOT itself throw, or write() would throw
      // instead of returning false and callers' fail-closed handling would be
      // skipped.
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* leave the temp file rather than mask the real failure */
      }
      console.warn(
        `⚠️  could not persist session store to ${this.file}: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  /**
   * The atomic replace, retried through a transient Windows failure.
   *
   * `rename` over an existing file fails with EPERM/EACCES/EBUSY whenever
   * anything holds the target for an instant — an antivirus scanner, the search
   * indexer, a backup agent. Treating that first attempt as final is not merely
   * a flaky test: `commit()` returns false, and `/new` then tells the operator
   * their DISK is broken and deletes the thread it just created, for a condition
   * that succeeds a few milliseconds later.
   *
   * Only those codes are retried, and only briefly (~90ms worst case) — a
   * genuinely permanent failure must still fail, promptly and honestly. The
   * sleep must be SYNCHRONOUS because `write()` is called from synchronous
   * persist-first paths that cannot become async without changing every
   * caller's contract; `Atomics.wait` blocks without spinning the CPU, which a
   * busy loop would do while also stalling the Discord event loop.
   */
  private renameWithRetry(from: string, to: string): void {
    const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
    const delays = [5, 15, 30, 40];
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(from, to);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (i >= delays.length || !TRANSIENT.has(code)) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[i]!);
      }
    }
  }
}

function isFileDeliveryBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSessionIdentity(value: SessionIdentity): boolean {
  return (
    typeof value.threadId === "string" &&
    value.threadId.length > 0 &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 1
  );
}

/** Parse a versioned multi-session file or a bare v1 record, or undefined if neither. */
function readRecords(v: unknown): { sessions: SessionRecord[]; staleRebinds: SessionRecord[]; highWater: number } | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (Object.hasOwn(o, "sessions")) {
    if (!Array.isArray(o["sessions"])) return undefined;
    const containerVersion = readSchemaVersion(o["schemaVersion"]);
    // A multi-row file is an explicit container. Its rows must agree with its
    // version: accepting a v3 row inside v4 would reinterpret a torn/downgraded
    // current record as legacy and reopen its attachment quota at zero.
    if (containerVersion === undefined || containerVersion < 2 || containerVersion > SCHEMA_VERSION) {
      return undefined;
    }
    const out: SessionRecord[] = [];
    for (const item of o["sessions"]) {
      const r = asRecord(item, containerVersion);
      if (!r) return undefined; // one bad row invalidates the file — fail closed
      out.push(r);
    }
    const rawStale = o["staleRebinds"];
    if (containerVersion >= 5 && !Array.isArray(rawStale)) return undefined;
    const staleItems: unknown[] = containerVersion >= 5 ? (rawStale as unknown[]) : [];
    const staleRebinds: SessionRecord[] = [];
    const staleKeys = new Set<string>();
    for (const item of staleItems) {
      const r = asRecord(item, containerVersion);
      // A stale rebind must stay terminal. Accepting an active row here would
      // make reconcile resume a second actor for one Discord thread.
      if (!r || r.state !== "blocked" || !r.reason?.startsWith("rebind-")) return undefined;
      const key = staleRebindKey(r.threadId, r.sessionId, r.generation);
      if (staleKeys.has(key)) return undefined;
      staleKeys.add(key);
      staleRebinds.push(r);
    }
    const hw = typeof o["generationHighWater"] === "number" ? o["generationHighWater"] : 0;
    return {
      sessions: out,
      staleRebinds,
      highWater: Math.max(hw, ...out.map((r) => r.generation), ...staleRebinds.map((r) => r.generation), 0),
    };
  }
  // Only an actual v1 bare record is legacy. A later-version object without
  // the multi-session container is corrupt, not an invitation to infer fields.
  if (readSchemaVersion(o["schemaVersion"]) !== 1) return undefined;
  const single = asRecord(o, 1);
  if (!single) return undefined;
  return { sessions: [single], staleRebinds: [], highWater: single.generation };
}

function readSchemaVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Parse ONE record, building every field explicitly.
 *
 * The previous version validated a handful of fields and then did
 * `{ ...(r as unknown as SessionRecord) }`, which copied whatever else was in
 * the JSON straight into a typed object — including a `branch` of the wrong
 * type, and any field a later version adds. The store file is plain JSON in the
 * user's home directory, so "trust the shape after checking four keys" is not a
 * property worth keeping.
 *
 * Migration of `devMode`, which v1/v2 records do not carry:
 *
 * - `branch` present ⇒ `worktree` (only worktree sessions ever recorded one);
 * - otherwise ⇒ `local`, which is what a v1 record and a v2 `shared`-isolation
 *   record actually were: the agent worked directly in the repo.
 *
 * This is deliberately only the STRUCTURAL half of the migration. It cannot ask
 * git whether a worktree really belongs to the recorded repo, or whether a
 * `local` record's workDir really is its repo — that is `validateBinding`'s job
 * at reconcile time, which blocks the record with a precise reason. Doing it
 * here would either need a subprocess inside a synchronous read, or would have
 * to mark the whole file corrupt and refuse to start over one bad row.
 */
function asRecord(v: unknown, containerVersion: number): SessionRecord | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof r[k] === "string" ? (r[k] as string) : undefined);
  const num = (k: string): number | undefined => (typeof r[k] === "number" ? (r[k] as number) : undefined);

  const schemaVersion = readSchemaVersion(r["schemaVersion"]);
  const threadId = str("threadId");
  const sessionId = str("sessionId");
  const generation = num("generation");
  const repoPath = str("repoPath");
  const guildId = str("guildId");
  const parentChannelId = str("parentChannelId");
  const updatedAt = num("updatedAt");
  const rawState = str("state");
  const state: SessionState | undefined =
    rawState === "creating" || rawState === "active" || rawState === "orphaned" || rawState === "blocked"
      ? rawState
      : undefined;

  if (
    schemaVersion !== containerVersion ||
    threadId === undefined ||
    sessionId === undefined ||
    generation === undefined ||
    repoPath === undefined ||
    guildId === undefined ||
    parentChannelId === undefined ||
    updatedAt === undefined ||
    state === undefined
  ) {
    return undefined;
  }

  // v1 records predate per-session isolation: those sessions ran directly in the
  // controlled repo, so that is their work dir.
  const workDir = str("workDir") ?? repoPath;
  const branch = str("branch");
  const rawMode = r["devMode"];
  // Inference is a MIGRATION, not a fallback. A file already claiming v3+ must
  // carry a valid `devMode`: guessing one there would silently paper over a
  // corrupt or hand-edited record, and `local` is the mode that needs a repo
  // lease — getting it wrong puts two agents in one checkout.
  const devMode: DevMode | undefined = isDevMode(rawMode)
    ? rawMode
    : containerVersion >= 3
      ? undefined
      : branch
        ? "worktree"
        : "local";
  if (devMode === undefined) return undefined;
  const reason = str("reason");
  const rawFileDeliveryBytes = r["fileDeliveryBytes"];
  // A missing field is a migration ONLY for records written before v4. A v4+
  // record that omits or corrupts its quota must fail closed rather than reopen
  // a thread's attachment budget after a hand edit or torn upgrade.
  const fileDeliveryBytes =
    rawFileDeliveryBytes === undefined
      ? containerVersion < 4
        ? 0
        : undefined
      : isFileDeliveryBytes(rawFileDeliveryBytes)
        ? rawFileDeliveryBytes
        : undefined;
  if (fileDeliveryBytes === undefined) return undefined;

  return {
    schemaVersion: SCHEMA_VERSION,
    threadId,
    sessionId,
    generation,
    repoPath,
    guildId,
    parentChannelId,
    workDir,
    devMode,
    fileDeliveryBytes,
    ...(branch ? { branch } : {}),
    state,
    ...(reason ? { reason } : {}),
    updatedAt,
  };
}

function staleRebindKey(threadId: string, sessionId: string, generation: number): string {
  return JSON.stringify([threadId, sessionId, generation]);
}
