import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type SessionBinding } from "../src/core/session-store.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "dcs-store-")), "s.json");
}

const bind = (threadId: string, over: Partial<SessionBinding> = {}): SessionBinding => ({
  threadId,
  sessionId: `sess-${threadId}`,
  generation: 1,
  repoPath: "C:\\repo",
  guildId: "g1",
  parentChannelId: "p1",
  workDir: "C:\\repo",
  ...over,
});

describe("SessionStore — basics", () => {
  it("returns nothing and not-corrupt when no file exists", () => {
    const s = new SessionStore(tmpFile());
    expect(s.all()).toEqual([]);
    expect(s.get("t1")).toBeUndefined();
    expect(s.isCorrupt()).toBe(false);
  });

  it("reserve writes a creating record; commit promotes it to active", () => {
    const f = tmpFile();
    const s = new SessionStore(f);
    expect(s.reserve(bind("t1"))).toBe(true);
    expect(s.get("t1")?.state).toBe("creating");
    expect(s.commit("t1")).toBe(true);
    expect(s.get("t1")?.state).toBe("active");
    expect(new SessionStore(f).get("t1")?.state).toBe("active"); // persisted
  });

  it("commit/setState for an unknown thread return false", () => {
    const s = new SessionStore(tmpFile());
    expect(s.commit("nope")).toBe(false);
    expect(s.setState("nope", "blocked", "x")).toBe(false);
  });

  it("setState updates state + reason", () => {
    const s = new SessionStore(tmpFile());
    s.reserve(bind("t1"));
    expect(s.setState("t1", "blocked", "thread-gone")).toBe(true);
    expect(s.get("t1")).toMatchObject({ state: "blocked", reason: "thread-gone" });
  });

  it("restore() writes a prior record back verbatim", () => {
    const s = new SessionStore(tmpFile());
    s.reserve(bind("t1"));
    s.commit("t1");
    const prior = s.get("t1")!;
    s.remove("t1");
    expect(s.get("t1")).toBeUndefined();
    expect(s.restore(prior)).toBe(true);
    expect(s.get("t1")).toMatchObject({ sessionId: prior.sessionId, state: prior.state });
  });

  it("carries workDir and branch so a resumed session lands in the SAME tree", () => {
    // Resuming a worktree-isolated session into the wrong directory would run
    // one thread's conversation against another thread's files.
    const f = tmpFile();
    const s = new SessionStore(f);
    s.reserve(bind("t1", { workDir: "C:\\wt\\t1", branch: "copilot/t1" }));
    s.commit("t1");
    expect(new SessionStore(f).get("t1")).toMatchObject({
      workDir: "C:\\wt\\t1",
      branch: "copilot/t1",
    });
  });
});

describe("SessionStore — many concurrent sessions", () => {
  it("holds several records at once and removes them individually", () => {
    const f = tmpFile();
    const s = new SessionStore(f);
    s.reserve(bind("t1", { generation: 1 }));
    s.reserve(bind("t2", { generation: 2 }));
    s.reserve(bind("t3", { generation: 3 }));
    expect(s.all().map((r) => r.threadId)).toEqual(["t1", "t2", "t3"]);
    expect(s.remove("t2")).toBe(true);
    expect(s.all().map((r) => r.threadId)).toEqual(["t1", "t3"]);
    expect(new SessionStore(f).all().map((r) => r.threadId)).toEqual(["t1", "t3"]);
  });

  it("ending one session leaves the others untouched", () => {
    const s = new SessionStore(tmpFile());
    s.reserve(bind("t1"));
    s.commit("t1");
    s.reserve(bind("t2", { generation: 2 }));
    s.commit("t2");
    s.setState("t1", "orphaned", "ended");
    expect(s.get("t1")?.state).toBe("orphaned");
    expect(s.get("t2")?.state).toBe("active"); // unaffected
  });

  it("NEVER reuses a generation, even after every record is removed", () => {
    // Generations fence a stale actor's decisions from a newer incarnation. If
    // removing records let a generation repeat, a late callback from the old
    // actor could be accepted by the new one.
    const f = tmpFile();
    const s = new SessionStore(f);
    expect(s.nextGeneration()).toBe(1);
    s.reserve(bind("t1", { generation: s.nextGeneration() }));
    s.reserve(bind("t2", { generation: s.nextGeneration() }));
    expect(s.nextGeneration()).toBe(3);
    s.remove("t1");
    s.remove("t2");
    expect(s.all()).toEqual([]);
    expect(s.nextGeneration()).toBe(3); // not back to 1
    expect(new SessionStore(f).nextGeneration()).toBe(3); // survives a restart
  });

  it("clear() empties the store but KEEPS the generation counter", () => {
    // Deleting the file would restart generations at 1 and let a stale actor's
    // decisions be accepted by a new incarnation.
    const f = tmpFile();
    const s = new SessionStore(f);
    s.reserve(bind("t1", { generation: 7 }));
    expect(s.clear()).toBe(true);
    expect(s.all()).toEqual([]);
    expect(new SessionStore(f).all()).toEqual([]);
    expect(new SessionStore(f).nextGeneration()).toBe(8);
  });
});

describe("SessionStore — v1 migration", () => {
  it("reads a pre-multi-session file (one bare record) and keeps it resumable", () => {
    const f = tmpFile();
    writeFileSync(
      f,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "old-thread",
        sessionId: "old-sess",
        generation: 9,
        repoPath: "C:\\repo",
        guildId: "g1",
        parentChannelId: "p1",
        state: "active",
        updatedAt: 123,
      }),
      "utf8"
    );
    const s = new SessionStore(f);
    expect(s.isCorrupt()).toBe(false);
    expect(s.all()).toHaveLength(1);
    expect(s.get("old-thread")).toMatchObject({ sessionId: "old-sess", state: "active" });
    // v1 predates isolation: that session ran directly in the controlled repo.
    expect(s.get("old-thread")?.workDir).toBe("C:\\repo");
    // and its generation must not be handed out again
    expect(s.nextGeneration()).toBe(10);
  });

  it("upgrades the file to v2 on the next write, without losing the old session", () => {
    const f = tmpFile();
    writeFileSync(
      f,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "old-thread",
        sessionId: "old-sess",
        generation: 2,
        repoPath: "C:\\repo",
        guildId: "g1",
        parentChannelId: "p1",
        state: "active",
        updatedAt: 1,
      }),
      "utf8"
    );
    const s = new SessionStore(f);
    s.reserve(bind("new-thread", { generation: s.nextGeneration() }));
    const onDisk = JSON.parse(readFileSync(f, "utf8")) as { schemaVersion: number; sessions: unknown[] };
    expect(onDisk.schemaVersion).toBe(2);
    expect(onDisk.sessions).toHaveLength(2);
    expect(new SessionStore(f).get("old-thread")?.sessionId).toBe("old-sess");
  });
});

describe("SessionStore — durability (unchanged safety properties)", () => {
  it("writes atomically (target parses as valid JSON, temp removed)", () => {
    const f = tmpFile();
    const s = new SessionStore(f);
    s.reserve(bind("t1"));
    expect(() => JSON.parse(readFileSync(f, "utf8"))).not.toThrow();
    expect(existsSync(`${f}.tmp`)).toBe(false);
  });

  it("PERSIST-FIRST: a failed write returns false AND leaves memory unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "dcs-store-ro-"));
    const f = join(dir, "s.json");
    const s = new SessionStore(f);
    s.reserve(bind("t1"));
    s.commit("t1");
    // Make the target path unwritable by turning it into a directory.
    rmSync(f, { force: true });
    mkdirSync(f);
    try {
      expect(s.reserve(bind("t2", { generation: 2 }))).toBe(false);
      expect(s.get("t2")).toBeUndefined(); // nothing adopted
      expect(s.get("t1")?.state).toBe("active"); // prior state intact
      expect(s.setState("t1", "blocked", "x")).toBe(false);
      expect(s.get("t1")?.state).toBe("active"); // still the last DURABLE state
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write failures NEVER throw — every mutation returns false instead", () => {
    const dir = mkdtempSync(join(tmpdir(), "dcs-store-throw-"));
    const f = join(dir, "s.json");
    const s = new SessionStore(f);
    s.reserve(bind("t1"));
    rmSync(f, { force: true });
    mkdirSync(f);
    try {
      expect(() => s.commit("t1")).not.toThrow();
      expect(() => s.remove("t1")).not.toThrow();
      expect(() => s.clear()).not.toThrow();
      expect(s.commit("t1")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CORRUPT != absent: an unparseable file sets isCorrupt()", () => {
    const f = tmpFile();
    writeFileSync(f, "{ not json", "utf8");
    expect(new SessionStore(f).isCorrupt()).toBe(true);
  });

  it("a structurally-invalid record is corrupt, not 'absent'", () => {
    const f = tmpFile();
    writeFileSync(f, JSON.stringify({ hello: "world" }), "utf8");
    expect(new SessionStore(f).isCorrupt()).toBe(true);
  });

  it("ONE bad row invalidates the whole file (fail closed, never partial)", () => {
    // Silently dropping the unreadable row would orphan a live thread without
    // saying so.
    const f = tmpFile();
    writeFileSync(
      f,
      JSON.stringify({
        schemaVersion: 2,
        generationHighWater: 2,
        sessions: [
          {
            schemaVersion: 2,
            threadId: "good",
            sessionId: "s",
            generation: 1,
            repoPath: "r",
            guildId: "g",
            parentChannelId: "p",
            workDir: "r",
            state: "active",
            updatedAt: 1,
          },
          { threadId: "bad" },
        ],
      }),
      "utf8"
    );
    const s = new SessionStore(f);
    expect(s.isCorrupt()).toBe(true);
    expect(s.all()).toEqual([]);
  });

  it("a NON-ENOENT read error (path is a directory) is corrupt, not 'absent'", () => {
    const dir = mkdtempSync(join(tmpdir(), "dcs-store-dir-"));
    try {
      expect(new SessionStore(dir).isCorrupt()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
