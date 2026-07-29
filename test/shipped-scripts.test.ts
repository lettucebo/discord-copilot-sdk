import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every .ps1 an end user is told to run. */
const USER_FACING_PS1 = ["install.ps1", "get.ps1", "run-bot.ps1", "stop-bot.ps1"];

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

  const SHELL = ["install.sh", "get.sh", "run-bot.sh", "stop-bot.sh"];

  it.each(SHELL)("%s has a shebang and no CRLF in the committed form", (name) => {
    // `.gitattributes` normalises *.sh to LF, but a stray CR would still make
    // bash fail with `$'\r': command not found` on the user's machine.
    const text = fs.readFileSync(path.join(ROOT, name), "utf8");
    expect(text.startsWith("#!")).toBe(true);
  });

  it("documents the one-line install in both README and INSTALL", () => {
    for (const doc of ["README.md", "INSTALL.md"]) {
      const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
      expect(text).toContain("get.ps1");
      expect(text).toContain("get.sh");
    }
  });

  it("does not present a raw.githubusercontent one-liner as THE way while the repo is private", () => {
    // The repo is private, so `irm https://raw.githubusercontent.com/...` 404s
    // for everyone — including its owner. Documenting it unconditionally is a
    // command that cannot work. Both docs must show the `gh` form, which uses
    // the reader's existing GitHub login, and say why.
    for (const doc of ["README.md", "INSTALL.md"]) {
      const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
      expect(text).toMatch(/gh api repos\/lettucebo\/discord-copilot-sdk\/contents\/get\.ps1/);
      expect(text).toMatch(/private/i);
    }
  });
});
