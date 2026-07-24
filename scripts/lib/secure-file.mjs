// Secure secret-file writing for the installer, extracted from setup.mjs so its
// atomicity + fail-closed behavior is unit-testable. Node built-ins only. The
// Windows ACL step is INJECTED (applyAcl) so tests can simulate ACL success and
// failure without touching real icacls.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Atomically write secret `contents` to `targetPath`:
 *  - create a UNIQUE per-invocation temp in the same dir (EMPTY, exclusive `wx`,
 *    owner-only mode),
 *  - lock its ACL (applyAcl) BEFORE any secret bytes land,
 *  - write the secret, then rename over the target (rename preserves the DACL).
 * On ACL failure it deletes ONLY its own just-created temp and throws (never
 * leaves an unprotected secret, never touches an existing target).
 *
 * The temp name is unique (`pid` + `randomUUID`) rather than a fixed
 * `<target>.tmp`: a fixed name could be deleted+recreated by a concurrent run
 * BETWEEN our ACL and our write, so our rename could publish another run's
 * not-yet-secured file (a secret in `.env` without the ACL). A unique name makes
 * that impossible and makes "clean up only the temp we created" literally true.
 *
 * @param applyAcl (file)=>void  — throws on failure; MUST NOT delete its input.
 * @param onAclFail (msg)=>Error — build the error to throw on ACL failure.
 */
export function secureWrite(targetPath, contents, { applyAcl, onAclFail } = {}) {
  const tmp = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (applyAcl) {
    try {
      applyAcl(tmp);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw onAclFail
        ? onAclFail(e instanceof Error ? e.message : String(e))
        : new Error("could not secure the temp file: " + (e instanceof Error ? e.message : String(e)));
    }
  }
  fs.writeFileSync(tmp, contents, { encoding: "utf8" });
  fs.renameSync(tmp, targetPath); // preserves the temp's locked DACL on Windows
  try {
    fs.chmodSync(targetPath, 0o600);
  } catch {
    /* windows: DACL already applied via the temp */
  }
}

/**
 * Copy `sourcePath` to a fresh backup at `destPath`, securing the destination
 * BEFORE the secret bytes are copied in: create empty → ACL → copy. On ACL
 * failure remove ONLY the (still-empty) backup and throw — never leaves a
 * world-readable backup, never touches the source. `destPath` MUST be unique per
 * invocation (the caller timestamps it); the exclusive `wx` create fails closed
 * if it somehow already exists.
 */
export function secureBackup(sourcePath, destPath, { applyAcl, onAclFail } = {}) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destPath, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (applyAcl) {
    try {
      applyAcl(destPath);
    } catch (e) {
      try {
        fs.rmSync(destPath, { force: true });
      } catch {
        /* ignore */
      }
      throw onAclFail
        ? onAclFail(e instanceof Error ? e.message : String(e))
        : new Error("could not secure the backup: " + (e instanceof Error ? e.message : String(e)));
    }
  }
  fs.writeFileSync(destPath, fs.readFileSync(sourcePath));
  try {
    fs.chmodSync(destPath, 0o600);
  } catch {
    /* windows */
  }
  return destPath;
}

/**
 * Best-effort harden of an EXISTING committed file (unchanged re-run path). MUST
 * NOT delete the file on ACL failure — deleting a valid existing secret file is
 * strictly worse than leaving it with imperfect permissions.
 *
 * Returns true when hardening succeeded. On Windows the ACL is the real
 * protection (chmod is a no-op), so an ACL failure returns false and reports the
 * reason via `onAclFail`. On non-Windows (no `applyAcl`) chmod IS the protection,
 * so a chmod failure returns false so the caller can warn.
 */
export function hardenExisting(file, { applyAcl, onAclFail } = {}) {
  let chmodOk = true;
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    chmodOk = false;
  }
  if (!applyAcl) return chmodOk; // non-Windows: chmod is the only protection
  try {
    applyAcl(file);
    return true; // Windows: ACL applied (chmod result is irrelevant)
  } catch (e) {
    if (onAclFail) onAclFail(e instanceof Error ? e.message : String(e));
    return false; // never delete; caller warns
  }
}
