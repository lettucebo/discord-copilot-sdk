import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.js";

/**
 * discopilot-side approval policy.
 *
 * The local Copilot CLI reports `canOfferSessionApproval: false` for shell
 * commands and does NOT honor an `approve-for-session` decision (verified: a
 * second `git` command re-prompts). So discopilot remembers approved
 * *executables* itself and auto-approves matching requests (as approve-once to
 * the SDK) without showing a card:
 *  - **session** scope: in memory, per sessionKey, dropped when the session ends;
 *  - **repo** scope: persisted to `~/.discopilot/approvals.json`, keyed by the
 *    controlled repo path, surviving restarts.
 *
 * Safety: a request is auto-approved only when EVERY parsed command executable
 * in it is approved AND (checked by the caller) the command is "simple" (no
 * shell chaining/piping/substitution) and each executable is a safe, specific
 * name (not a shell/runtime/wrapper). NOTE: approving an executable still trusts
 * whatever that executable can launch via its own options (e.g. `git` config
 * pagers) — the approval UI discloses this. Executables are matched
 * case-insensitively.
 */
export class ApprovalPolicy {
  private readonly session = new Map<string, Set<string>>();
  private repo: Record<string, string[]> = {};
  private readonly file: string;

  constructor(file: string = path.join(stateDir(), "approvals.json")) {
    this.file = file;
    this.load();
  }

  /** True only if the request has executables AND every one is approved for the
   *  session or the repo. Empty/none ⇒ false (never auto-approve the unknown). */
  isApproved(sessionKey: string, repoPath: string, executables: string[]): boolean {
    if (executables.length === 0) return false;
    const s = this.session.get(sessionKey);
    const r = this.repo[repoPath] ?? [];
    return executables.every((e) => {
      const n = norm(e);
      return n.length > 0 && (s?.has(n) === true || r.includes(n));
    });
  }

  /** Remember an executable for the rest of this session (in memory). */
  approveForSession(sessionKey: string, executable: string): void {
    const n = norm(executable);
    if (!n) return;
    let set = this.session.get(sessionKey);
    if (!set) {
      set = new Set();
      this.session.set(sessionKey, set);
    }
    set.add(n);
  }

  /** Remember an executable for this repo, persisted across restarts. */
  approveForRepo(repoPath: string, executable: string): void {
    const n = norm(executable);
    if (!n) return;
    const list = this.repo[repoPath] ?? (this.repo[repoPath] = []);
    if (!list.includes(n)) {
      list.push(n);
      this.persist();
    }
  }

  /** Drop a session's in-memory approvals (on session teardown). */
  clearSession(sessionKey: string): void {
    this.session.delete(sessionKey);
  }

  /** Executables approved in-memory for a session (for /approvals display). */
  sessionApprovals(sessionKey: string): string[] {
    return [...(this.session.get(sessionKey) ?? [])];
  }

  /** Executables persisted for a repo (for display/debug). */
  repoApprovals(repoPath: string): string[] {
    return [...(this.repo[repoPath] ?? [])];
  }

  /** Forget a repo's persisted approvals (e.g. /approvals clear). Returns true
   *  if the revocation was durably written to disk. False means it was cleared
   *  in memory (so THIS process is now fail-closed and will re-prompt) but the
   *  on-disk file may still hold the old rules and could resurface on restart —
   *  the caller must report that honestly rather than claim it's fully cleared. */
  clearRepo(repoPath: string): boolean {
    if (!this.repo[repoPath]) return true; // nothing to clear ⇒ trivially durable
    delete this.repo[repoPath];
    return this.persist();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string").map(norm);
        }
        this.repo = out;
      }
    } catch {
      /* no/invalid file yet — start empty */
    }
  }

  private persist(): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.repo, null, 2), "utf8");
      return true;
    } catch (err) {
      // Surface the failure (not silent). A failed WRITE of a granted approval is
      // fail-safe (it just won't survive restart); a failed write of a REVOCATION
      // is reported to the user via clearRepo's boolean so they aren't misled.
      console.warn(
        `⚠️  could not persist approvals to ${this.file}: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** The executable of a parsed command identifier / command text: its first
 *  whitespace-delimited token (e.g. "git --no-pager status" → "git"). */
export function commandExecutable(identifierOrCommand: string): string {
  return String(identifierOrCommand ?? "").trim().split(/\s+/)[0] ?? "";
}
