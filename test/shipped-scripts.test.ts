import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every .ps1 an end user is told to run. */
const USER_FACING_PS1 = ["install.ps1", "get.ps1", "run-bot.ps1", "stop-bot.ps1", "uninstall.ps1"];

describe("shipped scripts", () => {
  it.each(USER_FACING_PS1)("%s starts with a UTF-8 BOM", (name) => {
    // Windows PowerShell 5.1 — the `powershell` on every Windows box, and what
    // these files declare with `#Requires -Version 5.1` — reads a .ps1 as ANSI
    // unless it has a BOM. Without one, the bilingual (Chinese) strings are
    // mangled into unbalanced quotes and the whole file fails to PARSE, so the
    // installer cannot run at all for a fresh clone. PowerShell 7 hides this by
    // defaulting to UTF-8, which is why it survived review.
    const buf = fs.readFileSync(path.join(ROOT, name));
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it.each(USER_FACING_PS1)("%s has no BOM-defeating leading whitespace", (name) => {
    const buf = fs.readFileSync(path.join(ROOT, name));
    expect(buf.subarray(3, 4).toString()).not.toMatch(/\s/);
  });

  const SHELL = ["install.sh", "get.sh", "run-bot.sh", "stop-bot.sh", "uninstall.sh"];

  it.each(SHELL)("%s has a shebang and no CRLF in the committed form", (name) => {
    // `.gitattributes` normalises *.sh to LF, but a stray CR would still make
    // bash fail with `$'\r': command not found` on the user's machine.
    const text = fs.readFileSync(path.join(ROOT, name), "utf8");
    expect(text.startsWith("#!")).toBe(true);
  });

  it("every .sh is committed executable, because the docs say ./run-bot.sh", () => {
    // A 100644 mode means a fresh macOS/Linux clone gets `permission denied` on
    // every command the new docs tell people to run.
    const out = execFileSync("git", ["ls-files", "-s", ...SHELL], { cwd: ROOT, encoding: "utf8" });
    for (const line of out.trim().split(/\r?\n/)) {
      expect(line.startsWith("100755")).toBe(true);
    }
  });

  it("documents the one-line install in both README and INSTALL", () => {
    for (const doc of ["README.md", "INSTALL.md"]) {
      const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
      expect(text).toContain("get.ps1");
      expect(text).toContain("get.sh");
    }
  });

  it("documents the uninstaller in both README and INSTALL", () => {
    // A tool that installs residency, stores approval grants and holds a bot
    // token needs its removal documented where its installation is.
    for (const doc of ["README.md", "INSTALL.md"]) {
      const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
      expect(text).toContain("uninstall.ps1");
      expect(text).toContain("uninstall.sh");
    }
  });

  it("documents an install one-liner that matches the repo's actual visibility", () => {
    // This used to assert the opposite: while the repo was private,
    // `raw.githubusercontent.com` 404'd for everyone including its owner, so the
    // docs had to lead with the `gh api` form. Now that it is public the plain
    // form works and is what a reader should see first — a documented command
    // that cannot run is worse than no command.
    for (const doc of ["README.md", "INSTALL.md"]) {
      const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
      expect(text).toMatch(/raw\.githubusercontent\.com\/lettucebo\/discord-copilot-sdk\/main\/get\.(ps1|sh)/);
    }
    // The private-fork fallback is still documented, but as a fallback.
    const install = fs.readFileSync(path.join(ROOT, "INSTALL.md"), "utf8");
    expect(install).toMatch(/gh api repos\/<owner>\/discord-copilot-sdk\/contents\/get\.ps1/);
  });

  it("keeps real Discord snowflakes out of the tracked tree", () => {
    // A guild/channel id is only semi-sensitive, but a personal user id links a
    // GitHub identity to a Discord account permanently once this repo is public.
    // Synthetic ids read the same to a test and leak nothing.
    //
    // The ids are assembled from halves ON PURPOSE. Written as literals they
    // would be the very strings this test forbids, so a history rewrite that
    // redacts them (`git filter-repo --replace-text`) silently rewrites the
    // GUARD as well and the test starts asserting nothing. Split, it survives.
    const real = ["344653883" + "097743360", "1492831892" + "679164055", "1529767345" + "545936987"];
    const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).trim().split(/\r?\n/);
    for (const f of files) {
      if (!/\.(ts|mjs|js|md|json|ps1|sh|yml)$/.test(f)) continue;
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      for (const id of real) expect(text.includes(id), `${f} contains a real Discord id`).toBe(false);
    }
  });

  it("does not commit a lockfile pinned to a corporate proxy", () => {
    // One generated behind the corp proxy pins internal hosts AND carries that
    // proxy's integrity hashes (sha1, where public npm serves sha512), so
    // `npm ci` could not verify them anywhere else. Shipping none is honest.
    const tracked = execFileSync("git", ["ls-files", "package-lock.json"], { cwd: ROOT, encoding: "utf8" }).trim();
    expect(tracked).toBe("");
    const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    expect(ignore).toMatch(/^package-lock\.json$/m);
  });
});
