#!/usr/bin/env node
// discord-copilot-sdk installer core — the ONE config engine (bilingual zh-TW / English).
// Node built-ins ONLY (runs before `npm install`). Invoked by install.ps1 /
// install.sh, or directly: `node scripts/setup.mjs [--lang zh|en] [--yes]
// [--no-residency|--residency] [--dry-run] [--skip-auth]`.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { parseEnv } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, execSync } from "node:child_process";
import { mergeEnv, dropEnvKeys } from "./lib/env-file.mjs";
import { secureWrite, secureBackup, hardenExisting } from "./lib/secure-file.mjs";
import { nodeVersionOk, reposRootProblem, livePidFromLock, reportLogInfo } from "./lib/setup-core.mjs";
import { UNKNOWN, formatMessage, t, detectLang, normalizeLang } from "./lib/i18n.mjs";
import { formatSection, formatStage, formatKeyValue, formatSummary } from "./lib/ui.mjs";
import { parsePackageVersion } from "./lib/update-core.mjs";
import { MANAGED_KEYS, validateConfig, REMOVED_KEYS } from "./lib/validate.mjs";
import { setupResidency, residencyName, chooseResidencyMode, hasResidencyRegistration, instanceId } from "./lib/residency.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const ENV_PATH = path.join(REPO_ROOT, ".env");
const EXAMPLE_PATH = path.join(REPO_ROOT, ".env.example");
const STATE_DIR = path.join(os.homedir(), ".discord-copilot-sdk");

// ---- flags ---------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flagVal = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const FLAGS = {
  yes: has("--yes") || has("-y"),
  dryRun: has("--dry-run"),
  skipAuth: has("--skip-auth"),
  residency: has("--residency") ? true : has("--no-residency") ? false : undefined,
  // Separate from --residency on purpose: asking for 24/7 implies wanting
  // residency, but wanting residency must never imply consenting to a stored
  // password.
  residency247: has("--residency-24x7") ? true : undefined,
  lang: normalizeLang(flagVal("--lang")),
};
const interactive = process.stdin.isTTY && process.stdout.isTTY && !FLAGS.yes;
const TOTAL_STAGES = 5;

// ---- tiny UI -------------------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const info = (s) => process.stdout.write(s + "\n");
const ok = (s) => info(c(32, "✓ ") + s);
const warn = (s) => info(c(33, "! ") + s);
const err = (s) => process.stderr.write(c(31, "✗ ") + s + "\n");

class SetupError extends Error {}

// ---- language state machine (requirement: locale default, user-selectable) --
async function resolveLanguage() {
  if (FLAGS.lang) return FLAGS.lang; // explicit override wins, no prompt
  const detected = detectLang(process.env);
  if (!interactive) return detected; // --yes / non-TTY: locale default
  // First user-facing output MUST be the bilingual chooser (before any other text).
  const def = detected; // dynamic default marker
  const line = `${t("langPrompt", detected)}  (${def === "zh" ? "1" : "2"} = default)`;
  for (;;) {
    const ans = (await ask(line + " ", "")).trim();
    if (ans === "") return def;
    if (ans === "1") return "zh";
    if (ans === "2") return "en";
    info(t("langPrompt", detected)); // invalid → re-show bilingual prompt
  }
}

// ---- prompts -------------------------------------------------------------
function ask(question, def) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const suffix = def ? ` [${def}]` : "";
    rl.question(question + suffix + (question.endsWith(" ") ? "" : ": "), (a) => {
      rl.close();
      resolve(a.length ? a : def ?? "");
    });
  });
}

/** Hidden (no-echo) input for secrets. Requires a real TTY; NEVER falls back to
 *  visible input. Buffers raw bytes and decodes once (so a multi-byte char split
 *  across stream chunks can't corrupt input), and restores terminal mode on every
 *  exit path (resolve, reject, or a handler throw). */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new SetupError("no TTY for hidden input"));
    stdout.write(question + ": ");
    const bytes = [];
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      try {
        stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
      stdin.pause();
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onErr);
      stdin.removeListener("end", onEnd);
      fn(arg);
    };
    const onErr = (e) => finish(reject, e instanceof Error ? e : new SetupError(String(e)));
    const onEnd = () => finish(reject, new SetupError("input stream closed before a value was entered"));
    const onData = (chunk) => {
      try {
        for (const b of chunk) {
          if (b === 0x0d || b === 0x0a) {
            stdout.write("\n");
            return finish(resolve, Buffer.from(bytes).toString("utf8"));
          }
          if (b === 0x03) {
            stdout.write("\n");
            return finish(reject, new SetupError("cancelled"));
          }
          if (b === 0x7f || b === 0x08) bytes.pop();
          else if (b >= 0x20) bytes.push(b);
        }
      } catch (e) {
        finish(reject, e instanceof Error ? e : new SetupError(String(e)));
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    stdin.on("error", onErr);
    stdin.on("end", onEnd);
  });
}

// ---- prereqs (read-only detection; installing is install.ps1/.sh's job) ----
function onPath(exe) {
  const which = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(which, [exe], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function probeVersion(exe) {
  try {
    const output = execFileSync(exe, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000,
      windowsHide: true,
    });
    return String(output)
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

/** Copilot auth state. The CLI has no non-interactive status probe, so we cannot
 *  positively CONFIRM a login from files (e.g. config.json / mcp-config.json exist
 *  before `/login`). We therefore NEVER claim "verified": we only distinguish
 *  "unauthenticated" (copilot present but ~/.copilot absent → never ran it) from
 *  "indeterminate" (configured, but login can't be confirmed here). */
function copilotAuthState() {
  if (!onPath("copilot")) return "indeterminate";
  try {
    return fs.existsSync(path.join(os.homedir(), ".copilot")) ? "indeterminate" : "unauthenticated";
  } catch {
    return "indeterminate";
  }
}

// ---- secure .env write ---------------------------------------------------
// The atomic/fail-closed mechanics live in ./lib/secure-file.mjs (unit-tested);
// here we wire in the real Windows ACL step and messages.
function backupEnv(lang) {
  if (!fs.existsSync(ENV_PATH)) return undefined;
  const dir = path.join(STATE_DIR, "env-backups");
  const dest = path.join(dir, `.env.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`);
  secureBackup(ENV_PATH, dest, {
    applyAcl: process.platform === "win32" ? applyWindowsAcl : undefined,
    onAclFail: (m) => new SetupError("could not secure the .env backup; aborting: " + m),
  });
  info(t("backedUp", lang) + " " + dest);
  return dest;
}

function writeEnv(targetPath, contents) {
  secureWrite(targetPath, contents, {
    applyAcl: process.platform === "win32" ? applyWindowsAcl : undefined,
    onAclFail: (m) =>
      new SetupError("could not apply a Windows ACL to the .env temp file; aborting to avoid an unprotected secret: " + m),
  });
}

function hardenEnv(file) {
  const onWin = process.platform === "win32";
  const ok = hardenExisting(file, {
    applyAcl: onWin ? applyWindowsAcl : undefined,
    onAclFail: (m) => warn("could not harden the existing .env ACL (left in place): " + m),
  });
  if (!ok && !onWin) warn("could not chmod the existing .env to 0600 (left in place).");
}

/** Apply an owner-only DACL to `file` (remove inheritance, drop broad principals,
 *  grant only the current user). Throws on failure WITH the icacls reason (so the
 *  caller's warning is diagnosable); NEVER deletes the file. */
function applyWindowsAcl(file) {
  const user = process.env.USERNAME
    ? `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME}`
    : os.userInfo().username;
  try {
    execFileSync(
      "icacls",
      [
        file,
        "/inheritance:r",
        "/remove:g",
        "*S-1-1-0", // Everyone
        "*S-1-5-32-545", // Users
        "*S-1-5-11", // Authenticated Users
        "/grant:r",
        `${user}:(F)`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] } // capture stderr for the failure reason
    );
  } catch (e) {
    const reason = e?.stderr?.toString().trim() || (e instanceof Error ? e.message : String(e));
    throw new Error("icacls failed: " + reason);
  }
}

function ensureEnvNotTracked() {
  if (!onPath("git")) return;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", ".env"], { cwd: REPO_ROOT, stdio: "ignore" });
    throw new SetupError(".env is tracked by git — refusing to write secrets into a tracked file. Add it to .gitignore and `git rm --cached .env` first.");
  } catch (e) {
    if (e instanceof SetupError) throw e; // tracked
    /* non-zero exit = not tracked = good */
  }
}

function sanitizedChildEnv() {
  const e = { ...process.env };
  delete e.DISCORD_BOT_TOKEN; // never expose the secret to npm/build children
  return e;
}

// ---- main ----------------------------------------------------------------
/**
 * Decide login-keepalive vs true 24/7, and collect the credentials 24/7 needs.
 *
 * Two rules this must never break:
 *  - **Non-interactive never escalates.** A password cannot be asked for safely
 *    without a TTY (`askHidden` refuses to fall back), so `--yes` gets
 *    login-keepalive even if 24/7 was requested — never a silent prompt, never a
 *    password from a flag or the environment where it would land in shell
 *    history or a process listing.
 *  - **macOS never claims 24/7.** A LaunchAgent is login-bound and a LaunchDaemon
 *    runs as root, which leaves Copilot unauthenticated.
 */
async function residencyMode(lang, interactive) {
  const requested = FLAGS.residency247 ?? (interactive ? /^y/i.test(await ask(t("residency247Prompt", lang) + " ", "")) : false);
  const decided = chooseResidencyMode({
    requested,
    platform: process.platform,
    interactive,
    hasTty: !!process.stdin.isTTY,
  });
  if (decided === "logon") {
    // Say WHY, when 24/7 was asked for and refused.
    if (requested && process.platform === "darwin") warn(t("residency247Mac", lang));
    else if (requested) warn(t("residency247NoTty", lang));
    return { mode: "logon" };
  }
  if (decided === "always-free") return { mode: "always" }; // Linux: linger, no password
  const me = `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`.replace(/^\\/, "");
  const user = (await ask(`${t("residency247User", lang)}${me}): `, me)) || me;
  const password = await askHidden(t("residency247Pw", lang));
  if (!password) {
    warn(t("residency247NoPw", lang));
    return { mode: "logon" };
  }
  return { mode: "always", user, password };
}

async function main() {
  const lang = await resolveLanguage();
  if (interactive) ok(t("langChosen", lang));
  const installedVersion = packageVersion();
  info(c(36, "== " + bannerTitle(lang, installedVersion) + " =="));
  warn(t("labWarning", lang));
  if (FLAGS.dryRun) info(c(90, t("dryNote", lang)));
  printInstallPlan(lang, installedVersion);

  // Repo-root guard (verified via import.meta location AND package.json name).
  const pkg = readJson(path.join(REPO_ROOT, "package.json"));
  if (!pkg || pkg.name !== "discord-copilot-sdk") throw new SetupError(t("notInRepo", lang));

  // 1) Read-only prerequisite detection.
  printStage(lang, 1, "stagePrereqs");
  const missing = [];
  const nodeOk = nodeVersionOk();
  const gitOnPath = onPath("git");
  const copilotOnPath = onPath("copilot");
  if (!gitOnPath) missing.push("git");
  if (!copilotOnPath) missing.push("copilot");
  const authState = FLAGS.skipAuth ? "skipped" : copilotAuthState();
  info(formatKeyValue(t("prereqNodeLabel", lang), process.versions.node));
  info(formatKeyValue(t("prereqGitLabel", lang), gitOnPath ? probeVersion("git") || t("prereqPresentPath", lang) : t("prereqMissingValue", lang)));
  info(
    formatKeyValue(
      t("prereqCopilotLabel", lang),
      copilotOnPath ? probeVersion("copilot") || t("prereqPresentPath", lang) : t("prereqMissingValue", lang)
    )
  );
  info(formatKeyValue(t("prereqAuthLabel", lang), authStateLabel(authState, lang)));
  if (!nodeOk) throw new SetupError(t("prereqNodeOld", lang) + process.versions.node);
  if (missing.length) {
    warn(t("prereqMissing", lang) + missing.join(", "));
    info(t("prereqInstallHint", lang));
    if (!interactive) throw new SetupError(t("prereqMissing", lang) + missing.join(", "));
  } else {
    ok(t("prereqOk", lang));
  }

  // 2) Auth: never a false "ok". Only a definite "unauthenticated" (copilot on
  //    PATH but ~/.copilot absent) fails a non-interactive run; "indeterminate"
  //    just warns (we can't confirm a login from here).
  if (FLAGS.skipAuth) {
    warn(t("authSkip", lang));
  } else {
    warn(t("authUnknown", lang) + ` (${authState})`);
    if (!interactive && authState === "unauthenticated") throw new SetupError(t("authUnknown", lang));
  }

  // 3) Load existing .env as defaults (read-only) and collect config in memory.
  printStage(lang, 2, "stageConfig");
  info(t("configHeader", lang));
  const existing = readEnvValues();
  // 3a) Migrate a pre-multi-repo .env BEFORE prompting, so the operator is shown
  //     the derived values and can correct them, rather than being asked to
  //     retype a root the old value already implies.
  //     CONTROLLED_REPO_PATH=C:\Source\Repos\my-repo
  //       → REPOS_ROOT=C:\Source\Repos, DEFAULT_REPO=my-repo
  const migrated = migrateLegacyKeys(existing);
  if (migrated) info(c(90, t("migratedKeys", lang) + migrated));
  const values = {};
  for (const spec of MANAGED_KEYS) {
    const cur = existing[spec.key] ?? spec.defaultValue ?? "";
    if (!interactive) {
      values[spec.key] = cur;
      continue;
    }
    if (spec.key === "REPOS_ROOT") warn(t("repoLabWarn", lang));
    values[spec.key] = await promptField(spec, cur, lang);
  }

  // 4) Validate everything BEFORE any mutation (fail-closed).
  const { ok: valid, errors } = validateConfig(values);
  if (!valid) {
    const missingRequired = errors.map((e) => e.key).join(", ");
    if (!interactive) throw new SetupError(t("missingRequiredNonInteractive", lang) + missingRequired);
    for (const e of errors) err(`${e.key}: ${t(e.errKey, lang)}`);
    throw new SetupError(t("missingRequiredNonInteractive", lang) + missingRequired);
  }

  // 4b) REPOS_ROOT shape check, run UNCONDITIONALLY (interactive AND --yes),
  // unlike promptField's copy which only runs when a human is typing. A --yes
  // install reuses the EXISTING .env value without prompting, so without this a
  // long-broken path sails straight through to "complete".
  //
  // This is a FAST PRE-FLIGHT, not the source of truth: step 8b below calls the
  // runtime's own resolveReposRoot() once dist/ exists. Running here too means a
  // bad path fails in seconds instead of after minutes of npm ci + build.
  // Deliberately NOT folded into validateConfig()/MANAGED_KEYS: that is the
  // config CONTRACT with the runtime zod schema (test/config-contract.test.ts
  // asserts they accept/reject identically), and parseConfig() does no
  // filesystem I/O by design.
  {
    const repoErr = checkReposRootShape(values.REPOS_ROOT, lang);
    if (repoErr) throw new SetupError(repoErr);
  }

  // 5) Compute the merged .env in memory. Removed keys are DELETED from the base
  //    text first: mergeEnv preserves every unmanaged line, so a leftover
  //    CONTROLLED_REPO_PATH would survive and the bot would refuse to start on
  //    the config this installer just reported as complete.
  const exampleText = fs.existsSync(EXAMPLE_PATH) ? fs.readFileSync(EXAMPLE_PATH, "utf8") : "";
  const baseText = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : exampleText;
  const merged = mergeEnv(dropEnvKeys(baseText, REMOVED_KEYS), values);

  const dryRunResidencyInstalled = hasResidencyRegistration() || FLAGS.residency === true || FLAGS.residency247 === true;

  // 6) Dry-run stops here — nothing mutated. Never print the token.
  if (FLAGS.dryRun) {
    info(c(90, previewMasked(values, lang)));
    info(c(90, t("residencyDry", lang) + residencyName()));
    report(lang, installedVersion, { dryRun: true, residencyInstalled: dryRunResidencyInstalled });
    return;
  }

  // 6b) Refuse to reinstall over a RUNNING bot. npm replaces files inside
  //     node_modules that the live process holds open — on Windows that is a
  //     hard EPERM ("operation not permitted, unlink ...copilot-win32-x64/
  //     prebuilds/win32-x64/runtime.node"), which reads like a permissions or
  //     antivirus problem and says nothing about the actual cause. Re-running
  //     the installer to FIX a bad config is exactly when the bot is most
  //     likely to be running, so this is the common path, not an edge case.
  //     Checked here, after all validation but before the first mutation, so a
  //     refusal still changes nothing.
  {
    const running = runningInstancePid();
    if (running !== undefined) {
      throw new SetupError(t("errBotRunning", lang) + running);
    }
  }

  // 7) Guard, then BUILD FIRST — on a FRESH install no .env exists yet, so npm
  //    lifecycle scripts can't read a token from disk. (On a re-run the previous
  //    .env is still present during npm; the token is the user's own on their own
  //    machine, so this is acceptable for a single-owner lab.)
  ensureEnvNotTracked();
  printStage(lang, 3, "stageBuild");
  info(t("buildHeader", lang));
  // `npm ci` REQUIRES a lockfile and fails hard without one, and this project
  // deliberately ships no lockfile (see .gitignore: one generated behind a
  // corporate proxy pins internal hosts and carries integrity hashes public
  // `npm ci` cannot verify). Use `ci` when the user has generated their own —
  // it is faster and reproducible — and fall back to `install` otherwise.
  const hasLock = fs.existsSync(path.join(REPO_ROOT, "package-lock.json"));
  run("npm", hasLock ? ["ci"] : ["install", "--no-audit", "--no-fund"], sanitizedChildEnv());
  run("npm", ["run", "build"], sanitizedChildEnv());

  // 8) Validate the MERGED config through the REAL runtime schema (in memory —
  //    no .env file, no ambient env, no token in this process's env). This is the
  //    same parser+schema the bot uses (parseEnv → parseConfig), so a config the
  //    runtime would reject fails the install BEFORE we write anything.
  printStage(lang, 4, "stageValidateWrite");
  const { parseConfig } = await import(pathToFileURL(path.join(REPO_ROOT, "dist", "config.js")).href);
  let parsed;
  try {
    parsed = parseConfig(parseEnv(merged));
  } catch (e) {
    throw new SetupError(t("healthFail", lang) + " " + (e instanceof Error ? e.message : String(e)));
  }

  // 8b) AUTHORITATIVE repos-root check: call the very function the bot calls at
  //     startup (app.ts → resolveReposRoot), not a copy of its rules.
  //     parseConfig deliberately does no filesystem I/O, so the zod schema alone
  //     cannot catch a path that exists but is the wrong KIND of directory —
  //     which is exactly how an install once reported success while the bot died
  //     on its first launch. checkReposRootShape() above fails faster (before
  //     minutes of npm ci/build) but is a mirror of these rules; THIS is the one
  //     that cannot drift, because it is the same code. Run only after build,
  //     since it lives in dist/.
  const { resolveReposRoot } = await import(pathToFileURL(path.join(REPO_ROOT, "dist", "core", "repo.js")).href);
  try {
    resolveReposRoot(parsed.REPOS_ROOT);
  } catch (e) {
    throw new SetupError(t("healthFail", lang) + " " + (e instanceof Error ? e.message : String(e)));
  }
  ok(t("healthOk", lang));

  // 9) COMMIT: write .env LAST, after all validation + build succeeded. Because
  //    it's the final mutation there is nothing to roll back.
  info("\n" + c(1, t("writingEnv", lang)));
  if (fs.existsSync(ENV_PATH) && fs.readFileSync(ENV_PATH, "utf8") === merged) {
    hardenEnv(ENV_PATH); // ensure an unchanged .env is still owner-only
    info(t("envUnchanged", lang));
  } else {
    backupEnv(lang);
    writeEnv(ENV_PATH, merged);
    ok(t("wroteEnv", lang));
  }

  // 10) Residency (opt-in). Two distinct things, labelled honestly:
  //     login-keepalive (default) vs true 24/7 (needs a stored password).
  printStage(lang, 5, "stageResidency");
  const wantResidency =
    FLAGS.residency ?? FLAGS.residency247 ?? (interactive ? /^y/i.test(await ask(t("residencyPrompt", lang) + " ", "")) : false);
  let residencyInstalled = hasResidencyRegistration();
  if (wantResidency) {
    residencyInstalled = await setupResidency(lang, await residencyMode(lang, interactive));
    residencyInstalled = hasResidencyRegistration() || residencyInstalled;
  } else {
    info(t("residencySkip", lang));
  }

  // 10) Report.
  report(lang, installedVersion, { residencyInstalled });
}

// ---- helpers -------------------------------------------------------------
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

function packageVersion() {
  try {
    return parsePackageVersion(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  } catch {
    return UNKNOWN;
  }
}

function readEnvValues() {
  // Parse the existing .env with Node's own parser so defaults match runtime.
  try {
    if (!fs.existsSync(ENV_PATH)) return {};
    return parseEnv(fs.readFileSync(ENV_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function promptField(spec, cur, lang) {
  const label = t(spec.promptKey, lang);
  for (;;) {
    let val;
    if (spec.secret) {
      // Never echo; if a value already exists, Enter keeps it.
      const shown = cur ? `${label} (${lang === "zh" ? "已設定，Enter 沿用" : "configured, Enter keeps"})` : label;
      const entered = await askHidden(shown);
      val = entered === "" ? cur : entered;
    } else {
      // NOT `label + " "` — that trailing-space trick (used deliberately below
      // for the y/n and multi-choice prompts, to suppress ask()'s automatic
      // ": ") was copy-pasted in here too, which silently ate the colon (and
      // added a stray double space before "[default]") on every ordinary
      // "label: value" field except the hidden-input one (askHidden always
      // appends ": " unconditionally, which is why only the token prompt had
      // a colon).
      val = (await ask(label, cur)).trim();
    }
    if (spec.optional && val === "") return "";
    if (spec.required && val === "") {
      err(t("errRequired", lang));
      continue;
    }
    if (val !== "" && !spec.validate(val)) {
      err(t(spec.errKey, lang));
      continue;
    }
    if (spec.key === "REPOS_ROOT" && val !== "") {
      const repoErr = checkReposRootShape(val, lang);
      if (repoErr) {
        err(repoErr);
        continue;
      }
    }
    return val;
  }
}

/**
 * Rewrite pre-multi-repo keys in-place on the values read from `.env`, so the
 * rest of setup only ever sees the current shape.
 *
 * `CONTROLLED_REPO_PATH=C:\Source\Repos\my-repo` carries both new values: its
 * PARENT is the repos root and its BASENAME is the default repo. Deriving them
 * is what makes an upgrade a no-op for the operator instead of a puzzle. An
 * explicit REPOS_ROOT already in the file always wins — we never overwrite a
 * deliberate choice.
 *
 * Returns a short description of what was migrated, or null.
 */
function migrateLegacyKeys(values) {
  const legacy = values.CONTROLLED_REPO_PATH;
  const notes = [];
  if (legacy && legacy.trim() && !(values.REPOS_ROOT && values.REPOS_ROOT.trim())) {
    const trimmed = legacy.replace(/[\\/]+$/, "");
    const parent = path.dirname(trimmed);
    const name = path.basename(trimmed);
    // `path.dirname` of a bare root ("C:\" or "/") returns the root itself; there
    // is no meaningful repos root to derive there, so leave it to validation.
    if (parent && parent !== trimmed && name) {
      values.REPOS_ROOT = parent;
      if (!values.DEFAULT_REPO) values.DEFAULT_REPO = name;
      notes.push(`CONTROLLED_REPO_PATH → REPOS_ROOT=${parent}, DEFAULT_REPO=${name}`);
    }
  }
  // The old value must not survive into the new config in any form; the removed
  // lines themselves are stripped from the .env text by dropEnvKeys().
  for (const key of REMOVED_KEYS) delete values[key];
  return notes.length ? notes.join("; ") : null;
}

/**
 * Localizing wrapper over reposRootProblem() (scripts/lib/setup-core.mjs,
 * where the rules live and are unit-tested against the real resolveReposRoot).
 * Returns a localized error string, or null when the path is acceptable.
 */
function checkReposRootShape(val, lang) {
  const problem = reposRootProblem(val, fs, path, STATE_DIR);
  if (problem === "notAbsolute") return t("errRepoNotAbsolute", lang) + val;
  if (problem === "missing") return t("errRepoMissing", lang) + val;
  if (problem === "isRepo") return t("errReposRootIsRepo", lang) + val;
  if (problem === "trustOverlap") return t("errReposRootTrustOverlap", lang) + val;
  return null;
}

/**
 * Thin wrapper over livePidFromLock() (scripts/lib/setup-core.mjs, where the
 * logic lives and is unit-tested) resolving this instance's lock path.
 */
function runningInstancePid() {
  return livePidFromLock(path.join(STATE_DIR, `${instanceId()}.lock`), fs, process.kill.bind(process));
}

function previewMasked(values, lang) {
  const lines = MANAGED_KEYS.map((s) => {
    const v = values[s.key] ?? "";
    return formatKeyValue(s.key, `${s.secret ? (v ? "********" : "") : v}`, 24);
  });
  return `${formatSection(t("configPreviewHeader", lang))}\n${lines.join("\n")}`;
}

function run(cmd, args, env) {
  // On Windows npm is npm.cmd and Node refuses to spawn .cmd without a shell
  // (EINVAL, post CVE-2024-27980). Use execSync with a shell there (args are
  // hardcoded, no user input) to avoid the shell+args DEP0190 warning.
  if (process.platform === "win32" && cmd === "npm") {
    execSync(`npm ${args.join(" ")}`, { cwd: REPO_ROOT, stdio: "inherit", env });
  } else {
    execFileSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit", env });
  }
}

function bannerTitle(lang, version) {
  return version === UNKNOWN ? `${t("banner", lang)} (${UNKNOWN})` : `${t("banner", lang)} ${version}`;
}

function boolLabel(value, lang) {
  if (lang === "en") return value ? "Yes" : "No";
  return value ? t("yes", lang) : t("no", lang);
}

function trimLabel(label) {
  return String(label).replace(/[：:]\s*$/u, "");
}

function printSection(title) {
  info(formatSection(c(1, title)));
}

function printStage(lang, current, titleKey) {
  printSection(formatStage(current, TOTAL_STAGES, t(titleKey, lang)));
}

function printInstallPlan(lang, version) {
  const rows = [
    formatKeyValue(t("planPackageVersion", lang), version),
    formatKeyValue(t("planRepositoryRoot", lang), REPO_ROOT),
    formatKeyValue(t("planEnvPath", lang), ENV_PATH),
    formatKeyValue(t("planStateDir", lang), STATE_DIR),
    formatKeyValue(t("planInstanceId", lang), instanceId()),
  ];
  if (FLAGS.dryRun) rows.push(formatKeyValue(t("planDryRun", lang), boolLabel(true, lang)));
  printSection(t("planHeader", lang));
  info(rows.join("\n"));
}

function authStateLabel(state, lang) {
  if (FLAGS.skipAuth) return t("authStateSkipped", lang);
  if (state === "unauthenticated") return t("authStateUnauthenticated", lang);
  return t("authStateIndeterminate", lang);
}

function report(lang, version, options = {}) {
  const shell = process.platform === "win32" ? "ps1" : "sh";
  const manualLogInfo = reportLogInfo(
    {
      platform: process.platform,
      stateDir: STATE_DIR,
      instance: instanceId(),
      residencyInstalled: false,
    },
    path
  );
  const manualLogDetail =
    manualLogInfo.kind === "path" && manualLogInfo.afterFirstStart && !fs.existsSync(manualLogInfo.value)
      ? formatMessage(t("doneLogAfterStart", lang), [manualLogInfo.value])
      : manualLogInfo.value;
  const rows = [
    [trimLabel(t("doneVersion", lang)), version],
    [trimLabel(t("doneStart", lang)), `./run-bot.${shell}`],
    [trimLabel(t("doneStop", lang)), `./stop-bot.${shell}`],
    [trimLabel(t("doneLog", lang)), manualLogDetail],
  ];
  if (options.residencyInstalled) {
    const residencyLogInfo = reportLogInfo(
      {
        platform: process.platform,
        stateDir: STATE_DIR,
        instance: instanceId(),
        residencyInstalled: true,
      },
      path
    );
    rows.push([t("summaryResidencyLogLabel", lang), formatMessage(t("doneLogResidency", lang), [residencyLogInfo.value])]);
  }
  rows.push([trimLabel(t("doneUpdate", lang)), `./update.${shell}`]);
  rows.push([trimLabel(t("doneUninstall", lang)), `./uninstall.${shell}`]);
  rows.push([t("summaryManualLabel", lang), t("doneManual", lang)]);
  rows.push([t("summarySafetyLabel", lang), t("doneSafety", lang)]);
  printSection(t("summaryHeader", lang) + (options.dryRun ? " (dry-run)" : ""));
  info(formatSummary(rows));
}

main().catch((e) => {
  err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
