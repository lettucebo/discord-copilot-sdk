#!/usr/bin/env node
// discopilot installer core — the ONE config engine (bilingual zh-TW / English).
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
import { mergeEnv } from "./lib/env-file.mjs";
import { t, detectLang, normalizeLang } from "./lib/i18n.mjs";
import { MANAGED_KEYS, validateConfig } from "./lib/validate.mjs";
import { setupResidency, residencyName } from "./lib/residency.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const ENV_PATH = path.join(REPO_ROOT, ".env");
const EXAMPLE_PATH = path.join(REPO_ROOT, ".env.example");
const STATE_DIR = path.join(os.homedir(), ".discopilot");

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
  lang: normalizeLang(flagVal("--lang")),
};
const interactive = process.stdin.isTTY && process.stdout.isTTY && !FLAGS.yes;

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
function nodeVersionOk(v = process.versions.node) {
  const [maj, min] = v.split(".").map(Number);
  if (maj === 20) return min >= 19; // ^20.19
  if (maj >= 22) return maj > 22 || min >= 12; // >=22.12
  return false;
}

function onPath(exe) {
  const which = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(which, [exe], { stdio: "ignore" });
    return true;
  } catch {
    return false;
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
function backupEnv(lang) {
  if (!fs.existsSync(ENV_PATH)) return undefined;
  const dir = path.join(STATE_DIR, "env-backups");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, `.env.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`);
  // Create the backup EMPTY, lock its ACL, THEN copy the secret bytes in — so the
  // token never lands in a world-readable backup even briefly. Fail closed: if the
  // ACL can't be applied, remove the (still-empty) backup and abort.
  fs.writeFileSync(dest, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (process.platform === "win32") {
    try {
      applyWindowsAcl(dest);
    } catch (e) {
      try {
        fs.rmSync(dest, { force: true });
      } catch {
        /* ignore */
      }
      throw new SetupError(
        "could not secure the .env backup; aborting: " + (e instanceof Error ? e.message : String(e))
      );
    }
  }
  fs.writeFileSync(dest, fs.readFileSync(ENV_PATH));
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    /* windows */
  }
  info(t("backedUp", lang) + " " + dest);
  return dest;
}

function secureWrite(targetPath, contents) {
  const tmp = targetPath + ".tmp";
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* ignore */
  }
  // Create the temp EMPTY first (exclusive), lock its ACL on Windows, and only
  // THEN write the secret bytes. If the ACL fails, delete THIS temp (it's ours,
  // just created) and abort — never leave an unprotected secret behind.
  fs.writeFileSync(tmp, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (process.platform === "win32") {
    try {
      applyWindowsAcl(tmp);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw new SetupError(
        "could not apply a Windows ACL to the .env temp file; aborting to avoid an unprotected secret: " +
          (e instanceof Error ? e.message : String(e))
      );
    }
  }
  fs.writeFileSync(tmp, contents, { encoding: "utf8" });
  fs.renameSync(tmp, targetPath); // rename preserves the temp's locked DACL
  try {
    fs.chmodSync(targetPath, 0o600);
  } catch {
    /* windows: DACL already applied via the temp */
  }
}

/** Best-effort harden of an EXISTING committed .env (unchanged re-run path).
 *  MUST NOT delete the file on ACL failure — deleting a valid existing .env is
 *  strictly worse than leaving it with imperfect permissions. */
function hardenExisting(file) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
  if (process.platform === "win32") {
    try {
      applyWindowsAcl(file);
    } catch (e) {
      warn("could not harden the existing .env ACL (left in place): " + (e instanceof Error ? e.message : String(e)));
    }
  }
}

/** Apply an owner-only DACL to `file` (remove inheritance, drop broad principals,
 *  grant only the current user). Throws on failure; NEVER deletes the file — the
 *  caller decides whether a failure means "remove my just-created temp" or
 *  "warn and keep the existing file". */
function applyWindowsAcl(file) {
  const user = process.env.USERNAME
    ? `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME}`
    : os.userInfo().username;
  execFileSync(
    "icacls",
    [
      file,
      "/inheritance:r",
      // Drop broad principals that may exist as explicit ACEs on an older file.
      "/remove:g",
      "*S-1-1-0", // Everyone
      "*S-1-5-32-545", // Users
      "*S-1-5-11", // Authenticated Users
      "/grant:r",
      `${user}:(F)`,
    ],
    { stdio: "ignore" }
  );
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
async function main() {
  const lang = await resolveLanguage();
  if (interactive) ok(t("langChosen", lang));
  info(c(36, "== " + t("banner", lang) + " =="));
  warn(t("labWarning", lang));
  if (FLAGS.dryRun) info(c(90, t("dryNote", lang)));

  // Repo-root guard (verified via import.meta location AND package.json name).
  const pkg = readJson(path.join(REPO_ROOT, "package.json"));
  if (!pkg || pkg.name !== "discopilot") throw new SetupError(t("notInRepo", lang));

  // 1) Read-only prerequisite detection.
  info("\n" + c(1, t("prereqHeader", lang)));
  const missing = [];
  if (!nodeVersionOk()) throw new SetupError(t("prereqNodeOld", lang) + process.versions.node);
  for (const exe of ["git", "copilot"]) if (!onPath(exe)) missing.push(exe);
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
  info("\n" + c(1, t("authHeader", lang)));
  if (FLAGS.skipAuth) {
    warn(t("authSkip", lang));
  } else {
    const state = copilotAuthState();
    warn(t("authUnknown", lang) + ` (${state})`);
    if (!interactive && state === "unauthenticated") throw new SetupError(t("authUnknown", lang));
  }

  // 3) Load existing .env as defaults (read-only) and collect config in memory.
  info("\n" + c(1, t("configHeader", lang)));
  const existing = readEnvValues();
  const values = {};
  for (const spec of MANAGED_KEYS) {
    const cur = existing[spec.key] ?? spec.defaultValue ?? "";
    if (!interactive) {
      values[spec.key] = cur;
      continue;
    }
    if (spec.key === "CONTROLLED_REPO_PATH") warn(t("repoLabWarn", lang));
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

  // 5) Compute the merged .env in memory.
  const exampleText = fs.existsSync(EXAMPLE_PATH) ? fs.readFileSync(EXAMPLE_PATH, "utf8") : "";
  const baseText = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : exampleText;
  const merged = mergeEnv(baseText, values);

  // 6) Dry-run stops here — nothing mutated. Never print the token.
  if (FLAGS.dryRun) {
    info("\n" + c(90, previewMasked(values, lang)));
    info(c(90, t("residencyDry", lang) + residencyName()));
    info("\n" + c(32, t("doneHeader", lang)) + " (dry-run)");
    return;
  }

  // 7) Guard, then BUILD FIRST — on a FRESH install no .env exists yet, so npm
  //    lifecycle scripts can't read a token from disk. (On a re-run the previous
  //    .env is still present during npm; the token is the user's own on their own
  //    machine, so this is acceptable for a single-owner lab.)
  ensureEnvNotTracked();
  info("\n" + c(1, t("buildHeader", lang)));
  run("npm", ["ci"], sanitizedChildEnv());
  run("npm", ["run", "build"], sanitizedChildEnv());

  // 8) Validate the MERGED config through the REAL runtime schema (in memory —
  //    no .env file, no ambient env, no token in this process's env). This is the
  //    same parser+schema the bot uses (parseEnv → parseConfig), so a config the
  //    runtime would reject fails the install BEFORE we write anything.
  const { parseConfig } = await import(pathToFileURL(path.join(REPO_ROOT, "dist", "config.js")).href);
  try {
    parseConfig(parseEnv(merged));
  } catch (e) {
    throw new SetupError(t("healthFail", lang) + " " + (e instanceof Error ? e.message : String(e)));
  }
  ok(t("healthOk", lang));

  // 9) COMMIT: write .env LAST, after all validation + build succeeded. Because
  //    it's the final mutation there is nothing to roll back.
  info("\n" + c(1, t("writingEnv", lang)));
  if (fs.existsSync(ENV_PATH) && fs.readFileSync(ENV_PATH, "utf8") === merged) {
    hardenExisting(ENV_PATH); // ensure an unchanged .env is still owner-only
    info(t("envUnchanged", lang));
  } else {
    backupEnv(lang);
    secureWrite(ENV_PATH, merged);
    ok(t("wroteEnv", lang));
  }

  // 10) Residency (opt-in; honest login-keepalive labeling).
  const wantResidency = FLAGS.residency ?? (interactive ? /^y/i.test(await ask(t("residencyPrompt", lang) + " ", "")) : false);
  if (wantResidency) {
    await setupResidency(lang);
  } else {
    info(t("residencySkip", lang));
  }

  // 10) Report.
  report(lang);
}

// ---- helpers -------------------------------------------------------------
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
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
      val = (await ask(label + " ", cur)).trim();
    }
    if (spec.optional && val === "") return "";
    if (spec.required && val === "") {
      err(t("errRequired", lang));
      continue;
    }
    if (val !== "" && !spec.validate(val)) {
      err(t(spec.errKey, lang) + (spec.key === "CONTROLLED_REPO_PATH" ? "" : ""));
      continue;
    }
    if (spec.key === "CONTROLLED_REPO_PATH" && val !== "") {
      if (!fs.existsSync(val) || !fs.statSync(val).isDirectory()) {
        err(t("errRepoMissing", lang) + val);
        continue;
      }
    }
    return val;
  }
}

function previewMasked(values, lang) {
  const lines = MANAGED_KEYS.map((s) => {
    const v = values[s.key] ?? "";
    return `  ${s.key}=${s.secret ? (v ? "********" : "") : v}`;
  });
  return (lang === "zh" ? "將寫入的設定（token 已遮蔽）：\n" : "Config to write (token masked):\n") + lines.join("\n");
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

function report(lang) {
  const start = process.platform === "win32" ? "npm run start" : "npm run start";
  info("\n" + c(32, t("doneHeader", lang)));
  info(t("doneStart", lang) + start);
  info(t("doneManual", lang));
  info(c(33, t("doneSafety", lang)));
}

main().catch((e) => {
  err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
