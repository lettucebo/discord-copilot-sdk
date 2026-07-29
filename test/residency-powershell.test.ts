import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isWindows = process.platform === "win32";
const psExe = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** The guard shape the registration script relies on. */
const GUARDED = ["$ErrorActionPreference='Stop'", "throw 'GUARD'", "Write-Output 'REACHED-THE-THING-WE-GUARDED'"].join("\n");

describe.runIf(isWindows)("how PowerShell is invoked decides whether the guards work", () => {
  it("`-Command -` (REPL over stdin) does NOT abort on throw, and still exits 0", () => {
    // This is the trap. Every line is an independent command, so a `throw` in a
    // guard stops only that line: the foreign-task check did not prevent
    // `Register-ScheduledTask -Force` from overwriting someone else's task, and
    // `if(-not $pw){throw}` did not prevent registering with an EMPTY password.
    // Node saw exit 0 and told the operator it had succeeded.
    let exitCode = 0;
    let out = "";
    try {
      out = execFileSync(psExe, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
        input: GUARDED,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      exitCode = (e as { status?: number }).status ?? 1;
    }
    expect(exitCode).toBe(0); // no failure signalled
    expect(out).toContain("REACHED-THE-THING-WE-GUARDED"); // the guard did not stop it
  });

  it("`-File` (script mode) DOES abort on throw and exits non-zero", () => {
    const f = path.join(os.tmpdir(), `dcs-guard-${process.pid}-${Date.now()}.ps1`);
    fs.writeFileSync(f, "\ufeff" + GUARDED.replace(/\n/g, "\r\n") + "\r\n", "utf8");
    let exitCode = 0;
    let out = "";
    try {
      out = execFileSync(psExe, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      exitCode = (e as { status?: number }).status ?? 1;
      out = String((e as { stdout?: string }).stdout ?? "");
    } finally {
      fs.rmSync(f, { force: true });
    }
    expect(exitCode).not.toBe(0); // the failure is visible to Node
    expect(out).not.toContain("REACHED-THE-THING-WE-GUARDED"); // the guard held
  });

  it("a BOM makes a non-ASCII .ps1 parse under Windows PowerShell 5.1, on any machine", () => {
    // The generated residency wrapper interpolates REPO_ROOT and a log path built
    // from os.homedir(). Without a BOM, 5.1 reads the file as ANSI: the UTF-8
    // bytes of a Chinese Windows username are re-decoded as (say) Big5, which
    // changes both the characters AND their count, shifting the quotes so the
    // file fails to PARSE — silently, because the error precedes the `*>>`
    // redirect that would have logged it. That is exactly how the shipped
    // install.ps1 was broken:
    //     haveNode = 'Node version'  ->  The hash literal was incomplete.
    //
    // WHETHER a given machine breaks depends on its ANSI codepage, so asserting
    // the failure is not portable (an English CI runner at 1252 mangles the
    // bytes differently and can still parse). What IS portable, and what we
    // actually ship, is that the BOM version parses everywhere.
    const body = "Set-Location -LiteralPath 'C:\\Users\\使用者測試' -ErrorAction SilentlyContinue\r\nWrite-Output 'RAN'\r\n";
    const withBom = path.join(os.tmpdir(), `dcs-bom-${process.pid}.ps1`);
    fs.writeFileSync(withBom, "\ufeff" + body, "utf8");
    try {
      const out = execFileSync(psExe, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", withBom], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(out).toContain("RAN");
    } finally {
      fs.rmSync(withBom, { force: true });
    }
  });
});
