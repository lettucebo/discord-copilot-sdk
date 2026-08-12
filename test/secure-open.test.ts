import path from "node:path";
import os from "node:os";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureTrustedRoot,
  createDarwinBackend,
  createLinuxBackend,
  LINUX_POSIX_OPEN_FLAGS,
  linuxLibcCandidates,
  loadLinuxLibc,
  SecureOpenError,
  secureOpen,
  win32CreateFileFlags,
  type SecureOpenBackend,
  type SecureOpenDependencies,
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
      identity: `root:${trustedRoot}`,
      directory: true,
      revalidate: async () => ({
        finalPath: trustedRoot,
        identity: `root:${trustedRoot}`,
        directory: true,
      }),
      close: async () => undefined,
    })),
  };
}

function win32HandlePathDependencies(
  backend: SecureOpenBackend
): SecureOpenDependencies {
  return { backend, pathMode: "win32" };
}

function posixHandlePathDependencies(
  backend: SecureOpenBackend
): SecureOpenDependencies {
  return { backend, pathMode: "posix" };
}

async function secureOpenForTest(
  candidate: string,
  root: string,
  options: { maxBytes: number },
  dependencies: SecureOpenDependencies = {}
) {
  const trustedRoot = await captureTrustedRoot(root, dependencies);
  try {
    return await secureOpen(candidate, trustedRoot, options);
  } finally {
    await trustedRoot.close();
  }
}

function posixStat(options: {
  directory?: boolean;
  file?: boolean;
  size?: number;
  ino?: number;
  nlink?: number;
}) {
  return {
    dev: 1,
    ino: options.ino ?? 1,
    mtimeMs: 1,
    nlink: options.nlink ?? 1,
    size: options.size ?? 0,
    isDirectory: () => options.directory === true,
    isFile: () => options.file === true,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("secureOpen", () => {
  it("retains one opaque root handle and never reopens a replacement root pathname", async () => {
    const lexicalRoot = "/work/session";
    const originalRoot = "/canonical/original-session";
    const candidate = `${lexicalRoot}/artifact.txt`;
    const rootClose = vi.fn(async () => undefined);
    const candidateClose = vi.fn(async () => undefined);
    const candidateOpen = vi.fn(async (_candidate: string, _maxBytes: number): Promise<SecureOpenedFile> => {
      return {
        finalPath: `${originalRoot}/artifact.txt`,
        regular: true,
        size: 6,
        linkCount: 1,
        identity: "candidate:1",
        modifiedAt: "candidate-time",
        read: async () => Buffer.from("inside"),
        close: candidateClose,
      };
    });
    const revalidate = vi.fn(async () => ({
      finalPath: originalRoot,
      identity: "7:101",
      directory: true,
    }));
    const openDirectory = vi
      .fn()
      .mockResolvedValueOnce({
        finalPath: originalRoot,
        identity: "7:101",
        directory: true,
        openCandidate: candidateOpen,
        revalidate,
        close: rootClose,
      })
      .mockRejectedValue(new Error("the mutable root pathname must never be reopened"));
    const backend: SecureOpenBackend = {
      open: vi.fn(async () => {
        throw new Error("a POSIX candidate must use the retained root descriptor");
      }),
      openDirectory,
    };
    const dependencies = posixHandlePathDependencies(backend);

    const anchor = await captureTrustedRoot(lexicalRoot, dependencies);

    expect(JSON.parse(JSON.stringify(anchor))).toEqual({});
    const CapabilityConstructor = anchor.constructor as unknown as new (...args: unknown[]) => unknown;
    expect(() =>
      new CapabilityConstructor({
        originalPath: lexicalRoot,
        finalPath: originalRoot,
        identity: "7:101",
      })
    ).toThrow(/trusted root capability/i);
    expect(rootClose).not.toHaveBeenCalled();
    await expect(secureOpen(candidate, anchor, { maxBytes: 64 })).resolves.toMatchObject({
      finalPath: `${originalRoot}/artifact.txt`,
      bytes: Buffer.from("inside"),
    });
    expect(openDirectory).toHaveBeenCalledTimes(1);
    expect(openDirectory).toHaveBeenCalledWith(lexicalRoot);
    expect(candidateOpen).toHaveBeenCalledWith(candidate, 64);
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(rootClose).not.toHaveBeenCalled();

    await anchor.close();
    await anchor.close();
    expect(candidateClose).toHaveBeenCalledTimes(1);
    expect(rootClose).toHaveBeenCalledTimes(1);
  });

  it("exposes the captured handle final path without making the capability constructible", async () => {
    const lexicalRoot = "/work/session";
    const handleFinalPath = "/repo/worktrees/session";
    const close = vi.fn(async () => undefined);
    const backend: SecureOpenBackend = {
      open: vi.fn(async () => {
        throw new Error("this test only captures a root");
      }),
      openDirectory: vi.fn(async () => ({
        finalPath: handleFinalPath,
        identity: "root:captured",
        directory: true,
        revalidate: async () => ({
          finalPath: handleFinalPath,
          identity: "root:captured",
          directory: true,
        }),
        close,
      })),
    };

    const root = await captureTrustedRoot(lexicalRoot, posixHandlePathDependencies(backend));

    expect((root as unknown as { finalPath?: string }).finalPath).toBe(handleFinalPath);
    await root.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps the captured root handle open across multiple resolutions then fences use after close", async () => {
    const root = "/trusted-worktree";
    const candidate = `${root}/artifact.txt`;
    const rootClose = vi.fn(async () => undefined);
    const candidateClose = vi.fn(async () => undefined);
    const openCandidate = vi.fn(async (): Promise<SecureOpenedFile> => ({
      finalPath: candidate,
      regular: true,
      size: 6,
      linkCount: 1,
      identity: "candidate:1",
      modifiedAt: "candidate-time",
      read: async () => Buffer.from("inside"),
      close: candidateClose,
    }));
    const proof = {
      finalPath: root,
      identity: "root:1",
      directory: true,
    };
    const backend: SecureOpenBackend = {
      open: vi.fn(async () => {
        throw new Error("candidate lookup must remain rooted in the retained handle");
      }),
      openDirectory: vi.fn(async () => ({
        ...proof,
        openCandidate,
        revalidate: async () => proof,
        close: rootClose,
      })),
    };
    const dependencies = posixHandlePathDependencies(backend);
    const anchor = await captureTrustedRoot(root, dependencies);

    await expect(secureOpen(candidate, anchor, { maxBytes: 64 })).resolves.toMatchObject({
      bytes: Buffer.from("inside"),
    });
    await expect(secureOpen(candidate, anchor, { maxBytes: 64 })).resolves.toMatchObject({
      bytes: Buffer.from("inside"),
    });
    expect(backend.openDirectory).toHaveBeenCalledTimes(1);
    expect(rootClose).not.toHaveBeenCalled();

    await anchor.close();
    await expect(secureOpen(candidate, anchor, { maxBytes: 64 })).rejects.toMatchObject({
      reason: "unreadable",
    } satisfies Partial<SecureOpenError>);
    expect(rootClose).toHaveBeenCalledTimes(1);
  });

  it("returns bytes and handle-derived metadata for an ordinary file inside the trusted root", async () => {
    const root = makeRoot();
    const target = write(root, "artifacts\\report.txt", "inside bytes");

    const result = await secureOpenForTest(target, root, { maxBytes: 1024 });

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
    const revalidate = vi
      .fn()
      .mockImplementationOnce(async () => {
        events.push("revalidate root");
        return {
          finalPath: root,
          identity: "root-handle",
          directory: true,
        };
      })
      .mockImplementationOnce(async () => {
        events.push("revalidate root");
        return {
          finalPath: replacementRoot,
          identity: "root-handle",
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
          linkCount: 1,
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
          identity: "root-handle",
          directory: true,
          revalidate,
          close: closeRoot,
        };
      }),
    };

    await expect(secureOpenForTest(candidate, root, { maxBytes: 64 }, { backend })).rejects.toMatchObject({
      reason: "unreadable",
    } satisfies Partial<SecureOpenError>);
    expect(read).not.toHaveBeenCalled();
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "open root",
      "revalidate root",
      "open candidate",
      "revalidate root",
      "close candidate",
      "close root",
    ]);
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
    const revalidate = vi
      .fn()
      .mockImplementationOnce(async () => {
        events.push("revalidate root");
        return {
          finalPath: root,
          identity: "root-handle",
          directory: true,
        };
      })
      .mockImplementationOnce(async () => {
        events.push("revalidate root");
        return {
          finalPath: `${root} (deleted)`,
          identity: "root-handle",
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
          linkCount: 1,
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
          identity: "root-handle",
          directory: true,
          revalidate,
          close: closeRoot,
        };
      }),
    };

    await expect(secureOpenForTest(candidate, root, { maxBytes: 64 }, { backend })).rejects.toMatchObject({
      reason: "unreadable",
    } satisfies Partial<SecureOpenError>);
    expect(read).not.toHaveBeenCalled();
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "open root",
      "revalidate root",
      "open candidate",
      "revalidate root",
      "close candidate",
      "close root",
    ]);
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
          linkCount: 1,
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
          identity: "replacement-root",
          directory: true,
          revalidate: async () => ({
            finalPath: replacementRoot,
            identity: "replacement-root",
            directory: true,
          }),
          close: closeRoot,
        };
      }),
    };

    await expect(secureOpenForTest(candidate, root, { maxBytes: 64 }, { backend })).rejects.toMatchObject({
      reason: "outside-root",
    } satisfies Partial<SecureOpenError>);
    expect(events).toEqual(["root", "candidate"]);
    expect(read).not.toHaveBeenCalled();
    expect(closeCandidate).toHaveBeenCalledTimes(1);
    expect(closeRoot).toHaveBeenCalledTimes(1);
  });

  it("rejects a case-distinct Win32 handle path sibling", async () => {
    const root = String.raw`C:\work\Repo`;
    const candidate = String.raw`C:\work\repo\secret.txt`;
    const read = vi.fn(async () => Buffer.from("secret"));
    const close = vi.fn(async () => undefined);
    const backend = fakeBackend({
      finalPath: candidate,
      regular: true,
      size: 6,
      linkCount: 1,
      identity: "case-distinct-sibling",
      modifiedAt: "case-distinct-time",
      read,
      close,
    });

    await expect(
      secureOpenForTest(candidate, root, { maxBytes: 64 }, win32HandlePathDependencies(backend))
    ).rejects.toMatchObject({
      reason: "outside-root",
    } satisfies Partial<SecureOpenError>);
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects a revalidated Win32 root whose handle path differs only by case", async () => {
    const root = String.raw`C:\work\Repo`;
    const candidate = String.raw`C:\work\Repo\artifact.txt`;
    const read = vi.fn(async () => Buffer.from("inside"));
    const closeCandidate = vi.fn(async () => undefined);
    const closeRoot = vi.fn(async () => undefined);
    const backend: SecureOpenBackend = {
      open: vi.fn(async () => ({
        finalPath: candidate,
        regular: true,
        size: 6,
        linkCount: 1,
        identity: "candidate-handle",
        modifiedAt: "candidate-time",
        read,
        close: closeCandidate,
      })),
      openDirectory: vi.fn(async () => ({
        finalPath: root,
        identity: "root-handle",
        directory: true,
        revalidate: vi
          .fn()
          .mockResolvedValueOnce({
            finalPath: root,
            identity: "root-handle",
            directory: true,
          })
          .mockResolvedValueOnce({
            finalPath: String.raw`C:\work\repo`,
            identity: "root-handle",
            directory: true,
          }),
        close: closeRoot,
      })),
    };

    await expect(
      secureOpenForTest(candidate, root, { maxBytes: 64 }, win32HandlePathDependencies(backend))
    ).rejects.toMatchObject({
      reason: "unreadable",
    } satisfies Partial<SecureOpenError>);
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
      linkCount: 1,
      identity: "external-handle",
      modifiedAt: "external-time",
      read,
      close,
    });

    await expect(secureOpenForTest(inside, root, { maxBytes: 64 }, { backend })).rejects.toMatchObject({
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
      linkCount: 1,
      identity: "inside-handle",
      modifiedAt: "inside-time",
      read,
      close,
    });

    await expect(secureOpenForTest(target, root, { maxBytes: 64 }, { backend })).rejects.toMatchObject({
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

  it("falls back from glibc to the architecture-matched musl libc", () => {
    const muslLibc = { source: "musl" };
    const load = vi.fn((soname: string) => {
      if (soname === "libc.musl-x86_64.so.1") return muslLibc;
      throw new Error(`missing ${soname}`);
    });

    expect(loadLinuxLibc(load, "x64")).toBe(muslLibc);
    expect(load).toHaveBeenNthCalledWith(1, "libc.so.6");
    expect(load).toHaveBeenNthCalledWith(2, "libc.musl-x86_64.so.1");
    expect(linuxLibcCandidates("arm64")).toEqual([
      "libc.so.6",
      "libc.musl-aarch64.so.1",
      "libc.so",
    ]);
  });

  it("fails closed after every architecture-matched Linux libc candidate fails", () => {
    const load = vi.fn((_soname: string) => {
      throw new Error("not found");
    });
    let failure: unknown;

    try {
      loadLinuxLibc(load, "arm64");
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: "SecureOpenError",
      reason: "unreadable",
    } satisfies Partial<SecureOpenError>);
    expect(load.mock.calls.map(([soname]) => soname)).toEqual(linuxLibcCandidates("arm64"));
  });

  it("passes nonblocking directory flags to a trusted-root open and refuses a non-directory replacement", async () => {
    const root = "/trusted-worktree";
    const expectedRootFlags = 0x800 | 0x1_0000 | 0x8_0000;
    const close = vi.fn(async () => undefined);
    const openDirectory = vi.fn(async (_trustedRoot: string, _flags?: number) => ({
      fd: 31,
      close,
    }));
    const backend = createLinuxBackend(
      {
        openat: () => {
          throw new Error("a non-directory root must not resolve a candidate");
        },
      },
      {
        openDirectory,
        finalPath: async () => root,
        fstat: async () => posixStat({ file: true, ino: 31, nlink: 1 }),
      }
    );

    await expect(captureTrustedRoot(root, posixHandlePathDependencies(backend))).rejects.toMatchObject({
      reason: "unreadable",
    } satisfies Partial<SecureOpenError>);
    expect(openDirectory).toHaveBeenCalledWith(root, expectedRootFlags);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("opens a POSIX candidate component-by-component from the trusted root fd after pathname ABA replacement", async () => {
    const root = "/trusted-worktree";
    const candidate = "/trusted-worktree/nested/artifact.txt";
    const rootHandle = {
      fd: 41,
      close: vi.fn(async () => undefined),
    };
    const openat = vi.fn((dirFd: number, component: string) => {
      if (dirFd === 41 && component === "nested") return 42;
      if (dirFd === 42 && component === "artifact.txt") return 43;
      throw new Error(`unexpected pathname lookup for ${dirFd}:${component}`);
    });
    const fstat = vi.fn(async (fd: number) => {
      if (fd === 41) return posixStat({ directory: true, ino: 41, nlink: 2 });
      if (fd === 43) return posixStat({ file: true, size: 6, ino: 43 });
      throw new Error(`unexpected fstat fd ${fd}`);
    });
    const read = vi.fn(async (_fd: number, buffer: Buffer, offset: number, length: number) => {
      buffer.write("inside", offset, length, "utf8");
      return { bytesRead: length, buffer };
    });
    const close = vi.fn(async () => undefined);
    const backend = createLinuxBackend(
      {
        openat,
        errno: () => 40,
      },
      {
        openDirectory: vi.fn(async () => rootHandle),
        finalPath: async (fd) => (fd === 41 ? root : candidate),
        fstat,
        read,
        close,
      }
    );

    const result = await secureOpenForTest(candidate, root, { maxBytes: 64 }, posixHandlePathDependencies(backend));

    expect(result.bytes).toEqual(Buffer.from("inside"));
    expect(openat).toHaveBeenNthCalledWith(1, 41, "nested", LINUX_POSIX_OPEN_FLAGS.intermediate);
    expect(openat).toHaveBeenNthCalledWith(2, 42, "artifact.txt", LINUX_POSIX_OPEN_FLAGS.leaf);
    expect(close).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledWith(42);
    expect(close).toHaveBeenCalledWith(43);
    expect(rootHandle.close).toHaveBeenCalledTimes(1);
  });

  it("rejects an intermediate POSIX symlink without reading a candidate fd", async () => {
    const root = "/trusted-worktree";
    const read = vi.fn();
    const openat = vi.fn(() => -1);
    const backend = createLinuxBackend(
      {
        openat,
        errno: () => 40,
      },
      {
        openDirectory: async () => ({
          fd: 51,
          close: async () => undefined,
        }),
        finalPath: async () => root,
        fstat: async () => posixStat({ directory: true, ino: 51, nlink: 2 }),
        read,
        close: async () => undefined,
      }
    );

    await expect(
      secureOpenForTest(
        "/trusted-worktree/escape/loot.txt",
        root,
        { maxBytes: 64 },
        posixHandlePathDependencies(backend)
      )
    ).rejects.toMatchObject({
      reason: "outside-root",
    } satisfies Partial<SecureOpenError>);
    expect(openat).toHaveBeenCalledTimes(1);
    expect(openat).toHaveBeenCalledWith(51, "escape", LINUX_POSIX_OPEN_FLAGS.intermediate);
    expect(read).not.toHaveBeenCalled();
  });

  it("closes a newly opened intermediate fd once if closing its predecessor fails", async () => {
    const root = "/trusted-worktree";
    const close = vi.fn(async (fd: number) => {
      if (fd === 102) throw new Error("simulated close failure");
    });
    const backend = createLinuxBackend(
      {
        openat: (dirFd, component) => {
          if (dirFd === 101 && component === "first") return 102;
          if (dirFd === 102 && component === "second") return 103;
          throw new Error(`unexpected openat ${dirFd}:${component}`);
        },
        errno: () => 40,
      },
      {
        openDirectory: async () => ({
          fd: 101,
          close: async () => undefined,
        }),
        finalPath: async () => root,
        fstat: async () => posixStat({ directory: true, ino: 101, nlink: 2 }),
        read: async (_fd, buffer, _offset, length) => ({ bytesRead: length, buffer }),
        close,
      }
    );

    await expect(
      secureOpenForTest(`${root}/first/second/file.txt`, root, { maxBytes: 64 }, posixHandlePathDependencies(backend))
    ).rejects.toMatchObject({
      reason: "unreadable",
    } satisfies Partial<SecureOpenError>);
    expect(close).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledWith(102);
    expect(close).toHaveBeenCalledWith(103);
  });

  it("opens a POSIX leaf nonblocking and rejects a FIFO before any read", async () => {
    const root = "/trusted-worktree";
    const read = vi.fn();
    const close = vi.fn(async () => undefined);
    const openat = vi.fn(() => 62);
    const backend = createLinuxBackend(
      {
        openat,
        errno: () => 40,
      },
      {
        openDirectory: async () => ({
          fd: 61,
          close: async () => undefined,
        }),
        finalPath: async (fd) => (fd === 61 ? root : `${root}/pipe`),
        fstat: async (fd) =>
          fd === 61
            ? posixStat({ directory: true, ino: 61, nlink: 2 })
            : posixStat({ ino: 62 }),
        read,
        close,
      }
    );

    await expect(
      secureOpenForTest(`${root}/pipe`, root, { maxBytes: 64 }, posixHandlePathDependencies(backend))
    ).rejects.toMatchObject({
      reason: "not-regular-file",
    } satisfies Partial<SecureOpenError>);
    expect(openat).toHaveBeenCalledWith(61, "pipe", LINUX_POSIX_OPEN_FLAGS.leaf);
    expect(LINUX_POSIX_OPEN_FLAGS.leaf & 0x800).toBe(0x800);
    expect(LINUX_POSIX_OPEN_FLAGS.leaf & 0x40).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(62);
  });

  it("bounds raw POSIX reads to the statted size when a candidate grows", async () => {
    const root = "/trusted-worktree";
    let candidateStatCalls = 0;
    const read = vi.fn(async (_fd: number, buffer: Buffer, offset: number, length: number) => {
      buffer.fill(0x61, offset, offset + length);
      return { bytesRead: length, buffer };
    });
    const backend = createLinuxBackend(
      {
        openat: () => 72,
        errno: () => 40,
      },
      {
        openDirectory: async () => ({
          fd: 71,
          close: async () => undefined,
        }),
        finalPath: async (fd) => (fd === 71 ? root : `${root}/growing.txt`),
        fstat: async (fd) => {
          if (fd === 71) return posixStat({ directory: true, ino: 71, nlink: 2 });
          candidateStatCalls += 1;
          return posixStat({ file: true, size: candidateStatCalls === 1 ? 4 : 5, ino: 72 });
        },
        read,
        close: async () => undefined,
      }
    );

    await expect(
      secureOpenForTest(`${root}/growing.txt`, root, { maxBytes: 4 }, posixHandlePathDependencies(backend))
    ).rejects.toMatchObject({
      reason: "unreadable",
    } satisfies Partial<SecureOpenError>);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(72, expect.any(Buffer), 0, 4, null);
    expect((read.mock.calls[0]?.[1] as Buffer).byteLength).toBe(4);
  });

  it("derives Darwin candidate and root proofs from their still-open FileHandle descriptors", async () => {
    const root = makeRoot();
    const target = write(root, "artifact.txt", "inside");
    const calls: Array<{ fd: number; command: number; capacity: number }> = [];
    const backend = createDarwinBackend(
      {
        fcntl(fd, command, output) {
          calls.push({ fd, command, capacity: output.byteLength });
          const finalPath = fd === 82 ? "/trusted-root/artifact.txt" : "/trusted-root";
          output.write(finalPath, "utf8");
          output[Buffer.byteLength(finalPath)] = 0;
          return 0;
        },
        openat: () => 82,
        errno: () => 40,
      },
      {
        openDirectory: async () => ({
          fd: 81,
          close: async () => undefined,
        }),
        fstat: async (fd) =>
          fd === 81
            ? posixStat({ directory: true, ino: 81, nlink: 2 })
            : posixStat({ file: true, size: 6, ino: 82 }),
        read: async (_fd, buffer, offset, length) => {
          buffer.write("inside", offset, length, "utf8");
          return { bytesRead: length, buffer };
        },
        close: async () => undefined,
      }
    );

    await expect(
      secureOpenForTest(target, root, { maxBytes: 64 }, posixHandlePathDependencies(backend))
    ).resolves.toMatchObject({
      finalPath: "/trusted-root/artifact.txt",
      size: 6,
      bytes: Buffer.from("inside"),
    });

    const [captureRoot, initialRoot, candidate, revalidatedRoot] = calls;
    if (!captureRoot || !initialRoot || !candidate || !revalidatedRoot) {
      throw new Error("Darwin fcntl calls were incomplete");
    }
    expect(calls).toHaveLength(4);
    expect(captureRoot.fd).toBe(initialRoot.fd);
    expect(initialRoot.fd).toBe(revalidatedRoot.fd);
    expect(candidate.fd).not.toBe(initialRoot.fd);
    expect(calls.map(({ command }) => command)).toEqual([50, 50, 50, 50]);
    expect(calls.every(({ capacity }) => capacity >= 1024)).toBe(true);
  });

  it("fails closed when Darwin F_GETPATH cannot prove an opened handle path", async () => {
    const root = makeRoot();
    const target = write(root, "artifact.txt", "inside");
    const backend = createDarwinBackend(
      {
        fcntl: () => -1,
        openat: () => 92,
        errno: () => 40,
      },
      {
        openDirectory: async () => ({
          fd: 91,
          close: async () => undefined,
        }),
        fstat: async (fd) =>
          fd === 91
            ? posixStat({ directory: true, ino: 91, nlink: 2 })
            : posixStat({ file: true, size: 6, ino: 92 }),
        read: async (_fd, buffer, _offset, length) => ({ bytesRead: length, buffer }),
        close: async () => undefined,
      }
    );

    await expect(
      secureOpenForTest(target, root, { maxBytes: 64 }, posixHandlePathDependencies(backend))
    ).rejects.toMatchObject({
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

      await expect(secureOpenForTest(path.join(link, "loot.txt"), root, { maxBytes: 64 })).rejects.toMatchObject({
        reason: "outside-root",
      } satisfies Partial<SecureOpenError>);
    }
  );

  it.runIf(process.platform === "linux")("opens a real artifact through Linux openat", async () => {
    const root = makeRoot();
    const target = write(root, "artifact.txt", "inside");

    await expect(secureOpenForTest(target, root, { maxBytes: 64 })).resolves.toMatchObject({
      relativePath: "artifact.txt",
      bytes: Buffer.from("inside"),
    });
  });

  it.runIf(process.platform === "darwin")("opens a real artifact through Darwin F_GETPATH", async () => {
    const root = makeRoot();
    const target = write(root, "artifact.txt", "inside");

    await expect(secureOpenForTest(target, root, { maxBytes: 64 })).resolves.toMatchObject({
      relativePath: "artifact.txt",
      bytes: Buffer.from("inside"),
    });
  });

  it.skipIf(process.platform === "linux" || process.platform === "win32" || process.platform === "darwin")(
    "fails closed where no handle-bound backend exists",
    async () => {
      const root = makeRoot();
      const target = write(root, "artifact.txt", "inside");

      await expect(secureOpenForTest(target, root, { maxBytes: 64 })).rejects.toMatchObject({
        reason: "unsupported-platform",
      } satisfies Partial<SecureOpenError>);
    }
  );
});
