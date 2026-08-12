import path from "node:path";
import { constants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { isStrictlyInside } from "./repo.js";
import { hasBidiOrControls, sanitizeForInlineCode } from "./text-safety.js";

export type OutboundFilePolicy = "agent" | "operator";

export interface OutboundFile {
  absPath: string;
  displayName: string;
  size: number;
  fingerprint: string;
  /** Present on files produced by resolveOutboundFile; optional so transport
   * fixtures and adapters that never validate content remain source-compatible. */
  digest?: string;
  bytes: Buffer;
}

export type OutboundRefusal =
  | "not-found"
  | "unreadable"
  | "outside-workdir"
  | ".git-internal"
  | "not-regular-file"
  | "empty-file"
  | "too-large"
  | "unsafe-filename"
  | "disallowed-extension";

export interface ValidatedOutboundFile extends OutboundFile {
  digest: string;
}

export type ResolveOutboundFileResult = { ok: true; file: ValidatedOutboundFile } | { ok: false; reason: OutboundRefusal };

export interface ResolveOutboundFileOptions {
  maxBytes: number;
  policy: OutboundFilePolicy;
}

const AGENT_ALLOWED_EXTENSIONS = new Set([
  ".docx",
  ".xlsx",
  ".pptx",
  ".pdf",
  ".csv",
  ".txt",
  ".md",
  ".json",
  ".log",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".zip",
]);

export const DISCORD_BLOCKED_EXECUTABLE_EXTENSIONS = new Set([".exe", ".bat", ".cmd", ".scr", ".msi", ".com"]);
export const MAX_DISCORD_UPLOAD_BYTES = 8 * 1024 * 1024;

function isGitInternalRelative(rel: string): boolean {
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  return segs.some((seg) => seg === ".git");
}

function candidatePath(workDir: string, requestedPath: string): string {
  return path.isAbsolute(requestedPath) ? requestedPath : path.join(workDir, requestedPath);
}

function extensionAllowed(ext: string, policy: OutboundFilePolicy): boolean {
  return policy === "agent" ? AGENT_ALLOWED_EXTENSIONS.has(ext) : !DISCORD_BLOCKED_EXECUTABLE_EXTENSIONS.has(ext);
}

function fingerprintFromStat(stat: Awaited<ReturnType<fs.FileHandle["stat"]>>): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

type FileStat = Awaited<ReturnType<fs.FileHandle["stat"]>>;
type FileIdentity = { dev: bigint; ino: bigint };

function relativePathComponents(base: string, candidate: string): string[] | undefined {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  if (
    relative === "" ||
    relative === "." ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative.split(/[\\/]+/).filter(Boolean);
}

/** Reject link/reparse-like path components before opening the leaf. This keeps
 * FIFOs and linked worktree internals from turning validation into a blocking
 * open, while the post-open check below covers a swap after this inspection. */
async function inspectCandidatePath(workDir: string, requested: string): Promise<OutboundRefusal | undefined> {
  const components = relativePathComponents(workDir, requested);
  if (!components) return "unreadable";

  let current = path.resolve(workDir);
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]!);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "not-found" : "unreadable";
    }
    if (stat.isSymbolicLink()) return "not-regular-file";
    if (index < components.length - 1) {
      if (!stat.isDirectory()) return "not-regular-file";
    } else if (!stat.isFile()) {
      return "not-regular-file";
    }
  }
  return undefined;
}

function noFollowOpenFlag(): number | undefined {
  // Windows currently exposes no O_NOFOLLOW. The fallback is safe only because
  // verifyOpenedCandidate() binds the still-open handle to the post-open name;
  // if that proof is unavailable, it rejects rather than trusting the pathname.
  const noFollow = (constants as unknown as Record<string, unknown>)["O_NOFOLLOW"];
  return typeof noFollow === "number" && noFollow !== 0 ? constants.O_RDONLY | noFollow : undefined;
}

async function openReadOnlyNoFollow(candidate: string): Promise<fs.FileHandle> {
  const flags = noFollowOpenFlag();
  return fs.open(candidate, flags ?? constants.O_RDONLY);
}

function hasUsableFileIdentity(stat: FileIdentity): boolean {
  return typeof stat.dev === "bigint" && typeof stat.ino === "bigint" && stat.dev !== 0n && stat.ino !== 0n;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    hasUsableFileIdentity(left) &&
    hasUsableFileIdentity(right) &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

type OpenedCandidateVerification =
  | { ok: true; canonicalPath: string; stat: FileStat }
  | { ok: false; reason: OutboundRefusal };

/** The pre-open realpath check prevents ordinary escapes. This second check
 * authenticates the opened object, so a link/junction replacement between
 * canonicalization and open cannot make us digest or upload outside bytes. */
async function verifyOpenedCandidate(
  handle: fs.FileHandle,
  requested: string,
  realWorkDir: string
): Promise<OpenedCandidateVerification> {
  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(requested);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (path.basename(canonicalPath) === ".git" || isGitInternalRelative(path.relative(realWorkDir, canonicalPath))) {
    return { ok: false, reason: ".git-internal" };
  }
  if (!isStrictlyInside(canonicalPath, realWorkDir)) {
    return { ok: false, reason: "outside-workdir" };
  }

  try {
    const [identity, candidateIdentity, stat] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.stat(canonicalPath, { bigint: true }),
      handle.stat(),
    ]);
    if (!sameFileIdentity(identity, candidateIdentity)) return { ok: false, reason: "unreadable" };
    return { ok: true, canonicalPath, stat };
  } catch {
    // A filesystem that cannot give both identities cannot prove containment.
    return { ok: false, reason: "unreadable" };
  }
}

export async function resolveOutboundFile(
  workDir: string,
  requestedPath: string,
  options: ResolveOutboundFileOptions
): Promise<ResolveOutboundFileResult> {
  const requested = candidatePath(workDir, requestedPath);
  let realWorkDir: string;
  try {
    realWorkDir = await fs.realpath(workDir);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const relFromInput = path.relative(workDir, requested);
  if (isGitInternalRelative(relFromInput) || path.basename(requested) === ".git") {
    return { ok: false, reason: ".git-internal" };
  }

  let realCandidate: string;
  try {
    realCandidate = await fs.realpath(requested);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? "not-found" : "unreadable" };
  }

  if (path.basename(realCandidate) === ".git" || isGitInternalRelative(path.relative(realWorkDir, realCandidate))) {
    return { ok: false, reason: ".git-internal" };
  }
  if (!isStrictlyInside(realCandidate, realWorkDir)) {
    return { ok: false, reason: "outside-workdir" };
  }

  const unsafePathReason = await inspectCandidatePath(workDir, requested);
  if (unsafePathReason) return { ok: false, reason: unsafePathReason };

  const displayName = path.basename(realCandidate);
  if (hasBidiOrControls(displayName) || sanitizeForInlineCode(displayName) !== displayName) {
    return { ok: false, reason: "unsafe-filename" };
  }

  const ext = path.extname(displayName).toLowerCase();
  if (!extensionAllowed(ext, options.policy)) {
    return { ok: false, reason: "disallowed-extension" };
  }

  let handle: fs.FileHandle | undefined;
  try {
    handle = await openReadOnlyNoFollow(realCandidate);
    const verified = await verifyOpenedCandidate(handle, requested, realWorkDir);
    if (!verified.ok) return verified;
    const { canonicalPath, stat } = verified;
    if (!stat.isFile()) return { ok: false, reason: "not-regular-file" };
    if (stat.size === 0) return { ok: false, reason: "empty-file" };
    if (stat.size > options.maxBytes) return { ok: false, reason: "too-large" };

    const bytes = await handle.readFile();
    if (bytes.byteLength !== stat.size) {
      return { ok: false, reason: "unreadable" };
    }
    if (bytes.byteLength > options.maxBytes) {
      return { ok: false, reason: "too-large" };
    }
    return {
      ok: true,
      file: {
        absPath: canonicalPath,
        displayName,
        size: stat.size,
        fingerprint: fingerprintFromStat(stat),
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        bytes,
      },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? "not-found" : "unreadable" };
  } finally {
    await handle?.close();
  }
}
