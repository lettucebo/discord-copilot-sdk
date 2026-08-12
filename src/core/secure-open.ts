import path from "node:path";
import {
  close as closeRawFd,
  fstat as fstatRawFd,
  promises as fs,
  read as readRawFd,
} from "node:fs";
import { promisify } from "node:util";

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
  /** Handle-derived count of directory entries for this candidate file. */
  linkCount: number;
  identity: string;
  modifiedAt: string;
  read(): Promise<Buffer>;
  close(): Promise<void>;
}

/** Metadata sourced from one still-open trusted-root directory handle. */
export interface SecureDirectoryProof {
  finalPath: string;
  identity: string;
  directory: boolean;
}

/** A trusted root that can be proven again without reopening its pathname. */
export interface SecureOpenedDirectory extends SecureDirectoryProof {
  /** Present only on POSIX roots; it is the descriptor used for openat traversal. */
  readonly fd?: number;
  /** POSIX candidates must be opened below this proof, never by their pathname. */
  openCandidate?(candidate: string, maxBytes: number): Promise<SecureOpenedFile>;
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
  /** Test-only lexical grammar for fake handle paths; production always uses the native default. */
  pathMode?: "win32" | "posix";
}

interface TrustedRootState {
  readonly originalPath: string;
  readonly finalPath: string;
  readonly identity: string;
  readonly openedRoot: SecureOpenedDirectory;
  readonly backend: SecureOpenBackend;
  readonly pathMode: "win32" | "posix";
  activeUses: number;
  closing: boolean;
  closePromise?: Promise<void>;
  closeWaiter?: () => void;
}

const trustedRootStates = new WeakMap<object, TrustedRootState>();
const trustedRootConstructionToken = Symbol("trusted-root-capability");

/**
 * A non-serializable capability over one live, capture-time directory handle.
 * Its constructor is deliberately module-private: a pathname and scalar file
 * id must never be sufficient to manufacture a trusted root.
 */
class TrustedRootCapability {
  // Gives the exported alias nominal runtime/type identity without exposing
  // any mutable path or proof fields to callers.
  readonly #opaque = true;

  constructor(token: symbol, state: TrustedRootState) {
    if (token !== trustedRootConstructionToken) {
      throw refusal("unreadable", "Only captureTrustedRoot can create a trusted root capability.");
    }
    trustedRootStates.set(this, state);
  }

  /** Lexical input anchor only; secure resolution remains handle-bound. */
  get originalPath(): string {
    return trustedRootState(this).originalPath;
  }

  /** Immutable final path reported by the still-open directory handle at
   * capture time. Consumers may prove ownership with this value, but cannot
   * construct or retarget the capability from it. */
  get finalPath(): string {
    return trustedRootState(this).finalPath;
  }

  /** True from the instant teardown begins, including while active reads drain. */
  get closed(): boolean {
    return trustedRootState(this).closing;
  }

  /**
   * Releases the retained handle exactly once. New resolutions fail immediately;
   * a resolution already using the handle drains before its close runs.
   */
  close(): Promise<void> {
    return closeTrustedRootState(trustedRootState(this));
  }
}

/** Opaque live root capability, constructible only by captureTrustedRoot(). */
export type TrustedRoot = TrustedRootCapability;

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
const POSIX_O_RDONLY = 0;
const POSIX_O_CLOEXEC_LINUX = 0x8_0000;
const POSIX_O_DIRECTORY_LINUX = 0x1_0000;
const POSIX_O_NOFOLLOW_LINUX = 0x2_0000;
const POSIX_O_NONBLOCK_LINUX = 0x800;
const POSIX_O_CLOEXEC_DARWIN = 0x1_000000;
const POSIX_O_DIRECTORY_DARWIN = 0x1_00000;
const POSIX_O_NOFOLLOW_DARWIN = 0x100;
const POSIX_O_NONBLOCK_DARWIN = 0x4;

export const LINUX_POSIX_OPEN_FLAGS = {
  root: POSIX_O_RDONLY | POSIX_O_NONBLOCK_LINUX | POSIX_O_DIRECTORY_LINUX | POSIX_O_CLOEXEC_LINUX,
  intermediate:
    POSIX_O_RDONLY | POSIX_O_DIRECTORY_LINUX | POSIX_O_NOFOLLOW_LINUX | POSIX_O_CLOEXEC_LINUX,
  leaf: POSIX_O_RDONLY | POSIX_O_NOFOLLOW_LINUX | POSIX_O_NONBLOCK_LINUX | POSIX_O_CLOEXEC_LINUX,
} as const;

const DARWIN_POSIX_OPEN_FLAGS = {
  root: POSIX_O_RDONLY | POSIX_O_NONBLOCK_DARWIN | POSIX_O_DIRECTORY_DARWIN | POSIX_O_CLOEXEC_DARWIN,
  intermediate:
    POSIX_O_RDONLY | POSIX_O_DIRECTORY_DARWIN | POSIX_O_NOFOLLOW_DARWIN | POSIX_O_CLOEXEC_DARWIN,
  leaf: POSIX_O_RDONLY | POSIX_O_NOFOLLOW_DARWIN | POSIX_O_NONBLOCK_DARWIN | POSIX_O_CLOEXEC_DARWIN,
} as const;

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
function defaultHandlePathMode(): "win32" | "posix" {
  return process.platform === "win32" ? "win32" : "posix";
}

function normalizeHandlePath(value: string, pathMode: "win32" | "posix"): string | undefined {
  if (pathMode === "win32") {
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

function relativePathInsideCanonical(
  finalPath: string,
  canonicalRoot: string,
  pathMode: "win32" | "posix"
): string | undefined {
  const normalizedFinal = normalizeHandlePath(finalPath, pathMode);
  const normalizedRoot = normalizeHandlePath(canonicalRoot, pathMode);
  if (!normalizedFinal || !normalizedRoot) return undefined;

  const pathApi = pathMode === "win32" ? path.win32 : path.posix;
  // path.win32.relative case-folds even when Windows directories are configured
  // case-sensitive. Handle-derived paths must match exactly at a segment boundary.
  const rootPrefix = normalizedRoot.endsWith(pathApi.sep) ? normalizedRoot : `${normalizedRoot}${pathApi.sep}`;
  const relative = normalizedFinal.startsWith(rootPrefix) ? normalizedFinal.slice(rootPrefix.length) : "";
  return relative || undefined;
}

function normalizedFinalPath(value: string, pathMode: "win32" | "posix"): string {
  const normalized = normalizeHandlePath(value, pathMode);
  if (!normalized) throw refusal("unreadable", "The opened handle did not provide an absolute final path.");
  return normalized;
}

function lexicalRootPath(value: string, pathMode: "win32" | "posix"): string {
  const pathApi = pathMode === "win32" ? path.win32 : path.posix;
  return pathApi.resolve(value);
}

function stableDirectoryIdentity(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw refusal("unreadable", "The trusted-root handle did not provide a stable identity.");
  }
  return value;
}

function captureDirectoryProof(
  proof: SecureDirectoryProof,
  pathMode: "win32" | "posix"
): { finalPath: string; identity: string } {
  if (!proof.directory) throw refusal("unreadable", "The trusted root handle is not a directory.");
  return {
    finalPath: normalizedFinalPath(proof.finalPath, pathMode),
    identity: stableDirectoryIdentity(proof.identity),
  };
}

function trustedRootState(trustedRoot: TrustedRoot): TrustedRootState {
  if (!(trustedRoot instanceof TrustedRootCapability)) {
    throw refusal("unreadable", "The trusted root is not a live capability.");
  }
  const state = trustedRootStates.get(trustedRoot);
  if (!state) throw refusal("unreadable", "The trusted root capability is unavailable.");
  return state;
}

function closeTrustedRootState(state: TrustedRootState): Promise<void> {
  if (state.closePromise) return state.closePromise;
  state.closing = true;
  state.closePromise = (async () => {
    if (state.activeUses > 0) {
      await new Promise<void>((resolve) => {
        state.closeWaiter = resolve;
      });
    }
    await state.openedRoot.close();
  })();
  return state.closePromise;
}

function acquireTrustedRootUse(trustedRoot: TrustedRoot): {
  state: TrustedRootState;
  release(): void;
} {
  const state = trustedRootState(trustedRoot);
  if (state.closing) throw refusal("unreadable", "The trusted root capability is closed.");
  state.activeUses += 1;
  let released = false;
  return {
    state,
    release(): void {
      if (released) return;
      released = true;
      state.activeUses -= 1;
      if (state.activeUses === 0) {
        const waiter = state.closeWaiter;
        state.closeWaiter = undefined;
        waiter?.();
      }
    },
  };
}

function assertCapturedRoot(
  proof: SecureDirectoryProof,
  trustedRoot: { finalPath: string; identity: string },
  pathMode: "win32" | "posix"
): void {
  const current = captureDirectoryProof(proof, pathMode);
  if (current.finalPath !== trustedRoot.finalPath || current.identity !== trustedRoot.identity) {
    throw refusal("unreadable", "The retained trusted-root handle no longer matches its captured proof.");
  }
}

function validSize(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export interface PosixNativeApi {
  openat(dirFd: number, component: string, flags: number): unknown;
  errno?(): unknown;
}

export interface PosixStat {
  dev: unknown;
  ino: unknown;
  mtimeMs: unknown;
  nlink: unknown;
  size: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface PosixRawReadResult {
  bytesRead: unknown;
  buffer: unknown;
}

export interface PosixDirectoryHandle {
  readonly fd: number;
  close(): Promise<void>;
}

/** Test injection for the raw descriptors that openat returns. */
export interface PosixBackendDependencies {
  openDirectory?(trustedRoot: string, flags: number): Promise<PosixDirectoryHandle>;
  finalPath?(fd: number): Promise<string>;
  fstat?(fd: number): Promise<PosixStat>;
  read?(
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null
  ): Promise<PosixRawReadResult>;
  close?(fd: number): Promise<void>;
}

interface PosixFileMetadata {
  size: number;
  linkCount: number;
  identity: string;
  modifiedAt: string;
}

interface PosixOperations {
  openDirectory(trustedRoot: string, flags: number): Promise<PosixDirectoryHandle>;
  finalPath(fd: number): Promise<string>;
  fstat(fd: number): Promise<PosixStat>;
  read(
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null
  ): Promise<PosixRawReadResult>;
  close(fd: number): Promise<void>;
}

interface PosixOpenFlags {
  root: number;
  intermediate: number;
  leaf: number;
}

const fstatRawFdAsync = promisify(fstatRawFd);
const readRawFdAsync = promisify(readRawFd);
const closeRawFdAsync = promisify(closeRawFd);

function defaultPosixOperations(
  defaultFinalPath: (fd: number) => Promise<string>,
  flags: PosixOpenFlags,
  dependencies: PosixBackendDependencies
): PosixOperations {
  return {
    openDirectory:
      dependencies.openDirectory ??
      (async (trustedRoot, rootFlags) => fs.open(trustedRoot, requiredPosixRootOpenFlags(flags.root, rootFlags))),
    finalPath: dependencies.finalPath ?? defaultFinalPath,
    fstat: dependencies.fstat ?? (async (fd) => (await fstatRawFdAsync(fd)) as unknown as PosixStat),
    read:
      dependencies.read ??
      (async (fd, buffer, offset, length, position) =>
        (await readRawFdAsync(fd, buffer, offset, length, position)) as unknown as PosixRawReadResult),
    close: dependencies.close ?? (async (fd) => closeRawFdAsync(fd)),
  };
}

/**
 * A string "r" open can block forever on a FIFO substituted for the trusted
 * root before fstat can reject it. Require the fixed native numeric flags;
 * an unsupported flag makes fs.open fail closed rather than downgrading.
 */
function requiredPosixRootOpenFlags(expected: number, requested: number): number {
  if (!Number.isSafeInteger(expected) || expected < 0 || requested !== expected) {
    throw refusal("unreadable", "Required POSIX trusted-root open flags are unavailable.");
  }
  return requested;
}

function posixFd(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function posixErrno(api: PosixNativeApi): number | undefined {
  const value = api.errno?.();
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function openPosixAt(api: PosixNativeApi, dirFd: number, component: string, flags: number): number {
  let opened: unknown;
  try {
    opened = api.openat(dirFd, component, flags);
  } catch {
    throw refusal("unreadable", "POSIX openat failed.");
  }
  const fd = posixFd(opened);
  if (fd !== undefined) return fd;

  const errno = posixErrno(api);
  if (errno === 2) throw refusal("not-found", "POSIX openat could not find the requested component.");
  // O_NOFOLLOW can report ELOOP; O_DIRECTORY can report ENOTDIR for that
  // same symlink. Neither may be retried through a pathname.
  if (errno === 20 || errno === 40) {
    throw refusal("outside-root", "POSIX openat refused a non-directory or symbolic-link component.");
  }
  throw refusal("unreadable", "POSIX openat did not return a usable descriptor.");
}

function lexicalPosixComponents(candidate: string, originalRoot: string): string[] {
  const pathApi = path.posix;
  const absolute = pathApi.isAbsolute(candidate);
  const raw = absolute ? candidate.slice(1) : candidate;
  const rawComponents = raw.split("/");
  if (
    rawComponents.length === 0 ||
    rawComponents.some((component) => component.length === 0 || component === "." || component === "..")
  ) {
    throw refusal("outside-root", "The candidate path contains an unsafe lexical component.");
  }

  const relative = absolute ? pathApi.relative(pathApi.resolve(originalRoot), pathApi.resolve(candidate)) : candidate;
  if (
    relative.length === 0 ||
    relative === "." ||
    relative === ".." ||
    relative.startsWith("../") ||
    pathApi.isAbsolute(relative)
  ) {
    throw refusal("outside-root", "The candidate path is lexically outside the requested worktree.");
  }

  const components = relative.split("/");
  if (
    components.length === 0 ||
    components.some((component) => component.length === 0 || component === "." || component === "..")
  ) {
    throw refusal("outside-root", "The candidate path cannot be represented as safe lookup components.");
  }
  return components;
}

function assertPosixHandleLinked(stat: PosixStat): void {
  if (typeof stat.nlink !== "number" || !Number.isSafeInteger(stat.nlink) || stat.nlink < 1) {
    throw refusal("unreadable", "The POSIX handle was deleted before its containment could be proved.");
  }
}

function posixCandidateLinkCount(stat: PosixStat): number {
  if (typeof stat.nlink !== "number" || !Number.isSafeInteger(stat.nlink) || stat.nlink !== 1) {
    throw refusal("unreadable", "The POSIX candidate is externally reachable or deleted.");
  }
  return stat.nlink;
}

function stablePosixStatField(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);
  throw refusal("unreadable", "The POSIX handle did not provide stable file metadata.");
}

function posixFileMetadata(stat: PosixStat): PosixFileMetadata {
  if (!stat.isFile()) throw refusal("not-regular-file");
  const linkCount = posixCandidateLinkCount(stat);
  if (!validSize(stat.size)) throw refusal("unreadable", "The POSIX handle has an invalid file size.");
  return {
    size: stat.size,
    linkCount,
    identity: `${stablePosixStatField(stat.dev)}:${stablePosixStatField(stat.ino)}`,
    modifiedAt: stablePosixStatField(stat.mtimeMs),
  };
}

async function posixDirectoryProof(
  handle: PosixDirectoryHandle,
  operations: PosixOperations
): Promise<SecureDirectoryProof> {
  const finalPath = await operations.finalPath(handle.fd);
  const stat = await operations.fstat(handle.fd);
  assertPosixHandleLinked(stat);
  return {
    finalPath,
    identity: `${stablePosixStatField(stat.dev)}:${stablePosixStatField(stat.ino)}`,
    directory: stat.isDirectory(),
  };
}

async function readPosixBounded(
  fd: number,
  metadata: PosixFileMetadata,
  operations: PosixOperations
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(metadata.size);
  let offset = 0;
  while (offset < metadata.size) {
    const length = metadata.size - offset;
    const result = await operations.read(fd, bytes, offset, length, null);
    const bytesRead = result?.bytesRead;
    if (
      !result ||
      result.buffer !== bytes ||
      typeof bytesRead !== "number" ||
      !Number.isSafeInteger(bytesRead) ||
      bytesRead <= 0 ||
      bytesRead > length
    ) {
      throw refusal("unreadable", "The POSIX descriptor changed while it was being read.");
    }
    offset += bytesRead;
  }

  const after = posixFileMetadata(await operations.fstat(fd));
  if (
    after.size !== metadata.size ||
    after.linkCount !== metadata.linkCount ||
    after.identity !== metadata.identity ||
    after.modifiedAt !== metadata.modifiedAt
  ) {
    throw refusal("unreadable", "The POSIX descriptor changed while it was being read.");
  }
  return bytes;
}

async function openPosixCandidate(
  api: PosixNativeApi,
  operations: PosixOperations,
  flags: PosixOpenFlags,
  rootFd: number,
  candidate: string,
  originalRoot: string,
  maxBytes: number
): Promise<SecureOpenedFile> {
  if (!validSize(maxBytes)) throw refusal("unreadable", "The file size limit is invalid.");
  const components = lexicalPosixComponents(candidate, originalRoot);
  let currentFd = rootFd;
  let ownsCurrent = false;
  let leafFd: number | undefined;
  let leafClosed = false;

  const releaseCurrent = async (): Promise<void> => {
    if (!ownsCurrent) return;
    const fd = currentFd;
    ownsCurrent = false;
    await operations.close(fd);
  };
  const closeLeaf = async (): Promise<void> => {
    if (leafFd === undefined || leafClosed) return;
    leafClosed = true;
    await operations.close(leafFd);
  };

  try {
    for (const component of components.slice(0, -1)) {
      const nextFd = openPosixAt(api, currentFd, component, flags.intermediate);
      try {
        await releaseCurrent();
      } catch (error) {
        try {
          await operations.close(nextFd);
        } catch {
          // The predecessor close was attempted once; do not retry either fd.
        }
        throw error;
      }
      currentFd = nextFd;
      ownsCurrent = true;
    }

    const leaf = components.at(-1);
    if (!leaf) throw refusal("outside-root", "The candidate has no leaf component.");
    leafFd = openPosixAt(api, currentFd, leaf, flags.leaf);
    await releaseCurrent();

    const metadata = posixFileMetadata(await operations.fstat(leafFd));
    if (metadata.size === 0) throw refusal("empty-file");
    if (metadata.size > maxBytes) throw refusal("too-large");
    const finalPath = await operations.finalPath(leafFd);

    return {
      finalPath,
      regular: true,
      size: metadata.size,
      linkCount: metadata.linkCount,
      identity: metadata.identity,
      modifiedAt: metadata.modifiedAt,
      read: () => readPosixBounded(leafFd as number, metadata, operations),
      close: closeLeaf,
    };
  } catch (error) {
    try {
      await closeLeaf();
    } catch {
      // The original refusal is more useful; no descriptor is retried.
    }
    try {
      await releaseCurrent();
    } catch {
      // The original refusal is more useful; no descriptor is retried.
    }
    throw error;
  }
}

function createPosixBackend(
  api: PosixNativeApi,
  flags: PosixOpenFlags,
  defaultFinalPath: (fd: number) => Promise<string>,
  dependencies: PosixBackendDependencies = {}
): SecureOpenBackend {
  const operations = defaultPosixOperations(defaultFinalPath, flags, dependencies);
  return {
    async open(): Promise<SecureOpenedFile> {
      throw refusal("unreadable", "POSIX candidates must be opened relative to the trusted root descriptor.");
    },
    async openDirectory(trustedRoot: string): Promise<SecureOpenedDirectory> {
      let handle: PosixDirectoryHandle | undefined;
      let rootClosed = false;
      const closeRoot = async (): Promise<void> => {
        if (!handle || rootClosed) return;
        rootClosed = true;
        await handle.close();
      };

      try {
        handle = await operations.openDirectory(trustedRoot, flags.root);
        const rootFd = posixFd(handle.fd);
        if (rootFd === undefined) {
          throw refusal("unreadable", "The trusted POSIX root did not provide a usable descriptor.");
        }
        const initial = await posixDirectoryProof(handle, operations);
        if (!initial.directory) {
          throw refusal("unreadable", "The POSIX trusted-root handle is not a directory.");
        }
        return {
          ...initial,
          fd: rootFd,
          revalidate: () => posixDirectoryProof(handle as PosixDirectoryHandle, operations),
          openCandidate: (candidate, maxBytes) =>
            openPosixCandidate(api, operations, flags, rootFd, candidate, trustedRoot, maxBytes),
          close: closeRoot,
        };
      } catch (error) {
        try {
          await closeRoot();
        } catch {
          // The root has already been marked closed; do not retry it.
        }
        throw error;
      }
    },
  };
}

async function linuxFinalPath(fd: number): Promise<string> {
  const finalPath = await fs.readlink(`/proc/self/fd/${fd}`);
  if (finalPath.endsWith(" (deleted)")) {
    throw refusal("unreadable", "The opened handle was deleted before its containment could be proved.");
  }
  return finalPath;
}

type RawPosixCall = (...args: readonly unknown[]) => unknown;

function posixRawCall(value: unknown): RawPosixCall {
  if (typeof value !== "function") throw refusal("unreadable", "A required POSIX API entry point is unavailable.");
  return value as unknown as RawPosixCall;
}

export type LinuxLibcLoad<T> = (soname: string) => T;

/**
 * glibc exposes libc.so.6 on every supported architecture. musl uses an
 * architecture-specific SONAME, so ambiguous Node architectures are omitted
 * rather than guessing a compatible libc. libc.so is only a final fallback
 * after an exact musl SONAME is known for the current architecture.
 */
const MUSL_LIBC_SONAME_BY_NODE_ARCH: Readonly<Record<string, string>> = {
  arm64: "libc.musl-aarch64.so.1",
  ia32: "libc.musl-i386.so.1",
  riscv64: "libc.musl-riscv64.so.1",
  s390x: "libc.musl-s390x.so.1",
  x64: "libc.musl-x86_64.so.1",
};

/** Ordered Linux libc loader candidates for a known Node CPU architecture. */
export function linuxLibcCandidates(architecture: string = process.arch): readonly string[] {
  const muslSoname = MUSL_LIBC_SONAME_BY_NODE_ARCH[architecture];
  return muslSoname ? ["libc.so.6", muslSoname, "libc.so"] : ["libc.so.6"];
}

/**
 * Loads only a glibc SONAME or the musl SONAME explicitly matched to this CPU.
 * Koffi errors are intentionally not exposed: failure to load every candidate
 * must leave the secure-open boundary closed.
 */
export function loadLinuxLibc<T>(load: LinuxLibcLoad<T>, architecture: string = process.arch): T {
  const candidates = linuxLibcCandidates(architecture);
  for (const candidate of candidates) {
    try {
      return load(candidate);
    } catch {
      // Try the next compatible libc SONAME.
    }
  }

  throw refusal(
    "unreadable",
    `Unable to load a compatible Linux libc for ${architecture}; tried ${candidates.join(", ")}.`
  );
}

let linuxApiPromise: Promise<PosixNativeApi> | undefined;

async function loadLinuxApi(): Promise<PosixNativeApi> {
  if (!linuxApiPromise) {
    linuxApiPromise = (async () => {
      const koffi = (await import("koffi")).default;
      const libc = loadLinuxLibc((candidate) => koffi.load(candidate));
      const openat = posixRawCall(libc.func("openat", "int", ["int", "str", "int"]));
      const errno = posixRawCall(koffi.errno);
      return {
        openat: (dirFd, component, flags) => openat(dirFd, component, flags),
        errno: () => errno(),
      };
    })();
  }
  return linuxApiPromise;
}

/** Testable Linux backend; production loads libc directly below. */
export function createLinuxBackend(
  api: PosixNativeApi,
  dependencies: PosixBackendDependencies = {}
): SecureOpenBackend {
  return createPosixBackend(api, LINUX_POSIX_OPEN_FLAGS, linuxFinalPath, dependencies);
}

const linuxBackend: SecureOpenBackend = {
  async open(): Promise<SecureOpenedFile> {
    throw refusal("unreadable", "POSIX candidates must be opened relative to the trusted root descriptor.");
  },
  async openDirectory(trustedRoot: string): Promise<SecureOpenedDirectory> {
    return createLinuxBackend(await loadLinuxApi()).openDirectory(trustedRoot);
  },
};

/** Direct libSystem boundary for Darwin's descriptor-to-path proof and openat traversal. */
export interface DarwinFcntl extends PosixNativeApi {
  fcntl(fd: number, command: number, output: Buffer): unknown;
}

let darwinFcntlPromise: Promise<DarwinFcntl> | undefined;

async function loadDarwinFcntl(): Promise<DarwinFcntl> {
  if (!darwinFcntlPromise) {
    darwinFcntlPromise = (async () => {
      const koffi = (await import("koffi")).default;
      const libSystem = koffi.load("/usr/lib/libSystem.B.dylib");
      const fcntl = posixRawCall(libSystem.func("fcntl", "int", ["int", "int", "void *"]));
      const openat = posixRawCall(libSystem.func("openat", "int", ["int", "str", "int"]));
      const errno = posixRawCall(koffi.errno);
      return {
        fcntl: (fd, command, output) => fcntl(fd, command, output),
        openat: (dirFd, component, flags) => openat(dirFd, component, flags),
        errno: () => errno(),
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

/** Testable Darwin backend; production loads libSystem directly below. */
export function createDarwinBackend(
  api: DarwinFcntl,
  dependencies: PosixBackendDependencies = {}
): SecureOpenBackend {
  return createPosixBackend(api, DARWIN_POSIX_OPEN_FLAGS, async (fd) => darwinFinalPath(api, fd), dependencies);
}

const darwinBackend: SecureOpenBackend = {
  async open(): Promise<SecureOpenedFile> {
    throw refusal("unreadable", "POSIX candidates must be opened relative to the trusted root descriptor.");
  },
  async openDirectory(trustedRoot: string): Promise<SecureOpenedDirectory> {
    return createDarwinBackend(await loadDarwinFcntl()).openDirectory(trustedRoot);
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

function win32CandidateMetadata(
  fileInformation: Record<string, unknown>
): { identity: string; modifiedAt: string; linkCount: number } {
  const linkCount = asUint32(fileInformation["nNumberOfLinks"]);
  if (linkCount !== 1) {
    throw refusal("unreadable", "The Win32 candidate is externally reachable or deleted.");
  }
  return { ...win32FileIdentity(fileInformation), linkCount };
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
    const { identity, modifiedAt, linkCount } = win32CandidateMetadata(fileInformation);
    const finalPath = win32FinalPath(api, handle);

    return {
      finalPath,
      regular: true,
      size,
      linkCount,
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
  const { identity } = win32FileIdentity(fileInformation);

  return {
    finalPath: win32FinalPath(api, handle),
    identity,
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
 * Opens and retains the directory capability before a session can trust it for
 * file delivery. The caller owns close(): releasing this handle is the only
 * teardown path, never a later pathname reopen plus scalar-id comparison.
 */
export async function captureTrustedRoot(
  workDir: string,
  dependencies: SecureOpenDependencies = {}
): Promise<TrustedRoot> {
  const backend = dependencies.backend ?? defaultBackend();
  const pathMode = dependencies.pathMode ?? defaultHandlePathMode();
  const originalPath = lexicalRootPath(workDir, pathMode);
  let openedRoot: SecureOpenedDirectory | undefined;
  try {
    openedRoot = await backend.openDirectory(originalPath);
    const proof = captureDirectoryProof(openedRoot, pathMode);
    return new TrustedRootCapability(trustedRootConstructionToken, {
      originalPath,
      finalPath: proof.finalPath,
      identity: proof.identity,
      openedRoot,
      backend,
      pathMode,
      activeUses: 0,
      closing: false,
    });
  } catch (error) {
    if (openedRoot) {
      try {
        await openedRoot.close();
      } catch {
        // The attempted close cannot make the failed capture safe to use.
      }
    }
    throw classifyOpenError(error);
  }
}

/**
 * Reads a regular file from the retained root handle. The capability chooses
 * the backend/path grammar captured with that handle; a later caller cannot
 * redirect resolution by supplying another mutable root pathname or backend.
 */
export async function secureOpen(
  candidate: string,
  trustedRoot: TrustedRoot,
  options: SecureOpenOptions
): Promise<SecureOpenResult> {
  if (!validSize(options.maxBytes)) throw refusal("unreadable", "The file size limit is invalid.");

  const lease = acquireTrustedRootUse(trustedRoot);
  const { state: capturedRoot } = lease;
  let opened: SecureOpenedFile | undefined;
  try {
    assertCapturedRoot(await capturedRoot.openedRoot.revalidate(), capturedRoot, capturedRoot.pathMode);

    opened = capturedRoot.openedRoot.openCandidate
      ? await capturedRoot.openedRoot.openCandidate(candidate, options.maxBytes)
      : await capturedRoot.backend.open(candidate);
    const revalidatedRoot = await capturedRoot.openedRoot.revalidate();
    assertCapturedRoot(revalidatedRoot, capturedRoot, capturedRoot.pathMode);
    const finalPath = normalizedFinalPath(opened.finalPath, capturedRoot.pathMode);
    const relativePath = relativePathInsideCanonical(finalPath, capturedRoot.finalPath, capturedRoot.pathMode);
    if (!relativePath) {
      throw refusal("outside-root", "The opened handle resolves outside the trusted root.");
    }
    if (!opened.regular) throw refusal("not-regular-file");
    if (opened.linkCount !== 1) {
      throw refusal("unreadable", "The candidate handle is externally reachable or deleted.");
    }
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
      lease.release();
    }
  }
}
