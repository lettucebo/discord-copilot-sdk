import { afterEach, describe, expect, it, vi } from "vitest";
const fsMock = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  originalReaddirSync: undefined as typeof import("node:fs").readdirSync | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fsMock.originalReaddirSync = actual.readdirSync;
  fsMock.readdirSync.mockImplementation(actual.readdirSync);
  return { ...actual, readdirSync: fsMock.readdirSync };
});

import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  projectSkillDirectories,
  resolveSkillDirectories,
  userSkillDirectory,
} from "../src/core/skills.js";

describe("projectSkillDirectories", () => {
  it("returns the three CLI-native project skill roots in precedence order", () => {
    expect(projectSkillDirectories("C:\\repo")).toEqual([
      path.join("C:\\repo", ".github", "skills"),
      path.join("C:\\repo", ".agents", "skills"),
      path.join("C:\\repo", ".claude", "skills"),
    ]);
  });
});

describe("userSkillDirectory", () => {
  it("uses the Copilot user skills root", () => {
    expect(userSkillDirectory("C:\\Users\\Ada")).toBe(
      path.join("C:\\Users\\Ada", ".copilot", "skills")
    );
  });
});

describe("resolveSkillDirectories", () => {
  const roots: string[] = [];

  afterEach(() => {
    fsMock.readdirSync.mockReset();
    fsMock.readdirSync.mockImplementation(fsMock.originalReaddirSync!);
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function fixture(): { work: string; home: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-skills-"));
    roots.push(root);
    return { work: path.join(root, "work"), home: path.join(root, "home") };
  }

  function writeSkill(root: string, relative: string): void {
    const file = path.join(root, relative, "SKILL.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "---\nname: probe\n---\n");
  }

  it("includes enabled repo and user directories that contain a skill", () => {
    const { work, home } = fixture();
    writeSkill(work, path.join(".github", "skills", "repo-skill"));
    writeSkill(home, path.join(".copilot", "skills", "user-skill"));

    expect(
      resolveSkillDirectories({
        workingDirectory: work,
        includeRepoSkills: true,
        includeUserSkills: true,
        homeDirectory: home,
      })
    ).toEqual([
      path.join(work, ".github", "skills"),
      path.join(home, ".copilot", "skills"),
    ]);
  });

  it("finds skills nested below a project skill root", () => {
    const { work, home } = fixture();
    writeSkill(work, path.join(".claude", "skills", "nested", "deep-skill"));

    expect(
      resolveSkillDirectories({
        workingDirectory: work,
        includeRepoSkills: true,
        includeUserSkills: false,
        homeDirectory: home,
      })
    ).toEqual([path.join(work, ".claude", "skills")]);
  });

  it("omits confirmed-empty and missing directories", () => {
    const { work, home } = fixture();
    fs.mkdirSync(path.join(work, ".github", "skills"), { recursive: true });

    expect(
      resolveSkillDirectories({
        workingDirectory: work,
        includeRepoSkills: true,
        includeUserSkills: true,
        homeDirectory: home,
      })
    ).toEqual([]);
  });

  it("honours the source switches", () => {
    const { work, home } = fixture();
    writeSkill(work, path.join(".github", "skills", "repo-skill"));
    writeSkill(home, path.join(".copilot", "skills", "user-skill"));

    expect(
      resolveSkillDirectories({
        workingDirectory: work,
        includeRepoSkills: false,
        includeUserSkills: true,
        homeDirectory: home,
      })
    ).toEqual([path.join(home, ".copilot", "skills")]);
  });

  it("keeps an unreadable enabled root to avoid silently removing the skill tool", () => {
    const { work, home } = fixture();
    const userRoot = path.join(home, ".copilot", "skills");
    fs.mkdirSync(userRoot, { recursive: true });
    const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
    fsMock.readdirSync.mockImplementation((directory: fs.PathLike) => {
      if (String(directory) === userRoot) throw denied;
      return [];
    });

    expect(
      resolveSkillDirectories({
        workingDirectory: work,
        includeRepoSkills: false,
        includeUserSkills: true,
        homeDirectory: home,
      })
    ).toEqual([userRoot]);
  });

  it("does not treat a symbolic link alone as a loaded skill", () => {
    const { work, home } = fixture();
    const userRoot = path.join(home, ".copilot", "skills");
    fsMock.readdirSync.mockImplementation((directory: fs.PathLike) => {
      if (String(directory) !== userRoot) return [];
      return [
        {
          name: "dangling",
          isFile: () => false,
          isDirectory: () => false,
          isSymbolicLink: () => true,
        },
      ] as unknown as fs.Dirent[];
    });

    expect(
      resolveSkillDirectories({
        workingDirectory: work,
        includeRepoSkills: false,
        includeUserSkills: true,
        homeDirectory: home,
      })
    ).toEqual([]);
  });

  it("follows a user-owned linked skill directory when its target has SKILL.md", () => {
    const { work, home } = fixture();
    const userRoot = path.join(home, ".copilot", "skills");
    const target = path.join(home, "managed-skills", "linked");
    const link = path.join(userRoot, "linked");
    writeSkill(home, path.join("managed-skills", "linked"));
    fs.mkdirSync(userRoot, { recursive: true });
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

    expect(
      resolveSkillDirectories({
        workingDirectory: work,
        includeRepoSkills: false,
        includeUserSkills: true,
        homeDirectory: home,
      })
    ).toEqual([userRoot]);
  });

  it("does not follow linked directories from a controlled repository root", () => {
    const { work, home } = fixture();
    const repoRoot = path.join(work, ".github", "skills");
    const target = path.join(home, "external-skill");
    writeSkill(home, "external-skill");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.symlinkSync(target, path.join(repoRoot, "linked"), process.platform === "win32" ? "junction" : "dir");

    expect(
      resolveSkillDirectories({
        workingDirectory: work,
        includeRepoSkills: true,
        includeUserSkills: false,
        homeDirectory: home,
      })
    ).toEqual([]);
  });

  it("does not follow a controlled repository skill root that is itself linked", () => {
    const { work, home } = fixture();
    const repoParent = path.join(work, ".github");
    const repoRoot = path.join(repoParent, "skills");
    const target = path.join(home, "external-skill-root");
    writeSkill(home, "external-skill-root");
    fs.mkdirSync(repoParent, { recursive: true });
    fs.symlinkSync(target, repoRoot, process.platform === "win32" ? "junction" : "dir");

    expect(
      resolveSkillDirectories({
        workingDirectory: work,
        includeRepoSkills: true,
        includeUserSkills: false,
        homeDirectory: home,
      })
    ).toEqual([]);
  });

  it("rejects a repository skill root whose parent component links outside the worktree", () => {
    const { work, home } = fixture();
    const targetGithub = path.join(home, "external-github");
    writeSkill(home, path.join("external-github", "skills", "external"));
    fs.mkdirSync(work, { recursive: true });
    fs.symlinkSync(
      targetGithub,
      path.join(work, ".github"),
      process.platform === "win32" ? "junction" : "dir"
    );

    expect(
      resolveSkillDirectories({
        workingDirectory: work,
        includeRepoSkills: true,
        includeUserSkills: false,
        homeDirectory: home,
      })
    ).toEqual([]);
  });

  it("rejects an entire repository skill root when it mixes a real skill with a linked child", () => {
    const { work, home } = fixture();
    const repoRoot = path.join(work, ".github", "skills");
    const target = path.join(home, "external-skill");
    writeSkill(work, path.join(".github", "skills", "legit"));
    writeSkill(home, "external-skill");
    fs.symlinkSync(
      target,
      path.join(repoRoot, "linked"),
      process.platform === "win32" ? "junction" : "dir"
    );

    expect(
      resolveSkillDirectories({
        workingDirectory: work,
        includeRepoSkills: true,
        includeUserSkills: false,
        homeDirectory: home,
      })
    ).toEqual([]);
  });
});
