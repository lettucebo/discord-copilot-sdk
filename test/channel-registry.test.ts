import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelRegistry, CONFIG_SEED_ADDED_BY } from "../src/core/channel-registry.js";

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
  it("persists the configured default on first run, then reloads exact v2 data", () => {
    inTempDir((dir) => {
      const file = join(dir, "channels.json");
      const first = new ChannelRegistry(SEED, GUILD, file);

      expect(first.isCorrupt()).toBe(false);
      expect(first.enabledSet()).toEqual(new Set([SEED]));
      const configuredDefault = first.entries()[0]!;
      expect(configuredDefault).toEqual({
        id: SEED,
        addedBy: CONFIG_SEED_ADDED_BY,
        addedAt: expect.any(Number),
      });
      expect(first.enable("secondary-channel", "user-1")).toBe(true);

      const entry = first.entries()[1]!;
      expect(entry).toEqual({
        id: "secondary-channel",
        addedBy: "user-1",
        addedAt: expect.any(Number),
      });
      expect(readFileSync(file, "utf8")).toBe(
        JSON.stringify({ version: 2, guildId: GUILD, channels: [configuredDefault, entry] }, null, 2)
      );
      expect(existsSync(`${file}.tmp`)).toBe(false);

      const reloaded = new ChannelRegistry(SEED, GUILD, file);
      expect(reloaded.isCorrupt()).toBe(false);
      expect(reloaded.enabledSet()).toEqual(new Set([SEED, "secondary-channel"]));
      expect(reloaded.entries()).toEqual([configuredDefault, entry]);
    });
  });

  it("migrates a v1 file by preserving entries and adding the configured default once", () => {
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

      expect(registry.has(SEED)).toBe(true);
      expect(registry.enabledSet()).toEqual(new Set([SEED, "secondary-channel"]));
      expect(registry.entries()).toEqual([
        { id: SEED, addedBy: "stale-user", addedAt: 1 },
        { id: "secondary-channel", addedBy: "user-1", addedAt: 2 },
      ]);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
        version: 2,
        guildId: GUILD,
        channels: [
          { id: SEED, addedBy: "stale-user", addedAt: 1 },
          { id: "secondary-channel", addedBy: "user-1", addedAt: 2 },
        ],
      });
    });
  });

  it("adds a missing configured default while migrating v1 without dropping existing channels", () => {
    inTempDir((dir) => {
      const file = join(dir, "channels.json");
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          guildId: GUILD,
          channels: [{ id: "secondary-channel", addedBy: "user-1", addedAt: 2 }],
        }),
        "utf8"
      );

      const registry = new ChannelRegistry(SEED, GUILD, file);

      expect(registry.enabledSet()).toEqual(new Set(["secondary-channel", SEED]));
      expect(registry.entries()).toEqual([
        { id: "secondary-channel", addedBy: "user-1", addedAt: 2 },
        { id: SEED, addedBy: CONFIG_SEED_ADDED_BY, addedAt: expect.any(Number) },
      ]);
    });
  });

  it("treats an absent configured default in v2 as deliberately disabled", () => {
    inTempDir((dir) => {
      const file = join(dir, "channels.json");
      writeFileSync(
        file,
        JSON.stringify({
          version: 2,
          guildId: GUILD,
          channels: [{ id: "secondary-channel", addedBy: "user-1", addedAt: 2 }],
        }),
        "utf8"
      );

      const registry = new ChannelRegistry(SEED, GUILD, file);

      expect(registry.has(SEED)).toBe(false);
      expect(registry.enabledSet()).toEqual(new Set(["secondary-channel"]));
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
      (file: string) => writeFileSync(file, JSON.stringify({ version: 3, guildId: GUILD, channels: [] }), "utf8"),
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
      rmSync(parent, { force: true, recursive: true });
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

  it("throws when the first-run default cannot be persisted", () => {
    inTempDir((dir) => {
      const file = join(dir, "channels.json");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
        throw Object.assign(new Error("disk write failed"), { code: "EIO" });
      });
      try {
        expect(() => new ChannelRegistry(SEED, GUILD, file)).toThrow(
          /refusing to start with an empty authorization set/
        );
      } finally {
        rename.mockRestore();
        warn.mockRestore();
      }
    });
  });

  it("throws instead of authorizing a partial set when v1 migration cannot persist", () => {
    inTempDir((dir) => {
      const file = join(dir, "channels.json");
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          guildId: GUILD,
          channels: [{ id: "secondary-channel", addedBy: "user-1", addedAt: 2 }],
        }),
        "utf8"
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
        throw Object.assign(new Error("disk write failed"), { code: "EIO" });
      });
      try {
        expect(() => new ChannelRegistry(SEED, GUILD, file)).toThrow(
          /refusing to start with an empty authorization set/
        );
      } finally {
        rename.mockRestore();
        warn.mockRestore();
      }
    });
  });
});
