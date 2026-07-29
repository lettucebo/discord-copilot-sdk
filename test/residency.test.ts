import { describe, it, expect } from "vitest";
import { buildWindowsRegisterScript, chooseResidencyMode } from "../scripts/lib/residency.mjs";

const base = {
  name: "discord-copilot-sdk-default",
  psExe: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  wrapper: "C:\\repo\\scripts\\run-bot.default.ps1",
  wrapperLeaf: "run-bot.default.ps1",
  pwEnvVar: "DCS_RESIDENCY_PW",
};

describe("chooseResidencyMode", () => {
  const win = { platform: "win32", interactive: true, hasTty: true };

  it("never escalates without an interactive TTY — the password could not be asked for safely", () => {
    // --yes, CI, a pipe: all of these must land on login-keepalive rather than
    // prompting into a non-TTY or taking a secret from a flag/env, where it
    // would sit in shell history and process listings.
    expect(chooseResidencyMode({ ...win, requested: true, interactive: false })).toBe("logon");
    expect(chooseResidencyMode({ ...win, requested: true, hasTty: false })).toBe("logon");
    expect(chooseResidencyMode({ ...win, requested: true, interactive: false, hasTty: false })).toBe("logon");
  });

  it("never gives macOS 24/7, because it cannot run as you before login", () => {
    // LaunchAgent = login-bound; LaunchDaemon = root, which would run the
    // agent's arbitrary shell commands as root.
    expect(chooseResidencyMode({ requested: true, platform: "darwin", interactive: true, hasTty: true })).toBe("logon");
  });

  it("gives Linux 24/7 with NO password (linger)", () => {
    expect(chooseResidencyMode({ requested: true, platform: "linux", interactive: true, hasTty: true })).toBe(
      "always-free"
    );
  });

  it("only asks Windows for a password when 24/7 was actually requested interactively", () => {
    expect(chooseResidencyMode({ ...win, requested: true })).toBe("always");
    expect(chooseResidencyMode({ ...win, requested: false })).toBe("logon");
  });

  it("defaults to login-keepalive on every platform when not requested", () => {
    for (const platform of ["win32", "darwin", "linux"]) {
      expect(chooseResidencyMode({ requested: false, platform, interactive: true, hasTty: true })).toBe("logon");
    }
  });
});

describe("buildWindowsRegisterScript", () => {
  it("login mode never asks for credentials", () => {
    const s = buildWindowsRegisterScript({ ...base, mode: "logon" });
    expect(s).toContain("New-ScheduledTaskTrigger -AtLogOn");
    expect(s).not.toContain("-AtStartup"); // stops at logout, by design
    expect(s).not.toContain("-User");
    expect(s).not.toContain("-Password");
  });

  it("24/7 mode starts at BOOT and carries the user's credentials", () => {
    // The agent edits files in the controlled repo and its worktrees AS THIS
    // USER, so the task must run as them. Windows charges a stored password for
    // running as a user with nobody logged in.
    const s = buildWindowsRegisterScript({ ...base, mode: "always", user: "HOST\\alice" });
    expect(s).toContain("-AtStartup");
    expect(s).toContain("-User 'HOST\\alice'");
    expect(s).toContain("-Password $pw");
  });

  it("CANNOT leak the password, because it never receives one", () => {
    // `schtasks /RP` and `powershell -Command "...$pw..."` both put the secret in
    // argv, which any process on the machine can read via Win32_Process. The
    // builder takes no password at all and emits a read from the child
    // environment instead — the property is enforced by the signature, not by
    // remembering to escape something.
    const s = buildWindowsRegisterScript({ ...base, mode: "always", user: "HOST\\alice" });
    expect(s).toContain("$pw=$env:DCS_RESIDENCY_PW");
    expect(s).not.toMatch(/-Password\s+'/); // never a literal
    expect(buildWindowsRegisterScript.length).toBe(1); // one options object, no password arg
  });

  it("refuses to run 24/7 with no password rather than registering a broken task", () => {
    const s = buildWindowsRegisterScript({ ...base, mode: "always", user: "HOST\\alice" });
    expect(s).toContain("if(-not $pw){ throw");
  });

  it("clears the password from the environment after registering", () => {
    const s = buildWindowsRegisterScript({ ...base, mode: "always", user: "HOST\\alice" });
    expect(s).toContain("Remove-Item Env:\\DCS_RESIDENCY_PW");
  });

  it("keeps the foreign-task guard in BOTH modes", () => {
    // Replacing someone else's task of the same name would be destructive.
    for (const mode of ["logon", "always"] as const) {
      const s = buildWindowsRegisterScript({ ...base, mode, user: "HOST\\alice" });
      expect(s).toContain("Get-ScheduledTask -TaskName $name");
      expect(s).toContain("refusing to replace it");
    }
  });

  it("escapes an apostrophe in a path instead of breaking the script", () => {
    const s = buildWindowsRegisterScript({
      ...base,
      wrapper: "C:\\Users\\O'Brien\\run-bot.ps1",
      mode: "logon",
    });
    expect(s).toContain("C:\\Users\\O''Brien\\run-bot.ps1");
  });
});
