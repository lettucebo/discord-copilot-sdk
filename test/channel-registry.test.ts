import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelRegistry } from "../src/core/channel-registry.js";

const SEED = "seed-channel";
const GUILD = "guild-1";

function inTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "dcs-channel-registry-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

describe("ChannelRegistry", () => {
  it("starts seed-only for a missing file, persists an enable atomically, and reloads its exact data", () => {
    inTempDir((dir) => {
      const file = join(dir, "channels.json");
      const first = new ChannelRegistry(SEED, GUILD, file);

      expect(first.isCorrupt()).toBe(false);
      expect(first.enabledSet()).toEqual(new Set([SEED]));
      expect(first.enable("secondary-channel", "user-1")).toBe(true);

      const entry = first.entries()[0]!;
      expect(entry).toEqual({
        id: "secondary-channel",
        addedBy: "user-1",
        addedAt: expect.any(Number),
      });
      expect(readFileSync(file, "utf8")).toBe(
        JSON.stringify({ version: 1, guildId: GUILD, channels: [entry] }, null, 2)
      );
      expect(existsSync(`${file}.tmp`)).toBe(false);

      const reloaded = new ChannelRegistry(SEED, GUILD, file);
      expect(reloaded.isCorrupt()).toBe(false);
      expect(reloaded.enabledSet()).toEqual(new Set([SEED, "secondary-channel"]));
      expect(reloaded.entries()).toEqual([entry]);
    });
  });

  it("keeps the seed authorized but excludes its persisted duplicate from runtime entries", () => {
    inTempDir((dir) => {
      const file = join(dir, "channels.json");
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          guildId: GUILD,
          channels: [
            { id: SEED, addedBy: "stale-user", addedAt: 1 },
            { id: "secondary-channel", addedBy: "user-1", addedAt: 2 },
          ],
        }),
        "utf8"
      );

      const registry = new ChannelRegistry(SEED, GUILD, file);

      expect(registry.isSeed(SEED)).toBe(true);
      expect(registry.has(SEED)).toBe(true);
      expect(registry.enabledSet()).toEqual(new Set([SEED, "secondary-channel"]));
      expect(registry.entries()).toEqual([{ id: "secondary-channel", addedBy: "user-1", addedAt: 2 }]);
    });
  });

  it("keeps no-op mutations successful without advancing epoch, but advances it for persisted changes", () => {
    inTempDir((dir) => {
      const registry = new ChannelRegistry(SEED, GUILD, join(dir, "channels.json"));

      expect(registry.epoch).toBe(0);
      expect(registry.enable("secondary-channel", "user-1")).toBe(true);
      expect(registry.epoch).toBe(1);
      expect(registry.enable("secondary-channel", "user-2")).toBe(true);
      expect(registry.epoch).toBe(1);
      expect(registry.disable("missing-channel")).toBe(true);
      expect(registry.epoch).toBe(1);
      expect(registry.disable("secondary-channel")).toBe(true);
      expect(registry.epoch).toBe(2);
    });
  });

  it.each([
    ["invalid JSON", (file: string) => writeFileSync(file, "{", "utf8")],
    [
      "wrong schema",
      (file: string) => writeFileSync(file, JSON.stringify({ version: 1, guildId: GUILD, channels: {} }), "utf8"),
    ],
    [
      "unsupported version",
      (file: string) => writeFileSync(file, JSON.stringify({ version: 2, guildId: GUILD, channels: [] }), "utf8"),
    ],
    ["a directory where the file should be", (file: string) => mkdirSync(file)],
  ])("marks %s corrupt and authorizes no channels", (_case, createInvalidFile) => {
    inTempDir((dir) => {
      const file = join(dir, "channels.json");
      createInvalidFile(file);

      const registry = new ChannelRegistry(SEED, GUILD, file);

      expect(registry.isCorrupt()).toBe(true);
      expect(registry.corruptReason()).toEqual(expect.any(String));
      expect(registry.enabledSet()).toEqual(new Set());
      expect(registry.has(SEED)).toBe(false);
    });
  });

  it("marks a registry from a foreign guild corrupt", () => {
    inTempDir((dir) => {
      const file = join(dir, "channels.json");
      writeFileSync(file, JSON.stringify({ version: 1, guildId: "other-guild", channels: [] }), "utf8");

      const registry = new ChannelRegistry(SEED, GUILD, file);

      expect(registry.isCorrupt()).toBe(true);
      expect(registry.corruptReason()).toContain("other-guild");
      expect(registry.enabledSet()).toEqual(new Set());
    });
  });

  it("leaves memory unchanged when persistence fails", () => {
    inTempDir((dir) => {
      const parent = join(dir, "blocked-parent");
      const file = join(parent, "channels.json");
      const registry = new ChannelRegistry(SEED, GUILD, file);
      writeFileSync(parent, "not a directory", "utf8");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        const enabledBefore = new Set(registry.enabledSet());
        const entriesBefore = registry.entries();
        const epochBefore = registry.epoch;

        expect(registry.enable("secondary-channel", "user-1")).toBe(false);
        expect(registry.enabledSet()).toEqual(enabledBefore);
        expect(registry.entries()).toEqual(entriesBefore);
        expect(registry.epoch).toBe(epochBefore);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
