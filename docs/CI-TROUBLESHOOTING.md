# CI Troubleshooting

> **English** · [繁體中文](CI-TROUBLESHOOTING.zh-TW.md)

This guide records recurring failures in this repository's GitHub Actions matrix and the checks to run before pushing.

## 1. Reproduce CI locally

CI runs Node 20.19 and 22.12 on Ubuntu and Windows. Vitest is intentionally serialized because several suites create real Git repositories and worktrees.

```bash
npm install --no-audit --no-fund
npm run typecheck
npm test
```

There is no TypeScript lint command. `npm run build` does not typecheck `test/`; use `npm run typecheck`. A missing `node_modules` directory produces many misleading “Cannot find module” errors, so install dependencies first.

The script-check job also runs:

```bash
for f in install.sh get.sh update.sh run-bot.sh stop-bot.sh uninstall.sh; do bash -n "$f"; done
for f in scripts/setup.mjs scripts/run.mjs scripts/update.mjs scripts/uninstall.mjs scripts/release.mjs scripts/lib/*.mjs; do node --check "$f"; done
```

PowerShell parsing is authoritative in CI when `pwsh` is unavailable locally.

## 2. Common failures

### `Hook timed out` or `EPERM ... git.exe` in `update-integration`

Do not copy or link a test-only executable into the fixture tree. On Windows
with Node 20.19, a Git wrapper can keep recursive fixture cleanup from
finishing. Recursive `fs.rm` retries can apply to more than one path, so a
suite timeout cannot be safely derived by multiplying a retry budget by the
number of wrappers.

Use a `NODE_OPTIONS` preload to intercept the test process's literal
`execFileSync("git", ...)` calls and delegate to the real Git executable. This
preserves the fault-injection coverage on Windows without placing a lockable
executable in the fixture. Keep cleanup bounded and fail closed; do not use
unbounded retries or ignore cleanup errors.

### Windows path assertions fail but Ubuntu passes

Git Bash paths, Windows short names such as `RUNNER~1`, canonical handle paths, drive-letter casing, and backslash escaping can describe the same location differently. Derive expectations from validated handles or Node path APIs. Do not hardcode a runner path or compare an unnormalized display spelling.

### Shell bootstrap reports `No such file or directory` on Windows

A path produced by Node is not automatically a valid Git Bash path. Keep fixture paths inside the checkout when the test invokes Bash, and pass paths through the same conversion boundary used by the shipped wrapper.

### Fixture `git commit` reports an unknown or empty identity

Hosted runners do not guarantee a usable global Git identity. Every temporary repository that commits must set local `user.name`, `user.email`, and, where relevant, `commit.gpgsign=false`.

### A “missing npm” test runs the real npm or misses the expected command

Windows resolves `.cmd` launchers differently from POSIX executables. Build the fixture `PATH` explicitly, preserve both `PATH` and `Path` where required, and assert the protected setup log rather than relying on a developer machine's global tools.

### Installer/runtime configuration contract fails

`src/config.ts`, `scripts/lib/validate.mjs`, and `test/config-contract.test.ts` form one contract. Update the runtime schema, installer validation/managed keys, and shared acceptance corpus together. Empty optional values must keep the same meaning on both sides.

### Script checks fail only on one platform

All shipped `.sh` files require a shebang, LF endings, and executable Git mode. User-facing `.ps1` files require their repository encoding/line-ending contract and must parse after the UTF-8 BOM is preserved then trimmed, matching `Invoke-RestMethod`.

### Logs contain warnings although tests pass

Several fail-closed tests deliberately trigger persistence, permission, reconciliation, or resume errors and write to stderr. Judge the Vitest summary and exit code; do not “fix” expected warnings by silencing the behavior under test.

## 3. Why a session's first CI run often fails

This is not a Copilot-session startup failure. A branch push starts the complete four-way OS/Node matrix, while development commonly happens on only one OS. The first run therefore exposes Windows process locking, path spelling, shell, or hosted-runner assumptions that local Ubuntu validation cannot exercise. Each fix creates another commit and therefore another CI run, which makes the history look like “every session fails first, then succeeds.”

Reduce that loop by:

1. running the full commands in §1 before pushing;
2. treating temporary Git repositories as isolated fixtures with explicit identity and cleanup;
3. avoiding literal platform paths and global-tool assumptions;
4. checking every failed matrix job, not only the first failure; and
5. distinguishing local validation from the final GitHub Actions result.

## 4. Reading a failure

1. Open the latest **CI** workflow run, not the Copilot agent workflow.
2. Identify the failing OS and Node version.
3. Read the first failed assertion or hook error; later cleanup errors may be secondary.
4. Re-run the smallest affected file, for example:

   ```bash
   npx vitest run test/update-integration.test.ts
   ```

5. Finish with `npm run typecheck && npm test`.
