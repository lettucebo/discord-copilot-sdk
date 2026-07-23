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
 * in it is approved (so an approved `git` can't smuggle `rm` via
 * `git status && rm -rf`). Executables are matched case-insensitively.
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

  /** Executables persisted for a repo (for display/debug). */
  repoApprovals(repoPath: string): string[] {
    return [...(this.repo[repoPath] ?? [])];
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

  private persist(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.repo, null, 2), "utf8");
    } catch {
      /* best effort */
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
