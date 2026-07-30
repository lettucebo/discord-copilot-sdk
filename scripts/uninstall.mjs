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
import { planUninstall, classifyWorktree, irreversible, NEVER_TOUCHED } from "./lib/uninstall-core.mjs";

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

/** Every instance's running bot, not just this one — see findResidency. */
function findProcess() {
  if (!fs.existsSync(STATE_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(STATE_DIR)) {
    if (!f.endsWith(".lock")) continue;
    const raw = fs.readFileSync(path.join(STATE_DIR, f), "utf8").trim();
    if (!/^\d+$/.test(raw)) continue;
    const pid = Number(raw);
    try {
      process.kill(pid, 0); // signal 0 = existence check only
    } catch {
      continue; // stale lock
    }
    out.push({ pid, instance: f.replace(/\.lock$/, "") });
  }
  return out;
}

/** Worktrees this tool made, with git's verdict on each. */
function findWorktrees(repoPath) {
  if (!fs.existsSync(WORKTREE_ROOT)) return [];
  return fs
    .readdirSync(WORKTREE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(WORKTREE_ROOT, d.name);
      const status = tryRun("git", ["status", "--porcelain", "--ignored=matching"], { cwd: dir });
      const head = tryRun("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: dir });
      const branch = `copilot/t-${d.name}`;
      return { dir, branch, repoPath, verdict: classifyWorktree(status, head === null ? null : head.trim(), branch) };
    });
}

function findBranches(repoPath) {
  if (!repoPath || !fs.existsSync(repoPath)) return [];
  const out = tryRun("git", ["-C", repoPath, "branch", "--list", "copilot/t-*", "--format=%(refname:short)"]);
  return out ? out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
}

// ------------------------------------------------------------------- steps --

async function stepResidency(found, wrappers) {
  if (!found.length) say("  （沒有安裝常駐）", "  (no residency installed)");
  for (const r of found) {
    if (r.kind === "task") {
      tryRun("schtasks", ["/End", "/TN", r.id]);
      const del = tryRun("schtasks", ["/Delete", "/TN", r.id, "/F"]);
      if (del === null) warn(ZH ? `無法刪除排程工作 ${r.id}` : `could not delete scheduled task ${r.id}`);
      else ok(ZH ? `已刪除排程工作：${r.id}` : `deleted scheduled task: ${r.id}`);
    } else if (r.kind === "launchd") {
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
    }
  }
  // Outside the loop on purpose: a wrapper outlives the task that referenced it
  // (someone may have deleted the task by hand), and leaving one behind is a
  // stale script pointing at a state dir this uninstall is about to delete.
  for (const w of wrappers) {
    fs.rmSync(w, { force: true });
    ok(ZH ? `已移除啟動包裝腳本：${w}` : `removed wrapper: ${w}`);
  }
}

function stepProcess(found) {
  if (!found.length) return say("  （bot 沒有在執行）", "  (bot is not running)");
  for (const p of found) {
    try {
      process.kill(p.pid, "SIGTERM");
      ok(ZH ? `已停止 bot（${p.instance}，PID ${p.pid}）` : `stopped bot (${p.instance}, PID ${p.pid})`);
    } catch (e) {
      warn(ZH ? `無法停止 PID ${p.pid}：${e.message}` : `could not stop PID ${p.pid}: ${e.message}`);
    }
  }
}

async function stepCommands(env) {
  const token = env.DISCORD_BOT_TOKEN;
  const guild = env.DISCORD_GUILD_ID;
  if (!token || !guild) {
    return warn(
      ZH
        ? "  找不到 token/guild，略過解除註冊 slash commands（Discord 上仍會留著）。"
        : "  No token/guild found; skipped deregistering slash commands (they remain in Discord)."
    );
  }
  // Discord/Cloudflare answers 403 to a request with no User-Agent. Verified.
  const headers = {
    Authorization: `Bot ${token}`,
    "User-Agent": "DiscordBot (https://github.com/lettucebo/discord-copilot-sdk, 1.0)",
    "Content-Type": "application/json",
  };
  try {
    const me = await fetch("https://discord.com/api/v10/applications/@me", { headers });
    if (!me.ok) throw new Error(`applications/@me -> ${me.status}`);
    const appId = (await me.json()).id;
    const url = `https://discord.com/api/v10/applications/${appId}/guilds/${guild}/commands`;
    const before = await fetch(url, { headers });
    const count = before.ok ? (await before.json()).length : "?";
    const res = await fetch(url, { method: "PUT", headers, body: "[]" });
    if (!res.ok) throw new Error(`PUT commands -> ${res.status}`);
    ok(ZH ? `已解除註冊 ${count} 個 slash commands` : `deregistered ${count} slash commands`);
  } catch (e) {
    warn(
      (ZH ? "無法解除註冊 slash commands（可在 Discord 開發者後台刪除應用程式）：" : "Could not deregister slash commands (deleting the app in the Discord developer portal also removes them): ") +
        e.message
    );
  }
}

function stepWorktrees(worktrees) {
  if (!worktrees.length) return say("  （沒有 worktree）", "  (no worktrees)");
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
    } else {
      ok(ZH ? `已移除 worktree：${w.dir}（分支保留）` : `removed worktree: ${w.dir} (branch kept)`);
    }
  }
  if (fs.existsSync(WORKTREE_ROOT) && fs.readdirSync(WORKTREE_ROOT).length === 0) {
    fs.rmSync(WORKTREE_ROOT, { recursive: true, force: true });
    ok(ZH ? `已移除空的 worktree 根目錄：${WORKTREE_ROOT}` : `removed empty worktree root: ${WORKTREE_ROOT}`);
  }
}

function stepBranches(repoPath, branches) {
  if (!branches.length) return say("  （沒有 copilot/t-* 分支）", "  (no copilot/t-* branches)");
  for (const b of branches) {
    // `-d`, never `-D`: git refuses to delete a branch holding unmerged commits,
    // and that refusal is the whole safety net here.
    const out = tryRun("git", ["-C", repoPath, "branch", "-d", b]);
    if (out === null) {
      warn(
        ZH
          ? `保留分支 ${b} — 有尚未合併的 commit`
          : `kept branch ${b} — it holds unmerged commits`
      );
    } else {
      ok(ZH ? `已刪除分支：${b}` : `deleted branch: ${b}`);
    }
  }
}

function rmDir(dir, label) {
  if (!fs.existsSync(dir)) return say(`  （沒有 ${label}）`, `  (no ${label})`);
  fs.rmSync(dir, { recursive: true, force: true });
  ok(ZH ? `已移除 ${label}：${dir}` : `removed ${label}: ${dir}`);
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
  const repoPath = env.CONTROLLED_REPO_PATH || "";
  const residency = findResidency();
  const wrappers = findWrappers();
  const proc = findProcess();
  const worktrees = findWorktrees(repoPath);
  const branches = findBranches(repoPath);
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
  for (const s of steps) {
    if (s === "residency") await stepResidency(residency, wrappers);
    else if (s === "process") stepProcess(proc);
    else if (s === "commands") await stepCommands(env);
    else if (s === "worktrees") stepWorktrees(worktrees);
    else if (s === "branches") stepBranches(repoPath, branches);
    else if (s === "state") rmDir(STATE_DIR, ZH ? "狀態目錄" : "state dir");
    else if (s === "legacy") rmDir(LEGACY_DIR, ZH ? "改名前的目錄" : "legacy dir");
    else if (s === "env") stepEnv();
  }

  console.log("");
  say("解除安裝完成。", "Uninstall complete.");
  console.log("");
  say("還需要你自己做的：", "Still yours to do:");
  // Repeat the security-relevant leftovers HERE, not only in the plan. After a
  // long run the last thing on screen is what people act on, and "complete"
  // sitting above a still-present bot token is the wrong last word.
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
        ? `  • ⚠️ ${STATE_DIR} 仍在，含核准紀錄與 .env 備份（--keep-state）`
        : `  • ⚠️ ${STATE_DIR} is still there, with approval grants and .env backups (--keep-state)`
    );
  }
  for (const w of worktrees.filter((x) => x.verdict !== "removable")) {
    console.log(ZH ? `  • worktree 保留：${w.dir}（${w.verdict}）` : `  • worktree kept: ${w.dir} (${w.verdict})`);
  }
  console.log(
    ZH
      ? "  • 到 https://discord.com/developers/applications 刪除這個 bot 應用程式（或至少重設 token）"
      : "  • Delete the bot application at https://discord.com/developers/applications (or at least reset its token)"
  );
  console.log(
    ZH
      ? `  • 這份原始碼還在：${REPO_ROOT}\n    不自動刪除，因為腳本正在裡面執行；確認後可自行移除。`
      : `  • This checkout is still at: ${REPO_ROOT}\n    Not deleted automatically — the script is running from inside it. Remove it yourself when you are happy.`
  );
}

main().catch((e) => {
  console.error(c(31, "\u2717 ") + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
