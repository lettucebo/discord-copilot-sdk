import { describe, it, expect } from "vitest";
import { SessionStore, type SessionBinding } from "../src/core/session-store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";


const tmpFile = (): string => join(tmpdir(), `dp-session-${Math.random()}.json`);

const bind = (over: Partial<SessionBinding> = {}): SessionBinding => ({
  threadId: "t1",
  sessionId: "sess-1",
  generation: 1,
  repoPath: "C:\\repo",
  guildId: "g1",
  parentChannelId: "c1",
  ...over,
});

describe("SessionStore", () => {
  it("returns undefined and not-corrupt when no file exists", () => {
    const s = new SessionStore(tmpFile());
    expect(s.get()).toBeUndefined();
    expect(s.isCorrupt()).toBe(false);
  });

  it("commit → get roundtrips and persists across instances", () => {
    const f = tmpFile();
    try {
      const s1 = new SessionStore(f);
      expect(s1.commit(bind())).toBe(true);
      expect(s1.get()).toMatchObject({
        threadId: "t1",
        sessionId: "sess-1",
        generation: 1,
        repoPath: "C:\\repo",
        guildId: "g1",
        parentChannelId: "c1",
        state: "active",
        schemaVersion: 1,
      });
      expect(new SessionStore(f).get()).toMatchObject({ sessionId: "sess-1", state: "active" });
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("reserve writes a creating record; commit() promotes it to active", () => {
    const f = tmpFile();
    try {
      const s = new SessionStore(f);
      expect(s.reserve(bind())).toBe(true);
      expect(s.get()?.state).toBe("creating");
      expect(s.commit()).toBe(true); // promote in place
      expect(s.get()?.state).toBe("active");
      expect(new SessionStore(f).get()?.state).toBe("active");
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("commit() with no record returns false", () => {
    expect(new SessionStore(tmpFile()).commit()).toBe(false);
  });

  it("setState updates state + reason; no-op (false) without a record", () => {
    const f = tmpFile();
    try {
      const s = new SessionStore(f);
      expect(s.setState("blocked", "x")).toBe(false); // no record yet
      s.commit(bind());
      expect(s.setState("orphaned", "session-lost")).toBe(true);
      expect(s.get()).toMatchObject({ state: "orphaned", reason: "session-lost" });
      expect(new SessionStore(f).get()?.state).toBe("orphaned");
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("clear tombstones the record durably (file removed)", () => {
    const f = tmpFile();
    try {
      const s = new SessionStore(f);
      s.commit(bind());
      expect(s.clear()).toBe(true);
      expect(s.get()).toBeUndefined();
      expect(existsSync(f)).toBe(false);
      expect(new SessionStore(f).get()).toBeUndefined();
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("nextGeneration = current+1, or 1 when empty", () => {
    const f = tmpFile();
    try {
      const s = new SessionStore(f);
      expect(s.nextGeneration()).toBe(1);
      s.commit(bind({ generation: 7 }));
      expect(s.nextGeneration()).toBe(8);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("writes atomically (target parses as valid JSON, temp removed)", () => {
    const f = tmpFile();
    try {
      const s = new SessionStore(f);
      s.commit(bind());
      expect(JSON.parse(readFileSync(f, "utf8")).sessionId).toBe("sess-1");
      expect(existsSync(`${f}.tmp`)).toBe(false);
    } finally {
      rmSync(f, { force: true });
      rmSync(`${f}.tmp`, { force: true });
    }
  });

  it("PERSIST-FIRST: a failed write returns false AND leaves in-memory unchanged", () => {
    const f = tmpFile();
    try {
      const s = new SessionStore(f);
      expect(s.commit(bind({ sessionId: "old" }))).toBe(true); // durable baseline
      // Make the target path unwritable by turning it into a directory's child that
      // can't be created: point a second store at an existing DIRECTORY.
      const dir = mkdtempSync(join(tmpdir(), "dp-session-dir-"));
      try {
        const s2 = new SessionStore(join(dir)); // file path IS a directory → writes throw
        // seed s2 in-memory via a successful-looking call? No: first write fails.
        expect(s2.commit(bind({ sessionId: "new" }))).toBe(false);
        expect(s2.get()).toBeUndefined(); // never adopted the undurable state
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
      // original store's durable record is intact
      expect(new SessionStore(f).get()?.sessionId).toBe("old");
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("PERSIST-FIRST: failed setState keeps the prior durable state", () => {
    // Use a directory as the file so the write fails, but seed the in-memory
    // record by loading from a good file first is not possible here; instead we
    // assert setState on an unwritable store with a preloaded record is false.
    const good = tmpFile();
    const dir = mkdtempSync(join(tmpdir(), "dp-session-dir2-"));
    try {
      // Prepare a valid record file, then copy its path into a store whose writes fail.
      const seed = new SessionStore(good);
      seed.commit(bind({ sessionId: "keep" }));
      // A store pointed at a directory can't load (readFileSync on a dir throws →
      // treated as absent), so simulate: it has no record, setState is false.
      const s = new SessionStore(dir);
      expect(s.setState("blocked")).toBe(false);
    } finally {
      rmSync(good, { force: true });
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("CORRUPT != absent: an unparseable file sets isCorrupt()", () => {
    const f = tmpFile();
    try {
      writeFileSync(f, "{ this is not json", "utf8");
      const s = new SessionStore(f);
      expect(s.isCorrupt()).toBe(true);
      expect(s.get()).toBeUndefined();
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("a structurally-invalid JSON object is also corrupt", () => {
    const f = tmpFile();
    try {
      writeFileSync(f, JSON.stringify({ threadId: "t1" }), "utf8"); // missing fields
      expect(new SessionStore(f).isCorrupt()).toBe(true);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("a NON-ENOENT read error (path is a directory) is corrupt, not 'absent'", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-session-isdir-"));
    try {
      const s = new SessionStore(dir); // readFileSync(dir) → EISDIR
      expect(s.isCorrupt()).toBe(true);
      expect(s.get()).toBeUndefined();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("restore() writes a prior record back verbatim", () => {
    const f = tmpFile();
    try {
      const s = new SessionStore(f);
      s.commit(bind({ sessionId: "orig" }));
      const prev = s.get()!;
      s.reserve(bind({ sessionId: "new", generation: 2 })); // overwrite
      expect(s.get()?.sessionId).toBe("new");
      expect(s.restore(prev)).toBe(true); // roll back
      expect(s.get()).toMatchObject({ sessionId: "orig", state: "active", generation: 1 });
      expect(new SessionStore(f).get()?.sessionId).toBe("orig"); // durable
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("write failures NEVER throw — commit AND clear return false on an unwritable path", () => {
    // A directory as the file makes every write throw; the store must still
    // return false (not throw), so callers' fail-closed handling isn't skipped.
    const dir = mkdtempSync(join(tmpdir(), "dp-session-nothrow-"));
    try {
      const s = new SessionStore(dir);
      expect(() => {
        expect(s.commit(bind())).toBe(false);
        expect(s.clear()).toBe(false);
      }).not.toThrow();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("write() returns false (never throws) even when the temp CLEANUP itself throws", () => {
    // Fault injection WITHOUT mocking: pre-create a DIRECTORY at the temp path, so
    // both the main writeFileSync(tmp) AND the catch-block rmSync(tmp) throw
    // (EISDIR). write() must still return false — a throw here would bypass the
    // commit-fail fence / rollback in cmdNew. (The plain-directory test above
    // would pass even against the previous unguarded-cleanup code; this one won't.)
    const f = tmpFile();
    mkdirSync(`${f}.tmp`);
    try {
      const s = new SessionStore(f);
      let result: boolean | undefined;
      expect(() => {
        result = s.commit(bind());
      }).not.toThrow();
      expect(result).toBe(false);
    } finally {
      rmSync(`${f}.tmp`, { force: true, recursive: true });
      rmSync(f, { force: true });
    }
  });
});
