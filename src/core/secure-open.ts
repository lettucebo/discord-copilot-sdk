import path from "node:path";
import { promises as fs } from "node:fs";

export type SecureOpenRefusal =
  | "not-found"
  | "outside-root"
  | "not-regular-file"
  | "empty-file"
  | "too-large"
  | "unreadable"
  | "unsupported-platform";

/** A fail-closed result from the handle-bound file-open boundary. */
export class SecureOpenError extends Error {
  constructor(
    readonly reason: SecureOpenRefusal,
    message?: string
  ) {
    super(message ?? reason);
    this.name = "SecureOpenError";
  }
}

/** Metadata and bytes obtained from the same OS handle. */
export interface SecureOpenResult {
  finalPath: string;
  relativePath: string;
  size: number;
  identity: string;
  modifiedAt: string;
  bytes: Buffer;
}

export interface SecureOpenOptions {
  maxBytes: number;
}

/**
 * The platform backend must expose facts from exactly one still-open OS handle.
 * It must not re-resolve `finalPath` through a pathname after opening.
 */
export interface SecureOpenedFile {
  finalPath: string;
  regular: boolean;
  size: number;
  identity: string;
  modifiedAt: string;
  read(): Promise<Buffer>;
  close(): Promise<void>;
}

/** Metadata sourced from one still-open trusted-root directory handle. */
export interface SecureDirectoryProof {
  finalPath: string;
  directory: boolean;
}

/** A trusted root that can be proven again without reopening its pathname. */
export interface SecureOpenedDirectory extends SecureDirectoryProof {
  revalidate(): Promise<SecureDirectoryProof>;
  close(): Promise<void>;
}

export interface SecureOpenBackend {
  open(candidate: string): Promise<SecureOpenedFile>;
  openDirectory(trustedRoot: string): Promise<SecureOpenedDirectory>;
}

/** Test-only dependency injection for the OS-handle boundary. */
export interface SecureOpenDependencies {
  backend?: SecureOpenBackend;
}

const WIN32_FILE_TYPE_DISK = 1;
const WIN32_FILE_ATTRIBUTE_DIRECTORY = 0x10;
const WIN32_GENERIC_READ = 0x8000_0000;
const WIN32_FILE_SHARE_READ = 0x1;
const WIN32_OPEN_EXISTING = 3;
const WIN32_FILE_ATTRIBUTE_NORMAL = 0x80;
const WIN32_FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
const WIN32_MAX_PATH_CHARS = 32_768;
const WIN32_MAX_READ_CHUNK = 0xffff_ffff;
const DARWIN_F_GETPATH = 50;
const DARWIN_MAXPATHLEN = 1024;

export function win32CreateFileFlags(target: "candidate" | "directory"): number {
  return WIN32_FILE_ATTRIBUTE_NORMAL | (target === "directory" ? WIN32_FILE_FLAG_BACKUP_SEMANTICS : 0);
}

function refusal(reason: SecureOpenRefusal, message?: string): SecureOpenError {
  return new SecureOpenError(reason, message);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function classifyOpenError(error: unknown): SecureOpenError {
  if (error instanceof SecureOpenError) return error;
  return refusal(isErrno(error, "ENOENT") ? "not-found" : "unreadable");
}

function trimTrailingSeparators(value: string, pathApi: typeof path.posix): string {
  const parsed = pathApi.parse(value);
  if (value === parsed.root) return value;
  return value.replace(/[\\/]+$/, "") || parsed.root;
}

/**
 * Compare only canonical strings already sourced from the trusted root and the
 * opened handle. Calling realpath here would recreate the pathname race that
 * this module exists to eliminate.
 */
function normalizeHandlePath(value: string): string | undefined {
  if (process.platform === "win32") {
    let normalized = value;
    if (normalized.slice(0, 8).toUpperCase() === "\\\\?\\UNC\\") {
      normalized = `\\\\${normalized.slice(8)}`;
    } else if (normalized.slice(0, 4) === "\\\\?\\") {
      normalized = normalized.slice(4);
    }
    normalized = trimTrailingSeparators(path.win32.normalize(normalized), path.win32);
    return path.win32.isAbsolute(normalized) ? normalized : undefined;
  }

  const normalized = trimTrailingSeparators(path.posix.normalize(value), path.posix);
  return path.posix.isAbsolute(normalized) ? normalized : undefined;
}

function relativePathInsideCanonical(finalPath: string, canonicalRoot: string): string | undefined {
  const normalizedFinal = normalizeHandlePath(finalPath);
  const normalizedRoot = normalizeHandlePath(canonicalRoot);
  if (!normalizedFinal || !normalizedRoot) return undefined;

  const pathApi = process.platform === "win32" ? path.win32 : path.posix;
  const comparedFinal = process.platform === "win32" ? normalizedFinal.toLowerCase() : normalizedFinal;
  const comparedRoot = process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
  const relative = pathApi.relative(comparedRoot, comparedFinal);
  if (
    relative === "" ||
    relative === "." ||
    relative === ".." ||
    relative.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative;
}

function normalizedFinalPath(value: string): string {
  const normalized = normalizeHandlePath(value);
  if (!normalized) throw refusal("unreadable", "The opened handle did not provide an absolute final path.");
  return normalized;
}

function equivalentHandlePaths(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function validSize(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

async function linuxFinalPath(fd: number): Promise<string> {
  const finalPath = await fs.readlink(`/proc/self/fd/${fd}`);
  if (finalPath.endsWith(" (deleted)")) {
    throw refusal("unreadable", "The opened handle was deleted before its containment could be proved.");
  }
  return finalPath;
}

const linuxBackend: SecureOpenBackend = {
  async open(candidate: string): Promise<SecureOpenedFile> {
    const handle = await fs.open(candidate, "r");
    try {
      const finalPath = await linuxFinalPath(handle.fd);
      const stat = await handle.stat();
      return {
        finalPath,
        regular: stat.isFile(),
        size: stat.size,
        identity: `${stat.dev}:${stat.ino}`,
        modifiedAt: String(stat.mtimeMs),
        read: () => handle.readFile(),
        close: () => handle.close(),
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  },
  async openDirectory(trustedRoot: string): Promise<SecureOpenedDirectory> {
    const handle = await fs.open(trustedRoot, "r");
    try {
      const revalidate = async (): Promise<SecureDirectoryProof> => {
        const finalPath = await linuxFinalPath(handle.fd);
        const stat = await handle.stat();
        return {
          finalPath,
          directory: stat.isDirectory(),
        };
      };
      const initial = await revalidate();
      return {
        ...initial,
        revalidate,
        close: () => handle.close(),
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  },
};

/** Direct libc boundary for Darwin's descriptor-to-path proof. */
export interface DarwinFcntl {
  fcntl(fd: number, command: number, output: Buffer): unknown;
}

let darwinFcntlPromise: Promise<DarwinFcntl> | undefined;

async function loadDarwinFcntl(): Promise<DarwinFcntl> {
  if (!darwinFcntlPromise) {
    darwinFcntlPromise = (async () => {
      const koffi = (await import("koffi")).default;
      const libSystem = koffi.load("/usr/lib/libSystem.B.dylib");
      return {
        fcntl: rawCall(libSystem.func("fcntl", "int", ["int", "int", "void *"])),
      };
    })();
  }
  return darwinFcntlPromise;
}

function darwinFinalPath(api: DarwinFcntl, fd: number): string {
  // Darwin bsd/sys/fcntl.h defines F_GETPATH (50) for a MAXPATHLEN buffer on this fd.
  const buffer = Buffer.alloc(DARWIN_MAXPATHLEN);
  const result = api.fcntl(fd, DARWIN_F_GETPATH, buffer);
  if (result !== 0 && result !== 0n) {
    throw refusal("unreadable", "Darwin F_GETPATH could not prove the opened handle path.");
  }
  const terminator = buffer.indexOf(0);
  if (terminator <= 0) {
    throw refusal("unreadable", "Darwin F_GETPATH returned an invalid handle path.");
  }
  const finalPath = buffer.subarray(0, terminator).toString("utf8");
  if (!path.posix.isAbsolute(finalPath) || finalPath.endsWith(" (deleted)")) {
    throw refusal("unreadable", "Darwin F_GETPATH did not return a live absolute handle path.");
  }
  return finalPath;
}

function assertDarwinHandleLinked(nlink: number): void {
  if (!Number.isSafeInteger(nlink) || nlink < 1) {
    throw refusal("unreadable", "The Darwin handle was deleted before its containment could be proved.");
  }
}

async function openDarwin(candidate: string, api: DarwinFcntl): Promise<SecureOpenedFile> {
  const handle = await fs.open(candidate, "r");
  try {
    const finalPath = darwinFinalPath(api, handle.fd);
    const stat = await handle.stat();
    assertDarwinHandleLinked(stat.nlink);
    return {
      finalPath,
      regular: stat.isFile(),
      size: stat.size,
      identity: `${stat.dev}:${stat.ino}`,
      modifiedAt: String(stat.mtimeMs),
      read: () => handle.readFile(),
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function darwinDirectoryProof(api: DarwinFcntl, handle: Awaited<ReturnType<typeof fs.open>>): Promise<SecureDirectoryProof> {
  const finalPath = darwinFinalPath(api, handle.fd);
  const stat = await handle.stat();
  assertDarwinHandleLinked(stat.nlink);
  return {
    finalPath,
    directory: stat.isDirectory(),
  };
}

async function openDarwinDirectory(trustedRoot: string, api: DarwinFcntl): Promise<SecureOpenedDirectory> {
  const handle = await fs.open(trustedRoot, "r");
  try {
    const initial = await darwinDirectoryProof(api, handle);
    if (!initial.directory) {
      throw refusal("unreadable", "The Darwin trusted-root handle is not a directory.");
    }
    return {
      ...initial,
      revalidate: () => darwinDirectoryProof(api, handle),
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Testable Darwin backend; production loads libSystem directly below. */
export function createDarwinBackend(api: DarwinFcntl): SecureOpenBackend {
  return {
    open: (candidate) => openDarwin(candidate, api),
    openDirectory: (trustedRoot) => openDarwinDirectory(trustedRoot, api),
  };
}

const darwinBackend: SecureOpenBackend = {
  async open(candidate: string): Promise<SecureOpenedFile> {
    return openDarwin(candidate, await loadDarwinFcntl());
  },
  async openDirectory(trustedRoot: string): Promise<SecureOpenedDirectory> {
    return openDarwinDirectory(trustedRoot, await loadDarwinFcntl());
  },
};

type Win32Handle = bigint;
type RawWin32Call = (...args: readonly unknown[]) => unknown;

interface Win32Api {
  createFileW: RawWin32Call;
  getFinalPathNameByHandleW: RawWin32Call;
  getFileSizeEx: RawWin32Call;
  getFileType: RawWin32Call;
  getFileInformationByHandle: RawWin32Call;
  readFile: RawWin32Call;
  closeHandle: RawWin32Call;
  getLastError: RawWin32Call;
}

let win32ApiPromise: Promise<Win32Api> | undefined;

function rawCall(value: unknown): RawWin32Call {
  if (typeof value !== "function") throw refusal("unreadable", "A required Win32 API entry point is unavailable.");
  return value as unknown as RawWin32Call;
}

async function loadWin32Api(): Promise<Win32Api> {
  if (!win32ApiPromise) {
    win32ApiPromise = (async () => {
      const koffi = (await import("koffi")).default;
      const kernel32 = koffi.load("kernel32.dll");
      const handle = koffi.pointer("SecureOpenHandle", koffi.opaque());
      const fileTime = koffi.struct("SecureOpenFileTime", {
        dwLowDateTime: "uint32_t",
        dwHighDateTime: "uint32_t",
      });
      const fileInformation = koffi.struct("SecureOpenByHandleFileInformation", {
        dwFileAttributes: "uint32_t",
        ftCreationTime: fileTime,
        ftLastAccessTime: fileTime,
        ftLastWriteTime: fileTime,
        dwVolumeSerialNumber: "uint32_t",
        nFileSizeHigh: "uint32_t",
        nFileSizeLow: "uint32_t",
        nNumberOfLinks: "uint32_t",
        nFileIndexHigh: "uint32_t",
        nFileIndexLow: "uint32_t",
      });
      const dwordOut = koffi.out(koffi.pointer("uint32_t"));
      const int64Out = koffi.out(koffi.pointer("int64_t"));
      const fileInformationOut = koffi.out(koffi.pointer(fileInformation));

      return {
        createFileW: rawCall(
          kernel32.func("__stdcall", "CreateFileW", handle, [
            "str16",
            "uint32_t",
            "uint32_t",
            "void *",
            "uint32_t",
            "uint32_t",
            handle,
          ])
        ),
        getFinalPathNameByHandleW: rawCall(
          kernel32.func("__stdcall", "GetFinalPathNameByHandleW", "uint32_t", [
            handle,
            "void *",
            "uint32_t",
            "uint32_t",
          ])
        ),
        getFileSizeEx: rawCall(
          kernel32.func("__stdcall", "GetFileSizeEx", "bool", [handle, int64Out])
        ),
        getFileType: rawCall(kernel32.func("__stdcall", "GetFileType", "uint32_t", [handle])),
        getFileInformationByHandle: rawCall(
          kernel32.func("__stdcall", "GetFileInformationByHandle", "bool", [handle, fileInformationOut])
        ),
        readFile: rawCall(
          kernel32.func("__stdcall", "ReadFile", "bool", [
            handle,
            "void *",
            "uint32_t",
            dwordOut,
            "void *",
          ])
        ),
        closeHandle: rawCall(kernel32.func("__stdcall", "CloseHandle", "bool", [handle])),
        getLastError: rawCall(kernel32.func("__stdcall", "GetLastError", "uint32_t", [])),
      };
    })();
  }
  return win32ApiPromise;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === 1n;
}

function asUint32(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
    ? value
    : undefined;
}

function asSafeNonnegativeInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  return undefined;
}

function asWin32Handle(value: unknown): Win32Handle | undefined {
  if (
    typeof value === "bigint" &&
    value > 0n &&
    value !== 0xffff_ffffn &&
    value !== 0xffff_ffff_ffff_ffffn
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value !== -1) return BigInt(value);
  return undefined;
}

function win32Error(api: Win32Api, fallback: SecureOpenRefusal, mapMissing = false): SecureOpenError {
  const code = asUint32(api.getLastError());
  if (mapMissing && (code === 2 || code === 3)) return refusal("not-found", `Win32 error ${code}.`);
  return refusal(fallback, code === undefined ? "Win32 operation failed." : `Win32 error ${code}.`);
}

function closeWin32Handle(api: Win32Api, handle: Win32Handle): void {
  if (!asBoolean(api.closeHandle(handle))) throw win32Error(api, "unreadable");
}

function win32FinalPath(api: Win32Api, handle: Win32Handle): string {
  let capacity = 260;
  while (capacity <= WIN32_MAX_PATH_CHARS) {
    const buffer = Buffer.alloc(capacity * 2);
    const written = asUint32(api.getFinalPathNameByHandleW(handle, buffer, capacity, 0));
    if (written === undefined || written === 0) throw win32Error(api, "unreadable");
    if (written < capacity) return buffer.subarray(0, written * 2).toString("utf16le");
    if (written > WIN32_MAX_PATH_CHARS) break;
    capacity = written + 1;
  }
  throw refusal("unreadable", "The Win32 final path exceeds the trusted path buffer limit.");
}

function win32FileIdentity(fileInformation: Record<string, unknown>): { identity: string; modifiedAt: string } {
  const volumeSerial = asUint32(fileInformation["dwVolumeSerialNumber"]);
  const fileIndexHigh = asUint32(fileInformation["nFileIndexHigh"]);
  const fileIndexLow = asUint32(fileInformation["nFileIndexLow"]);
  const writeTime = fileInformation["ftLastWriteTime"];
  if (
    volumeSerial === undefined ||
    fileIndexHigh === undefined ||
    fileIndexLow === undefined ||
    typeof writeTime !== "object" ||
    writeTime === null
  ) {
    throw refusal("unreadable", "The Win32 handle did not provide stable file metadata.");
  }
  const writeTimeRecord = writeTime as Record<string, unknown>;
  const writeHigh = asUint32(writeTimeRecord["dwHighDateTime"]);
  const writeLow = asUint32(writeTimeRecord["dwLowDateTime"]);
  if (writeHigh === undefined || writeLow === undefined) {
    throw refusal("unreadable", "The Win32 handle did not provide a last-write timestamp.");
  }
  // Windows has no POSIX dev/ino pair; its handle-derived volume serial and
  // file index are the durable equivalent, while the resolver still binds bytes by digest.
  return {
    identity: `${volumeSerial}:${fileIndexHigh}:${fileIndexLow}`,
    modifiedAt: `${writeHigh}:${writeLow}`,
  };
}

async function openWindows(candidate: string): Promise<SecureOpenedFile> {
  const api = await loadWin32Api();
  const handle = asWin32Handle(
    api.createFileW(
      candidate,
      WIN32_GENERIC_READ,
      WIN32_FILE_SHARE_READ,
      null,
      WIN32_OPEN_EXISTING,
      win32CreateFileFlags("candidate"),
      null
    )
  );
  if (!handle) throw win32Error(api, "unreadable", true);

  try {
    if (asUint32(api.getFileType(handle)) !== WIN32_FILE_TYPE_DISK) {
      throw refusal("not-regular-file", "The Win32 handle is not a disk file.");
    }

    const fileInformation: Record<string, unknown> = {};
    if (!asBoolean(api.getFileInformationByHandle(handle, fileInformation))) {
      throw win32Error(api, "unreadable");
    }
    const attributes = asUint32(fileInformation["dwFileAttributes"]);
    if (attributes === undefined) throw refusal("unreadable", "The Win32 handle has invalid attributes.");
    if ((attributes & WIN32_FILE_ATTRIBUTE_DIRECTORY) !== 0) {
      throw refusal("not-regular-file", "The Win32 handle is a directory.");
    }

    const sizeOut: unknown[] = [0n];
    if (!asBoolean(api.getFileSizeEx(handle, sizeOut))) throw win32Error(api, "unreadable");
    const size = asSafeNonnegativeInteger(sizeOut[0]);
    if (size === undefined) throw refusal("unreadable", "The Win32 handle has an invalid file size.");
    const { identity, modifiedAt } = win32FileIdentity(fileInformation);
    const finalPath = win32FinalPath(api, handle);

    return {
      finalPath,
      regular: true,
      size,
      identity,
      modifiedAt,
      async read(): Promise<Buffer> {
        const bytes = Buffer.allocUnsafe(size);
        let offset = 0;
        while (offset < size) {
          const length = Math.min(size - offset, WIN32_MAX_READ_CHUNK);
          const readOut: unknown[] = [0];
          if (!asBoolean(api.readFile(handle, bytes.subarray(offset, offset + length), length, readOut, null))) {
            throw win32Error(api, "unreadable");
          }
          const read = asUint32(readOut[0]);
          if (read === undefined || read > length) {
            throw refusal("unreadable", "The Win32 handle changed while it was being read.");
          }
          if (read === 0) break;
          offset += read;
        }
        if (offset !== size) throw refusal("unreadable", "The Win32 handle ended before its statted byte count.");
        return bytes;
      },
      async close(): Promise<void> {
        closeWin32Handle(api, handle);
      },
    };
  } catch (error) {
    closeWin32Handle(api, handle);
    throw error;
  }
}

function win32DirectoryProof(api: Win32Api, handle: Win32Handle): SecureDirectoryProof {
  if (asUint32(api.getFileType(handle)) !== WIN32_FILE_TYPE_DISK) {
    throw refusal("unreadable", "The Win32 trusted-root handle is not a disk directory.");
  }

  const fileInformation: Record<string, unknown> = {};
  if (!asBoolean(api.getFileInformationByHandle(handle, fileInformation))) {
    throw win32Error(api, "unreadable");
  }
  const attributes = asUint32(fileInformation["dwFileAttributes"]);
  if (attributes === undefined) throw refusal("unreadable", "The Win32 trusted-root handle has invalid attributes.");

  return {
    finalPath: win32FinalPath(api, handle),
    directory: (attributes & WIN32_FILE_ATTRIBUTE_DIRECTORY) !== 0,
  };
}

async function openWindowsDirectory(trustedRoot: string): Promise<SecureOpenedDirectory> {
  const api = await loadWin32Api();
  const handle = asWin32Handle(
    api.createFileW(
      trustedRoot,
      WIN32_GENERIC_READ,
      WIN32_FILE_SHARE_READ,
      null,
      WIN32_OPEN_EXISTING,
      win32CreateFileFlags("directory"),
      null
    )
  );
  if (!handle) throw win32Error(api, "unreadable", true);

  try {
    const initial = win32DirectoryProof(api, handle);
    if (!initial.directory) {
      throw refusal("unreadable", "The Win32 trusted-root handle is not a directory.");
    }

    return {
      ...initial,
      revalidate: async () => win32DirectoryProof(api, handle),
      async close(): Promise<void> {
        closeWin32Handle(api, handle);
      },
    };
  } catch (error) {
    closeWin32Handle(api, handle);
    throw error;
  }
}

const windowsBackend: SecureOpenBackend = {
  open: openWindows,
  openDirectory: openWindowsDirectory,
};

function defaultBackend(): SecureOpenBackend {
  if (process.platform === "linux") return linuxBackend;
  if (process.platform === "darwin") return darwinBackend;
  if (process.platform === "win32") return windowsBackend;
  return {
    async open(): Promise<SecureOpenedFile> {
      throw refusal("unsupported-platform", `No handle-bound secure open backend exists for ${process.platform}.`);
    },
    async openDirectory(): Promise<SecureOpenedDirectory> {
      throw refusal("unsupported-platform", `No handle-bound secure open backend exists for ${process.platform}.`);
    },
  };
}

/**
 * Reads a regular file only after its final path is derived from the same open
 * handle and proven to be strictly below the trusted root.
 */
export async function secureOpen(
  candidate: string,
  trustedRoot: string,
  options: SecureOpenOptions,
  dependencies: SecureOpenDependencies = {}
): Promise<SecureOpenResult> {
  if (!validSize(options.maxBytes)) throw refusal("unreadable", "The file size limit is invalid.");

  const backend = dependencies.backend ?? defaultBackend();
  let openedRoot: SecureOpenedDirectory | undefined;
  let opened: SecureOpenedFile | undefined;
  try {
    openedRoot = await backend.openDirectory(trustedRoot);
    if (!openedRoot.directory) {
      throw refusal("unreadable", "The trusted root handle is not a directory.");
    }
    const initialRoot = normalizedFinalPath(openedRoot.finalPath);

    opened = await backend.open(candidate);
    const revalidatedRoot = await openedRoot.revalidate();
    if (!revalidatedRoot.directory) {
      throw refusal("unreadable", "The trusted root handle is no longer a directory.");
    }
    const canonicalRoot = normalizedFinalPath(revalidatedRoot.finalPath);
    if (!equivalentHandlePaths(initialRoot, canonicalRoot)) {
      throw refusal("unreadable", "The trusted root changed while the candidate was being opened.");
    }
    const finalPath = normalizedFinalPath(opened.finalPath);
    const relativePath = relativePathInsideCanonical(finalPath, canonicalRoot);
    if (!relativePath) {
      throw refusal("outside-root", "The opened handle resolves outside the trusted root.");
    }
    if (!opened.regular) throw refusal("not-regular-file");
    if (!validSize(opened.size)) throw refusal("unreadable", "The opened handle has an invalid file size.");
    if (opened.size === 0) throw refusal("empty-file");
    if (opened.size > options.maxBytes) throw refusal("too-large");

    const bytes = await opened.read();
    if (!Buffer.isBuffer(bytes) || bytes.byteLength !== opened.size) {
      throw refusal("unreadable", "The handle did not return its statted byte count.");
    }
    if (bytes.byteLength > options.maxBytes) throw refusal("too-large");
    return {
      finalPath,
      relativePath,
      size: opened.size,
      identity: opened.identity,
      modifiedAt: opened.modifiedAt,
      bytes,
    };
  } catch (error) {
    throw classifyOpenError(error);
  } finally {
    try {
      if (opened) await opened.close();
    } finally {
      if (openedRoot) await openedRoot.close();
    }
  }
}
