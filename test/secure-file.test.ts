import { describe, it, expect } from "vitest";
import { secureWrite, secureBackup, hardenExisting } from "../scripts/lib/secure-file.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";

const dir = () => mkdtempSync(join(tmpdir(), "dp-secure-"));
const noTmp = (d) => readdirSync(d).filter((f) => f.endsWith(".tmp"));

describe("secureWrite", () => {
  it("writes the contents atomically and leaves no temp behind", () => {
    const d = dir();
    try {
      const target = join(d, ".env");
      secureWrite(target, "SECRET=abc\n", { applyAcl: () => {} });
      expect(readFileSync(target, "utf8")).toBe("SECRET=abc\n");
      expect(noTmp(d)).toEqual([]); // unique temp cleaned up on the rename
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("writes the file even with NO applyAcl (the non-Windows production path)", () => {
    const d = dir();
    try {
      const target = join(d, ".env");
      secureWrite(target, "SECRET=noacl\n"); // applyAcl undefined
      expect(readFileSync(target, "utf8")).toBe("SECRET=noacl\n");
      expect(noTmp(d)).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("applies the ACL BEFORE the secret bytes are written (temp is empty at ACL time)", () => {
    const d = dir();
    try {
      const target = join(d, ".env");
      let sizeAtAcl = -1;
      secureWrite(target, "SECRET=xyz\n", {
        applyAcl: (f) => {
          sizeAtAcl = readFileSync(f, "utf8").length;
        },
      });
      expect(sizeAtAcl).toBe(0); // ACL ran while the temp was still empty
      expect(readFileSync(target, "utf8")).toBe("SECRET=xyz\n");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("uses a unique per-invocation temp (never a fixed <target>.tmp)", () => {
    const d = dir();
    try {
      const target = join(d, ".env");
      let seen;
      secureWrite(target, "SECRET=uniq\n", {
        applyAcl: (f) => {
          seen = f;
        },
      });
      expect(seen).toBeDefined();
      expect(seen).not.toBe(target + ".tmp"); // not the fixed name a concurrent run could clobber
      expect(seen.startsWith(target + ".")).toBe(true); // same dir, unique suffix
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("FAIL-CLOSED: on ACL failure removes its OWN temp, throws, and never creates the target", () => {
    const d = dir();
    try {
      const target = join(d, ".env");
      expect(() =>
        secureWrite(target, "SECRET=nope\n", {
          applyAcl: () => {
            throw new Error("icacls boom");
          },
          onAclFail: (m) => new Error("aborting: " + m),
        })
      ).toThrow(/aborting: icacls boom/);
      expect(existsSync(target)).toBe(false); // secret never written
      expect(noTmp(d)).toEqual([]); // temp cleaned up
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("does NOT touch an existing target when the ACL fails", () => {
    const d = dir();
    try {
      const target = join(d, ".env");
      writeFileSync(target, "PRE=existing\n");
      expect(() =>
        secureWrite(target, "SECRET=new\n", {
          applyAcl: () => {
            throw new Error("boom");
          },
        })
      ).toThrow();
      expect(readFileSync(target, "utf8")).toBe("PRE=existing\n"); // untouched
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("secureBackup", () => {
  it("secures the destination BEFORE copying the secret, and copies exactly", () => {
    const d = dir();
    try {
      const src = join(d, ".env");
      writeFileSync(src, "SECRET=keep\n");
      let sizeAtAcl = -1;
      const dest = join(d, "backups", ".env.bak");
      secureBackup(src, dest, {
        applyAcl: (f) => {
          sizeAtAcl = readFileSync(f, "utf8").length;
        },
      });
      expect(sizeAtAcl).toBe(0); // dest empty at ACL time
      expect(readFileSync(dest, "utf8")).toBe("SECRET=keep\n");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("copies even with NO applyAcl (non-Windows path), creating the backup dir", () => {
    const d = dir();
    try {
      const src = join(d, ".env");
      writeFileSync(src, "SECRET=keep2\n");
      const dest = join(d, "backups", ".env.bak");
      secureBackup(src, dest); // applyAcl undefined
      expect(readFileSync(dest, "utf8")).toBe("SECRET=keep2\n");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("FAIL-CLOSED: on ACL failure removes the empty backup, throws, never copies the secret", () => {
    const d = dir();
    try {
      const src = join(d, ".env");
      writeFileSync(src, "SECRET=keep\n");
      const dest = join(d, "backups", ".env.bak");
      expect(() =>
        secureBackup(src, dest, {
          applyAcl: () => {
            throw new Error("boom");
          },
          onAclFail: (m) => new Error("backup aborted: " + m),
        })
      ).toThrow(/backup aborted/);
      expect(existsSync(dest)).toBe(false); // no secret-bearing backup left
      expect(readFileSync(src, "utf8")).toBe("SECRET=keep\n"); // source untouched
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("hardenExisting", () => {
  it("returns true when the ACL applies, and does NOT call onAclFail", () => {
    const d = dir();
    try {
      const f = join(d, ".env");
      writeFileSync(f, "x\n");
      let failMsg;
      expect(hardenExisting(f, { applyAcl: () => {}, onAclFail: (m) => (failMsg = m) })).toBe(true);
      expect(failMsg).toBeUndefined();
      expect(existsSync(f)).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("NEVER deletes the file on ACL failure — returns false, keeps it, reports the reason", () => {
    const d = dir();
    try {
      const f = join(d, ".env");
      writeFileSync(f, "VALID=env\n");
      let failMsg;
      const okAcl = hardenExisting(f, {
        applyAcl: () => {
          throw new Error("no ACL on this fs");
        },
        onAclFail: (m) => (failMsg = m),
      });
      expect(okAcl).toBe(false);
      expect(failMsg).toBe("no ACL on this fs"); // detail preserved for the caller's warning
      expect(existsSync(f)).toBe(true); // the valid .env is preserved
      expect(readFileSync(f, "utf8")).toBe("VALID=env\n");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("returns true on the no-applyAcl (non-Windows) path when chmod succeeds", () => {
    const d = dir();
    try {
      const f = join(d, ".env");
      writeFileSync(f, "y\n");
      expect(hardenExisting(f)).toBe(true); // chmod on an owned temp file succeeds
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// Real-icacls coverage of the write/ACL seam. Injected fakes prove ordering and
// fail-closed logic above; this proves the ACTUAL Windows command produces an
// owner-only DACL when driven through secureWrite's empty→ACL→write→rename path.
const winOnly = process.platform === "win32" ? describe : describe.skip;
winOnly("secureWrite with the real Windows ACL (icacls)", () => {
  const realAcl = (file) => {
    const user = process.env.USERNAME
      ? `${process.env.USERDOMAIN || "."}\\${process.env.USERNAME}`
      : undefined;
    if (!user) throw new Error("no USERNAME to grant");
    execFileSync(
      "icacls",
      [file, "/inheritance:r", "/remove:g", "*S-1-1-0", "*S-1-5-32-545", "*S-1-5-11", "/grant:r", `${user}:(F)`],
      { stdio: "ignore" }
    );
  };

  it("produces a DACL that grants ONLY the current user", () => {
    const d = dir();
    try {
      const target = join(d, ".env");
      secureWrite(target, "SECRET=real\n", { applyAcl: realAcl });
      expect(readFileSync(target, "utf8")).toBe("SECRET=real\n");
      const acl = execFileSync("icacls", [target], { encoding: "utf8" });
      // No broad principals survive the /inheritance:r + /remove:g + /grant:r.
      expect(acl).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users/i);
      expect(acl).toMatch(new RegExp(`${process.env.USERNAME}`, "i"));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
