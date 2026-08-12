import path from "node:path";
import os from "node:os";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDarwinBackend,
  SecureOpenError,
  secureOpen,
  win32CreateFileFlags,
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
  return {
    open: vi.fn(async () => opened),
    openDirectory: vi.fn(async (trustedRoot: string) => ({
      finalPath: trustedRoot,
      directory: true,
      revalidate: async () => ({
        finalPath: trustedRoot,
        directory: true,
      }),
      close: async () => undefined,
    })),
  };
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
      finalPath: process.platform === "darwin" ? expect.stringMatching(/report\.txt$/) : target,
      size: 12,
      bytes: Buffer.from("inside bytes"),
      identity: expect.any(String),
    });
  });

  it("rejects a trusted root whose final path changes after candidate opening before reading", async () => {
    const root = makeRoot();
    const replacementRoot = makeRoot();
    const candidate = write(root, "artifact.txt", "inside");
    const events: string[] = [];
    const read = vi.fn(async () => Buffer.from("inside"));
    const closeCandidate = vi.fn(async () => {
      events.push("close candidate");
    });
    const closeRoot = vi.fn(async () => {
      events.push("close root");
    });
    const revalidate = vi.fn(async () => {
      events.push("revalidate root");
      return {
        finalPath: replacementRoot,
        directory: true,
      };
    });
    const backend: SecureOpenBackend = {
      open: vi.fn(async (): Promise<SecureOpenedFile> => {
        events.push("open candidate");
        return {
          finalPath: candidate,
          regular: true,
          size: 6,
          identity: "candidate-handle",
          modifiedAt: "candidate-time",
          read,
          close: closeCandidate,
        };
      }),
      openDirectory: vi.fn(async () => {
        events.push("open root");
        return {
          finalPath: root,
          directory: true,
          revalidate,
          close: closeRoot,
        };
      }),
    };

    await expect(secureOpen(candidate, root, { maxBytes: 64 }, { backend })).rejects.toMatchObject({
      reason: "unreadable",
    } satisfies Partial<SecureOpenError>);
    expect(read).not.toHaveBeenCalled();
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["open root", "open candidate", "revalidate root", "close candidate", "close root"]);
  });

  it("rejects a deleted trusted root after candidate opening before reading", async () => {
    const root = makeRoot();
    const candidate = write(root, "artifact.txt", "inside");
    const events: string[] = [];
    const read = vi.fn(async () => Buffer.from("inside"));
    const closeCandidate = vi.fn(async () => {
      events.push("close candidate");
    });
    const closeRoot = vi.fn(async () => {
      events.push("close root");
    });
    const revalidate = vi.fn(async () => {
      events.push("revalidate root");
      return {
        finalPath: `${root} (deleted)`,
        directory: false,
      };
    });
    const backend: SecureOpenBackend = {
      open: vi.fn(async (): Promise<SecureOpenedFile> => {
        events.push("open candidate");
        return {
          finalPath: candidate,
          regular: true,
          size: 6,
          identity: "candidate-handle",
          modifiedAt: "candidate-time",
          read,
          close: closeCandidate,
        };
      }),
      openDirectory: vi.fn(async () => {
        events.push("open root");
        return {
          finalPath: root,
          directory: true,
          revalidate,
          close: closeRoot,
        };
      }),
    };

    await expect(secureOpen(candidate, root, { maxBytes: 64 }, { backend })).rejects.toMatchObject({
      reason: "unreadable",
    } satisfies Partial<SecureOpenError>);
    expect(read).not.toHaveBeenCalled();
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["open root", "open candidate", "revalidate root", "close candidate", "close root"]);
  });

  it("uses the opened root handle final path and refuses a root-side swap before reading", async () => {
    const root = makeRoot();
    const candidate = write(root, "artifact.txt", "inside");
    const replacementRoot = makeRoot();
    const events: string[] = [];
    const read = vi.fn(async () => Buffer.from("inside"));
    const closeCandidate = vi.fn(async () => undefined);
    const closeRoot = vi.fn(async () => undefined);
    const backend = {
      open: vi.fn(async (): Promise<SecureOpenedFile> => {
        events.push("candidate");
        return {
          finalPath: candidate,
          regular: true,
          size: 6,
          identity: "candidate-handle",
          modifiedAt: "candidate-time",
          read,
          close: closeCandidate,
        };
      }),
      openDirectory: vi.fn(async (requestedRoot: string) => {
        events.push("root");
        expect(requestedRoot).toBe(root);
        return {
          // The pathname still points at `root`, but its opened handle proves a
          // replacement root. A pathname realpath anchor would allow candidate.
          finalPath: replacementRoot,
          directory: true,
          revalidate: async () => ({
            finalPath: replacementRoot,
            directory: true,
          }),
          close: closeRoot,
        };
      }),
    };

    await expect(secureOpen(candidate, root, { maxBytes: 64 }, { backend })).rejects.toMatchObject({
      reason: "outside-root",
    } satisfies Partial<SecureOpenError>);
    expect(events).toEqual(["root", "candidate"]);
    expect(read).not.toHaveBeenCalled();
    expect(closeCandidate).toHaveBeenCalledTimes(1);
    expect(closeRoot).toHaveBeenCalledTimes(1);
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

  it("keeps backup semantics exclusive to trusted-directory CreateFileW calls", () => {
    const backupSemantics = 0x0200_0000;
    expect(win32CreateFileFlags("candidate") & backupSemantics).toBe(0);
    expect(win32CreateFileFlags("directory") & backupSemantics).toBe(backupSemantics);
  });

  it("derives Darwin candidate and root proofs from their still-open FileHandle descriptors", async () => {
    const root = makeRoot();
    const target = write(root, "artifact.txt", "inside");
    const calls: Array<{ fd: number; command: number; capacity: number }> = [];
    const backend = createDarwinBackend({
      fcntl(fd, command, output) {
        calls.push({ fd, command, capacity: output.byteLength });
        const finalPath = calls.length === 2 ? "/trusted-root/artifact.txt" : "/trusted-root";
        output.write(finalPath, "utf8");
        output[Buffer.byteLength(finalPath)] = 0;
        return 0;
      },
    });

    const openedRoot = await backend.openDirectory(root);
    let opened: SecureOpenedFile | undefined;
    try {
      opened = await backend.open(target);
      const revalidated = await openedRoot.revalidate();

      expect(opened.finalPath).toBe("/trusted-root/artifact.txt");
      expect(opened.regular).toBe(true);
      expect(opened.size).toBe(6);
      await expect(opened.read()).resolves.toEqual(Buffer.from("inside"));
      expect(revalidated).toEqual({ finalPath: "/trusted-root", directory: true });

      const [initialRoot, candidate, revalidatedRoot] = calls;
      if (!initialRoot || !candidate || !revalidatedRoot) throw new Error("Darwin fcntl calls were incomplete");
      expect(calls).toHaveLength(3);
      expect(initialRoot.fd).toBe(revalidatedRoot.fd);
      expect(candidate.fd).not.toBe(initialRoot.fd);
      expect(calls.map(({ command }) => command)).toEqual([50, 50, 50]);
      expect(calls.every(({ capacity }) => capacity >= 1024)).toBe(true);
    } finally {
      await opened?.close();
      await openedRoot.close();
    }
  });

  it("fails closed when Darwin F_GETPATH cannot prove an opened handle path", async () => {
    const root = makeRoot();
    const target = write(root, "artifact.txt", "inside");
    const backend = createDarwinBackend({
      fcntl: () => -1,
    });

    await expect(backend.open(target)).rejects.toMatchObject({
      reason: "unreadable",
    } satisfies Partial<SecureOpenError>);
  });

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "rejects an actual symlink escape from the kernel handle target",
    async () => {
      const root = makeRoot();
      const outsideRoot = makeRoot();
      write(outsideRoot, "loot.txt", "outside");
      const link = path.join(root, "escape");
      symlinkSync(outsideRoot, link, "dir");

      await expect(secureOpen(path.join(link, "loot.txt"), root, { maxBytes: 64 })).rejects.toMatchObject({
        reason: "outside-root",
      } satisfies Partial<SecureOpenError>);
    }
  );

  it.runIf(process.platform === "darwin")("opens a real artifact through Darwin F_GETPATH", async () => {
    const root = makeRoot();
    const target = write(root, "artifact.txt", "inside");

    await expect(secureOpen(target, root, { maxBytes: 64 })).resolves.toMatchObject({
      relativePath: "artifact.txt",
      bytes: Buffer.from("inside"),
    });
  });

  it.skipIf(process.platform === "linux" || process.platform === "win32" || process.platform === "darwin")(
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
