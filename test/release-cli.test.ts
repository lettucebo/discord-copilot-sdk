import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX_ROOT = fs.mkdtempSync(path.join(ROOT, ".tmp-release-cli-"));

const DEFAULT_CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "## [0.1.0] - 2026-08-06",
  "",
  "### Added",
  "",
  "- Initial release",
  "",
].join("\n");

type CommitSpec = {
  subject: string;
  body?: string;
  fileName?: string;
  content?: string;
};

type FixtureOptions = {
  packageVersion?: string;
  changelog?: string;
  initialTag?: string;
  commits?: CommitSpec[];
};

type Snapshot = {
  head: string;
  status: string;
  tags: string;
  remoteRefs: string;
  packageJson: string;
  changelog: string;
};

const git = (cwd: string, ...args: string[]): Promise<{ stdout: string }> =>
  exec("git", args, { cwd, encoding: "utf8" });
const gitWithEnv = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): Promise<{ stdout: string }> =>
  exec("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });

async function copyReleaseTooling(repo: string): Promise<void> {
  await fs.promises.mkdir(path.join(repo, "scripts", "lib"), { recursive: true });
  await fs.promises.copyFile(path.join(ROOT, "scripts", "release.mjs"), path.join(repo, "scripts", "release.mjs"));
  await fs.promises.copyFile(
    path.join(ROOT, "scripts", "lib", "release-core.mjs"),
    path.join(repo, "scripts", "lib", "release-core.mjs")
  );
}

async function commitFile(repo: string, spec: CommitSpec, index: number): Promise<void> {
  const fileName = spec.fileName ?? `commit-${index}.txt`;
  const content = spec.content ?? `${spec.subject}\n${spec.body ?? ""}\n`;
  await fs.promises.writeFile(path.join(repo, fileName), content, "utf8");
  await git(repo, "add", "-A");
  const args = ["commit", "-q", "-m", spec.subject];
  if (spec.body) args.push("-m", spec.body);
  await git(repo, ...args);
}

async function createFixture(options: FixtureOptions = {}): Promise<{ sandbox: string; source: string; remote: string; target: string }> {
  const sandbox = path.join(SANDBOX_ROOT, randomUUID());
  const source = path.join(sandbox, "source");
  const remote = path.join(sandbox, "remote.git");
  const target = path.join(sandbox, "target");
  await fs.promises.mkdir(source, { recursive: true });
  await copyReleaseTooling(source);
  await fs.promises.writeFile(
    path.join(source, "package.json"),
    JSON.stringify(
      {
        name: "discord-copilot-sdk",
        version: options.packageVersion ?? "0.1.0",
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  await fs.promises.writeFile(path.join(source, "CHANGELOG.md"), options.changelog ?? DEFAULT_CHANGELOG, "utf8");
  await fs.promises.writeFile(path.join(source, "README.md"), "fixture\n", "utf8");

  await git(sandbox, "init", "-q", "-b", "main", source);
  await git(source, "config", "user.email", "release@test.invalid");
  await git(source, "config", "user.name", "release test");
  await git(source, "config", "commit.gpgsign", "false");
  await git(source, "add", "-A");
  await git(source, "commit", "-q", "-m", "initial");

  if (options.initialTag) {
    await git(source, "tag", "-a", options.initialTag, "-m", options.initialTag);
  }

  for (const [index, spec] of (options.commits ?? []).entries()) {
    await commitFile(source, spec, index + 1);
  }

  await git(sandbox, "init", "-q", "--bare", remote);
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "-q", "-u", "origin", "main", "--tags");
  await git(sandbox, "clone", "-q", "--branch", "main", remote, target);
  await git(target, "config", "user.email", "release@test.invalid");
  await git(target, "config", "user.name", "release test");

  return { sandbox, source, remote, target };
}

async function dirtyRepo(repo: string, fileName = "README.md"): Promise<void> {
  const filePath = path.join(repo, fileName);
  const existing = await fs.promises.readFile(filePath, "utf8");
  await fs.promises.writeFile(filePath, `${existing}dirty\n`, "utf8");
}

async function snapshotRepo(repo: string): Promise<Snapshot> {
  return {
    head: (await git(repo, "rev-parse", "HEAD")).stdout.trim(),
    status: (await git(repo, "status", "--porcelain", "--untracked-files=all")).stdout,
    tags: (await git(repo, "tag", "--list", "--sort=refname")).stdout,
    remoteRefs: (await git(repo, "ls-remote", "--heads", "--tags", "origin")).stdout,
    packageJson: await fs.promises.readFile(path.join(repo, "package.json"), "utf8"),
    changelog: await fs.promises.readFile(path.join(repo, "CHANGELOG.md"), "utf8"),
  };
}

async function runRelease(repo: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await exec(process.execPath, [path.join(repo, "scripts", "release.mjs"), ...args], {
      cwd: repo,
      encoding: "utf8",
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

afterAll(async () => {
  await fs.promises.rm(SANDBOX_ROOT, { recursive: true, force: true });
});

describe("release CLI", { timeout: 60_000 }, () => {
  it("plans from all reachable history without mutating a dirty repo when no release tag exists", async () => {
    const fixture = await createFixture({
      commits: [
        { subject: "feat: add release planning" },
        { subject: "docs: refresh release guide" },
      ],
    });
    await dirtyRepo(fixture.target);
    expect((await git(fixture.target, "remote", "get-url", "origin")).stdout).not.toContain("github.com");
    const before = await snapshotRepo(fixture.target);

    const result = await runRelease(fixture.target, "--plan");
    const after = await snapshotRepo(fixture.target);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Current version: 0.1.0");
    expect(result.stdout).toContain("Baseline tag: (none found; using all reachable history)");
    expect(result.stdout).toContain("Proposed version: 0.1.1");
    expect(result.stdout).toContain("Release level: patch");
    expect(result.stdout).toContain("CHANGELOG DRAFT");
    expect(result.stdout).toContain("### Added");
    expect(result.stdout).toContain("- add release planning");
    expect(result.stdout).toContain("REVIEW BY HAND");
    expect(result.stdout).toContain("- docs: refresh release guide");
    expect(after).toEqual(before);
  });

  it("reports no release-worthy commits from the latest reachable release tag without mutating a dirty repo", async () => {
    const fixture = await createFixture({
      initialTag: "v0.1.0",
      commits: [{ subject: "docs: refresh release guide" }],
    });
    await dirtyRepo(fixture.target);
    const before = await snapshotRepo(fixture.target);

    const result = await runRelease(fixture.target, "--plan");
    const after = await snapshotRepo(fixture.target);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Baseline tag: v0.1.0");
    expect(result.stdout).toContain("No release-worthy commits found.");
    expect(result.stdout).toContain("CHANGELOG DRAFT");
    expect(result.stdout).toContain("(none)");
    expect(result.stdout).toContain("REVIEW BY HAND");
    expect(result.stdout).toContain("- docs: refresh release guide");
    expect(after).toEqual(before);
  });

  it("uses the nearest reachable release tag in history order instead of tag creation time", async () => {
    const fixture = await createFixture({
      commits: [
        { subject: "feat: add release planning" },
        { subject: "fix: preserve CLI compatibility" },
        { subject: "docs: refresh release guide" },
      ],
    });
    const revisions = (await git(fixture.source, "rev-list", "--reverse", "HEAD")).stdout.trim().split(/\r?\n/);
    expect(revisions.length).toBeGreaterThanOrEqual(3);
    const featCommit = revisions[1];
    const fixCommit = revisions[2];
    if (!featCommit || !fixCommit) throw new Error("expected tagged fixture revisions");
    await gitWithEnv(
      fixture.source,
      { GIT_COMMITTER_DATE: "2026-08-07T00:00:00Z", GIT_AUTHOR_DATE: "2026-08-07T00:00:00Z" },
      "tag",
      "-a",
      "v0.2.0",
      featCommit,
      "-m",
      "v0.2.0"
    );
    await gitWithEnv(
      fixture.source,
      { GIT_COMMITTER_DATE: "2026-08-01T00:00:00Z", GIT_AUTHOR_DATE: "2026-08-01T00:00:00Z" },
      "tag",
      "-a",
      "v0.3.0",
      fixCommit,
      "-m",
      "v0.3.0"
    );
    await git(fixture.source, "push", "-q", "origin", "--tags");
    await git(fixture.target, "fetch", "-q", "--tags", "origin");
    await dirtyRepo(fixture.target);
    const before = await snapshotRepo(fixture.target);

    const result = await runRelease(fixture.target, "--plan");
    const after = await snapshotRepo(fixture.target);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Baseline tag: v0.3.0");
    expect(result.stdout).toContain("No release-worthy commits found.");
    expect(after).toEqual(before);
  });

  it("prints exact release notes without mutating a dirty repo even when the heading date is non-ISO", async () => {
    const fixture = await createFixture({
      changelog: [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "## [1.2.0] - TBD",
        "",
        "### Added",
        "",
        "- Release planning",
        "",
        "## [1.1.0] - 2026-07-01",
        "",
        "### Fixed",
        "",
        "- Preserve compatibility",
        "",
      ].join("\n"),
    });
    await dirtyRepo(fixture.target);
    const before = await snapshotRepo(fixture.target);

    const result = await runRelease(fixture.target, "--notes", "1.2.0");
    const after = await snapshotRepo(fixture.target);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.replace(/\r\n/g, "\n")).toBe("### Added\n\n- Release planning\n");
    expect(result.stderr).toBe("");
    expect(after).toEqual(before);
  });

  it.each([
    {
      version: "9.9.9",
      changelog: DEFAULT_CHANGELOG,
      message: "could not find release notes for 9.9.9",
    },
    {
      version: "1.0.0",
      changelog: [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "## [1.0.0] - 2026-08-01",
        "",
      ].join("\n"),
      message: "could not find release notes for 1.0.0",
    },
  ])("fails nonzero for missing or empty notes: $version", async ({ version, changelog, message }) => {
    const fixture = await createFixture({ changelog });

    const result = await runRelease(fixture.target, "--notes", version);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  });

  it("rejects unknown args before touching the repository", async () => {
    const fixture = await createFixture();
    await dirtyRepo(fixture.target);
    const before = await snapshotRepo(fixture.target);

    const result = await runRelease(fixture.target, "--wat");
    const after = await snapshotRepo(fixture.target);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown");
    expect(result.stderr).not.toContain("clean working tree");
    expect(after).toEqual(before);
  });

  it("keeps positional release mode protected by clean-tree and duplicate-tag checks", async () => {
    const dirtyFixture = await createFixture();
    await dirtyRepo(dirtyFixture.target);

    const dirtyResult = await runRelease(dirtyFixture.target, "0.1.1");

    expect(dirtyResult.code).toBe(1);
    expect(dirtyResult.stderr).toContain("clean working tree");

    const taggedFixture = await createFixture({ initialTag: "v0.1.0" });

    const taggedResult = await runRelease(taggedFixture.target, "0.1.0");

    expect(taggedResult.code).toBe(1);
    expect(taggedResult.stderr).toContain("tag v0.1.0 already exists");
  });
});
