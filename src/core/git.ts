import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

/** Discord message content hard limit; we keep the summary safely under it. */
const MAX_LEN = 1900;

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await pExecFile("git", ["-C", repoPath, "--no-pager", ...args], {
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

/** Produce a compact git-diff summary for the controlled repo, safe to post as
 *  a single Discord message. Uses `git` with a fixed argument vector (no shell)
 *  so there is no injection surface. `staged` switches to `--cached`. Untracked
 *  files (which don't appear in `diff`) are surfaced via `status --porcelain`. */
export async function gitDiffSummary(repoPath: string, staged: boolean): Promise<string> {
  const scope = staged ? "--cached" : undefined;
  const statArgs = ["diff", "--stat"];
  if (scope) statArgs.push(scope);
  const stat = (await git(repoPath, statArgs)).trimEnd();

  // Untracked files never show in `git diff`; count them for an honest summary.
  const porcelain = (await git(repoPath, ["status", "--porcelain", "--untracked-files=all"])).split("\n");
  const untracked = porcelain.filter((l) => l.startsWith("?? ")).length;

  const label = staged ? "已暫存 (staged)" : "工作區 (unstaged)";
  if (!stat) {
    const note =
      untracked > 0 && !staged ? `\n（另有 ${untracked} 個未追蹤檔案）` : "";
    return `📊 **git diff — ${label}**\n沒有變更。${note}`;
  }

  let body = stat;
  const fenceOverhead = 8; // ```\n ... \n```
  if (body.length > MAX_LEN - fenceOverhead) {
    body = body.slice(0, MAX_LEN - fenceOverhead - 20) + "\n… (已截斷)";
  }
  const note = untracked > 0 && !staged ? `\n（另有 ${untracked} 個未追蹤檔案）` : "";
  return `📊 **git diff — ${label}**\n\`\`\`\n${body}\n\`\`\`${note}`;
}
