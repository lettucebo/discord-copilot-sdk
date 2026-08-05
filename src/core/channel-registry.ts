import fs from "node:fs";
import path from "node:path";
import { channelRegistryPath } from "./paths.js";

const SCHEMA_VERSION = 1;

/** One channel the owner enabled at runtime. The seed channel is NOT stored —
 *  it comes from `DISCORD_PARENT_CHANNEL_ID` and is always enabled. */
export interface ChannelEntry {
  id: string;
  /** Discord user id that ran `/channel enable`, for the audit trail in `/channel list`. */
  addedBy: string;
  addedAt: number;
}

interface RegistryFile {
  version: number;
  /** The guild these ids belong to. A file from a different guild is refused
   *  outright rather than filtered: ids are only meaningful within a guild. */
  guildId: string;
  channels: ChannelEntry[];
}

/**
 * The durable set of channels the bot will act in.
 *
 * ## Why corruption is FATAL here
 *
 * This store is unusual: degrading gracefully would cause irreversible damage.
 * If an unreadable file silently meant "only the seed channel", every session
 * living under a secondary channel would fail `bindingOk` at the next startup
 * and be marked `blocked` — and `blocked` is terminal (`reconcile.ts`), so
 * re-enabling the channel afterwards does NOT bring those conversations back.
 * So this class follows `SessionStore` (present-but-unreadable ⇒ refuse to
 * start) and deliberately NOT `ApprovalPolicy` (invalid ⇒ empty), whose
 * degradation only costs an extra approval prompt.
 *
 * A missing file is the ordinary first-run state and means "seed only".
 *
 * ## Write discipline
 *
 * Persist-first: memory is updated only after the atomic write succeeds, so a
 * channel that is authorized in memory is always authorized on disk too. Every
 * mutation bumps `epoch` so tests and diagnostics can observe a durable change.
 * Product authorization gates check their TARGET channel directly, rather than
 * using this global counter: an unrelated channel mutation must not abort work
 * in a channel whose authorization never changed.
 */
export class ChannelRegistry {
  private readonly file: string;
  private readonly enabled = new Map<string, ChannelEntry>();
  private corrupt = false;
  private corruptDetail?: string;
  private generation = 0;
  private cache?: ReadonlySet<string>;

  constructor(
    /** `DISCORD_PARENT_CHANNEL_ID` — always enabled, never removable. */
    readonly seedChannelId: string,
    /** `DISCORD_GUILD_ID` — a registry naming any other guild is refused. */
    private readonly guildId: string,
    file: string = channelRegistryPath()
  ) {
    this.file = file;
    this.load();
  }

  /** True when the file exists but could not be trusted. Startup MUST refuse. */
  isCorrupt(): boolean {
    return this.corrupt;
  }

  /** Why the load failed, for the startup error message. */
  corruptReason(): string | undefined {
    return this.corruptDetail;
  }

  /** Bumped by every successful mutation. See the class comment. */
  get epoch(): number {
    return this.generation;
  }

  /** Channels the bot will act in: the seed plus everything enabled at runtime.
   *
   *  Empty while corrupt. Startup already refuses in that case, so this is only
   *  belt-and-braces — but the safe answer to "which channels are authorized"
   *  when the answer is unknown is "none", never "the seed", because callers
   *  cannot tell a deliberate seed-only setup from a lost one. */
  enabledSet(): ReadonlySet<string> {
    if (this.corrupt) return new Set();
    if (!this.cache) {
      this.cache = new Set<string>([this.seedChannelId, ...this.enabled.keys()]);
    }
    return this.cache;
  }

  isSeed(channelId: string): boolean {
    return channelId === this.seedChannelId;
  }

  has(channelId: string): boolean {
    return this.enabledSet().has(channelId);
  }

  /** Runtime-enabled channels only, oldest first — the seed is not in here. */
  entries(): ChannelEntry[] {
    return [...this.enabled.values()].sort((a, b) => a.addedAt - b.addedAt);
  }

  /**
   * Enable a channel. Returns DURABILITY: `false` means nothing changed, in
   * memory or on disk, and the caller must report failure rather than success.
   *
   * Enabling the seed is a no-op success — it is already permanently enabled,
   * and writing it to the file would make the file disagree with `.env` the
   * moment the seed changes.
   */
  enable(channelId: string, addedBy: string): boolean {
    if (this.corrupt) return false;
    if (this.isSeed(channelId) || this.enabled.has(channelId)) return true;
    const next = new Map(this.enabled);
    next.set(channelId, { id: channelId, addedBy, addedAt: Date.now() });
    return this.commit(next);
  }

  /** Disable a channel. Returns durability. Refusing to remove the seed is the
   *  CALLER's job (it needs to explain why); here it is simply never present. */
  disable(channelId: string): boolean {
    if (this.corrupt) return false;
    if (!this.enabled.has(channelId)) return true;
    const next = new Map(this.enabled);
    next.delete(channelId);
    return this.commit(next);
  }

  private commit(next: Map<string, ChannelEntry>): boolean {
    const candidate: RegistryFile = {
      version: SCHEMA_VERSION,
      guildId: this.guildId,
      channels: [...next.values()],
    };
    if (!this.write(candidate)) return false;
    this.enabled.clear();
    for (const [k, v] of next) this.enabled.set(k, v);
    this.cache = undefined;
    this.generation += 1;
    return true;
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      // Only a genuinely-absent file is "seed only". Any OTHER read error
      // (permissions, a directory in the way, a sharing violation) is corrupt:
      // it is indistinguishable from a registry we simply cannot see, and
      // guessing "seed only" is the irreversible guess.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
      this.markCorrupt(`cannot read it (${(err as Error).message})`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.markCorrupt(`it is not valid JSON (${(err as Error).message})`);
      return;
    }
    const readIt = readRegistry(parsed);
    if (!readIt) {
      this.markCorrupt("its contents do not match the expected schema");
      return;
    }
    if (readIt.version !== SCHEMA_VERSION) {
      // Forward AND backward: a newer file may carry fields whose meaning this
      // build would silently ignore, and ignoring a field in an authorization
      // list is exactly the failure this class exists to prevent.
      this.markCorrupt(`it declares version ${readIt.version}, but this build only understands ${SCHEMA_VERSION}`);
      return;
    }
    if (readIt.guildId !== this.guildId) {
      this.markCorrupt(
        `it belongs to guild ${readIt.guildId}, but DISCORD_GUILD_ID is ${this.guildId}. ` +
          `Channel ids are only meaningful within one guild`
      );
      return;
    }
    for (const c of readIt.channels) {
      if (c.id === this.seedChannelId) continue; // the seed is config, not data
      this.enabled.set(c.id, c);
    }
  }

  private markCorrupt(detail: string): void {
    this.corrupt = true;
    this.corruptDetail = detail;
  }

  /** Atomically write the file. Returns false (and logs) on any I/O error —
   *  callers' fail-closed handling depends on it never throwing. */
  private write(candidate: RegistryFile): boolean {
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(candidate, null, 2), "utf8");
      renameWithRetry(tmp, this.file);
      return true;
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* leave the temp file rather than mask the real failure */
      }
      console.warn(
        `⚠️  could not persist the channel registry to ${this.file}: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }
}

/**
 * The atomic replace, retried through a transient Windows failure. Same
 * reasoning (and the same codes/delays) as `SessionStore.renameWithRetry`: an
 * antivirus scanner holding the target for an instant must not be reported to
 * the operator as "your disk is broken".
 */
function renameWithRetry(from: string, to: string): void {
  const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
  const delays = [5, 15, 30, 40];
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (i >= delays.length || !TRANSIENT.has(code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[i]!);
    }
  }
}

/** Parse a registry file, or undefined if it is not one. Strict on purpose: a
 *  half-understood authorization list is worse than none. */
function readRegistry(v: unknown): RegistryFile | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o["version"] !== "number") return undefined;
  if (typeof o["guildId"] !== "string" || !o["guildId"]) return undefined;
  const rawChannels = o["channels"];
  if (!Array.isArray(rawChannels)) return undefined;
  const channels: ChannelEntry[] = [];
  for (const entry of rawChannels) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const e = entry as Record<string, unknown>;
    const id = e["id"];
    const addedBy = e["addedBy"];
    const addedAt = e["addedAt"];
    if (typeof id !== "string" || !id) return undefined;
    if (typeof addedBy !== "string") return undefined;
    if (typeof addedAt !== "number" || !Number.isFinite(addedAt)) return undefined;
    channels.push({ id, addedBy, addedAt });
  }
  return { version: o["version"], guildId: o["guildId"], channels };
}
