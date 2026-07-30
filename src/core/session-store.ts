import fs from "node:fs";
import path from "node:path";

/** Lifecycle state of a persisted session record.
 *  Absent record = tombstone (nothing to resume). */
export type SessionState = "creating" | "active" | "orphaned" | "blocked";

/** v1 stored ONE bare record at the top level. v2 stores many, plus a
 *  generation high-water mark. v1 files are migrated on read. */
const SCHEMA_VERSION = 2;

export interface SessionRecord {
  schemaVersion: number;
  threadId: string;
  sessionId: string;
  generation: number;
  repoPath: string;
  guildId: string;
  parentChannelId: string;
  /** Directory the agent actually works in. Equals `repoPath` for a shared-tree
   *  session; a per-session git worktree otherwise. Absent in v1 records, which
   *  predate isolation — migrated to `repoPath`. */
  workDir: string;
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
  branch?: string;
}

interface StoreFile {
  schemaVersion: number;
  generationHighWater: number;
  sessions: SessionRecord[];
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
  private highWater = 0;
  private corrupt = false;

  constructor(private readonly file: string) {
    this.load();
  }

  /** Every persisted record, in insertion order. */
  all(): SessionRecord[] {
    return [...this.sessions.values()].map((r) => ({ ...r }));
  }

  /** One record by thread id, or undefined. */
  get(threadId: string): SessionRecord | undefined {
    const r = this.sessions.get(threadId);
    return r ? { ...r } : undefined;
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

  /** Forget every session. The file is KEPT (holding only the generation
   *  high-water mark) so generations still never repeat — see `mutate`. */
  clear(): boolean {
    return this.mutate((m, hw) => {
      m.clear();
      return hw;
    });
  }

  /** Write a prior record back verbatim (used to roll back a reserve when a
   *  later step fails, restoring the still-live previous session). */
  restore(rec: SessionRecord): boolean {
    return this.mutate((m, hw) => {
      m.set(rec.threadId, { ...rec, updatedAt: Date.now() });
      return Math.max(hw, rec.generation);
    });
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
  private mutate(f: (m: Map<string, SessionRecord>, highWater: number) => number): boolean {
    const next = new Map(this.sessions);
    const nextHw = f(next, this.highWater);
    const candidate: StoreFile = {
      schemaVersion: SCHEMA_VERSION,
      generationHighWater: nextHw,
      sessions: [...next.values()],
    };
    if (!this.write(candidate)) return false;
    this.sessions = next;
    this.highWater = nextHw;
    this.corrupt = false;
    return true;
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

/** Parse either a v2 store file or a bare v1 record, or undefined if neither. */
function readRecords(v: unknown): { sessions: SessionRecord[]; highWater: number } | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (Array.isArray(o["sessions"])) {
    const out: SessionRecord[] = [];
    for (const item of o["sessions"]) {
      const r = asRecord(item);
      if (!r) return undefined; // one bad row invalidates the file — fail closed
      out.push(r);
    }
    const hw = typeof o["generationHighWater"] === "number" ? o["generationHighWater"] : 0;
    return { sessions: out, highWater: Math.max(hw, ...out.map((r) => r.generation), 0) };
  }
  // v1: a single bare record at the top level.
  const single = asRecord(o);
  if (!single) return undefined;
  return { sessions: [single], highWater: single.generation };
}

function asRecord(v: unknown): SessionRecord | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const ok =
    typeof r["schemaVersion"] === "number" &&
    typeof r["threadId"] === "string" &&
    typeof r["sessionId"] === "string" &&
    typeof r["generation"] === "number" &&
    typeof r["repoPath"] === "string" &&
    typeof r["guildId"] === "string" &&
    typeof r["parentChannelId"] === "string" &&
    (r["state"] === "creating" || r["state"] === "active" || r["state"] === "orphaned" || r["state"] === "blocked") &&
    typeof r["updatedAt"] === "number";
  if (!ok) return undefined;
  // `workDir` is absent in v1 records, which predate per-session isolation: those
  // sessions ran directly in the controlled repo, so that is their work dir.
  const workDir = typeof r["workDir"] === "string" ? r["workDir"] : (r["repoPath"] as string);
  const branch = typeof r["branch"] === "string" ? r["branch"] : undefined;
  return { ...(r as unknown as SessionRecord), workDir, ...(branch ? { branch } : {}) };
}
