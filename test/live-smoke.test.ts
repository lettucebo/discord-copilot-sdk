import { describe, expect, it } from "vitest";
import { matchesExpectedShellPermission } from "../scripts/lib/live-smoke.mjs";
import type { PermissionView } from "../src/core/transport.js";

const EXPECTED_COMMAND = "git status --short";

function permission(summary: string, canOfferSession = true): PermissionView {
  return {
    nonce: "n",
    sessionKey: "smoke",
    kind: "shell",
    supported: true,
    canOfferSession,
    summary,
    scopeCommands: ["git"],
  };
}

describe("live smoke permission allowlist", () => {
  it("accepts only the expected simple read-only command", () => {
    expect(
      matchesExpectedShellPermission(
        permission(`intent: Check repository status\n$ ${EXPECTED_COMMAND}`),
        EXPECTED_COMMAND
      )
    ).toBe(true);
    expect(
      matchesExpectedShellPermission(permission(`$ ${EXPECTED_COMMAND}`), EXPECTED_COMMAND)
    ).toBe(true);
    expect(
      matchesExpectedShellPermission(
        permission(`$ ${EXPECTED_COMMAND}\n• paths: C:\\disposable\\repo`),
        EXPECTED_COMMAND
      )
    ).toBe(true);
  });

  it.each([
    [`$ ${EXPECTED_COMMAND}\nRemove-Item important.txt`, true],
    [`$ ${EXPECTED_COMMAND}\n$ Remove-Item important.txt`, true],
    [`intent: Check status\n$ ${EXPECTED_COMMAND}\n$ ${EXPECTED_COMMAND}`, true],
    [`$ ${EXPECTED_COMMAND}; Remove-Item important.txt`, true],
    [`$ ${EXPECTED_COMMAND}`, false],
    [`$ ${EXPECTED_COMMAND}\n⚠️ WARNING: writes files`, true],
    [`$ ${EXPECTED_COMMAND}\n• urls: https://example.invalid`, true],
  ])("rejects a request outside the exact allowlist", (summary, canOfferSession) => {
    expect(
      matchesExpectedShellPermission(
        permission(summary, canOfferSession),
        EXPECTED_COMMAND
      )
    ).toBe(false);
  });

  it("rejects unsupported or non-shell permission kinds", () => {
    expect(
      matchesExpectedShellPermission(
        { ...permission(`$ ${EXPECTED_COMMAND}`), supported: false },
        EXPECTED_COMMAND
      )
    ).toBe(false);
    expect(
      matchesExpectedShellPermission(
        { ...permission(`$ ${EXPECTED_COMMAND}`), kind: "write" },
        EXPECTED_COMMAND
      )
    ).toBe(false);
  });
});
