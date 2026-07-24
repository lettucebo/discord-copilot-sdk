import fs from "node:fs";
import path from "node:path";

/** Lifecycle state of the single persisted session record (one-session model).
 *  Absent record = tombstone (nothing to resume). */
export type SessionState = "creating" | "active" | "orphaned" | "blocked";

const SCHEMA_VERSION = 1;

export interface SessionRecord {
  schemaVersion: number;
  threadId: string;
  sessionId: string;
  generation: number;
  repoPath: string;
  guildId: string;
  parentChannelId: string;
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
}

/**
 * Durable store for discopilot's single current thread↔session mapping, so a bot
 * restart can resume the active Discord thread instead of orphaning it.
 *
 * Persisted as JSON at a per-instance path under `~/.discopilot`.
 *
 * Safety properties (P2):
 * - **Atomic**: writes go to a temp file then rename over the target, so a crash
 *   mid-write can't leave a torn file.
 * - **Persist-first**: in-memory state is updated ONLY after the disk write
 *   succeeds, so the store never reports a state that isn't durable. Every
 *   mutation returns a boolean; false = the write failed and nothing changed.
 * - **Corrupt != absent**: a present-but-unparseable file sets `isCorrupt()` so
 *   startup can fail closed rather than silently start fresh (which could drop a
 *   recoverable session).
 */
export class SessionStore {
  private record?: SessionRecord;
  private corrupt = false;

  constructor(private readonly file: string) {
    this.load();
  }

  /** The current record, or undefined when none/tombstoned. */
  get(): SessionRecord | undefined {
    return this.record ? { ...this.record } : undefined;
  }

  /** True when the on-disk file existed but could not be parsed/validated.
   *  Startup should treat this as fatal, not as "no session". */
  isCorrupt(): boolean {
    return this.corrupt;
  }

  /** Reserve a session as `creating` BEFORE createSession, using a caller-assigned
   *  session id. Overwrites any prior record, so a crash after this can never
   *  resurrect the superseded session. Returns durability. */
  reserve(b: SessionBinding): boolean {
    return this.write({ ...this.toRecord(b), state: "creating" });
  }

  /** Mark a freshly created/resumed session as active. When `b` is omitted, the
   *  current record is promoted creating→active (used right after createSession
   *  succeeds for a reserved id). Returns durability. */
  commit(b?: SessionBinding): boolean {
    if (b) return this.write({ ...this.toRecord(b), state: "active" });
    if (!this.record) return false;
    return this.write({ ...this.record, state: "active", updatedAt: Date.now() });
  }

  /** Transition the current record's state (e.g. active→orphaned/blocked). No-op
   *  (false) when there is no record. */
  setState(state: SessionState, reason?: string): boolean {
    if (!this.record) return false;
    return this.write({ ...this.record, state, reason, updatedAt: Date.now() });
  }

  /** Tombstone: forget the current record. Returns durability of the removal. */
  clear(): boolean {
    return this.write(undefined);
  }

  /** The generation to assign to the next incarnation: current + 1, or 1 when
   *  there is no record. Monotonic bookkeeping (NOT a security fence — see design). */
  nextGeneration(): number {
    return (this.record?.generation ?? 0) + 1;
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
      state: "active",
      updatedAt: Date.now(),
    };
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      // Only a genuinely-absent file is "no session". Any OTHER read error
      // (permissions, a directory in the way, sharing violation) is treated as
      // corrupt so startup fails closed rather than silently starting fresh and
      // dropping a recoverable session.
      if ((err as { code?: string })?.code === "ENOENT") return;
      this.corrupt = true;
      return;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed)) this.record = parsed;
      else this.corrupt = true; // present but invalid → fail closed at startup
    } catch {
      this.corrupt = true;
    }
  }

  /** Write back a full prior record verbatim (used to roll back a reserve when a
   *  subsequent step fails, restoring the still-live previous session). */
  restore(rec: SessionRecord): boolean {
    return this.write({ ...rec, updatedAt: Date.now() });
  }

  /** Atomically write (or remove) the record, updating in-memory state ONLY on a
   *  successful write (persist-first). Returns false (and logs) on any I/O error. */
  private write(candidate: SessionRecord | undefined): boolean {
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (!candidate) {
        fs.rmSync(this.file, { force: true });
      } else {
        fs.writeFileSync(tmp, JSON.stringify(candidate, null, 2), "utf8");
        fs.renameSync(tmp, this.file); // atomic replace
      }
      this.record = candidate; // only reached when the write succeeded
      this.corrupt = false;
      return true;
    } catch (err) {
      // Best-effort temp cleanup — must NOT itself throw, or write() would throw
      // instead of returning false and callers' fail-closed handling (commit-fail
      // fence, rollback) would be skipped.
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
}

function isRecord(v: unknown): v is SessionRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["schemaVersion"] === "number" &&
    typeof r["threadId"] === "string" &&
    typeof r["sessionId"] === "string" &&
    typeof r["generation"] === "number" &&
    typeof r["repoPath"] === "string" &&
    typeof r["guildId"] === "string" &&
    typeof r["parentChannelId"] === "string" &&
    (r["state"] === "creating" || r["state"] === "active" || r["state"] === "orphaned" || r["state"] === "blocked") &&
    typeof r["updatedAt"] === "number"
  );
}
