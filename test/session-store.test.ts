import { describe, it, expect, vi } from "vitest";
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
  devMode: "local",
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

  it("commit clears a retry reason after the session successfully becomes active", () => {
    const f = tmpFile();
    const s = new SessionStore(f);
    s.reserve(bind("t1"));
    s.commit("t1");
    expect(s.setState("t1", "active", "thread-no-access")).toBe(true);

    expect(s.commit("t1")).toBe(true);

    expect(s.get("t1")).toMatchObject({ state: "active" });
    expect(s.get("t1")?.reason).toBeUndefined();
    expect(new SessionStore(f).get("t1")?.reason).toBeUndefined();
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

  it("persists a terminal stale rebind binding separately from its replacement", () => {
    const f = tmpFile();
    const store = new SessionStore(f);
    expect(
      store.reserve(
        bind("t1", {
          sessionId: "old-session",
          generation: 1,
          workDir: "C:\\wt\\old",
          devMode: "worktree",
          branch: "copilot/t-t1",
        })
      )
    ).toBe(true);
    expect(store.commit("t1")).toBe(true);
    const old = store.get("t1")!;
    expect(
      (
        store as unknown as {
          retainStaleRebind(record: typeof old, reason: string): boolean;
        }
      ).retainStaleRebind(old, "rebind-teardown-unconfirmed")
    ).toBe(true);

    expect(
      store.reserve(
        bind("t1", {
          sessionId: "replacement-session",
          generation: 2,
          workDir: "C:\\wt\\replacement",
          devMode: "worktree",
          branch: "copilot/t-t1",
        })
      )
    ).toBe(true);
    expect(store.commit("t1")).toBe(true);

    const reloaded = new SessionStore(f) as unknown as {
      get(threadId: string): ReturnType<SessionStore["get"]>;
      staleRebinds(): Array<ReturnType<SessionStore["get"]> extends infer R ? Exclude<R, undefined> : never>;
    };
    expect(reloaded.get("t1")).toMatchObject({ sessionId: "replacement-session", generation: 2, state: "active" });
    expect(reloaded.staleRebinds()).toEqual([
      expect.objectContaining({
        threadId: "t1",
        sessionId: "old-session",
        generation: 1,
        workDir: "C:\\wt\\old",
        branch: "copilot/t-t1",
        state: "blocked",
        reason: "rebind-teardown-unconfirmed",
      }),
    ]);
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
    // …which is what `local` mode now means.
    expect(s.get("old-thread")?.devMode).toBe("local");
    // and its generation must not be handed out again
    expect(s.nextGeneration()).toBe(10);
  });

  it("upgrades the file to the current schema on the next write, without losing the old session", () => {
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
    expect(onDisk.schemaVersion).toBe(5);
    expect(onDisk.sessions).toHaveLength(2);
    expect(new SessionStore(f).get("old-thread")?.sessionId).toBe("old-sess");
  });
});

describe("SessionStore — durable file delivery quota", () => {
  it("defaults a new record and migrates a pre-quota record to zero bytes", () => {
    const freshFile = tmpFile();
    const fresh = new SessionStore(freshFile);
    expect(fresh.reserve(bind("fresh"))).toBe(true);
    expect(fresh.get("fresh")?.fileDeliveryBytes).toBe(0);
    expect(new SessionStore(freshFile).get("fresh")?.fileDeliveryBytes).toBe(0);

    const legacyFile = tmpFile();
    writeFileSync(
      legacyFile,
      JSON.stringify({
        schemaVersion: 3,
        generationHighWater: 1,
        sessions: [
          {
            schemaVersion: 3,
            threadId: "legacy",
            sessionId: "s-legacy",
            generation: 1,
            repoPath: "C:\\repo",
            guildId: "g1",
            parentChannelId: "p1",
            workDir: "C:\\repo",
            devMode: "local",
            state: "active",
            updatedAt: 1,
          },
        ],
      }),
      "utf8"
    );
    const legacy = new SessionStore(legacyFile);
    expect(legacy.isCorrupt()).toBe(false);
    expect(legacy.get("legacy")?.fileDeliveryBytes).toBe(0);
    expect(legacy.commit("legacy")).toBe(true);
    expect(JSON.parse(readFileSync(legacyFile, "utf8")).sessions[0].fileDeliveryBytes).toBe(0);
  });

  it("rejects a malformed persisted byte total rather than resetting it to zero", () => {
    const f = tmpFile();
    writeFileSync(
      f,
      JSON.stringify({
        schemaVersion: 3,
        generationHighWater: 1,
        sessions: [
          {
            schemaVersion: 3,
            threadId: "t1",
            sessionId: "s1",
            generation: 1,
            repoPath: "C:\\repo",
            guildId: "g1",
            parentChannelId: "p1",
            workDir: "C:\\repo",
            devMode: "local",
            state: "active",
            updatedAt: 1,
            fileDeliveryBytes: "not-a-byte-total",
          },
        ],
      }),
      "utf8"
    );

    const store = new SessionStore(f);
    expect(store.isCorrupt()).toBe(true);
    expect(store.all()).toEqual([]);
  });

  it("persists a compare-and-set file delivery reservation", () => {
    const f = tmpFile();
    const store = new SessionStore(f);
    expect(store.reserve(bind("t1"))).toBe(true);
    expect(store.reserveFileDeliveryBytes("t1", "sess-t1", 1, 0, 42)).toBe(true);
    expect(store.get("t1")?.fileDeliveryBytes).toBe(42);
    expect(new SessionStore(f).get("t1")?.fileDeliveryBytes).toBe(42);
    expect(store.reserveFileDeliveryBytes("t1", "sess-t1", 1, 0, 50)).toBe(false);
    expect(store.reserveFileDeliveryBytes("t1", "sess-t1", 1, 42, 41)).toBe(false);
    expect(store.get("t1")?.fileDeliveryBytes).toBe(42);
  });

  it("refuses a stale restore rather than lowering a newer incarnation's reserved quota", () => {
    const f = tmpFile();
    const store = new SessionStore(f);
    expect(store.reserve(bind("t1", { sessionId: "old", generation: 1, fileDeliveryBytes: 17 }))).toBe(true);
    const prior = store.get("t1")!;
    expect(store.reserve(bind("t1", { sessionId: "new", generation: 2, fileDeliveryBytes: 17 }))).toBe(true);
    expect(store.reserveFileDeliveryBytes("t1", "new", 2, 17, 25)).toBe(true);

    expect(store.restore(prior)).toBe(false);
    expect(new SessionStore(f).get("t1")).toMatchObject({
      sessionId: "new",
      generation: 2,
      fileDeliveryBytes: 25,
    });
  });

  it("keeps an advanced replacement reservation across conditional rollback and restart", () => {
    const f = tmpFile();
    const store = new SessionStore(f);
    expect(store.reserve(bind("t1", { sessionId: "old", generation: 1, fileDeliveryBytes: 17 }))).toBe(true);
    const prior = store.get("t1")!;
    expect(store.reserve(bind("t1", { sessionId: "replacement", generation: 2, fileDeliveryBytes: 17 }))).toBe(true);
    expect(store.reserveFileDeliveryBytes("t1", "replacement", 2, 17, 25)).toBe(true);

    expect(store.restoreIfCurrent(prior, "replacement", 2)).toEqual({ ok: true, quotaAdvanced: true });
    expect(store.get("t1")).toMatchObject({
      sessionId: "old",
      generation: 1,
      fileDeliveryBytes: 25,
    });
    expect(new SessionStore(f).get("t1")?.fileDeliveryBytes).toBe(25);
  });

  it("atomically restores the original record and clears paired stale rows from a matching fallback reservation", () => {
    const f = tmpFile();
    const store = new SessionStore(f);
    expect(store.reserve(bind("t1", { sessionId: "old", generation: 1, fileDeliveryBytes: 17 }))).toBe(true);
    expect(store.commit("t1")).toBe(true);
    const original = store.get("t1")!;
    expect(store.retainStaleRebind(original, "rebind-cleanup-pending")).toBe(true);
    expect(store.reserve(bind("t1", { sessionId: "target", generation: 2, fileDeliveryBytes: 17 }))).toBe(true);
    const target = { threadId: "t1", sessionId: "target", generation: 2 };
    expect(
      store.retainStaleRebind(store.get("t1")!, "rebind-teardown-unconfirmed")
    ).toBe(true);

    expect(
      store.reconcileFallbackPrimary(target, {
        kind: "restore",
        original,
        staleRebinds: [
          target,
          { threadId: "t1", sessionId: original.sessionId, generation: original.generation },
        ],
      })
    ).toEqual({ ok: true, quotaAdvanced: false });

    expect(store.get("t1")).toMatchObject({
      sessionId: "old",
      generation: 1,
      state: "active",
      fileDeliveryBytes: 17,
    });
    expect(store.staleRebinds()).toEqual([]);
    expect(new SessionStore(f).get("t1")).toMatchObject({ sessionId: "old", generation: 1, state: "active" });
    expect(new SessionStore(f).staleRebinds()).toEqual([]);
  });

  it("leaves the primary fallback and stale tracker rows untouched when its target identity no longer matches", () => {
    const f = tmpFile();
    const store = new SessionStore(f);
    expect(store.reserve(bind("t1", { sessionId: "old", generation: 1 }))).toBe(true);
    expect(store.commit("t1")).toBe(true);
    const original = store.get("t1")!;
    expect(store.retainStaleRebind(original, "rebind-cleanup-pending")).toBe(true);
    expect(store.reserve(bind("t1", { sessionId: "newer", generation: 3 }))).toBe(true);
    const stale = { threadId: "t1", sessionId: original.sessionId, generation: original.generation };

    expect(
      store.reconcileFallbackPrimary(
        { threadId: "t1", sessionId: "target", generation: 2 },
        { kind: "restore", original, staleRebinds: [stale] }
      )
    ).toEqual({ ok: false, quotaAdvanced: false });

    expect(store.get("t1")).toMatchObject({ sessionId: "newer", generation: 3, state: "creating" });
    expect(store.staleRebinds()).toEqual([expect.objectContaining(stale)]);
    expect(new SessionStore(f).get("t1")).toMatchObject({ sessionId: "newer", generation: 3 });
    expect(new SessionStore(f).staleRebinds()).toEqual([expect.objectContaining(stale)]);
  });

  it("leaves the fallback and stale rows unchanged when atomic reconciliation cannot persist", () => {
    const dir = mkdtempSync(join(tmpdir(), "dcs-store-fallback-persist-"));
    const f = join(dir, "s.json");
    const store = new SessionStore(f);
    try {
      expect(store.reserve(bind("t1", { sessionId: "old", generation: 1 }))).toBe(true);
      expect(store.commit("t1")).toBe(true);
      const original = store.get("t1")!;
      expect(store.retainStaleRebind(original, "rebind-cleanup-pending")).toBe(true);
      expect(store.reserve(bind("t1", { sessionId: "target", generation: 2 }))).toBe(true);
      const target = { threadId: "t1", sessionId: "target", generation: 2 };

      rmSync(f, { force: true });
      mkdirSync(f);
      expect(
        store.reconcileFallbackPrimary(target, {
          kind: "restore",
          original,
          staleRebinds: [
            target,
            { threadId: "t1", sessionId: original.sessionId, generation: original.generation },
          ],
        })
      ).toEqual({ ok: false, quotaAdvanced: false });

      expect(store.get("t1")).toMatchObject({ sessionId: "target", generation: 2, state: "creating" });
      expect(store.staleRebinds()).toEqual([
        expect.objectContaining({ sessionId: "old", generation: 1, state: "blocked" }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes a matching fallback reservation without restoring the original record", () => {
    const f = tmpFile();
    const store = new SessionStore(f);
    expect(store.reserve(bind("t1", { sessionId: "old", generation: 1 }))).toBe(true);
    expect(store.commit("t1")).toBe(true);
    const original = store.get("t1")!;
    expect(store.reserve(bind("t1", { sessionId: "target", generation: 2 }))).toBe(true);
    const target = { threadId: "t1", sessionId: "target", generation: 2 };

    expect(store.reconcileFallbackPrimary(target, { kind: "remove", staleRebinds: [target] })).toEqual({
      ok: true,
      quotaAdvanced: false,
    });

    expect(store.get("t1")).toBeUndefined();
    expect(store.staleRebinds()).toEqual([]);
    expect(new SessionStore(f).get("t1")).toBeUndefined();
  });

  it("fails closed if a persisted v4 row later loses its reserved byte total", () => {
    const f = tmpFile();
    writeFileSync(
      f,
      JSON.stringify({
        schemaVersion: 3,
        generationHighWater: 1,
        sessions: [
          {
            schemaVersion: 3,
            threadId: "legacy",
            sessionId: "s-legacy",
            generation: 1,
            repoPath: "C:\\repo",
            guildId: "g1",
            parentChannelId: "p1",
            workDir: "C:\\repo",
            devMode: "local",
            state: "active",
            updatedAt: 1,
          },
        ],
      }),
      "utf8"
    );

    const migrated = new SessionStore(f);
    expect(migrated.isCorrupt()).toBe(false);
    expect(migrated.get("legacy")?.fileDeliveryBytes).toBe(0);
    expect(migrated.reserveFileDeliveryBytes("legacy", "s-legacy", 1, 0, 42)).toBe(true);

    const persisted = JSON.parse(readFileSync(f, "utf8")) as {
      schemaVersion: number;
      sessions: Array<Record<string, unknown>>;
    };
    expect(persisted.schemaVersion).toBe(5);
    expect(persisted.sessions[0]?.schemaVersion).toBe(5);
    expect(persisted.sessions[0]?.fileDeliveryBytes).toBe(42);

    delete persisted.sessions[0]!.fileDeliveryBytes;
    writeFileSync(f, JSON.stringify(persisted), "utf8");

    const restarted = new SessionStore(f);
    expect(restarted.isCorrupt()).toBe(true);
    expect(restarted.all()).toEqual([]);
  });

  it("rejects a downgraded row in a v4 container instead of migrating its missing quota", () => {
    const f = tmpFile();
    const store = new SessionStore(f);
    expect(store.reserve(bind("t1"))).toBe(true);
    const persisted = JSON.parse(readFileSync(f, "utf8")) as {
      schemaVersion: number;
      sessions: Array<Record<string, unknown>>;
    };
    expect(persisted.schemaVersion).toBe(5);
    persisted.sessions[0]!.schemaVersion = 3;
    delete persisted.sessions[0]!.fileDeliveryBytes;
    writeFileSync(f, JSON.stringify(persisted), "utf8");

    const restarted = new SessionStore(f);
    expect(restarted.isCorrupt()).toBe(true);
    expect(restarted.all()).toEqual([]);
  });

  it("keeps the prior byte total in memory when its durable reservation fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "dcs-store-quota-ro-"));
    const f = join(dir, "s.json");
    const store = new SessionStore(f);
    expect(store.reserve(bind("t1"))).toBe(true);
    expect(store.reserveFileDeliveryBytes("t1", "sess-t1", 1, 0, 10)).toBe(true);
    rmSync(f, { force: true });
    mkdirSync(f);
    try {
      expect(store.reserveFileDeliveryBytes("t1", "sess-t1", 1, 10, 20)).toBe(false);
      expect(store.get("t1")?.fileDeliveryBytes).toBe(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SessionStore — devMode migration (v3)", () => {
  /** Write a v2 store file holding one record with `over` applied. */
  function v2File(over: Record<string, unknown>): string {
    const f = tmpFile();
    writeFileSync(
      f,
      JSON.stringify({
        schemaVersion: 2,
        generationHighWater: 4,
        sessions: [
          {
            schemaVersion: 2,
            threadId: "t1",
            sessionId: "s1",
            generation: 4,
            repoPath: "C:\\repo",
            guildId: "g1",
            parentChannelId: "p1",
            workDir: "C:\\repo",
            state: "active",
            updatedAt: 1,
            ...over,
          },
        ],
      }),
      "utf8"
    );
    return f;
  }

  it("reads a v2 WORKTREE record (it has a branch) as devMode=worktree", () => {
    const f = v2File({ workDir: "C:\\wt\\t1", branch: "copilot/t-t1" });
    expect(new SessionStore(f).get("t1")).toMatchObject({ devMode: "worktree", branch: "copilot/t-t1" });
  });

  it("reads a v2 SHARED record (no branch, workDir === repoPath) as devMode=local", () => {
    // This is the migration that must NOT be left to inference at the call site:
    // a shared-isolation session really did work directly in the repo, which is
    // exactly what `local` now means — and `local` is the mode that needs a
    // repo lease, so getting it wrong lets two sessions share one checkout.
    expect(new SessionStore(v2File({})).get("t1")).toMatchObject({ devMode: "local" });
    expect(new SessionStore(v2File({})).get("t1")?.branch).toBeUndefined();
  });

  it("honours an explicit devMode over the inference", () => {
    const f = v2File({ devMode: "worktree", workDir: "C:\\wt\\t1", branch: "b" });
    expect(new SessionStore(f).get("t1")?.devMode).toBe("worktree");
  });

  it("ignores a devMode that is not one of the two modes, rather than trusting it", () => {
    const f = v2File({ devMode: "shared" });
    expect(new SessionStore(f).get("t1")?.devMode).toBe("local");
  });

  it("does NOT copy unknown or wrongly-typed fields out of the JSON", () => {
    // The old reader spread the raw object, so a `branch: 42` (or any field a
    // future version adds) landed in a typed record unchecked.
    const f = v2File({ branch: 42, injected: "surprise" });
    const rec = new SessionStore(f).get("t1") as Record<string, unknown> | undefined;
    expect(rec?.["branch"]).toBeUndefined();
    expect(rec?.["injected"]).toBeUndefined();
    expect(rec?.["devMode"]).toBe("local"); // a non-string branch is not a branch
  });

  it("still rejects a record missing a required field (corrupt, not silently fresh)", () => {
    const f = v2File({ sessionId: undefined });
    expect(new SessionStore(f).isCorrupt()).toBe(true);
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

describe("SessionStore — transient Windows write failures", () => {
  it("RETRIES a rename that fails once, instead of reporting a false failure", async () => {
    // On Windows `rename` can fail with a transient EPERM/EACCES/EBUSY when an
    // antivirus scanner, the search indexer, or a backup agent holds the target
    // for a moment. A single attempt turns that into commit() === false, and
    // cmdNew then tells the operator the DISK is broken and DELETES the thread
    // it just created — for a condition that succeeds milliseconds later.
    //
    // The failure is exercised on commit() REPLACING AN EXISTING FILE, which is
    // the shape the production failure actually takes: replacing an existing
    // target is what Windows contends on, not creating a new one.
    const fs = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "dcs-store-retry-"));
    const f = join(dir, "s.json");
    const s = new SessionStore(f);
    expect(s.reserve(bind("t1"))).toBe(true); // file now exists
    const real = fs.default.renameSync;
    let calls = 0;
    const spy = vi.spyOn(fs.default, "renameSync").mockImplementation(((a: string, b: string) => {
      calls++;
      if (calls === 1) {
        const e = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
      }
      return real(a, b);
    }) as typeof fs.default.renameSync);
    try {
      expect(s.commit("t1")).toBe(true); // survived the transient failure
      expect(calls).toBeGreaterThan(1); // and it really did retry
      expect(s.get("t1")?.state).toBe("active");
      expect(JSON.parse(readFileSync(f, "utf8")).sessions[0].state).toBe("active"); // durable
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still gives up — and reports false — when the failure is permanent", async () => {
    // Retrying must not turn a real, persistent failure into a hang or a lie.
    const fs = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "dcs-store-perm-"));
    const f = join(dir, "s.json");
    const spy = vi.spyOn(fs.default, "renameSync").mockImplementation((() => {
      const e = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    }) as typeof fs.default.renameSync);
    try {
      const s = new SessionStore(f);
      expect(s.reserve(bind("t1"))).toBe(false);
      expect(s.get("t1")).toBeUndefined(); // persist-first still holds
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
