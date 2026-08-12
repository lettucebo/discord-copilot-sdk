import path from "node:path";
import { promises as fs } from "node:fs";
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
    handle = await fs.open(realCandidate, "r");
    const stat = await handle.stat();
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
        absPath: realCandidate,
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
