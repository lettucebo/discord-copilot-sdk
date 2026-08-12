import path from "node:path";
import os from "node:os";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SecureOpenError,
  secureOpen,
  type SecureOpenBackend,
  type SecureOpenedFile,
} from "../src/core/secure-open.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "dcs-secure-open-"));
  roots.push(root);
  return root;
}

function write(root: string, rel: string, content: Buffer | string): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function fakeBackend(opened: SecureOpenedFile): SecureOpenBackend {
  return { open: vi.fn(async () => opened) };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("secureOpen", () => {
  it("returns bytes and handle-derived metadata for an ordinary file inside the trusted root", async () => {
    const root = makeRoot();
    const target = write(root, "artifacts\\report.txt", "inside bytes");

    const result = await secureOpen(target, root, { maxBytes: 1024 });

    expect(result).toMatchObject({
      finalPath: target,
      size: 12,
      bytes: Buffer.from("inside bytes"),
      identity: expect.any(String),
    });
  });

  it("rejects a three-phase swap from the opened handle path before reading external bytes", async () => {
    const root = makeRoot();
    const inside = write(root, "artifact.txt", "inside");
    const outsideRoot = makeRoot();
    const outside = write(outsideRoot, "artifact.txt", "outside");
    const read = vi.fn(async () => Buffer.from("outside"));
    const close = vi.fn(async () => undefined);
    const backend = fakeBackend({
      finalPath: outside,
      regular: true,
      size: 7,
      identity: "external-handle",
      modifiedAt: "external-time",
      read,
      close,
    });

    await expect(secureOpen(inside, root, { maxBytes: 64 }, { backend })).rejects.toMatchObject({
      reason: "outside-root",
    } satisfies Partial<SecureOpenError>);
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects a short read from the verified handle", async () => {
    const root = makeRoot();
    const target = write(root, "artifact.txt", "inside");
    const read = vi.fn(async () => Buffer.from("short"));
    const close = vi.fn(async () => undefined);
    const backend = fakeBackend({
      finalPath: target,
      regular: true,
      size: 6,
      identity: "inside-handle",
      modifiedAt: "inside-time",
      read,
      close,
    });

    await expect(secureOpen(target, root, { maxBytes: 64 }, { backend })).rejects.toMatchObject({
      reason: "unreadable",
    } satisfies Partial<SecureOpenError>);
    expect(read).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform === "linux")("rejects an actual symlink escape from the Linux handle target", async () => {
    const root = makeRoot();
    const outsideRoot = makeRoot();
    write(outsideRoot, "loot.txt", "outside");
    const link = path.join(root, "escape");
    symlinkSync(outsideRoot, link, "dir");

    await expect(secureOpen(path.join(link, "loot.txt"), root, { maxBytes: 64 })).rejects.toMatchObject({
      reason: "outside-root",
    } satisfies Partial<SecureOpenError>);
  });

  it.skipIf(process.platform === "linux" || process.platform === "win32")(
    "fails closed where no handle-bound backend exists",
    async () => {
      const root = makeRoot();
      const target = write(root, "artifact.txt", "inside");

      await expect(secureOpen(target, root, { maxBytes: 64 })).rejects.toMatchObject({
        reason: "unsupported-platform",
      } satisfies Partial<SecureOpenError>);
    }
  );
});
