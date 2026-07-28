import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveControlledRepo } from "../src/core/repo.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "discord-copilot-sdk-repo-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveControlledRepo", () => {
  it("accepts an absolute git working-tree root and returns a canonical absolute path", () => {
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    const r = resolveControlledRepo(dir);
    expect(path.isAbsolute(r)).toBe(true);
  });

  it("rejects a relative path", () => {
    expect(() => resolveControlledRepo("relative/path")).toThrow(/absolute/i);
  });

  it("rejects a non-existent path", () => {
    expect(() => resolveControlledRepo(path.join(dir, "nope"))).toThrow(/does not exist/i);
  });

  it("rejects a directory that is not a git root", () => {
    const plain = path.join(dir, "plain");
    mkdirSync(plain, { recursive: true });
    expect(() => resolveControlledRepo(plain)).toThrow(/git/i);
  });
});
