#!/usr/bin/env node
// discord-copilot-sdk uninstaller.
//
// Removes everything this tool created, shows exactly what it will do before it
// does it, and refuses to touch anything that might hold work you cannot get
// back. Node built-ins only, so it runs on a machine where `npm install` was
// never finished.
//
//   node scripts/uninstall.mjs [--yes] [--dry-run] [--keep-config]
//                              [--keep-state] [--branches] [--lang zh|en]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  planUninstall,
  classifyWorktree,
  irreversible,
  isOurBotCommandLine,
  isOurTaskDefinition,
  isSignalablePid,
  NEVER_TOUCHED,
} from "./lib/uninstall-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const FLAGS = {
  yes: has("--yes") || has("-y"),
  dryRun: has("--dry-run"),
  keepConfig: has("--keep-config"),
  keepState: has("--keep-state"),
  branches: has("--branches"),
  lang: valOf("--lang"),
};

const ZH = FLAGS.lang ? FLAGS.lang === "zh" : /^zh/i.test(process.env.DISCORD_COPILOT_SDK_LOCALE ?? process.env.LANG ?? "");
const say = (zh, en) => console.log(ZH ? zh : en);
const c = (n, s) => (process.stdout.isTTY ? `\u001b[${n}m${s}\u001b[0m` : s);
const warn = (s) => console.log(c(33, "! ") + s);
const ok = (s) => console.log(c(32, "\u2713 ") + s);

function ask(q) {
  if (!process.stdin.isTTY) return Promise.resolve("");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => (rl.close(), res(a.trim()))));
}

// The uninstall is inherently GLOBAL, not per-instance: the state directory is
// shared by every instance and gets deleted wholesale, so there is no coherent
// "uninstall just this one". Everything below therefore scans for all instances
// rather than reading DISCORD_COPILOT_SDK_INSTANCE_ID.
const STATE_DIR = path.join(os.homedir(), ".discord-copilot-sdk");
const WORKTREE_ROOT = `${STATE_DIR}-worktrees`;
const LEGACY_DIR = path.join(os.homedir(), ".discopilot");
const ENV_PATH = path.join(REPO_ROOT, ".env");

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const tryRun = (cmd, args, opts = {}) => {
  try {
    return run(cmd, args, opts);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- inventory --

function readEnv() {
  try {
    const out = {};
    for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2].trim();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Find residency for EVERY instance, not just this one.
 *
 * The state directory is shared across instances and gets deleted wholesale, so
 * an uninstall is inherently global. Removing one instance's task while leaving
 * another's would leave a scheduled job pointing at a state dir that no longer
 * exists — it would start, fail, and retry 999 times.
 */
function findResidency() {
  if (process.platform === "win32") {
    // /FO LIST is parsed rather than Get-ScheduledTask so this works without
    // PowerShell, and `schtasks /Query` has no wildcard, so list and filter.
    const out = tryRun("schtasks", ["/Query", "/FO", "CSV", "/NH"], { stdio: ["ignore", "pipe", "ignore"] });
    if (!out) return [];
    const names = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = /^"\\?([^"]*discord-copilot-sdk-[^"]*)"/.exec(line.trim());
      if (m) names.add(m[1].replace(/^\\/, ""));
    }
    return [...names].map((id) => ({ kind: "task", id }));
  }
  if (process.platform === "darwin") {
    const dir = path.join(os.homedir(), "Library", "LaunchAgents");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("com.discord-copilot-sdk.") && f.endsWith(".plist"))
      .map((f) => ({ kind: "launchd", id: path.join(dir, f) }));
  }
  const dir = path.join(os.homedir(), ".config", "systemd", "user");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("discord-copilot-sdk-") && f.endsWith(".service"))
    .map((f) => ({ kind: "systemd", id: path.join(dir, f), unit: f }));
}

/** Wrapper scripts residency generated, for any instance. */
function findWrappers() {
  const dir = path.join(REPO_ROOT, "scripts");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^run-bot\..+\.ps1$/.test(f))
    .map((f) => path.join(dir, f));
}

/** This process's command line, or null when it cannot be read. */
function commandLineOf(pid) {
  if (process.platform === "win32") {
    // wmic first (fast, still present on most Windows builds), PowerShell as the
    // fallback for machines where it has been removed.
    const w = tryRun("wmic", ["process", "where", `processid=${pid}`, "get", "commandline", "/format:list"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (w && /CommandLine=/.test(w)) return w.split("CommandLine=")[1] ?? "";
    const ps = tryRun(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    return ps === null ? null : ps.trim();
  }
  const out = tryRun("ps", ["-p", String(pid), "-o", "args="]);
  return out === null ? null : out.trim();
}

/**
 * Every instance's running bot, not just this one — see findResidency.
 *
 * A PID alone is not identity: the lock is released only on a CLEAN shutdown, so
 * a hard kill or a reboot leaves a stale PID, and PIDs get reused. Anything whose
 * command line is not our bot is reported rather than signalled.
 */
function findProcess() {
  if (!fs.existsSync(STATE_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(STATE_DIR)) {
    if (!f.endsWith(".lock")) continue;
    const raw = fs.readFileSync(path.join(STATE_DIR, f), "utf8").trim();
    if (!/^\d+$/.test(raw)) continue;
    const pid = Number(raw);
    if (!isSignalablePid(pid)) continue; // 0 = whole process group, 1 = init
    try {
      process.kill(pid, 0); // signal 0 = existence check only
    } catch {
      continue; // stale lock, dead PID
    }
    const cmd = commandLineOf(pid);
    out.push({ pid, instance: f.replace(/\.lock$/, ""), ours: isOurBotCommandLine(cmd), cmd });
  }
  return out;
}

/**
 * Worktrees this tool made, with git's verdict on each.
 *
 * Two things changed with multi-repo, and both are load-bearing here:
 *
 *  - the layout is now `<root>/<repoSlug>/<threadId>`, while records written
 *    before the change legitimately still use the flat `<root>/<threadId>`, so
 *    BOTH have to be walked;
 *  - the owning repo is no longer "the one configured repo". It is asked of git
 *    directly (`--git-common-dir` resolves a linked worktree to its MAIN repo),
 *    because `git worktree remove` run with the wrong repo as cwd simply fails,
 *    and a worktree that cannot name its owner is one we must not remove.
 */
function findWorktrees() {
  if (!fs.existsSync(WORKTREE_ROOT)) return [];
  const out = [];
  const inspect = (dir, name) => {
    const owner = ownerRepoOf(dir);
    const status = tryRun("git", ["status", "--porcelain", "--ignored=matching"], { cwd: dir });
    const head = tryRun("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: dir });
    const branch = `copilot/t-${name}`;
    const verdict = owner === null ? "unknown-owner" : classifyWorktree(status, head === null ? null : head.trim(), branch);
    out.push({ dir, branch, repoPath: owner, verdict });
  };
  for (const top of fs.readdirSync(WORKTREE_ROOT, { withFileTypes: true })) {
    if (!top.isDirectory()) continue;
    const dir = path.join(WORKTREE_ROOT, top.name);
    if (fs.existsSync(path.join(dir, ".git"))) {
      inspect(dir, top.name); // legacy flat layout: this IS a worktree
      continue;
    }
    let inner = [];
    try {
      inner = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of inner) {
      if (!child.isDirectory()) continue;
      inspect(path.join(dir, child.name), child.name);
    }
  }
  return out;
}

/** The repo a worktree belongs to, or null when git cannot say. Never guesses:
 *  a wrong answer here means `git worktree remove` targets the wrong repo. */
function ownerRepoOf(dir) {
  const common = tryRun("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir });
  if (common === null || !common.trim()) return null;
  return path.resolve(path.dirname(common.trim()));
}

/** `copilot/t-*` branches across EVERY repo under the repos root. Scanning only
 *  one repo (all there was before multi-repo) silently leaves branches behind in
 *  every other project the bot has worked in. */
function findBranches(reposRoot) {
  if (!reposRoot || !fs.existsSync(reposRoot)) return [];
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(reposRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const repo = path.join(reposRoot, e.name);
    if (!fs.existsSync(path.join(repo, ".git"))) continue;
    const listed = tryRun("git", ["-C", repo, "branch", "--list", "copilot/t-*", "--format=%(refname:short)"]);
    if (!listed) continue;
    for (const b of listed.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      out.push({ repo, branch: b });
    }
  }
  return out;
}

// ------------------------------------------------------------------- steps --

async function stepResidency(found, wrappers) {
  if (!found.length && !wrappers.length) {
    say("  （沒有安裝常駐）", "  (no residency installed)");
    return true;
  }
  let allGood = true;
  for (const r of found) {
    if (r.kind === "task") {
      // The installer refuses to REPLACE a same-named task that is not its own;
      // deleting on a name match alone would destroy what it deliberately left.
      const xml = tryRun("schtasks", ["/Query", "/TN", r.id, "/XML"], { stdio: ["ignore", "pipe", "ignore"] });
      if (!isOurTaskDefinition(xml)) {
        warn(
          ZH
            ? `排程工作 ${r.id} 不是這個工具建立的（動作不是我們的包裝腳本），不動它。`
            : `scheduled task ${r.id} was not created by this tool (its action is not our wrapper) — refusing.`
        );
        continue;
      }
      tryRun("schtasks", ["/End", "/TN", r.id]);
      const del = tryRun("schtasks", ["/Delete", "/TN", r.id, "/F"]);
      if (del === null) {
        warn(ZH ? `無法刪除排程工作 ${r.id}` : `could not delete scheduled task ${r.id}`);
        allGood = false;
      } else ok(ZH ? `已刪除排程工作：${r.id}` : `deleted scheduled task: ${r.id}`);
    } else if (r.kind === "launchd") {
      if (!isOurTaskDefinition(readTextOr(r.id))) {
        warn(ZH ? `${r.id} 不像是這個工具產生的，不動它。` : `${r.id} does not look like ours — refusing.`);
        continue;
      }
      const uid = tryRun("id", ["-u"])?.trim();
      if (uid) tryRun("launchctl", ["bootout", `gui/${uid}`, r.id]);
      fs.rmSync(r.id, { force: true });
      ok(ZH ? `已移除 launchd plist：${r.id}` : `removed launchd plist: ${r.id}`);
    } else {
      tryRun("systemctl", ["--user", "stop", r.unit]);
      tryRun("systemctl", ["--user", "disable", r.unit]);
      fs.rmSync(r.id, { force: true });
      tryRun("systemctl", ["--user", "daemon-reload"]);
      ok(ZH ? `已移除 systemd unit：${r.id}` : `removed systemd unit: ${r.id}`);
      // `enable-linger` is what --residency-24x7 turned on, and nothing else
      // reverts it. Report rather than revert: the account may linger for
      // reasons that have nothing to do with this tool.
      const who = tryRun("id", ["-un"])?.trim();
      if (who) {
        console.log(
          ZH
            ? `  ℹ️ 若當初開了 24/7，linger 仍是開的：loginctl disable-linger ${who}`
            : `  ℹ️ if you enabled 24/7, linger is still on: loginctl disable-linger ${who}`
        );
      }
    }
  }
  // Outside the loop on purpose: a wrapper outlives the task that referenced it
  // (someone may have deleted the task by hand), and leaving one behind is a
  // stale script pointing at a state dir this uninstall is about to delete.
  for (const w of wrappers) {
    fs.rmSync(w, { force: true });
    ok(ZH ? `已移除啟動包裝腳本：${w}` : `removed wrapper: ${w}`);
  }
  return allGood;
}

function readTextOr(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Stop the bots, and WAIT for them to actually be gone.
 *
 * Signalling is not stopping. Shutdown disconnects every live session and can
 * take seconds, during which the bot is still writing to its worktrees and its
 * state file — both of which the very next steps delete. Removing a directory
 * out from under a running agent is how an uninstall corrupts the work it was
 * supposed to leave alone.
 *
 * Returns false if anything is still alive afterwards, so the caller can refuse
 * to go on to the destructive steps.
 */
function stepProcess(found) {
  if (!found.length) {
    say("  （bot 沒有在執行）", "  (bot is not running)");
    return true;
  }
  const signalled = [];
  let allGood = true;
  for (const p of found) {
    if (!p.ours) {
      // Liveness is not identity. Refuse, and show what it actually is so the
      // operator can decide — rather than force-killing a stranger's process.
      warn(
        ZH
          ? `PID ${p.pid}（${p.instance}.lock）不是這個 bot，不動它：${p.cmd ?? "無法讀取指令列"}`
          : `PID ${p.pid} (${p.instance}.lock) is not this bot — refusing: ${p.cmd ?? "command line unreadable"}`
      );
      continue;
    }
    try {
      process.kill(p.pid, "SIGTERM");
      signalled.push(p);
    } catch (e) {
      warn(ZH ? `無法停止 PID ${p.pid}：${e.message}` : `could not stop PID ${p.pid}: ${e.message}`);
      allGood = false;
    }
  }
  // Up to ~15s, which comfortably covers the app's own teardown timeout.
  const deadline = Date.now() + 15_000;
  for (const p of signalled) {
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(p.pid, 0);
      } catch {
        alive = false;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
    if (alive) {
      warn(
        ZH
          ? `PID ${p.pid} 在 15 秒後仍在執行，不繼續刪除它的資料。`
          : `PID ${p.pid} is still running after 15s; refusing to delete its data.`
      );
      allGood = false;
    } else {
      ok(ZH ? `已停止 bot（${p.instance}，PID ${p.pid}）` : `stopped bot (${p.instance}, PID ${p.pid})`);
    }
  }
  return allGood;
}

async function stepCommands(env) {
  const token = env.DISCORD_BOT_TOKEN;
  const guild = env.DISCORD_GUILD_ID;
  if (!token || !guild) {
    warn(
      ZH
        ? "  找不到 token/guild，略過解除註冊 slash commands（Discord 上仍會留著）。"
        : "  No token/guild found; skipped deregistering slash commands (they remain in Discord)."
    );
    return true; // nothing we could have done — not a failure to retry
  }
  // Discord/Cloudflare answers 403 to a request with no User-Agent. Verified.
  const headers = {
    Authorization: `Bot ${token}`,
    "User-Agent": "DiscordBot (https://github.com/lettucebo/discord-copilot-sdk, 1.0)",
    "Content-Type": "application/json",
  };
  // Guild-command overwrite is a rate-limited bucket, and 429 is the one error
  // that WOULD have worked on a second attempt — the difference between a clean
  // uninstall and commands stranded in Discord for good.
  const send = async (url, init) => {
    for (let i = 0; ; i++) {
      const res = await fetch(url, { ...init, headers });
      if (res.status !== 429 || i >= 3) return res;
      const retry = Number(res.headers.get("retry-after") ?? "1");
      const ms = Math.min(Number.isFinite(retry) ? retry * 1000 : 1000, 10_000);
      say(`  （被限流，${Math.round(ms / 1000)} 秒後重試）`, `  (rate limited, retrying in ${Math.round(ms / 1000)}s)`);
      await new Promise((r) => setTimeout(r, ms));
    }
  };
  try {
    const me = await send("https://discord.com/api/v10/applications/@me", {});
    if (!me.ok) throw new Error(`applications/@me -> ${me.status}`);
    const app = await me.json();
    const url = `https://discord.com/api/v10/applications/${app.id}/guilds/${guild}/commands`;
    const before = await send(url, {});
    const count = before.ok ? (await before.json()).length : "?";
    const res = await send(url, { method: "PUT", body: "[]" });
    if (!res.ok) throw new Error(`PUT commands -> ${res.status}`);
    ok(ZH ? `已解除註冊 ${count} 個 slash commands` : `deregistered ${count} slash commands`);
    // Print the exact app URL while we still have the id — far more useful than
    // a generic link once .env is gone.
    APP_URL = `https://discord.com/developers/applications/${app.id}`;
    return true;
  } catch (e) {
    warn((ZH ? "無法解除註冊 slash commands：" : "Could not deregister slash commands: ") + e.message);
    return false;
  }
}
let APP_URL = "";

function stepWorktrees(worktrees) {
  if (!worktrees.length) {
    say("  （沒有 worktree）", "  (no worktrees)");
    return true;
  }
  let allGood = true;
  for (const w of worktrees) {
    if (w.verdict !== "removable") {
      warn(
        ZH
          ? `保留 worktree（${w.verdict}）：${w.dir} — 裡面可能有只存在於此的東西`
          : `kept worktree (${w.verdict}): ${w.dir} — it may hold work that exists nowhere else`
      );
      continue;
    }
    const removed = tryRun("git", ["worktree", "remove", w.dir], { cwd: w.repoPath });
    if (removed === null) {
      warn(ZH ? `無法移除：${w.dir}` : `could not remove: ${w.dir}`);
      allGood = false;
    } else {
      ok(ZH ? `已移除 worktree：${w.dir}（分支保留）` : `removed worktree: ${w.dir} (branch kept)`);
    }
  }
  if (fs.existsSync(WORKTREE_ROOT) && fs.readdirSync(WORKTREE_ROOT).length === 0) {
    fs.rmSync(WORKTREE_ROOT, { recursive: true, force: true });
    ok(ZH ? `已移除空的 worktree 根目錄：${WORKTREE_ROOT}` : `removed empty worktree root: ${WORKTREE_ROOT}`);
  }
  return allGood;
}

function stepBranches(branches) {
  if (!branches.length) {
    say("  （沒有 copilot/t-* 分支）", "  (no copilot/t-* branches)");
    return true;
  }
  for (const { repo, branch } of branches) {
    // `-d`, never `-D`: git refuses to delete a branch holding unmerged commits,
    // and that refusal is the whole safety net here. Report git's own words
    // rather than assuming "unmerged" — it may be a lock or a checked-out branch.
    const out = tryRun("git", ["-C", repo, "branch", "-d", branch]);
    const where = path.basename(repo);
    if (out === null) {
      warn(
        ZH
          ? `保留分支 ${where}/${branch}（git 拒絕刪除：可能有未合併的 commit，或正被 worktree 使用）`
          : `kept branch ${where}/${branch} (git refused: unmerged commits, or checked out in a worktree)`
      );
    } else {
      ok(ZH ? `已刪除分支：${where}/${branch}` : `deleted branch: ${where}/${branch}`);
    }
  }
  return true; // a refusal to delete is a safety feature, not a failure
}

function rmDir(dir, label) {
  if (!fs.existsSync(dir)) {
    say(`  （沒有 ${label}）`, `  (no ${label})`);
    return true;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    ok(ZH ? `已移除 ${label}：${dir}` : `removed ${label}: ${dir}`);
    return true;
  } catch (e) {
    warn(ZH ? `無法移除 ${label}：${e.message}` : `could not remove ${label}: ${e.message}`);
    return false;
  }
}

function stepEnv() {
  if (!fs.existsSync(ENV_PATH)) return say("  （沒有 .env）", "  (no .env)");
  // Only claim the token went if there actually was one — a .env without a token
  // is perfectly possible (a half-finished install), and saying otherwise would
  // leave someone believing a secret was cleaned up that never existed.
  const hadToken = /^DISCORD_BOT_TOKEN=\S/m.test(fs.readFileSync(ENV_PATH, "utf8"));
  fs.rmSync(ENV_PATH, { force: true });
  ok(
    hadToken
      ? ZH
        ? `已刪除 .env（bot token 一併移除）：${ENV_PATH}`
        : `deleted .env (the bot token went with it): ${ENV_PATH}`
      : ZH
        ? `已刪除 .env（裡面沒有 token）：${ENV_PATH}`
        : `deleted .env (it held no token): ${ENV_PATH}`
  );
}

// -------------------------------------------------------------------- main --

async function main() {
  say("== discord-copilot-sdk 解除安裝 ==", "== discord-copilot-sdk uninstall ==");
  const env = readEnv();
  // Multi-repo: worktrees name their own owner (git is asked), and branches are
  // swept across every repo under the root — not just one configured repo.
  const reposRoot = env.REPOS_ROOT || "";
  const residency = findResidency();
  const wrappers = findWrappers();
  const proc = findProcess();
  const worktrees = findWorktrees();
  const branches = findBranches(reposRoot);
  const { steps, refusals } = planUninstall(FLAGS);

  // --- the plan, before anything happens ---
  console.log("");
  say("將會移除：", "Will remove:");
  const lines = {
    residency:
      residency.length || wrappers.length
        ? ZH
          ? `${residency.length} 個常駐設定、${wrappers.length} 個啟動包裝腳本`
          : `${residency.length} residency registration(s) and ${wrappers.length} wrapper script(s)`
        : null,
    process: proc.length
      ? ZH
        ? `${proc.length} 個執行中的 bot（PID ${proc.map((p) => p.pid).join(", ")}）`
        : `${proc.length} running bot(s) (PID ${proc.map((p) => p.pid).join(", ")})`
      : null,
    commands: env.DISCORD_BOT_TOKEN ? (ZH ? "該 Discord 伺服器的 slash commands" : "the Discord slash commands in that guild") : null,
    worktrees: worktrees.length
      ? ZH
        ? `${worktrees.filter((w) => w.verdict === "removable").length}/${worktrees.length} 個 worktree（只移除 git 確認乾淨的）`
        : `${worktrees.filter((w) => w.verdict === "removable").length} of ${worktrees.length} worktrees (only the ones git proves clean)`
      : null,
    branches: branches.length
      ? ZH
        ? `${branches.length} 個 copilot/t-* 分支中已合併的部分`
        : `the merged ones among ${branches.length} copilot/t-* branches`
      : null,
    state: fs.existsSync(STATE_DIR)
      ? ZH
        ? `${STATE_DIR}（核准紀錄、session 記錄、日誌、.env 備份）`
        : `${STATE_DIR} (approvals, session records, logs, .env backups)`
      : null,
    legacy: fs.existsSync(LEGACY_DIR) ? (ZH ? `${LEGACY_DIR}（改名前的殘留）` : `${LEGACY_DIR} (pre-rename leftovers)`) : null,
    env: fs.existsSync(ENV_PATH) ? (ZH ? `${ENV_PATH}（含 bot token）` : `${ENV_PATH} (contains the bot token)`) : null,
  };
  let anything = false;
  for (const s of steps) {
    if (lines[s]) {
      console.log(`  • ${lines[s]}`);
      anything = true;
    }
  }
  if (!anything) console.log(ZH ? "  （沒有找到任何需要移除的東西）" : "  (nothing found to remove)");

  const dirty = worktrees.filter((w) => w.verdict !== "removable");
  if (dirty.length || refusals.length) {
    console.log("");
    say("將會保留：", "Will keep:");
    for (const w of dirty) console.log(`  • ${w.dir} (${w.verdict})`);
    for (const r of refusals) console.log(`  • ${r.split(":").slice(1).join(":")}`);
  }

  console.log("");
  say("不會碰：", "Never touched:");
  for (const [what, why] of NEVER_TOUCHED) console.log(`  • ${what} — ${why}`);

  const gone = irreversible(steps).length;
  if (gone) {
    console.log("");
    warn(
      ZH
        ? "以上有無法用重新安裝復原的項目（.env / 分支 / 狀態目錄）。"
        : "Some of the above cannot be undone by re-running the installer (.env / branches / state)."
    );
  }

  if (FLAGS.dryRun) {
    console.log("");
    say("（--dry-run：什麼都沒有動。）", "(--dry-run: nothing was changed.)");
    return;
  }
  if (!anything) return;
  if (!FLAGS.yes) {
    console.log("");
    if (!process.stdin.isTTY) {
      // Fail closed and say why. Silently proceeding without a confirmable
      // prompt is how an uninstall ends up running somewhere nobody meant it to.
      say(
        "沒有互動終端機，無法確認，因此不做任何變更。確定要執行請加 --yes（或先用 --dry-run 看計畫）。",
        "No interactive terminal, so nothing was changed. Pass --yes to proceed (or --dry-run to see the plan)."
      );
      return;
    }
    const a = await ask(ZH ? "確定要繼續嗎？輸入 yes 確認： " : "Proceed? type yes to confirm: ");
    if (a.toLowerCase() !== "yes") {
      say("已取消。", "Cancelled.");
      return;
    }
  }

  // --- act, in the order the planner fixed ---
  console.log("");
  // Track every step. Reporting "complete" over a swallowed failure is the exact
  // half-truth this whole design keeps refusing to ship — and one failure in
  // particular is load-bearing: if deregistering the commands failed, deleting
  // .env destroys the only credential that could retry it.
  const failed = new Set();
  let commandsOk = true;
  for (const s of steps) {
    if (s === "residency") {
      if (!(await stepResidency(residency, wrappers))) failed.add("residency");
    } else if (s === "process") {
      if (!stepProcess(proc)) failed.add("process");
    } else if (s === "commands") {
      commandsOk = await stepCommands(env);
      if (!commandsOk) failed.add("commands");
    } else if (s === "worktrees") {
      // Never delete a running bot's working directory.
      if (failed.has("process")) {
        warn(ZH ? "有 bot 仍在執行，略過 worktree 清理。" : "a bot is still running; skipped worktree cleanup.");
        failed.add("worktrees");
      } else if (!stepWorktrees(worktrees)) failed.add("worktrees");
    } else if (s === "branches") {
      if (!stepBranches(branches)) failed.add("branches");
    } else if (s === "state") {
      if (failed.has("process")) {
        warn(ZH ? "有 bot 仍在執行，略過刪除狀態目錄。" : "a bot is still running; skipped deleting the state dir.");
        failed.add("state");
      } else if (!rmDir(STATE_DIR, ZH ? "狀態目錄" : "state dir")) failed.add("state");
    } else if (s === "legacy") {
      if (!rmDir(LEGACY_DIR, ZH ? "改名前的目錄" : "legacy dir")) failed.add("legacy");
    } else if (s === "env") {
      if (!commandsOk) {
        // Keep the token: it is the only way to retry the deregistration.
        warn(
          ZH
            ? "slash commands 解除註冊失敗，因此**保留 .env**（那是唯一能重試的憑證）。修好網路後重跑即可。"
            : "deregistering the slash commands failed, so .env is KEPT — it is the only credential that could retry. Re-run once the network is back."
        );
        failed.add("env");
      } else stepEnv();
    }
  }

  console.log("");
  if (failed.size) {
    warn(
      ZH
        ? `解除安裝**未完成**：${[...failed].join("、")} 這幾步沒有成功。`
        : `Uninstall INCOMPLETE — these steps did not succeed: ${[...failed].join(", ")}.`
    );
  } else {
    say("本機解除安裝完成。", "Local uninstall complete.");
  }
  console.log("");
  say("還需要你自己做的：", "Still yours to do:");
  // Repeat the security-relevant leftovers HERE, not only in the plan. After a
  // long run the last thing on screen is what people act on.
  if (!steps.includes("env") && fs.existsSync(ENV_PATH)) {
    console.log(
      ZH
        ? `  • ⚠️ ${ENV_PATH} 仍在，裡面**還有你的 bot token**（--keep-config）`
        : `  • ⚠️ ${ENV_PATH} is still there and **still holds your bot token** (--keep-config)`
    );
  }
  if (!steps.includes("state") && fs.existsSync(STATE_DIR)) {
    console.log(
      ZH
        ? `  • ⚠️ ${STATE_DIR} 仍在，含核准紀錄，且 env-backups/ 內的**舊 .env 備份也含 token**（--keep-state）`
        : `  • ⚠️ ${STATE_DIR} is still there with approval grants, and env-backups/ holds **old .env copies that also contain tokens** (--keep-state)`
    );
  }
  if (failed.has("commands")) {
    console.log(
      ZH
        ? `  • ⚠️ slash commands **仍註冊在該伺服器**（解除註冊失敗）。網路恢復後重跑本腳本即可。`
        : `  • ⚠️ the slash commands are STILL registered in that guild (deregistration failed). Re-run this script once the network is back.`
    );
  }
  for (const w of worktrees.filter((x) => x.verdict !== "removable")) {
    console.log(ZH ? `  • worktree 保留：${w.dir}（${w.verdict}）` : `  • worktree kept: ${w.dir} (${w.verdict})`);
  }
  console.log(
    ZH
      ? `  • 刪除 Discord 應用程式（或至少重設 token —— 刪掉 .env 不會讓已外流的 token 失效）：\n    ${APP_URL || "https://discord.com/developers/applications"}`
      : `  • Delete the bot application, or at least RESET its token — deleting .env does not revoke a token that leaked:\n    ${APP_URL || "https://discord.com/developers/applications"}`
  );
  console.log(
    ZH
      ? "  • bot 仍是該 Discord 伺服器的成員，先前的討論串與訊息也還在 —— 這個腳本不會動 Discord 上的內容。"
      : "  • The bot is still a member of that Discord server, and its old threads and messages remain — this script does not touch content in Discord."
  );
  console.log(
    ZH
      ? "  • Copilot 自己的 session 資料仍在 ~/.copilot/session-state/（屬於 Copilot CLI，本工具不碰）。"
      : "  • Copilot's own session data remains under ~/.copilot/session-state/ (it belongs to the Copilot CLI; this tool does not touch it)."
  );
  console.log(
    ZH
      ? `  • 這份原始碼還在（含 node_modules 與 dist，通常是最大的殘留）：${REPO_ROOT}\n    不自動刪除，因為腳本正在裡面執行；確認後可自行移除。`
      : `  • This checkout is still at (node_modules and dist included — usually the largest residue): ${REPO_ROOT}\n    Not deleted automatically — the script is running from inside it.`
  );
  console.log(
    ZH
      ? "  • 若你還有**另一份 clone**：本次已刪除所有 instance 共用的狀態，但那份的 .env（含 token）仍在，請自行處理。"
      : "  • If you have ANOTHER checkout: this removed the state shared by all instances, but that checkout's .env (and its token) is untouched — handle it yourself."
  );
  if (failed.size) process.exitCode = 1;
}

main().catch((e) => {
  console.error(c(31, "\u2717 ") + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
