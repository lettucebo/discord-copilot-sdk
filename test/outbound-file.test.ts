import path from "node:path";
import os from "node:os";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  promises as fsPromises,
} from "node:fs";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  resolveOutboundFile,
  DISCORD_BLOCKED_EXECUTABLE_EXTENSIONS,
  type OutboundFilePolicy,
} from "../src/core/outbound-file.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "dcs-outbound-file-"));
  roots.push(root);
  return root;
}

function write(root: string, rel: string, content: Buffer | string): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveOutboundFile", () => {
  it("returns a normal agent artifact with bytes and sanitized display name", async () => {
    const root = makeRoot();
    const abs = write(root, "artifacts\\report.txt", "hello report");

    const result = await resolveOutboundFile(root, "artifacts\\report.txt", {
      maxBytes: 1024,
      policy: "agent",
    });

    expect(result).toEqual({
      ok: true,
      file: {
        absPath: abs,
        displayName: "report.txt",
        size: 12,
        fingerprint: expect.any(String),
        digest: "sha256:6dce0a4409fabc637beaa80f9a1d36e0528575f6201c4834d02f6ec7e421fd66",
        bytes: Buffer.from("hello report"),
      },
    });
  });

  it("accepts an absolute path that stays inside the worktree", async () => {
    const root = makeRoot();
    const abs = write(root, "logs\\session.log", "ok");

    const result = await resolveOutboundFile(root, abs, { maxBytes: 64, policy: "agent" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.absPath).toBe(abs);
  });

  it("refuses traversal that resolves outside the worktree", async () => {
    const root = makeRoot();
    const outsideRoot = makeRoot();
    write(outsideRoot, "secret.txt", "nope");

    const result = await resolveOutboundFile(root, path.join("..", path.basename(outsideRoot), "secret.txt"), {
      maxBytes: 64,
      policy: "agent",
    });

    expect(result).toEqual({ ok: false, reason: "outside-workdir" });
  });

  it("refuses a symlink inside the worktree that resolves outside", async () => {
    const root = makeRoot();
    const outsideRoot = makeRoot();
    write(outsideRoot, "loot.txt", "steal");
    const link = path.join(root, "escape");
    try {
      symlinkSync(outsideRoot, link, "junction");
    } catch {
      return;
    }

    const result = await resolveOutboundFile(root, "escape\\loot.txt", {
      maxBytes: 64,
      policy: "agent",
    });

    expect(result).toEqual({ ok: false, reason: "outside-workdir" });
  });

  it("refuses .git internals including a linked-worktree git file", async () => {
    const root = makeRoot();
    write(root, ".git", "gitdir: C:\\elsewhere");

    const result = await resolveOutboundFile(root, ".git", { maxBytes: 64, policy: "operator" });

    expect(result).toEqual({ ok: false, reason: ".git-internal" });
  });

  it("refuses directories", async () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "folder"), { recursive: true });

    const result = await resolveOutboundFile(root, "folder", { maxBytes: 64, policy: "operator" });

    expect(result).toEqual({ ok: false, reason: "not-regular-file" });
  });

  it("refuses zero-byte and oversized files", async () => {
    const root = makeRoot();
    write(root, "empty.txt", "");
    write(root, "big.txt", Buffer.alloc(9, 1));

    await expect(resolveOutboundFile(root, "empty.txt", { maxBytes: 8, policy: "agent" })).resolves.toEqual({
      ok: false,
      reason: "empty-file",
    });
    await expect(resolveOutboundFile(root, "big.txt", { maxBytes: 8, policy: "agent" })).resolves.toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("refuses bidi/control filenames", async () => {
    const root = makeRoot();
    const badName = `bad\u202Egnp.txt`;
    write(root, badName, "x");

    const result = await resolveOutboundFile(root, badName, { maxBytes: 8, policy: "agent" });

    expect(result).toEqual({ ok: false, reason: "unsafe-filename" });
  });

  it("enforces the asymmetric extension policy", async () => {
    const root = makeRoot();
    write(root, "artifact.exe", "MZ");
    write(root, "notes.bin", "bin");

    expect(DISCORD_BLOCKED_EXECUTABLE_EXTENSIONS.has(".exe")).toBe(true);

    await expect(resolveOutboundFile(root, "artifact.exe", { maxBytes: 8, policy: "operator" })).resolves.toEqual({
      ok: false,
      reason: "disallowed-extension",
    });
    await expect(resolveOutboundFile(root, "notes.bin", { maxBytes: 8, policy: "agent" })).resolves.toEqual({
      ok: false,
      reason: "disallowed-extension",
    });
    await expect(resolveOutboundFile(root, "notes.bin", { maxBytes: 8, policy: "operator" })).resolves.toMatchObject({
      ok: true,
      file: { displayName: "notes.bin" },
    });
  });

  it("changes fingerprint after a file replacement or modification", async () => {
    const root = makeRoot();
    const abs = write(root, "artifact.txt", "first");

    const first = await resolveOutboundFile(root, "artifact.txt", { maxBytes: 64, policy: "agent" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(abs, "second-version");

    const second = await resolveOutboundFile(root, "artifact.txt", { maxBytes: 64, policy: "agent" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.file.fingerprint).not.toBe(first.file.fingerprint);
  });

  it("changes digest for equal-size bytes even when the metadata fingerprint is restored", async () => {
    const root = makeRoot();
    const abs = write(root, "artifact.txt", "original");
    const originalOpen = fsPromises.open;
    const originalStat = fsPromises.stat;
    const stableStat = {
      isFile: () => true,
      size: 8,
      mtimeMs: 3,
    };
    const openSpy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const actualStat = await originalStat(args[0]!);
      const actualIdentity = await originalStat(args[0]!, { bigint: true });
      // Model an in-place equal-size rewrite that restored the stat tuple.
      return Object.assign(handle, {
        stat: async (options?: { bigint?: boolean }) =>
          options?.bigint ? actualIdentity : { ...stableStat, dev: actualStat.dev, ino: actualStat.ino },
      }) as typeof handle;
    });

    try {
      const first = await resolveOutboundFile(root, "artifact.txt", { maxBytes: 64, policy: "agent" });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      writeFileSync(abs, "replaced");

      const second = await resolveOutboundFile(root, "artifact.txt", { maxBytes: 64, policy: "agent" });
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      expect(second.file.fingerprint).toBe(first.file.fingerprint);
      expect(second.file.digest).not.toBe(first.file.digest);
      expect(second.file.bytes).toEqual(Buffer.from("replaced"));
    } finally {
      openSpy.mockRestore();
    }
  });

  it("refuses a size-raced file when the bytes no longer match the handle stat", async () => {
    const root = makeRoot();
    const abs = write(root, "race.txt", "abcdef");
    let truncated = false;

    const readOnce = vi.fn(async function (this: { readFile: () => Promise<Buffer> }) {
      if (!truncated) {
        truncated = true;
        writeFileSync(abs, "abc");
      }
      return Buffer.from("abc");
    });

    try {
      const originalOpen = fsPromises.open;
      vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        return Object.assign(handle, { readFile: readOnce }) as typeof handle;
      });
      const result = await resolveOutboundFile(root, "race.txt", { maxBytes: 64, policy: "agent" });
      expect(result).toEqual({ ok: false, reason: "unreadable" });
      expect(readOnce).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("rejects a reparse-like final candidate before opening it", async () => {
    const root = makeRoot();
    const target = write(root, "artifact.txt", "artifact");
    const originalLstat = fsPromises.lstat;
    const openSpy = vi.spyOn(fsPromises, "open");
    const lstatSpy = vi.spyOn(fsPromises, "lstat").mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(target)) {
        return {
          isSymbolicLink: () => true,
          isFile: () => false,
        } as Awaited<ReturnType<typeof fsPromises.lstat>>;
      }
      return originalLstat(...args);
    });

    try {
      await expect(resolveOutboundFile(root, "artifact.txt", { maxBytes: 64, policy: "agent" })).resolves.toEqual({
        ok: false,
        reason: "not-regular-file",
      });
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      lstatSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("refuses an opened handle when a post-open canonicalization shows an outside swap", async () => {
    const root = makeRoot();
    const target = write(root, "artifact.txt", "inside");
    const outsideRoot = makeRoot();
    const outside = write(outsideRoot, "artifact.txt", "outside");
    const originalOpen = fsPromises.open;
    const originalRealpath = fsPromises.realpath;
    let opened = false;
    const openSpy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      opened = true; // The attacker swaps the name after this handle bound the old file.
      return handle;
    });
    const realpathSpy = vi.spyOn(fsPromises, "realpath").mockImplementation(async (...args) => {
      if (opened && path.resolve(String(args[0])) === path.resolve(target)) return outside;
      return originalRealpath(...args);
    });

    try {
      await expect(resolveOutboundFile(root, "artifact.txt", { maxBytes: 64, policy: "agent" })).resolves.toEqual({
        ok: false,
        reason: "outside-workdir",
      });
      expect(openSpy).toHaveBeenCalledTimes(1);
    } finally {
      realpathSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("refuses an opened handle when post-open path identity differs", async () => {
    const root = makeRoot();
    const target = write(root, "artifact.txt", "inside");
    const originalStat = fsPromises.stat;
    const statSpy = vi.spyOn(fsPromises, "stat").mockImplementation(async (...args) => {
      const stat = await originalStat(...args);
      if (path.resolve(String(args[0])) !== path.resolve(target)) return stat;
      return {
        ...stat,
        ino: typeof stat.ino === "bigint" ? stat.ino + 1n : stat.ino + 1024,
      } as typeof stat;
    });

    try {
      await expect(resolveOutboundFile(root, "artifact.txt", { maxBytes: 64, policy: "agent" })).resolves.toEqual({
        ok: false,
        reason: "unreadable",
      });
      expect(statSpy).toHaveBeenCalled();
    } finally {
      statSpy.mockRestore();
    }
  });

  it("maps handle read permission failures to unreadable", async () => {
    const root = makeRoot();
    const target = write(root, "denied.txt", "secret");
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" as const });
    const candidateStat = await fsPromises.stat(target);
    const candidateIdentity = await fsPromises.stat(target, { bigint: true });

    const readFile = vi.fn(async () => {
      throw denied;
    });

    const close = vi.fn(async () => undefined);
    const stat = vi.fn(async (options?: { bigint?: boolean }) =>
      options?.bigint
        ? candidateIdentity
        : {
            isFile: () => true,
            size: 6,
            dev: candidateStat.dev,
            ino: candidateStat.ino,
            mtimeMs: 3,
          }
    );

    const openSpy = vi.spyOn(fsPromises, "open").mockResolvedValue({
      stat,
      readFile,
      close,
    } as unknown as Awaited<ReturnType<typeof fsPromises.open>>);

    try {
      const result = await resolveOutboundFile(root, "denied.txt", { maxBytes: 64, policy: "agent" });

      expect(result).toEqual({ ok: false, reason: "unreadable" });
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(stat).toHaveBeenCalledTimes(2);
      expect(readFile).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("refuses missing paths", async () => {
    const root = makeRoot();
    const missing = await resolveOutboundFile(root, "ghost.txt", { maxBytes: 64, policy: "agent" });
    expect(missing).toEqual({ ok: false, reason: "not-found" });
  });
});
