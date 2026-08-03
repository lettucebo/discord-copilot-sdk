import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isStrictlyInside, repoNameProblem } from "./repo.js";
import { sanitizeForInlineCode } from "./text-safety.js";

/**
 * `/repo clone` and `/repo new`.
 *
 * The threat model is not "a careless operator" but "a URL typed into Discord".
 * Everything here is therefore fail-closed and the git invocations are hardened
 * against the ways a remote can turn a clone into code execution:
 *
 *  - `ext::` is a REAL remote-code-execution vector. Git's `protocol.ext.allow`
 *    defaults to `user`, which means a directly-typed `git clone 'ext::sh -c id'`
 *    RUNS that command. It is refused by the URL parser AND disabled by config.
 *  - `url.<base>.insteadOf` in the operator's own git config can silently rewrite
 *    an allowed URL into a different one, and an SSH `ProxyCommand` / `Match exec`
 *    can execute a program. Both are neutralised by pointing git and ssh at empty
 *    configuration rather than trusting the ambient environment.
 *  - hostnames are checked against a policy, and internal/loopback targets are
 *    refused even when the policy is permissive.
 *
 * Ported from seam-acp's `repo-provisioner.ts`, with its two documented gaps
 * closed: POSIX timeouts kill the whole process group (it killed only the
 * top-level pid), and a destination lease bounds concurrent clones. That lease
 * is INSTANCE state, so it only works while there is one instance — see
 * `DiscordCopilotApp.provisioner()`, which is why the app holds a single
 * long-lived one instead of constructing it per command.
 */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Windows device names, which cannot be used as directory names at all. */
const RESERVED_WIN = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

export type CloneHostPolicy = "github" | "allowlist";

export interface ClonePolicy {
  hostPolicy: CloneHostPolicy;
  allowedHosts: readonly string[];
}

export interface ParsedSource {
  /** How to fetch: `gh` for github.com (uses the operator's existing login),
   *  `git` for everything else. */
  kind: "gh" | "git";
  /** The exact argument handed to the tool. Never shell-interpolated. */
  canonical: string;
  host: string;
  /** Directory name derived from the source, before `validateRepoName`. */
  suggestedName: string;
}

/**
 * Is this host one that must never be fetched from?
 *
 * Ported verbatim in spirit from seam-acp, including the cases that look
 * paranoid until you meet them: an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`)
 * and a trailing dot (`localhost.`) both resolve to the loopback while looking
 * like ordinary hostnames to a naive check, and `169.254.169.254` is the cloud
 * metadata endpoint.
 *
 * NOTE the limit, which is why there is no "any public host" policy: this reads
 * the hostname TEXT. It cannot stop a name that RESOLVES to a private address.
 */
export function isInternalHost(host: string): boolean {
  let h = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!h) return true;
  h = h.replace(/\.+$/, ""); // "localhost." === "localhost"
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    return true;
  }
  const mapped = h.match(/^::ffff:(.+)$/i);
  if (mapped?.[1]) return isInternalHost(mapped[1]);
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 127) return true; // this-host / loopback
    if (a === 10) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    return false;
  }
  if (h === "::1" || h === "::") return true; // IPv6 loopback
  if (h.includes(":") && (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd"))) {
    return true; // IPv6 link-local / unique-local
  }
  return false;
}

function assertHostAllowed(host: string, policy: ClonePolicy): void {
  const h = host.toLowerCase();
  if (isInternalHost(host)) {
    throw new Error(`Host \`${host}\` looks internal or loopback; refusing to clone from it.`);
  }
  if (policy.hostPolicy === "github") {
    if (h !== "github.com") {
      throw new Error(
        `Host \`${host}\` is not allowed (REPO_CLONE_HOST_POLICY=github). Only github.com is permitted. ` +
          `Set REPO_CLONE_HOST_POLICY=allowlist and list the host in REPO_CLONE_ALLOWED_HOSTS to change that.`
      );
    }
    return;
  }
  if (!policy.allowedHosts.some((a) => a.toLowerCase() === h)) {
    throw new Error(`Host \`${host}\` is not in REPO_CLONE_ALLOWED_HOSTS.`);
  }
}

function nameFromPath(p: string): string {
  const segs = p.split("/").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  return last.replace(/\.git$/i, "");
}

/**
 * Parse and authorise a clone source. Accepts `owner/repo`, an `https://` URL,
 * an `ssh://` URL, and the scp-style `git@host:owner/repo`. Everything else is
 * refused — deliberately including `http://` (cleartext) and `file://`.
 */
export function parseCloneSource(raw: string, policy: ClonePolicy): ParsedSource {
  const source = (raw ?? "").trim();
  if (!source) throw new Error("A clone source is required.");
  if (CONTROL_CHARS.test(source)) throw new Error("The source contains control characters.");
  // A leading dash would be read by git as an OPTION, not a URL — e.g.
  // `--upload-pack=<command>`. argv arrays stop shell injection, not this.
  if (source.startsWith("-")) throw new Error("The source cannot start with `-`.");

  // `owner/repo` shorthand.
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source)) {
    assertHostAllowed("github.com", policy);
    return {
      kind: "gh",
      canonical: source,
      host: "github.com",
      suggestedName: nameFromPath(source),
    };
  }

  // scp-style `git@host:owner/repo` (no scheme, exactly one colon before a path).
  const scp = source.match(/^([A-Za-z0-9._-]+)@([A-Za-z0-9._:-]+):(.+)$/);
  if (scp && !source.includes("://")) {
    const host = scp[2] ?? "";
    const p = scp[3] ?? "";
    assertHostAllowed(host, policy);
    return { kind: "git", canonical: source, host, suggestedName: nameFromPath(p) };
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error("The source is not a recognised repo, URL or `git@host:owner/repo` address.");
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "https" && scheme !== "ssh") {
    throw new Error(
      `Unsupported URL scheme \`${scheme}:\` — only https and ssh are allowed. ` +
        `(\`ext:\` in particular executes a command, and \`file:\` reads local disk.)`
    );
  }
  if (url.password) throw new Error("The source must not embed credentials (`user:password@…`).");
  if (scheme === "https" && url.username) throw new Error("The source must not embed a username.");
  assertHostAllowed(url.hostname, policy);
  const useGh = scheme === "https" && url.hostname.toLowerCase() === "github.com";
  return {
    kind: useGh ? "gh" : "git",
    canonical: url.toString(),
    host: url.hostname,
    suggestedName: nameFromPath(url.pathname),
  };
}

/**
 * Validate a directory name for a NEW repo. Cross-platform on purpose: a name
 * that is legal on Linux but not on Windows would make the same `.env` work on
 * one machine and fail on another.
 */
export function validateRepoName(name: string): string {
  const n = (name ?? "").trim();
  const problem = repoNameProblem(n);
  if (problem) throw new Error(`Invalid repo name \`${name}\`: ${problem}.`);
  if (n.length > 100) throw new Error("The repo name is too long (max 100 characters).");
  if (/[<>:"|?*]/.test(n)) throw new Error('The repo name contains an illegal character (< > : " | ? *).');
  if (n.startsWith("-")) throw new Error("The repo name cannot start with `-`.");
  if (n.startsWith(".")) throw new Error("The repo name cannot start with `.`.");
  if (/[.]$/.test(n)) {
    // Windows silently STRIPS a trailing dot, so `a.` and `a` would name the
    // same directory while looking different in the picker. A trailing SPACE is
    // not checked here because the name is trimmed above — refusing a
    // copy-pasted value for a stray space would be unhelpful, not safer.
    throw new Error("The repo name cannot end with `.`.");
  }
  if (RESERVED_WIN.has((n.split(".")[0] ?? "").toUpperCase())) {
    throw new Error(`\`${n}\` is a reserved Windows device name.`);
  }
  return n;
}

/** `-c` flags applied to every git invocation we make. */
const GIT_HARDENING = [
  "-c", "protocol.ext.allow=never",
  "-c", "protocol.file.allow=never",
  "-c", "protocol.ftp.allow=never",
  "-c", "credential.helper=",
  "-c", "core.symlinks=false",
];

/** An environment in which git can neither prompt, nor read the operator's
 *  config, nor be steered by ssh config. `gh` does NOT forward `-c` flags to the
 *  git it spawns, which is why the same restrictions are ALSO passed as
 *  `GIT_CONFIG_*` — those git does inherit. */
function hardenedEnv(): NodeJS.ProcessEnv {
  const nul = process.platform === "win32" ? "NUL" : "/dev/null";
  const keys = [
    ["protocol.ext.allow", "never"],
    ["protocol.file.allow", "never"],
    ["protocol.ftp.allow", "never"],
    ["core.symlinks", "false"],
    ["credential.helper", ""],
  ] as const;
  const cfg: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(keys.length) };
  keys.forEach(([k, v], i) => {
    cfg[`GIT_CONFIG_KEY_${i}`] = k;
    cfg[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return {
    ...process.env,
    ...cfg,
    // Never block on a credential prompt — a hung clone is indistinguishable
    // from a slow one, and this runs unattended.
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_PROTOCOL_FROM_USER: "0",
    // Ignore the operator's git config entirely: `url.<base>.insteadOf` there
    // can rewrite an allowed URL into one the policy would have refused.
    GIT_CONFIG_GLOBAL: nul,
    GIT_CONFIG_SYSTEM: nul,
    // `-F none` ignores ~/.ssh/config, where ProxyCommand / Match exec run
    // arbitrary programs. BatchMode stops interactive prompts.
    GIT_SSH_COMMAND: "ssh -F none -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
  };
}

/** Kill a process AND its children. Windows gets `taskkill /t`; POSIX gets a
 *  process-GROUP signal, which is why the child is spawned detached. seam-acp
 *  signalled only the top-level pid, so a `gh`-spawned git survived a timeout. */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    /* already gone */
  }
}

/**
 * Remote output is attacker-controlled: a git server chooses the `remote:` and
 * `fatal: remote error:` text that git relays verbatim. It must not be able to
 * forge a line that looks like the bot's own output.
 *
 * Delegates to `sanitizeForInlineCode`, which is the transform this project
 * already established for exactly this problem — it strips the FULL unsafe class
 * (bidi overrides AND isolates, line/paragraph separators, C0 controls), REPLACES
 * backticks rather than escaping them (a single backtick closes an inline span,
 * after which the rest renders as markdown), and flattens newlines so one message
 * cannot fake several lines. A local copy of "strip some control characters" was
 * weaker than the shared one on every count.
 */
export function sanitizeToolOutput(s: string, max = 500): string {
  return sanitizeForInlineCode(s, max);
}

export interface ProvisionOpts {
  reposRoot: string;
  timeoutMs: number;
  /** Injectable for tests. */
  spawnImpl?: typeof spawn;
}

export interface ProvisionResult {
  name: string;
  path: string;
}

export class RepoProvisioner {
  /** Destination names being provisioned right now. Taken BEFORE staging starts,
   *  so two concurrent clones of the same name cannot both stage and then race on
   *  the final rename. Case-folded on Windows, where the filesystem is. */
  private readonly leased = new Set<string>();

  constructor(private readonly opts: ProvisionOpts) {}

  private leaseKey(name: string): string {
    return process.platform === "win32" ? name.toLowerCase() : name;
  }

  private takeLease(name: string): void {
    const key = this.leaseKey(name);
    if (this.leased.has(key)) {
      throw new Error(`\`${name}\` is already being created right now. Wait for that to finish.`);
    }
    if (this.leased.size > 0) {
      throw new Error("Another clone is already running. One at a time, please.");
    }
    this.leased.add(key);
  }

  private releaseLease(name: string): void {
    this.leased.delete(this.leaseKey(name));
  }

  /** Clone `source` into REPOS_ROOT. */
  async clone(source: string, requestedName: string | undefined, policy: ClonePolicy): Promise<ProvisionResult> {
    const parsed = parseCloneSource(source, policy);
    const name = validateRepoName(requestedName || parsed.suggestedName);
    return this.provision(name, async (staging) => {
      if (parsed.kind === "gh") {
        await this.run("gh", ["repo", "clone", parsed.canonical, staging]);
      } else {
        // `--` terminates option parsing: belt and braces alongside the
        // leading-dash rejection in the parser.
        await this.run("git", [...GIT_HARDENING, "clone", "--", parsed.canonical, staging]);
      }
    });
  }

  /** Create a new, empty repo in REPOS_ROOT. */
  async init(requestedName: string): Promise<ProvisionResult> {
    const name = validateRepoName(requestedName);
    return this.provision(name, async (staging) => {
      await this.run("git", [...GIT_HARDENING, "init", "-b", "main", staging]);
      // An empty initial commit gives HEAD a real ref to point at. Without it
      // HEAD is unborn, and git reads that the agent makes (status, log, diff)
      // fail in ways that look like a broken repo rather than an empty one.
      await this.run("git", [...GIT_HARDENING, "-C", staging, "commit", "--allow-empty", "-m", "Initial commit"], {
        GIT_AUTHOR_NAME: "discord-copilot-sdk",
        GIT_AUTHOR_EMAIL: "discord-copilot-sdk@localhost",
        GIT_COMMITTER_NAME: "discord-copilot-sdk",
        GIT_COMMITTER_EMAIL: "discord-copilot-sdk@localhost",
      });
    });
  }

  /**
   * Stage → build → atomically rename into place.
   *
   * The staging directory is dot-prefixed so `listRepos` skips it — a half-built
   * clone must never be bindable. On ANY failure it is removed whole, so a
   * partial clone never survives.
   *
   * The ownership marker is a SIBLING FILE, not a file inside the staging
   * directory, and the directory is left for git to create. `git clone` refuses
   * any destination that already exists and is non-empty, and a dot-file counts:
   * pre-creating the directory and dropping a marker in it made every clone fail
   * with `destination path already exists and is not an empty directory`.
   * `git init` has no such rule, which is why `/repo new` kept working and hid it.
   */
  private async provision(name: string, build: (staging: string) => Promise<void>): Promise<ProvisionResult> {
    const finalPath = path.join(this.opts.reposRoot, name);
    if (!isStrictlyInside(finalPath, this.opts.reposRoot)) {
      throw new Error(`\`${name}\` would land outside REPOS_ROOT.`);
    }
    if (fs.existsSync(finalPath)) {
      throw new Error(`\`${name}\` already exists under REPOS_ROOT. Use \`/repo set ${name}\` to bind it.`);
    }
    this.takeLease(name);
    const staging = path.join(this.opts.reposRoot, `.staging-${randomBytes(4).toString("hex")}`);
    const marker = `${staging}${STAGING_MARKER_SUFFIX}`;
    try {
      await this.ensureDiskSpace();
      // Marker first: it exists to identify OUR scratch after a crash, so it has
      // to be on disk before anything is created that could be left behind.
      await fsp.writeFile(marker, `${process.pid}\n`, "utf8");
      await build(staging);
      // Re-check immediately before the rename: the existence test above is old
      // by now, and rename would silently replace a directory that appeared.
      if (fs.existsSync(finalPath)) {
        throw new Error(`\`${name}\` appeared while it was being created. Nothing was overwritten.`);
      }
      await fsp.rename(staging, finalPath);
      await fsp.rm(marker, { force: true });
      return { name, path: finalPath };
    } catch (err) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(marker, { force: true }).catch(() => {});
      throw err;
    } finally {
      this.releaseLease(name);
    }
  }

  /** Refuse to start a clone that obviously cannot finish. Best-effort: `statfs`
   *  is not available everywhere, and "unknown" must not block the operation. */
  private async ensureDiskSpace(): Promise<void> {
    const statfs = (fsp as unknown as { statfs?: (p: string) => Promise<{ bavail: bigint | number; bsize: bigint | number }> })
      .statfs;
    if (!statfs) return;
    try {
      const st = await statfs(this.opts.reposRoot);
      const free = Number(st.bavail) * Number(st.bsize);
      if (free > 0 && free < 500 * 1024 * 1024) {
        throw new Error("Less than 500 MB free under REPOS_ROOT; refusing to start a clone.");
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("500 MB")) throw err;
      /* statfs unsupported — proceed */
    }
  }

  /** Run a tool with an argv ARRAY (never a shell), a hard timeout, and a
   *  process-tree kill if it overruns. */
  private run(file: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
    const spawnFn = this.opts.spawnImpl ?? spawn;
    return new Promise<void>((resolve, reject) => {
      const child = spawnFn(file, args, {
        env: { ...hardenedEnv(), ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // POSIX: give the child its own process group so the timeout can signal
        // the whole tree, not just the process we happen to hold a pid for.
        detached: process.platform !== "win32",
      });
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => {
        if (stderr.length < 4096) stderr += d.toString();
      });
      const timer = setTimeout(() => {
        if (typeof child.pid === "number") killTree(child.pid);
        reject(new Error(`\`${file}\` timed out after ${Math.round(this.opts.timeoutMs / 1000)}s.`));
      }, this.opts.timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? new Error(`\`${file}\` is not installed or not on PATH.`)
            : err
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`\`${file}\` failed (exit ${code}): ${sanitizeToolOutput(stderr.trim())}`));
      });
    });
  }
}

/** Suffix of the sibling file marking a staging directory as ours. */
const STAGING_MARKER_SUFFIX = ".dcs-staging";

/** Is a process with this pid still running? Used to avoid sweeping the scratch
 *  of a LIVE sibling instance sharing the same repos root. Signal 0 performs the
 *  permission/existence check without delivering anything; EPERM means it exists
 *  but belongs to another user, which still counts as alive. */
function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove `.staging-*` directories left by a crashed run. Only those with OUR
 *  sibling marker are touched: a dot-directory in the operator's repos root that
 *  we did not create is none of our business. A marker naming a LIVE process is
 *  skipped — a second instance sharing this repos root may be mid-clone, and
 *  deleting its scratch would fail its clone for no reason. Orphaned markers
 *  (directory already gone) are cleaned up too. */
export async function sweepStaleStaging(reposRoot: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(reposRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const ownerAlive = (markerPath: string): boolean => {
    try {
      return pidIsAlive(Number.parseInt(fs.readFileSync(markerPath, "utf8").trim(), 10));
    } catch {
      return false;
    }
  };
  for (const e of entries) {
    if (!e.name.startsWith(".staging-")) continue;
    const full = path.join(reposRoot, e.name);
    if (e.isDirectory()) {
      const marker = `${full}${STAGING_MARKER_SUFFIX}`;
      if (!fs.existsSync(marker)) continue; // not ours
      if (ownerAlive(marker)) continue; // a live sibling is using it
      await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(marker, { force: true }).catch(() => {});
      continue;
    }
    if (e.name.endsWith(STAGING_MARKER_SUFFIX)) {
      if (ownerAlive(full)) continue;
      await fsp.rm(full, { force: true }).catch(() => {});
    }
  }
}

