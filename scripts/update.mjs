#!/usr/bin/env node
// Safe local updater. The ordering is deliberate:
//
//   read-only preflight -> stop residency -> stop bot -> move HEAD -> setup -> restore
//
// npm may replace files held by a live bot on Windows, while residency restarts
// a killed process. Moving either stop step earlier is how an update becomes an
// EPERM failure or a bot that starts halfway through a build. Conversely, an
// apply failure never restores automatically: the new dist/old .env combination
// is exactly what setup rejected, and a scheduled restart would turn that into a
// crash loop. `--restore` is the explicit, operator-visible recovery path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import {
  classifyCheckout,
  parseLsRemote,
  parseUpdateArgs,
  planUpdate,
  remoteRefSpecs,
  resolveRemoteSha,
} from "./lib/update-core.mjs";
import { nodeVersionOk } from "./lib/setup-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const STATE_DIR = path.join(os.homedir(), ".discord-copilot-sdk");
const REPO_URL = "https://github.com/lettucebo/discord-copilot-sdk.git";
const INSTANCE_RE = /^[A-Za-z0-9._-]{1,64}$/;

class UpdateError extends Error {}

const flags = parseUpdateArgs(process.argv.slice(2));
const lang = flags.lang ?? (/^zh/i.test(process.env.DISCORD_COPILOT_SDK_LOCALE ?? process.env.LANG ?? "") ? "zh" : "en");
const say = (zh, en) => console.log(lang === "zh" ? zh : en);

function run(command, args, opts = {}) {
  return execFileSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function runInherited(command, args, opts = {}) {
  execFileSync(command, args, { cwd: REPO_ROOT, stdio: "inherit", ...opts });
}

function tryRun(command, args, opts = {}) {
  try {
    return run(command, args, opts);
  } catch {
    return null;
  }
}

function currentInstance() {
  const raw = (process.env.DISCORD_COPILOT_SDK_INSTANCE_ID ?? "").trim();
  return INSTANCE_RE.test(raw) ? raw : "default";
}

function statePath(instance) {
  return path.join(STATE_DIR, `update-state.${instance}.json`);
}

function updateLockPath(instance) {
  return path.join(STATE_DIR, `update.${instance}.lock`);
}

function ensureRepo() {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  } catch {
    throw new UpdateError("not a readable discord-copilot-sdk checkout");
  }
  if (pkg?.name !== "discord-copilot-sdk") throw new UpdateError("not a discord-copilot-sdk checkout");
  const origin = tryRun("git", ["remote", "get-url", "origin"])?.trim();
  const normalize = (value) => value?.replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
  if (!origin || normalize(origin) !== normalize(REPO_URL)) {
    throw new UpdateError(`origin is '${origin ?? "(missing)"}', not ${REPO_URL}`);
  }
}

function onPath(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(probe, [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ensurePrerequisites() {
  if (!nodeVersionOk()) throw new UpdateError(`unsupported Node version ${process.versions.node}`);
  const missing = ["git", "copilot"].filter((command) => !onPath(command));
  if (missing.length) throw new UpdateError(`missing prerequisite(s): ${missing.join(", ")}`);
}

function checkoutFacts() {
  const status = tryRun("git", ["status", "--porcelain", "--untracked-files=all"]);
  if (status === null) return { kind: "unknown", branch: null };
  const symbolic = tryRun("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (symbolic !== null) return { kind: classifyCheckout({ symbolicRef: symbolic.trim(), status }), branch: symbolic.trim() };
  // `symbolic-ref --quiet` exits 1 for a detached HEAD. Require a readable HEAD
  // as a second fact so a damaged git repository never masquerades as managed.
  if (tryRun("git", ["rev-parse", "--verify", "HEAD"]) === null) return { kind: "unknown", branch: null };
  return { kind: classifyCheckout({ symbolicRef: "", status }), branch: null };
}

function localSha() {
  const sha = tryRun("git", ["rev-parse", "HEAD"])?.trim();
  if (!sha || !/^[0-9a-f]{40,64}$/i.test(sha)) throw new UpdateError("could not resolve local HEAD");
  return sha;
}

function remoteFor(ref) {
  const specs = remoteRefSpecs(ref);
  if (!specs.length) throw new UpdateError(`invalid ref: ${ref}`);
  const output = tryRun("git", ["ls-remote", "origin", ...specs]);
  if (output === null) throw new UpdateError(`could not query origin for ${ref}`);
  return resolveRemoteSha(parseLsRemote(output), ref);
}

function fetchResolved(remote, checkoutKind) {
  const ref = remote.ref.replace(/\^\{\}$/, "");
  const args = ["fetch"];
  if (checkoutKind === "managed") args.push("--depth", "1");
  args.push("origin", ref);
  runInherited("git", args);
}

function preflightBranchFastForward() {
  if (tryRun("git", ["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]) === null) {
    throw new UpdateError("the current branch cannot fast-forward to the requested ref");
  }
}

function countDanglingManagedCommits() {
  const value = tryRun("git", ["rev-list", "HEAD", "--not", "FETCH_HEAD", "--count"])?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : 0;
}

async function precheckIncomingConfig() {
  const envPath = path.join(REPO_ROOT, ".env");
  if (!fs.existsSync(envPath)) throw new UpdateError("no .env exists; run the installer interactively first");
  const values = parseEnv(fs.readFileSync(envPath, "utf8"));
  // setup.mjs owns the old-key migration. Its implementation is intentionally
  // not duplicated here, so leave this one known migration path to the
  // authoritative setup engine instead of rejecting a configuration it repairs.
  if ("CONTROLLED_REPO_PATH" in values) return;

  const source = tryRun("git", ["show", "FETCH_HEAD:scripts/lib/validate.mjs"]);
  if (source === null) throw new UpdateError("the requested revision does not contain scripts/lib/validate.mjs");
  const temp = path.join(os.tmpdir(), `dcs-update-validate-${process.pid}-${Date.now()}.mjs`);
  try {
    fs.writeFileSync(temp, source, "utf8");
    const incoming = await import(`${pathToFileURL(temp).href}?${Date.now()}`);
    const result = incoming.validateConfig(values);
    if (!result?.ok) {
      const keys = Array.isArray(result?.errors) ? result.errors.map((error) => error.key).join(", ") : "unknown";
      throw new UpdateError(`the requested version rejects the current configuration: ${keys}`);
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function isLivePid(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function liveInstances() {
  if (!fs.existsSync(STATE_DIR)) return [];
  const instances = [];
  for (const file of fs.readdirSync(STATE_DIR)) {
    const match = /^(.+)\.lock$/.exec(file);
    if (!match || !INSTANCE_RE.test(match[1] ?? "")) continue;
    let pid;
    try {
      pid = Number(fs.readFileSync(path.join(STATE_DIR, file), "utf8").trim());
    } catch {
      continue;
    }
    if (isLivePid(pid)) instances.push({ instance: match[1], pid });
  }
  return instances;
}

function activeThreadSummary() {
  let threads = 0;
  let unreadable = 0;
  if (fs.existsSync(STATE_DIR)) {
    for (const file of fs.readdirSync(STATE_DIR)) {
      if (!file.endsWith(".session.json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(STATE_DIR, file), "utf8"));
        if (!Array.isArray(parsed?.sessions)) {
          unreadable++;
          continue;
        }
        threads += parsed.sessions.filter((session) => ["creating", "active", "orphaned", "blocked"].includes(session?.state)).length;
      } catch {
        unreadable++;
      }
    }
  }

  const worktreeRoot = `${STATE_DIR}-worktrees`;
  let dirtyWorktrees = 0;
  if (fs.existsSync(worktreeRoot)) {
    const candidates = [];
    for (const top of fs.readdirSync(worktreeRoot, { withFileTypes: true })) {
      if (!top.isDirectory()) continue;
      const topPath = path.join(worktreeRoot, top.name);
      if (fs.existsSync(path.join(topPath, ".git"))) {
        candidates.push(topPath);
        continue;
      }
      for (const child of fs.readdirSync(topPath, { withFileTypes: true })) {
        if (child.isDirectory() && fs.existsSync(path.join(topPath, child.name, ".git"))) {
          candidates.push(path.join(topPath, child.name));
        }
      }
    }
    for (const worktree of candidates) {
      const status = tryRun("git", ["status", "--porcelain", "--ignored=matching"], { cwd: worktree });
      if (status === null || status.trim()) dirtyWorktrees++;
    }
  }
  return { threads, dirtyWorktrees, unreadable };
}

function ask(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(?:es)?$/i.test(answer.trim()));
    })
  );
}

async function confirmActiveThreads(summary) {
  if (!summary.threads && !summary.dirtyWorktrees && !summary.unreadable) return;
  say(
    `警告：有 ${summary.threads} 個可恢復 thread、${summary.dirtyWorktrees} 個髒 worktree，${summary.unreadable} 個無法讀取的 session store。Windows 上更新會硬砍進行中的 turn。`,
    `Warning: ${summary.threads} resumable thread(s), ${summary.dirtyWorktrees} dirty worktree(s), and ${summary.unreadable} unreadable session store(s) exist. Windows updates hard-kill an in-flight turn.`
  );
  if (flags.yes) return;
  const accepted = await ask(lang === "zh" ? "仍要更新嗎？[y/N] " : "Continue with the update? [y/N] ");
  if (!accepted) throw new UpdateError("update cancelled at the active-thread guard");
}

function readWindowsResidency(instance) {
  const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const name = `discord-copilot-sdk-${instance}`;
  const output = tryRun(ps, [
    "-NoProfile",
    "-Command",
    `$t=Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue;if($t){if($t.Settings.Enabled){'enabled'}else{'disabled'}}`,
  ]);
  return { registered: output !== null && /^(enabled|disabled)\s*$/i.test(output), enabled: /^enabled\s*$/i.test(output ?? "") };
}

function residencyState(instance) {
  if (process.platform === "win32") return readWindowsResidency(instance);
  if (process.platform === "darwin") {
    const uid = String(process.getuid?.() ?? "");
    const label = `com.discord-copilot-sdk.${instance}`;
    return {
      registered: fs.existsSync(path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`)),
      enabled: tryRun("launchctl", ["print", `gui/${uid}/${label}`]) !== null,
    };
  }
  const unit = `discord-copilot-sdk-${instance}.service`;
  const enabled = tryRun("systemctl", ["--user", "is-enabled", unit])?.trim() === "enabled";
  return { registered: enabled || tryRun("systemctl", ["--user", "cat", unit]) !== null, enabled };
}

function writeState(instance, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const target = statePath(instance);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.renameSync(temp, target);
}

function acquireUpdateLock(instance) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const lock = updateLockPath(instance);
  let fd;
  try {
    fd = fs.openSync(lock, "wx");
    fs.writeFileSync(fd, String(process.pid));
  } catch (error) {
    if (typeof fd === "number") fs.closeSync(fd);
    throw new UpdateError(`another update appears to be active (${lock}): ${error instanceof Error ? error.message : String(error)}`);
  }
  fs.closeSync(fd);
  return () => fs.rmSync(lock, { force: true });
}

function stopInstance(instance) {
  if (process.platform === "win32") {
    const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    runInherited(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(REPO_ROOT, "stop-bot.ps1"), "-Disable"], {
      env: { ...process.env, DISCORD_COPILOT_SDK_INSTANCE_ID: instance },
    });
    return;
  }
  if (process.platform === "darwin") {
    const label = `com.discord-copilot-sdk.${instance}`;
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
    if (fs.existsSync(plist)) {
      // bootout can report non-zero when the plist exists but is not currently
      // loaded. That is already the desired stopped state; stop-bot below still
      // proves any lock PID before it signals it.
      tryRun("launchctl", ["bootout", `gui/${String(process.getuid?.() ?? "")}`, plist]);
    }
  }
  runInherited("bash", [path.join(REPO_ROOT, "stop-bot.sh"), "--disable"], {
    env: { ...process.env, DISCORD_COPILOT_SDK_INSTANCE_ID: instance },
  });
}

async function verifyStopped(instances) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (instances.every(({ pid }) => !isLivePid(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new UpdateError("a bot process remained alive after stop-bot; refusing to update live files");
}

function restoreResidency(instance, residency, shouldRun) {
  if (!residency.registered || !residency.enabled) return false;
  if (process.platform === "win32") {
    const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const name = `discord-copilot-sdk-${instance}`;
    const commands = [`Enable-ScheduledTask -TaskName '${name}' -ErrorAction Stop`];
    if (shouldRun) commands.push(`Start-ScheduledTask -TaskName '${name}' -ErrorAction Stop`);
    runInherited(ps, ["-NoProfile", "-Command", commands.join(";")]);
    return shouldRun;
  }
  if (process.platform === "darwin") {
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", `com.discord-copilot-sdk.${instance}.plist`);
    const uid = String(process.getuid?.() ?? "");
    runInherited("launchctl", ["bootstrap", `gui/${uid}`, plist]);
    return shouldRun;
  }
  const unit = `discord-copilot-sdk-${instance}.service`;
  runInherited("systemctl", ["--user", "enable", unit]);
  if (shouldRun) runInherited("systemctl", ["--user", "start", unit]);
  return shouldRun;
}

function startInstance(instance) {
  if (process.platform === "win32") {
    const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    runInherited(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(REPO_ROOT, "run-bot.ps1")], {
      env: { ...process.env, DISCORD_COPILOT_SDK_INSTANCE_ID: instance },
    });
    return;
  }
  runInherited("bash", [path.join(REPO_ROOT, "run-bot.sh")], {
    env: { ...process.env, DISCORD_COPILOT_SDK_INSTANCE_ID: instance },
  });
}

async function restoreState(state) {
  for (const entry of state.instances) {
    const startedByResidency = restoreResidency(entry.instance, entry.residency, entry.wasRunning);
    if (entry.wasRunning && !startedByResidency) startInstance(entry.instance);
  }
  const expected = state.instances.filter((entry) => entry.wasRunning).map((entry) => entry.instance);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const live = new Set(liveInstances().map((entry) => entry.instance));
    if (expected.every((instance) => live.has(instance))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (expected.length) throw new UpdateError("update succeeded but the prior bot process did not restart; inspect the bot log before retrying");
}

function applySource(kind) {
  if (kind === "managed") {
    runInherited("git", ["checkout", "-q", "--detach", "FETCH_HEAD"]);
    return;
  }
  if (kind === "branch-clean") {
    runInherited("git", ["merge", "--ff-only", "FETCH_HEAD"]);
    return;
  }
  throw new UpdateError(`unsafe checkout kind: ${kind}`);
}

function runSetup() {
  runInherited(process.execPath, [path.join(REPO_ROOT, "scripts", "setup.mjs"), "--yes", "--skip-auth", "--no-residency", "--lang", lang]);
}

function readSavedStates() {
  if (!fs.existsSync(STATE_DIR)) return [];
  const states = [];
  for (const file of fs.readdirSync(STATE_DIR)) {
    const match = /^update-state\.([A-Za-z0-9._-]{1,64})\.json$/.exec(file);
    if (!match) continue;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, file), "utf8"));
      if (Array.isArray(state?.instances)) states.push({ file: path.join(STATE_DIR, file), state });
    } catch (error) {
      throw new UpdateError(`cannot read saved update state ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return states;
}

async function restoreSaved() {
  const saved = readSavedStates();
  if (!saved.length) throw new UpdateError("no saved failed-update state exists");
  for (const { file, state } of saved) {
    await restoreState(state);
    fs.rmSync(file, { force: true });
  }
  say("已還原更新前的執行狀態。", "Restored the pre-update running state.");
}

async function main() {
  if (flags.error) throw new UpdateError(`invalid arguments: ${flags.error}`);
  if (flags.restore) {
    await restoreSaved();
    return;
  }

  ensureRepo();
  ensurePrerequisites();
  const ref = flags.ref ?? process.env.DISCORD_COPILOT_SDK_REF ?? "main";
  const remote = remoteFor(ref);
  const local = localSha();
  const checkout = checkoutFacts();
  const instance = currentInstance();
  const live = liveInstances();
  const otherLive = live.filter((entry) => entry.instance !== instance);
  if (otherLive.length && !flags.allInstances) {
    throw new UpdateError(`other instance(s) are running: ${otherLive.map((entry) => entry.instance).join(", ")}; re-run with --all-instances`);
  }

  const decision = planUpdate({
    checkout: checkout.kind,
    localSha: local,
    remoteSha: remote?.sha ?? null,
    runningInstances: live.map((entry) => entry.instance),
    allInstances: flags.allInstances,
    mode: flags.check ? "check" : flags.dryRun ? "dry-run" : undefined,
  });
  if (decision.action === "refuse") throw new UpdateError(`preflight refused: ${decision.reason}`);
  if (decision.action === "up-to-date") {
    say(`已是最新版本（${local.slice(0, 12)}）。`, `Already up to date (${local.slice(0, 12)}).`);
    return;
  }

  say(
    `目前 ${local.slice(0, 12)}，遠端 ${remote.sha.slice(0, 12)}（${remote.ref}），checkout=${checkout.kind}。`,
    `Local ${local.slice(0, 12)}, remote ${remote.sha.slice(0, 12)} (${remote.ref}), checkout=${checkout.kind}.`
  );
  if (decision.action === "check") {
    process.exitCode = 2; // useful to a monitor: an update exists, no action taken
    return;
  }
  if (decision.action === "dry-run") {
    say(
      "Dry run: would fetch, validate the incoming config, stop residency before every bot, move HEAD, run setup, then restore the prior state.",
      "Dry run: would fetch, validate the incoming config, stop residency before every bot, move HEAD, run setup, then restore the prior state."
    );
    return;
  }

  // Fetch and prove branch ancestry BEFORE downtime. Fetch adds objects but
  // never moves HEAD, so failures here leave the running installation intact.
  fetchResolved(remote, checkout.kind);
  if (checkout.kind === "branch-clean") preflightBranchFastForward();
  if (checkout.kind === "managed") {
    const dangling = countDanglingManagedCommits();
    if (dangling) say(`警告：managed checkout 有 ${dangling} 個即將失去 ref 的 commit。`, `Warning: managed checkout has ${dangling} commit(s) about to lose their ref.`);
  }
  await precheckIncomingConfig();
  await confirmActiveThreads(activeThreadSummary());

  const targetIds = [...new Set([instance, ...(flags.allInstances ? live.map((entry) => entry.instance) : [])])];
  const state = {
    version: 1,
    repoRoot: REPO_ROOT,
    oldSha: local,
    requestedRef: ref,
    createdAt: new Date().toISOString(),
    instances: targetIds.map((id) => ({
      instance: id,
      wasRunning: live.some((entry) => entry.instance === id),
      residency: residencyState(id),
    })),
  };

  const releaseLock = acquireUpdateLock(instance);
  writeState(instance, state);
  let setupSucceeded = false;
  try {
    // `stop-bot` is the identity-aware lifecycle path. Do not duplicate its PID
    // trust checks here; verify afterward because its user-facing scripts return
    // success when they decline to stop a stale/reused PID.
    for (const id of targetIds) stopInstance(id);
    await verifyStopped(live.filter((entry) => targetIds.includes(entry.instance)));
    applySource(checkout.kind);
    runSetup();
    setupSucceeded = true;
    if (flags.noRestart) {
      say("更新成功；依 --no-restart 保持停止，保留 restore state。", "Update succeeded; --no-restart leaves it stopped and retains restore state.");
      return;
    }
    await restoreState(state);
    fs.rmSync(statePath(instance), { force: true });
    const now = localSha();
    say(`更新完成：${local.slice(0, 12)} -> ${now.slice(0, 12)}。`, `Update complete: ${local.slice(0, 12)} -> ${now.slice(0, 12)}.`);
  } finally {
    releaseLock();
    if (!setupSucceeded) {
      say(
        `更新未完成；bot 保持停止，沒有自動還原。修正原因後執行 node scripts/update.mjs --restore。`,
        `Update did not complete; the bot remains stopped and was not restored automatically. Fix the cause, then run node scripts/update.mjs --restore.`
      );
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
