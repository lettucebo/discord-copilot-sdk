import path from "node:path";
import { createHash } from "node:crypto";
import { hasBidiOrControls, sanitizeForInlineCode } from "./text-safety.js";
import { SecureOpenError, secureOpen } from "./secure-open.js";

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
  return segs.some((seg) => (process.platform === "win32" ? seg.toLowerCase() : seg) === ".git");
}

function isGitName(name: string): boolean {
  return (process.platform === "win32" ? name.toLowerCase() : name) === ".git";
}

function candidatePath(workDir: string, requestedPath: string): string {
  return path.isAbsolute(requestedPath) ? requestedPath : path.join(workDir, requestedPath);
}

function extensionAllowed(ext: string, policy: OutboundFilePolicy): boolean {
  return policy === "agent" ? AGENT_ALLOWED_EXTENSIONS.has(ext) : !DISCORD_BLOCKED_EXECUTABLE_EXTENSIONS.has(ext);
}

function isLexicallyOutside(workDir: string, candidate: string): boolean {
  const root = path.resolve(workDir);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(
    process.platform === "win32" ? root.toLowerCase() : root,
    process.platform === "win32" ? resolvedCandidate.toLowerCase() : resolvedCandidate
  );
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function mapSecureOpenRefusal(error: unknown): OutboundRefusal {
  if (!(error instanceof SecureOpenError)) return "unreadable";
  switch (error.reason) {
    case "not-found":
    case "not-regular-file":
    case "empty-file":
    case "too-large":
      return error.reason;
    case "outside-root":
      return "outside-workdir";
    case "unsupported-platform":
    case "unreadable":
      return "unreadable";
  }
}

/**
 * Resolve an agent-requested artifact without using a post-open pathname as
 * containment proof. The secure-open boundary derives the final path and bytes
 * from one OS handle; re-stat'ing a restored name would reintroduce the swap
 * race that can otherwise deliver an external file.
 */
export async function resolveOutboundFile(
  workDir: string,
  requestedPath: string,
  options: ResolveOutboundFileOptions
): Promise<ResolveOutboundFileResult> {
  const requested = candidatePath(workDir, requestedPath);
  const lexicalRelative = path.relative(path.resolve(workDir), path.resolve(requested));
  if (isGitInternalRelative(lexicalRelative) || isGitName(path.basename(requested))) {
    return { ok: false, reason: ".git-internal" };
  }
  if (isLexicallyOutside(workDir, requested)) {
    return { ok: false, reason: "outside-workdir" };
  }

  let opened: Awaited<ReturnType<typeof secureOpen>>;
  try {
    opened = await secureOpen(requested, workDir, { maxBytes: options.maxBytes });
  } catch (error) {
    return { ok: false, reason: mapSecureOpenRefusal(error) };
  }

  if (isGitInternalRelative(opened.relativePath) || isGitName(path.basename(opened.finalPath))) {
    return { ok: false, reason: ".git-internal" };
  }

  const displayName = path.basename(opened.finalPath);
  if (hasBidiOrControls(displayName) || sanitizeForInlineCode(displayName) !== displayName) {
    return { ok: false, reason: "unsafe-filename" };
  }

  const ext = path.extname(displayName).toLowerCase();
  if (!extensionAllowed(ext, options.policy)) {
    return { ok: false, reason: "disallowed-extension" };
  }

  return {
    ok: true,
    file: {
      absPath: opened.finalPath,
      displayName,
      size: opened.size,
      fingerprint: `${opened.identity}:${opened.size}:${opened.modifiedAt}`,
      digest: `sha256:${createHash("sha256").update(opened.bytes).digest("hex")}`,
      bytes: opened.bytes,
    },
  };
}
