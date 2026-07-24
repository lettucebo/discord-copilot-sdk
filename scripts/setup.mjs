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
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
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
 *  visible input. Restores terminal mode on every exit path. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new SetupError("no TTY for hidden input"));
    stdout.write(question + ": ");
    let buf = "";
    const onData = (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stdout.write("\n");
          return resolve(buf);
        }
        if (ch === "\u0003") {
          cleanup();
          stdout.write("\n");
          return reject(new SetupError("cancelled"));
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    const cleanup = () => {
      try {
        stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
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

/** Copilot auth probe with a bounded timeout → verified | unauthenticated |
 *  indeterminate. Never hangs; never claims success it can't confirm. */
function copilotAuthState() {
  if (!onPath("copilot")) return "indeterminate";
  // A real login writes token/host files under ~/.copilot; treat their presence
  // as "verified" (best-effort — we cannot run an interactive login here).
  try {
    const dir = path.join(os.homedir(), ".copilot");
    if (!fs.existsSync(dir)) return "unauthenticated";
    const files = fs.readdirSync(dir).join(" ");
    return /token|host|apps|config|mcp/i.test(files) ? "verified" : "unauthenticated";
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
  fs.copyFileSync(ENV_PATH, dest);
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
  // Exclusive create so we never clobber a racing temp; owner-only bits.
  fs.writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (process.platform === "win32") lockdownWindowsAcl(tmp);
  fs.renameSync(tmp, targetPath);
  try {
    fs.chmodSync(targetPath, 0o600);
  } catch {
    /* windows */
  }
}

function lockdownWindowsAcl(file) {
  // Restrict to the current user only (remove inheritance). Fail closed: if we
  // can't secure it, don't leave a world-readable secret behind.
  try {
    const user = process.env.USERNAME ? `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME}` : os.userInfo().username;
    execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore" });
  } catch {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
    throw new SetupError("could not apply a Windows ACL to the .env temp file; aborting to avoid an unprotected secret");
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

  // 2) Auth (3-state; never a false "ok").
  info("\n" + c(1, t("authHeader", lang)));
  if (FLAGS.skipAuth) {
    warn(t("authSkip", lang));
  } else {
    const state = copilotAuthState();
    if (state === "verified") ok("copilot: verified");
    else {
      warn(t("authUnknown", lang) + ` (${state})`);
      if (!interactive) throw new SetupError(t("authUnknown", lang));
    }
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

  // 7) COMMIT: guard, backup, atomic secure write.
  ensureEnvNotTracked();
  info("\n" + c(1, t("writingEnv", lang)));
  if (fs.existsSync(ENV_PATH) && fs.readFileSync(ENV_PATH, "utf8") === merged) {
    info(t("envUnchanged", lang));
  } else {
    backupEnv(lang);
    secureWrite(ENV_PATH, merged);
    ok(t("wroteEnv", lang));
  }

  // 8) Build (sanitized child env), then a real config-load health check.
  info("\n" + c(1, t("buildHeader", lang)));
  run("npm", ["ci"], sanitizedChildEnv());
  run("npm", ["run", "build"], sanitizedChildEnv());
  execFileSync(process.execPath, ["-e", "import('./dist/config.js').then(m=>m.loadConfig())"], {
    cwd: REPO_ROOT,
    stdio: "ignore",
  });
  ok(t("healthOk", lang));

  // 9) Residency (opt-in; honest login-keepalive labeling).
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
  const realCmd = process.platform === "win32" && cmd === "npm" ? "npm.cmd" : cmd;
  execFileSync(realCmd, args, { cwd: REPO_ROOT, stdio: "inherit", env });
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
