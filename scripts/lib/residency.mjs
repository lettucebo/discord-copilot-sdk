// 24/7 residency setup (opt-in). Honest scope: this configures AUTO-START +
// KEEPALIVE WHILE THE USER IS LOGGED IN (Windows Scheduled Task at-logon /
// macOS LaunchAgent / Linux systemd --user). True pre-login unattended startup
// needs extra steps (documented). Node built-ins only.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { t } from "./i18n.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Logical instance id → safe resource name, consistent across task/unit/logs. */
export function instanceId() {
  const raw = (process.env.DISCORD_COPILOT_SDK_INSTANCE_ID ?? "default").trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : "default";
}

export function residencyName() {
  return `discord-copilot-sdk-${instanceId()}`;
}

/** Directory that holds copilot(.exe) so the resident process can find it (the
 *  Scheduled Task / launchd / systemd env has almost no PATH). */
function copilotDir() {
  const which = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(which, ["copilot"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
    return out ? path.dirname(out) : "";
  } catch {
    return "";
  }
}

function gitDir() {
  const which = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(which, ["git"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
    return out ? path.dirname(out) : "";
  } catch {
    return "";
  }
}

/**
 * Decide which residency to install. Pure, because this is a security decision
 * and "did we accidentally escalate to storing a password?" must be answerable
 * by a test rather than by reading the installer.
 *
 * Returns:
 *  - `"logon"`       — auto-start + keepalive while logged in
 *  - `"always"`      — true 24/7, needs the user's password (Windows only)
 *  - `"always-free"` — true 24/7 with no password (Linux linger)
 *
 * Rules that must never break:
 *  - a password can only be asked for on a real interactive TTY, so anything
 *    non-interactive falls back to `logon` instead of prompting, or reading a
 *    secret from a flag/env where it would land in shell history
 *  - macOS can never be `always`: a LaunchAgent is login-bound and a LaunchDaemon
 *    runs as root, which would run the agent's shell commands as root
 */
export function chooseResidencyMode({ requested, platform, interactive, hasTty }) {
  if (!requested) return "logon";
  if (platform === "darwin") return "logon";
  if (platform !== "win32") return "always-free"; // Linux: linger needs no password
  if (!interactive || !hasTty) return "logon";
  return "always";
}

/**
 * `opts.mode`:
 *  - `"logon"`  (default) — auto-start + keepalive WHILE LOGGED IN. Stops at logout.
 *  - `"always"` — true 24/7: starts at boot, before and without any login.
 *
 * 24/7 is Windows- and Linux-only. On macOS a LaunchAgent is login-bound and a
 * LaunchDaemon runs as root; running the agent as root would mean arbitrary
 * shell commands execute as root, which is worse than not having 24/7 — so
 * macOS is reported as login-keepalive rather than quietly sold as 24/7.
 */
export async function setupResidency(lang, opts = {}) {
  if (process.platform === "win32") return setupWindows(lang, opts);
  if (process.platform === "darwin") return setupMac(lang, opts);
  if (process.platform === "linux") return setupLinux(lang, opts);
  return;
}

// ---- Windows: Scheduled Task (at-logon keepalive, no admin) ----------------
/**
 * Build the PowerShell that registers the Windows Scheduled Task. Pure: options
 * in, script text out, so tests can assert the things an integration test would
 * not catch cheaply — above all that the password never appears in it.
 *
 * `mode`:
 *  - `"logon"`  — starts at logon, keepalive WHILE LOGGED IN. Stops at logout.
 *  - `"always"` — starts at boot, before and without any login. Requires the
 *    task to carry the user's credentials — not because Copilot cannot
 *    authenticate headlessly (the SDK exposes `gitHubToken`; this app chooses
 *    `useLoggedInUser: true`), but because the agent edits files in the
 *    controlled repo and its worktrees AS THIS USER. Running as a user with
 *    nobody logged in is what Windows charges a stored password for.
 *
 * The password is NEVER passed to this function — it is read at runtime from the
 * CHILD PROCESS ENVIRONMENT (`pwEnvVar`). That is the point: `schtasks /RP` and
 * `powershell -Command "...$pw..."` both place the secret in argv, which any
 * process on the machine can read through `Win32_Process.CommandLine`. A builder
 * that cannot see the password cannot leak it into the script.
 */
export function buildWindowsRegisterScript({ name, psExe, wrapper, wrapperLeaf, mode, user = "", pwEnvVar }) {
  const q = (s) => String(s).replace(/'/g, "''");
  const always = mode === "always";
  const lines = [
    "$ErrorActionPreference='Stop'",
    `$name='${q(name)}'`,
    `$action=New-ScheduledTaskAction -Execute '${q(psExe)}' -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${q(wrapper)}"'`,
    always
      ? "$trigger=@((New-ScheduledTaskTrigger -AtStartup),(New-ScheduledTaskTrigger -AtLogOn))"
      : "$trigger=New-ScheduledTaskTrigger -AtLogOn",
    "$settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew",
    // Verify an existing task, if any, belongs to THIS discord-copilot-sdk instance before replacing it.
    "$existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue",
    `if($existing -and ($existing.Actions.Arguments -notlike '*${q(wrapperLeaf)}*')){ throw "A Scheduled Task named $name exists but is not discord-copilot-sdk's; refusing to replace it." }`,
  ];
  if (always) {
    lines.push(
      `$pw=$env:${pwEnvVar}`,
      "if(-not $pw){ throw 'no password supplied for 24/7 residency' }",
      `Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -User '${q(user)}' -Password $pw -RunLevel Limited -Force | Out-Null`,
      // Do not leave it in this process's environment any longer than needed.
      `Remove-Item Env:\\${pwEnvVar} -ErrorAction SilentlyContinue`,
      "$pw=$null"
    );
  } else {
    lines.push("Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null");
  }
  lines.push("Start-ScheduledTask -TaskName $name", "Write-Output 'registered'");
  return lines.join("\n");
}

function setupWindows(lang, opts = {}) {
  const mode = opts.mode === "always" ? "always" : "logon";
  const name = residencyName();
  const node = process.execPath;
  const cop = copilotDir();
  const git = gitDir();
  const logDir = path.join(os.homedir(), ".discord-copilot-sdk", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${name}.log`);
  // Escape a value for embedding inside a PowerShell single-quoted string
  // (double any single quote) — prevents breakage/injection from paths that
  // contain an apostrophe (e.g. C:\Users\O'Brien\...).
  const q = (s) => String(s).replace(/'/g, "''");

  // A PER-INSTANCE wrapper fixes PATH + HOME so copilot.exe resolves, then runs
  // the bot. Per-instance so multiple DISCORD_COPILOT_SDK_INSTANCE_ID deployments don't
  // share one file.
  const wrapper = path.join(REPO_ROOT, "scripts", `run-bot.${instanceId()}.ps1`);
  const wrapperBody = [
    "# Auto-generated by discord-copilot-sdk setup — starts the bot with a fixed environment.",
    "$ErrorActionPreference = 'Stop'",
    // Prepend the copilot + git dirs so copilot.exe resolves under the minimal
    // Scheduled-Task environment.
    `$env:PATH = '${q(cop)};${q(git)};' + $env:PATH`,
    "$env:HOME = $env:USERPROFILE",
    `$env:DISCORD_COPILOT_SDK_INSTANCE_ID = '${q(instanceId())}'`,
    `Set-Location -LiteralPath '${q(REPO_ROOT)}'`,
    `& '${q(node)}' dist/index.js *>> '${q(logFile)}'`,
  ].join("\r\n");
  fs.writeFileSync(wrapper, wrapperBody + "\r\n", "utf8");

  const psExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const wrapperLeaf = path.basename(wrapper);
  const PW_ENV = "DCS_RESIDENCY_PW";
  const register = buildWindowsRegisterScript({
    name,
    psExe,
    wrapper,
    wrapperLeaf,
    mode,
    user: opts.user ?? "",
    pwEnvVar: PW_ENV,
  });

  // The script goes over STDIN and the password over the child ENVIRONMENT, so
  // neither ever lands in a command line that other processes can read.
  const childEnv = { ...process.env };
  if (mode === "always") childEnv[PW_ENV] = opts.password ?? "";
  execFileSync(psExe, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
    input: register,
    env: childEnv,
    stdio: ["pipe", "inherit", "inherit"],
  });
  console.log((mode === "always" ? t("residencyWin247", lang) : t("residencyWin", lang)) + name);
  console.log(
    lang === "zh"
      ? `  停止：schtasks /End /TN ${name}  ；移除：schtasks /Delete /TN ${name} /F  ；記錄：${logFile}`
      : `  Stop: schtasks /End /TN ${name}  ; Remove: schtasks /Delete /TN ${name} /F  ; Log: ${logFile}`
  );
}

// ---- macOS: LaunchAgent (login-only; experimental, unverified on real HW) ----
function setupMac(lang) {
  // `opts.mode` is deliberately ignored: see setupResidency's note. A LaunchAgent
  // is login-bound and a LaunchDaemon runs as root, so neither can hold the
  // user's Copilot login before login. The caller reports login-keepalive.
  const name = residencyName();
  const label = `com.discord-copilot-sdk.${instanceId()}`;
  const node = process.execPath;
  const cop = copilotDir();
  const logDir = path.join(os.homedir(), ".discord-copilot-sdk", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key><array><string>${esc(node)}</string><string>dist/index.js</string></array>
  <key>WorkingDirectory</key><string>${esc(REPO_ROOT)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>${esc(os.homedir())}</string>
    <key>PATH</key><string>${esc([cop, "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":"))}</string>
    <key>DISCORD_COPILOT_SDK_INSTANCE_ID</key><string>${esc(instanceId())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(path.join(logDir, name + ".log"))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logDir, name + ".log"))}</string>
</dict></plist>
`;
  fs.writeFileSync(plistPath, plist, "utf8");
  try {
    execFileSync("plutil", ["-lint", plistPath], { stdio: "ignore" });
    const uid = String(process.getuid ? process.getuid() : "");
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}`, plistPath], { stdio: "ignore" });
    } catch {
      /* not loaded */
    }
    execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { stdio: "inherit" });
    console.log(t("residencyMac", lang) + plistPath); // only on success
  } catch (e) {
    console.log(
      (lang === "zh"
        ? "⚠️ launchd 載入未完成（實驗性）。已產生 plist："
        : "⚠️ launchd load incomplete (experimental). plist generated: ") +
        plistPath +
        " — " +
        (e && e.message)
    );
  }
}

// ---- Linux: systemd --user (login keepalive; pre-login needs linger) --------
function setupLinux(lang, opts = {}) {
  const name = residencyName();
  const node = process.execPath;
  const cop = copilotDir();
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  fs.mkdirSync(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, `${name}.service`);
  const unit = `[Unit]
Description=discord-copilot-sdk (${name})
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO_ROOT}
Environment=HOME=${os.homedir()}
Environment=PATH=${[cop, "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":")}
Environment=DISCORD_COPILOT_SDK_INSTANCE_ID=${instanceId()}
ExecStart=${node} dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitPath, unit, "utf8");
  let enabled = false;
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    execFileSync("systemctl", ["--user", "enable", "--now", `${name}.service`], { stdio: "inherit" });
    enabled = true;
  } catch (e) {
    console.log((lang === "zh" ? "⚠️ systemd 啟用未完成（實驗性）。已產生 unit：" : "⚠️ systemd enable incomplete (experimental). unit generated: ") + unitPath + " — " + (e && e.message));
  }
  if (enabled) console.log(t("residencyLinux", lang) + unitPath); // only on success
  if (opts.mode === "always") {
    // systemd --user stops at logout unless the account lingers. This is the one
    // non-Windows platform where real pre-login residency is reachable without
    // breaking Copilot auth, because the unit still runs as this user.
    let lingering = false;
    try {
      execFileSync("loginctl", ["enable-linger", os.userInfo().username], { stdio: "inherit" });
      lingering = true;
    } catch (e) {
      console.log(
        (lang === "zh" ? "⚠️ 無法啟用 linger（24/7 需要它），請手動執行：" : "⚠️ Could not enable linger (24/7 needs it); run manually: ") +
          `loginctl enable-linger ${os.userInfo().username}` +
          " — " +
          (e && e.message)
      );
    }
    console.log(
      lingering
        ? lang === "zh"
          ? "  ✅ 已啟用 linger：登出後仍會執行，開機即啟動。"
          : "  ✅ Linger enabled: keeps running after logout and starts at boot."
        : lang === "zh"
          ? "  ⚠️ 目前仍只是「登入後保活」。"
          : "  ⚠️ Still login-keepalive only for now."
    );
    return;
  }
  console.log(
    lang === "zh"
      ? "  提示：登入前也要常駐請執行 `loginctl enable-linger $USER`（可能需權限）。"
      : "  Note: for pre-login residency run `loginctl enable-linger $USER` (may need privileges)."
  );
}
