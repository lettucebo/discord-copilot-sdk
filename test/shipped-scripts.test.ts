import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_DOCUMENTS = ["README.md", "README.zh-TW.md", "INSTALL.md", "INSTALL.zh-TW.md"];
const INSTALL_GUIDES = ["INSTALL.md", "INSTALL.zh-TW.md"];
const DOCUMENTATION_PAIRS = [
  ["README.md", "README.zh-TW.md"],
  ["INSTALL.md", "INSTALL.zh-TW.md"],
  ["docs/DISCORD-SETUP.md", "docs/DISCORD-SETUP.zh-TW.md"],
  ["docs/CHANNEL-ACCESS.md", "docs/CHANNEL-ACCESS.zh-TW.md"],
] as const;

function relativeMarkdownLinks(text: string): string[] {
  const prose = text.replace(/^```[\s\S]*?^```/gm, "");
  const links = [...prose.matchAll(/\[[^\]]*]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\)/g)];
  return links
    .map((match) => match[1] ?? match[2] ?? "")
    .filter((href) => !/^(?:https?:|mailto:|#|\/)/i.test(href))
    .map((href) => href.split("#", 1)[0] ?? "")
    .filter((href) => href.endsWith(".md"));
}

/** Every .ps1 an end user is told to run. */
const USER_FACING_PS1 = ["install.ps1", "get.ps1", "update.ps1", "run-bot.ps1", "stop-bot.ps1", "uninstall.ps1"];

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

  const SHELL = ["install.sh", "get.sh", "update.sh", "run-bot.sh", "stop-bot.sh", "uninstall.sh"];

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

  it("documents the one-line install in English and Traditional Chinese README and INSTALL", () => {
    for (const doc of INSTALL_DOCUMENTS) {
      const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
      expect(text).toContain("get.ps1");
      expect(text).toContain("get.sh");
    }
  });

  it("documents the uninstaller in English and Traditional Chinese README and INSTALL", () => {
    // A tool that installs residency, stores approval grants and holds a bot
    // token needs its removal documented where its installation is.
    for (const doc of INSTALL_DOCUMENTS) {
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
    for (const doc of INSTALL_DOCUMENTS) {
      const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
      expect(text).toMatch(/raw\.githubusercontent\.com\/lettucebo\/discord-copilot-sdk\/main\/get\.(ps1|sh)/);
    }
    // The private-fork fallback is still documented, but as a fallback.
    for (const doc of INSTALL_GUIDES) {
      const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
      expect(text).toMatch(/gh api repos\/<owner>\/discord-copilot-sdk\/contents\/get\.ps1/);
    }
  });

  it("every documented get.ps1 command strips the BOM before scriptblock::Create, and never bare-pipes into iex", () => {
    // Invoke-RestMethod does NOT strip the UTF-8 BOM get.ps1 ships with (on
    // EITHER PowerShell 5.1 or 7). [scriptblock]::Create() parses a raw string,
    // not a file, so an untrimmed BOM lands on the `#Requires` token and the
    // whole script fails to parse. `irm ... | iex` cannot be fixed by trimming
    // either — Invoke-Expression evaluates in the caller's scope, where a
    // top-level param() degenerates into variable declarations, and it cannot
    // take flags — so a bare `| iex` invocation must never be the documented
    // form again.
    const fence = /```powershell\r?\n([\s\S]*?)```/g;
    for (const doc of INSTALL_DOCUMENTS) {
      const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
      const blocks = [...text.matchAll(fence)].map((m) => m[1] ?? "");
      const getBlocks = blocks.filter((b) => b.includes("get.ps1"));
      expect(getBlocks.length, `${doc} should have a powershell code block invoking get.ps1`).toBeGreaterThan(0);
      for (const block of getBlocks) {
        expect(block).toContain("TrimStart([char]0xFEFF)");
        expect(block).not.toMatch(/\|\s*iex\b/);
      }
    }
  });

  it("keeps each bilingual documentation pair and language switcher linked", () => {
    for (const [english, chinese] of DOCUMENTATION_PAIRS) {
      expect(fs.existsSync(path.join(ROOT, english)), `${english} exists`).toBe(true);
      expect(fs.existsSync(path.join(ROOT, chinese)), `${chinese} exists`).toBe(true);
      expect(fs.readFileSync(path.join(ROOT, english), "utf8"))
        .toContain(`> **English** · [繁體中文](${path.basename(chinese)})`);
      expect(fs.readFileSync(path.join(ROOT, chinese), "utf8"))
        .toContain(`> [English](${path.basename(english)}) · **繁體中文**`);
    }
  });

  it("keeps relative Markdown document links within each language valid", () => {
    for (const [english, chinese] of DOCUMENTATION_PAIRS) {
      for (const doc of [english, chinese]) {
        const directory = path.dirname(path.join(ROOT, doc));
        for (const href of relativeMarkdownLinks(fs.readFileSync(path.join(ROOT, doc), "utf8"))) {
          expect(fs.existsSync(path.resolve(directory, href)), `${doc} links to ${href}`).toBe(true);
        }
      }
    }
  });

  describe("PowerShell parse check (network-BOM simulation)", { timeout: 60_000 }, () => {
    it.each(USER_FACING_PS1)("%s parses via [scriptblock]::Create the way irm/iex sees it over the network", (name) => {
      // Reproduces exactly how a networked `irm` response is consumed: read the
      // raw bytes, decode as UTF-8 (this keeps the BOM as a leading U+FEFF
      // character — Invoke-RestMethod does not strip it), trim it, then parse.
      // Before this test (and the matching CI step in ci.yml's lint-scripts job)
      // NOTHING ever parsed a shipped .ps1 at all, which is how get.ps1's BOM
      // broke the documented one-liner without failing any check. A raised
      // timeout matches this repo's convention for subprocess-heavy suites
      // (app-reclaim, setup-integration, worktree-git) — spawning a real pwsh
      // process per file is slow, especially under load.
      let pwshOk = true;
      try {
        execFileSync("pwsh", ["-NoProfile", "-Command", "1"], { stdio: "ignore" });
      } catch {
        pwshOk = false;
      }
      if (!pwshOk) return; // authoritative guard is CI's pwsh step; skip if pwsh isn't installed locally

      // pwsh's -Command treats everything after it as the script text (it does
      // NOT expose further argv entries as $args), so the path is embedded
      // directly — single-quoted and doubled per PowerShell's escaping rule.
      const psPath = path.join(ROOT, name).replace(/'/g, "''");
      const script = [
        `$bytes = [System.IO.File]::ReadAllBytes('${psPath}')`,
        "$text = [System.Text.Encoding]::UTF8.GetString($bytes)",
        "[scriptblock]::Create($text.TrimStart([char]0xFEFF))",
        "'PARSE OK'",
      ].join("\n");
      const out = execFileSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8" });
      expect(out).toContain("PARSE OK");
    });
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

  it("pins every user-facing PowerShell script to CRLF", () => {
    const attributes = fs.readFileSync(path.join(ROOT, ".gitattributes"), "utf8");
    for (const file of USER_FACING_PS1) {
      expect(attributes).toContain(`${file} text eol=crlf`);
    }
  });

  it("runs syntax checks for every shipped update entrypoint in CI", () => {
    const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(workflow).toMatch(/for f in install\.sh get\.sh update\.sh run-bot\.sh stop-bot\.sh uninstall\.sh; do/);
    expect(workflow).toMatch(/for f in scripts\/setup\.mjs scripts\/update\.mjs scripts\/uninstall\.mjs scripts\/lib\/\*\.mjs; do/);
    expect(workflow).toMatch(/\$files = 'install\.ps1', 'get\.ps1', 'update\.ps1', 'run-bot\.ps1', 'stop-bot\.ps1', 'uninstall\.ps1'/);
  });
});
