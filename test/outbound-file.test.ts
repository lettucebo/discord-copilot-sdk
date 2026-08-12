import path from "node:path";
import os from "node:os";
import {
  linkSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import {
  resolveOutboundFile,
  DISCORD_BLOCKED_EXECUTABLE_EXTENSIONS,
} from "../src/core/outbound-file.js";
import { captureTrustedRoot } from "../src/core/secure-open.js";

const roots: string[] = [];

function supportsHardLinks(): boolean {
  const probeRoot = mkdtempSync(path.join(os.tmpdir(), "dcs-hardlink-probe-"));
  try {
    const source = path.join(probeRoot, "source.txt");
    writeFileSync(source, "probe");
    linkSync(source, path.join(probeRoot, "linked.txt"));
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP") return false;
    throw error;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

const hardLinksSupported = supportsHardLinks();

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

async function resolveForTest(
  root: string,
  requestedPath: string,
  options: Parameters<typeof resolveOutboundFile>[2]
) {
  const trustedRoot = await captureTrustedRoot(root);
  try {
    return await resolveOutboundFile(trustedRoot, requestedPath, options);
  } finally {
    await trustedRoot.close();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveOutboundFile", () => {
  it("returns a normal agent artifact with bytes and sanitized display name", async () => {
    const root = makeRoot();
    const requestedPath = path.join("artifacts", "report.txt");
    const abs = write(root, requestedPath, "hello report");
    const trustedRoot = await captureTrustedRoot(root);

    let result: Awaited<ReturnType<typeof resolveOutboundFile>>;
    try {
      result = await resolveOutboundFile(trustedRoot, requestedPath, {
        maxBytes: 1024,
        policy: "agent",
      });
    } finally {
      await trustedRoot.close();
    }

    expect(result).toEqual({
      ok: true,
      file: {
        absPath: abs,
        displayName: "report.txt",
        relativePath: requestedPath,
        size: 12,
        fingerprint: expect.any(String),
        digest: "sha256:6dce0a4409fabc637beaa80f9a1d36e0528575f6201c4834d02f6ec7e421fd66",
        bytes: Buffer.from("hello report"),
      },
    });
  });

  it("accepts an absolute path that stays inside the worktree", async () => {
    const root = makeRoot();
    const abs = write(root, path.join("logs", "session.log"), "ok");

    const result = await resolveForTest(root, abs, { maxBytes: 64, policy: "agent" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.absPath).toBe(abs);
  });

  it("refuses traversal that resolves outside the worktree", async () => {
    const root = makeRoot();
    const outsideRoot = makeRoot();
    write(outsideRoot, "secret.txt", "nope");

    const result = await resolveForTest(root, path.join("..", path.basename(outsideRoot), "secret.txt"), {
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

    const result = await resolveForTest(root, path.join("escape", "loot.txt"), {
      maxBytes: 64,
      policy: "agent",
    });

    expect(result).toEqual({ ok: false, reason: "outside-workdir" });
  });

  it.skipIf(!hardLinksSupported)("refuses an externally reachable hard-linked candidate without returning bytes", async () => {
    const root = makeRoot();
    const outsideRoot = makeRoot();
    const outside = write(outsideRoot, "secret.txt", "external bytes");
    const candidate = path.join(root, "artifact.txt");
    linkSync(outside, candidate);

    const result = await resolveForTest(root, candidate, { maxBytes: 64, policy: "agent" });

    expect(result).toEqual({ ok: false, reason: "unreadable" });
    expect(result).not.toHaveProperty("file");
  });

  it("refuses .git internals including a linked-worktree git file", async () => {
    const root = makeRoot();
    write(root, ".git", "gitdir: C:\\elsewhere");

    const result = await resolveForTest(root, ".git", { maxBytes: 64, policy: "operator" });

    expect(result).toEqual({ ok: false, reason: ".git-internal" });
  });

  it("models Darwin as case-insensitive for lexical .git internals", async () => {
    const root = makeRoot();
    write(root, path.join(".GIT", "config"), "git config");
    const trustedRoot = await captureTrustedRoot(root);
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platform) throw new Error("process.platform descriptor is unavailable");

    try {
      Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
      await expect(
        resolveOutboundFile(trustedRoot, path.join(".GIT", "config"), { maxBytes: 64, policy: "operator" })
      ).resolves.toEqual({ ok: false, reason: ".git-internal" });
    } finally {
      Object.defineProperty(process, "platform", platform);
      await trustedRoot.close();
    }
  });

  it("retains an exact safe root-relative path and rejects an unsafe path segment", async () => {
    const root = makeRoot();
    const firstPath = path.join("drafts", "report.txt");
    const secondPath = path.join("final", "report.txt");
    const zeroWidthPath = path.join(`review\u200Bcopy`, "report.txt");
    write(root, firstPath, "draft");
    write(root, secondPath, "final");
    write(root, path.join(`spoof\u202Edir`, "report.txt"), "unsafe");
    write(root, zeroWidthPath, "invisible");

    const first = await resolveForTest(root, firstPath, { maxBytes: 64, policy: "agent" });
    const second = await resolveForTest(root, secondPath, { maxBytes: 64, policy: "agent" });
    const unsafe = await resolveForTest(root, path.join(`spoof\u202Edir`, "report.txt"), {
      maxBytes: 64,
      policy: "agent",
    });
    const zeroWidth = await resolveForTest(root, zeroWidthPath, { maxBytes: 64, policy: "agent" });

    expect(first).toMatchObject({ ok: true, file: { displayName: "report.txt", relativePath: firstPath } });
    expect(second).toMatchObject({ ok: true, file: { displayName: "report.txt", relativePath: secondPath } });
    expect(unsafe).toEqual({ ok: false, reason: "unsafe-filename" });
    expect(zeroWidth).toEqual({ ok: false, reason: "unsafe-filename" });
  });

  it("refuses directories", async () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "folder"), { recursive: true });

    const result = await resolveForTest(root, "folder", { maxBytes: 64, policy: "operator" });

    expect(result).toEqual({
      ok: false,
      // CreateFileW no longer requests backup semantics for a candidate, so
      // Windows refuses directory opens before the handle-level defense runs.
      reason: process.platform === "win32" ? "unreadable" : "not-regular-file",
    });
  });

  it("refuses zero-byte and oversized files", async () => {
    const root = makeRoot();
    write(root, "empty.txt", "");
    write(root, "big.txt", Buffer.alloc(9, 1));

    await expect(resolveForTest(root, "empty.txt", { maxBytes: 8, policy: "agent" })).resolves.toEqual({
      ok: false,
      reason: "empty-file",
    });
    await expect(resolveForTest(root, "big.txt", { maxBytes: 8, policy: "agent" })).resolves.toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("refuses bidi/control filenames", async () => {
    const root = makeRoot();
    const badName = `bad\u202Egnp.txt`;
    write(root, badName, "x");

    const result = await resolveForTest(root, badName, { maxBytes: 8, policy: "agent" });

    expect(result).toEqual({ ok: false, reason: "unsafe-filename" });
  });

  it("enforces the asymmetric extension policy", async () => {
    const root = makeRoot();
    write(root, "artifact.exe", "MZ");
    write(root, "notes.bin", "bin");

    expect(DISCORD_BLOCKED_EXECUTABLE_EXTENSIONS.has(".exe")).toBe(true);

    await expect(resolveForTest(root, "artifact.exe", { maxBytes: 8, policy: "operator" })).resolves.toEqual({
      ok: false,
      reason: "disallowed-extension",
    });
    await expect(resolveForTest(root, "notes.bin", { maxBytes: 8, policy: "agent" })).resolves.toEqual({
      ok: false,
      reason: "disallowed-extension",
    });
    await expect(resolveForTest(root, "notes.bin", { maxBytes: 8, policy: "operator" })).resolves.toMatchObject({
      ok: true,
      file: { displayName: "notes.bin" },
    });
  });

  it("changes fingerprint after a file replacement or modification", async () => {
    const root = makeRoot();
    const abs = write(root, "artifact.txt", "first");

    const first = await resolveForTest(root, "artifact.txt", { maxBytes: 64, policy: "agent" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(abs, "second-version");

    const second = await resolveForTest(root, "artifact.txt", { maxBytes: 64, policy: "agent" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.file.fingerprint).not.toBe(first.file.fingerprint);
  });

  it("changes digest after an equal-size replacement", async () => {
    const root = makeRoot();
    const abs = write(root, "artifact.txt", "original");
    const first = await resolveForTest(root, "artifact.txt", { maxBytes: 64, policy: "agent" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    writeFileSync(abs, "replaced");

    const second = await resolveForTest(root, "artifact.txt", { maxBytes: 64, policy: "agent" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.file.size).toBe(first.file.size);
    expect(second.file.digest).not.toBe(first.file.digest);
    expect(second.file.bytes).toEqual(Buffer.from("replaced"));
  });

  it("refuses missing paths", async () => {
    const root = makeRoot();
    const missing = await resolveForTest(root, "ghost.txt", { maxBytes: 64, policy: "agent" });
    expect(missing).toEqual({ ok: false, reason: "not-found" });
  });
});
