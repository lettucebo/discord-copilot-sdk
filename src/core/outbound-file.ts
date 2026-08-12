import path from "node:path";
import { createHash } from "node:crypto";
import { hasBidiOrControls, sanitizeForInlineCode } from "./text-safety.js";
import { SecureOpenError, secureOpen, type TrustedRoot } from "./secure-open.js";

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

function candidatePath(trustedRoot: TrustedRoot, requestedPath: string): string {
  return path.isAbsolute(requestedPath) ? requestedPath : path.join(trustedRoot.originalPath, requestedPath);
}

function extensionAllowed(ext: string, policy: OutboundFilePolicy): boolean {
  return policy === "agent" ? AGENT_ALLOWED_EXTENSIONS.has(ext) : !DISCORD_BLOCKED_EXECUTABLE_EXTENSIONS.has(ext);
}

function isLexicallyOutside(trustedRoot: TrustedRoot, candidate: string): boolean {
  const root = path.resolve(trustedRoot.originalPath);
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
 * Resolve an artifact only from the actor's capture-time root identity. The
 * secure-open boundary proves the reopened root still matches that anchor
 * before candidate lookup, then derives final path and bytes from one handle.
 */
export async function resolveOutboundFile(
  trustedRoot: TrustedRoot,
  requestedPath: string,
  options: ResolveOutboundFileOptions
): Promise<ResolveOutboundFileResult> {
  const requested = candidatePath(trustedRoot, requestedPath);
  const lexicalRelative = path.relative(path.resolve(trustedRoot.originalPath), path.resolve(requested));
  if (isGitInternalRelative(lexicalRelative) || isGitName(path.basename(requested))) {
    return { ok: false, reason: ".git-internal" };
  }
  if (isLexicallyOutside(trustedRoot, requested)) {
    return { ok: false, reason: "outside-workdir" };
  }

  let opened: Awaited<ReturnType<typeof secureOpen>>;
  try {
    opened = await secureOpen(requested, trustedRoot, { maxBytes: options.maxBytes });
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
