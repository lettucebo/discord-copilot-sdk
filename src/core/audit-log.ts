import fs from "node:fs";
import path from "node:path";
import { auditLogPath } from "./paths.js";

export interface AuditEntry {
  sessionKey: string;
  text: string;
}

export interface AuditSink {
  append(entry: AuditEntry): boolean;
}

/**
 * Durable append-only audit log for permissions that execute without a Discord
 * approval card. A synchronous write + fsync completes before the SDK receives
 * approval, so the bot never relies on a best-effort Discord render as its only
 * record of a YOLO action.
 */
export class AuditLog implements AuditSink {
  constructor(
    private readonly file: string = auditLogPath(),
    private readonly now: () => Date = () => new Date()
  ) {}

  append(entry: AuditEntry): boolean {
    let fd: number | undefined;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const line =
        JSON.stringify({
          timestamp: this.now().toISOString(),
          sessionKey: entry.sessionKey,
          text: entry.text,
        }) + "\n";
      fd = fs.openSync(this.file, "a");
      const bytes = Buffer.from(line, "utf8");
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (!Number.isInteger(written) || written <= 0) {
          throw new Error("audit log write made no forward progress");
        }
        offset += written;
      }
      fs.fsyncSync(fd);
      return true;
    } catch (err) {
      console.warn(
        `⚠️  could not append approval audit to ${this.file}: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* the append outcome was already determined */
        }
      }
    }
  }
}
