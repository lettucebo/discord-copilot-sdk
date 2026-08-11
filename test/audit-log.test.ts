import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/core/audit-log.js";

describe("AuditLog", () => {
  it("appends durable JSONL records without overwriting earlier approvals", () => {
    const dir = mkdtempSync(join(tmpdir(), "dcs-audit-"));
    try {
      const file = join(dir, "audit.jsonl");
      const audit = new AuditLog(file, () => new Date("2026-08-11T03:00:00.000Z"));

      expect(audit.append({ sessionKey: "thread-1", text: "⚡ YOLO auto-approved — `read`: `a`" })).toBe(
        true
      );
      expect(audit.append({ sessionKey: "thread-1", text: "⚡ YOLO auto-approved — `read`: `b`" })).toBe(
        true
      );

      expect(readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([
        {
          timestamp: "2026-08-11T03:00:00.000Z",
          sessionKey: "thread-1",
          text: "⚡ YOLO auto-approved — `read`: `a`",
        },
        {
          timestamp: "2026-08-11T03:00:00.000Z",
          sessionKey: "thread-1",
          text: "⚡ YOLO auto-approved — `read`: `b`",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false without throwing when its target cannot be opened", () => {
    const dir = mkdtempSync(join(tmpdir(), "dcs-audit-"));
    try {
      const target = join(dir, "not-a-file");
      mkdirSync(target);
      const audit = new AuditLog(target);

      expect(audit.append({ sessionKey: "thread-1", text: "entry" })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the operating system reports a short write", () => {
    const dir = mkdtempSync(join(tmpdir(), "dcs-audit-"));
    try {
      const file = join(dir, "audit.jsonl");
      const write = vi
        .spyOn(fs, "writeSync")
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0);
      const audit = new AuditLog(file);

      expect(audit.append({ sessionKey: "thread-1", text: "entry" })).toBe(false);
      expect(write).toHaveBeenCalledTimes(2);
      write.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
