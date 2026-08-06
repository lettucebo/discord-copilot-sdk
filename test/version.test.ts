import { describe, expect, it } from "vitest";
import {
  formatVersionInfo,
  readAppVersion,
  readCommitSha,
} from "../src/core/version.js";

describe("readAppVersion", () => {
  it("reads the app version only from this project's package metadata", () => {
    const version = readAppVersion("C:\\repo", (file) => {
      expect(file).toBe("C:\\repo\\package.json");
      return JSON.stringify({ name: "discord-copilot-sdk", version: "0.1.0" });
    });

    expect(version).toBe("0.1.0");
  });

  it("fails closed to unknown for malformed or foreign metadata", () => {
    expect(readAppVersion("C:\\repo", () => "{")).toBe("unknown");
    expect(readAppVersion("C:\\repo", () => JSON.stringify({ name: "other", version: "9.9.9" }))).toBe("unknown");
    expect(readAppVersion("C:\\repo", () => JSON.stringify({ name: "discord-copilot-sdk", version: 1 }))).toBe("unknown");
    expect(readAppVersion("C:\\repo", () => JSON.stringify({ name: "discord-copilot-sdk", version: "not-semver" }))).toBe(
      "unknown"
    );
  });
});

describe("readCommitSha", () => {
  it("uses git -C against the installation root, independent of process cwd", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const commit = readCommitSha("C:\\repo", (command, args) => {
      calls.push({ command, args });
      return "a1b2c3d\n";
    });

    expect(commit).toBe("a1b2c3d");
    expect(calls).toEqual([{ command: "git", args: ["-C", "C:\\repo", "rev-parse", "--short", "HEAD"] }]);
  });

  it("fails closed to unknown when git cannot report a valid sha", () => {
    expect(readCommitSha("C:\\repo", () => "a1b2c\n")).toBe("a1b2c");
    expect(readCommitSha("C:\\repo", () => "")).toBe("unknown");
    expect(readCommitSha("C:\\repo", () => "not-a-sha")).toBe("unknown");
    expect(readCommitSha("C:\\repo", () => {
      throw new Error("git missing");
    })).toBe("unknown");
  });
});

describe("formatVersionInfo", () => {
  it("reports the app release, source commit and installed SDK together", () => {
    expect(formatVersionInfo({ app: "0.1.0", commit: "a1b2c3d", sdk: "1.0.7-preview.3" })).toBe(
      "discord-copilot-sdk 0.1.0 • commit a1b2c3d • @github/copilot-sdk 1.0.7-preview.3"
    );
  });
});
