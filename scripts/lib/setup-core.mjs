// Pure installer decision helpers, extracted from setup.mjs so their boundaries
// are unit-testable in isolation. Node built-ins only (runs before npm install).

/**
 * Does this Node satisfy discord-copilot-sdk's engines (^20.19 || >=22.12)? The boundary
 * versions matter: 20.18 is too old, 20.19 is the first supported 20.x; 21.x is
 * unsupported (odd/non-LTS); 22.11 is too old, 22.12 is the first supported 22.x.
 * @param {string} v e.g. process.versions.node ("22.12.0")
 */
export function nodeVersionOk(v = process.versions.node) {
  const [maj, min] = String(v).split(".").map(Number);
  if (!Number.isFinite(maj) || !Number.isFinite(min)) return false;
  if (maj === 20) return min >= 19; // ^20.19
  if (maj >= 22) return maj > 22 || min >= 12; // >=22.12
  return false; // <20, 20.<19, or 21.x
}

/**
 * Fast mirror of the filesystem rules in src/core/repo.ts's resolveReposRoot().
 *
 * REPOS_ROOT must exist, be a directory, and — this is the INVERSE of the rule
 * this function enforced when there was one `CONTROLLED_REPO_PATH` — must NOT
 * itself be a git working-tree root. A repos root CONTAINS repos; pointing it at
 * a repo (by pasting the old single-repo value during migration) is exactly the
 * mistake this check exists to name.
 *
 * It must also not sit on either side of the bot's own state directory: an
 * agent's working directory may not have the trust store as an ancestor, and the
 * trust store may not be reachable as a "repo" under the root.
 *
 * Returns a reason CODE, not a message, so this stays pure and i18n-free:
 *   null           — acceptable
 *   "notAbsolute"  — not an absolute path (the runtime refuses these outright,
 *                    because a relative path silently means a different
 *                    directory depending on the process's cwd; this also catches
 *                    Windows drive-relative `C:foo`)
 *   "missing"      — does not exist, or is not a directory
 *   "isRepo"       — exists, but is itself a git working-tree root (a `.git`
 *                    entry: a directory for a normal clone, a FILE for a linked
 *                    worktree, which is why this tests existence rather than
 *                    isDirectory)
 *   "trustOverlap" — contains, or sits inside, the bot's state/worktree dirs
 *
 * Why it exists even though setup.mjs also calls the REAL resolveReposRoot after
 * building: that one lives in dist/ and cannot run until after npm ci + build
 * (minutes). This gives the interactive prompt an immediate answer and fails a
 * bad --yes install in seconds. test/setup-core.test.ts asserts the two agree,
 * the same way test/config-contract.test.ts pins validate.mjs to the zod schema —
 * a mirror nobody checks is how they drift. (The absoluteness rule was added
 * precisely because the first version of this mirror omitted it and accepted
 * `.`, which the runtime rejects.)
 *
 * Why any of this is needed: parseConfig()'s zod schema deliberately does no
 * filesystem I/O, so it cannot tell that a path exists but is the wrong KIND of
 * directory. The installer once accepted a folder that merely CONTAINED several
 * repos, reported "installation complete", and the bot then died on its very
 * first launch inside DiscordCopilotApp.start(). An installer that reports
 * success for a config the runtime refuses is lying — in either direction.
 *
 * @param {string} p absolute path to check
 * @param {{existsSync:Function, statSync:Function}} fsMod node:fs (injectable for tests)
 * @param {{join:Function, isAbsolute:Function, resolve:Function, relative:Function, parse:Function}} pathMod node:path
 * @param {string} [stateDirPath] the bot's state directory (omit to skip the overlap rule)
 */
export function reposRootProblem(p, fsMod, pathMod, stateDirPath) {
  if (!p || !pathMod.isAbsolute(p)) return "notAbsolute";
  if (!fsMod.existsSync(p) || !fsMod.statSync(p).isDirectory()) return "missing";
  if (fsMod.existsSync(pathMod.join(p, ".git"))) return "isRepo";
  if (stateDirPath) {
    for (const other of [stateDirPath, `${stateDirPath}-worktrees`]) {
      if (pathsOverlap(p, other, pathMod)) return "trustOverlap";
    }
  }
  return null;
}

/**
 * True when either path IS the other, or contains it.
 *
 * Mirrors `pathRelation` in src/core/repo.ts, including the "case-fold only on
 * Windows" rule: lowercasing on Linux would report two genuinely different
 * directories (`/srv/Repos` and `/srv/repos`) as the same one.
 *
 * @param {string} a
 * @param {string} b
 * @param {{resolve:Function, relative:Function, isAbsolute:Function, parse:Function}} pathMod
 */
export function pathsOverlap(a, b, pathMod) {
  const fold = (s) => (process.platform === "win32" ? s.toLowerCase() : s);
  const trim = (s) => {
    const root = pathMod.parse(s).root;
    return s === root ? s : s.replace(/[\\/]+$/, "") || root;
  };
  const fa = fold(trim(pathMod.resolve(a)));
  const fb = fold(trim(pathMod.resolve(b)));
  if (fa === fb) return true;
  const inside = (child, parent) => {
    const rel = pathMod.relative(parent, child);
    return !!rel && !rel.startsWith("..") && !pathMod.isAbsolute(rel);
  };
  return inside(fa, fb) || inside(fb, fa);
}

/**
 * PID of a LIVE bot instance holding `lockPath`, or undefined if none.
 *
 * Reads the same lock file the app itself writes
 * (~/.discord-copilot-sdk/<instance>.lock, see src/core/single-instance.ts) —
 * deliberately not a second source of truth, the same reason run-bot.* keeps no
 * PID file of its own.
 *
 * The installer uses this to refuse reinstalling over a running bot. npm has to
 * replace files inside node_modules that the live process holds open; on
 * Windows that is a hard EPERM ("operation not permitted, unlink
 * ...copilot-win32-x64/prebuilds/win32-x64/runtime.node") which reads like a
 * permissions or antivirus problem and names nothing that would help. Re-running
 * the installer to FIX a bad config is exactly when the bot is most likely to be
 * running, so this is the common path, not an edge case.
 *
 * Fails OPEN (undefined) on a missing/garbage/unreadable lock: the guard exists
 * to turn a confusing error into a clear one, and refusing to install because a
 * stale file could not be parsed would be worse than the failure it prevents. A
 * lock left by a crashed process is likewise ignored, since its pid is not alive.
 *
 * @param {string} lockPath
 * @param {{existsSync:Function, readFileSync:Function}} fsMod node:fs (injectable)
 * @param {(pid:number, sig:number)=>void} killFn process.kill (injectable)
 */
export function livePidFromLock(lockPath, fsMod, killFn) {
  try {
    if (!fsMod.existsSync(lockPath)) return undefined;
    const pid = Number.parseInt(String(fsMod.readFileSync(lockPath, "utf8")).trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return undefined;
    try {
      // Signal 0 checks existence without sending anything.
      killFn(pid, 0);
      return pid;
    } catch (e) {
      // ESRCH = no such process (stale lock). EPERM = it exists but belongs to
      // another user — still alive, still holding the files npm wants to replace.
      return e && e.code === "EPERM" ? pid : undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * Log target shown in the installer's completion report.
 *
 * Manual launches write `run-bot.<instance>.log`, but residency uses its own
 * platform-specific target: a named file for Windows/macOS, the user journal on
 * Linux. The completion report must name the log for the launch mode setup just
 * configured, not a different one the operator might never use.
 *
 * @param {{platform:string, stateDir:string, instance:string, residencyInstalled:boolean}} input
 * @param {{join:Function}} pathMod node:path (injectable)
 */
export function reportLogInfo({ platform, stateDir, instance, residencyInstalled }, pathMod) {
  if (residencyInstalled) {
    if (platform === "linux") {
      return {
        kind: "command",
        value: `journalctl --user -u discord-copilot-sdk-${instance}.service -f`,
        afterFirstStart: false,
      };
    }
    return {
      kind: "path",
      value: pathMod.join(stateDir, "logs", `discord-copilot-sdk-${instance}.log`),
      afterFirstStart: false,
    };
  }
  return {
    kind: "path",
    value: pathMod.join(stateDir, "logs", `run-bot.${instance}.log`),
    afterFirstStart: true,
  };
}

/**
 * Create a bounded rolling line buffer for streamed installer child output.
 *
 * The quiet installer keeps the FULL output on disk but only the final N lines
 * in memory for actionable failure reporting. The buffer must handle arbitrary
 * chunk boundaries, because child stdout/stderr can split a line anywhere.
 *
 * @param {number} maxLines
 */
export function createOutputTail(maxLines = 40, maxLineChars = 4000) {
  if (!Number.isInteger(maxLines) || maxLines < 1) throw new TypeError("maxLines must be an integer at least 1");
  if (!Number.isInteger(maxLineChars) || maxLineChars < 1) throw new TypeError("maxLineChars must be an integer at least 1");
  return { maxLines, maxLineChars, lines: [], partial: "", pendingLfFromCr: false };
}

function clampTailLine(text, maxLineChars) {
  const value = String(text);
  if (value.length <= maxLineChars) return value;
  return maxLineChars === 1 ? "…" : `…${value.slice(-(maxLineChars - 1))}`;
}

/**
 * Feed one streamed text chunk into a bounded output tail created by
 * createOutputTail().
 *
 * @param {{maxLines:number, lines:string[], partial:string}} tail
 * @param {string|Buffer} chunk
 */
export function pushOutputTail(tail, chunk) {
  let text = String(chunk);
  if (tail.pendingLfFromCr && text.startsWith("\n")) text = text.slice(1);
  tail.pendingLfFromCr = false;
  const combined = `${tail.partial}${text}`;
  const parts = combined.split(/\r\n|\n|\r/u);
  tail.pendingLfFromCr = combined.endsWith("\r");
  tail.partial = clampTailLine(parts.pop() ?? "", tail.maxLineChars);
  tail.lines.push(...parts.map((line) => clampTailLine(line, tail.maxLineChars)));
  if (tail.lines.length > tail.maxLines) tail.lines.splice(0, tail.lines.length - tail.maxLines);
}

/**
 * Materialize the current bounded tail as lines, including a final unterminated
 * line if one is in progress.
 *
 * @param {{maxLines:number, lines:string[], partial:string}} tail
 */
export function outputTailLines(tail) {
  const lines = tail.partial ? [...tail.lines, tail.partial] : [...tail.lines];
  return lines.slice(-tail.maxLines);
}

/**
 * Write one decoded child-output chunk to multiple sinks while respecting
 * backpressure across all of them. The source stream pauses once when the first
 * sink backpressures and resumes only after every blocked sink drains.
 *
 * @param {{pause:Function, resume:Function}} source
 * @param {string} text
 * @param {Array<{write:Function, once:Function, off?:Function}>} sinks
 */
export function writeChunkToSinks(source, text, sinks) {
  let pending = 0;
  const drains = [];
  const onDrain = () => {
    pending -= 1;
    if (pending === 0) source.resume();
  };
  for (const sink of sinks) {
    try {
      if (!sink.write(text)) {
        if (pending === 0) source.pause();
        pending += 1;
        const listener = () => onDrain();
        drains.push([sink, listener]);
        sink.once("drain", listener);
      }
    } catch (e) {
      for (const [drainSink, listener] of drains) drainSink.off?.("drain", listener);
      throw e;
    }
  }
}
