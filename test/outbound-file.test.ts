import path from "node:path";
import os from "node:os";
import {
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
  return resolveOutboundFile(await captureTrustedRoot(root), requestedPath, options);
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

    const result = await resolveOutboundFile(trustedRoot, requestedPath, {
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

  it("refuses .git internals including a linked-worktree git file", async () => {
    const root = makeRoot();
    write(root, ".git", "gitdir: C:\\elsewhere");

    const result = await resolveForTest(root, ".git", { maxBytes: 64, policy: "operator" });

    expect(result).toEqual({ ok: false, reason: ".git-internal" });
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
