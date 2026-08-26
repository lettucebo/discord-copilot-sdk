import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");

const EN_DOCS = [
  "README.md",
  "INSTALL.md",
  "docs/DISCORD-SETUP.md",
  "docs/CHANNEL-ACCESS.md",
] as const;
const ZH_DOCS = [
  "README.zh-TW.md",
  "INSTALL.zh-TW.md",
  "docs/DISCORD-SETUP.zh-TW.md",
  "docs/CHANNEL-ACCESS.zh-TW.md",
] as const;

describe("Discord private-channel documentation contract", () => {
  it("uses the private-channel seed-default workflow in every operator guide", () => {
    for (const file of EN_DOCS) {
      const text = read(file);
      expect(text, file).toMatch(/private (?:Discord |work )?channel/i);
      expect(text, file).toContain("seed default");
      expect(text, file).toContain("/channel list");
    }
    for (const file of ZH_DOCS) {
      const text = read(file);
      expect(text, file).toContain("私密");
      expect(text, file).toContain("種子預設值");
      expect(text, file).toContain("/channel list");
    }
  });

  it("keeps command permissions secondary while documenting non-admin overrides", () => {
    for (const file of [
      "INSTALL.md",
      "docs/DISCORD-SETUP.md",
      "docs/CHANNEL-ACCESS.md",
    ]) {
      const text = read(file);
      expect(text, file).toContain('default_member_permissions="0"');
      expect(text, file).toContain("Integrations");
    }
    for (const file of [
      "INSTALL.zh-TW.md",
      "docs/DISCORD-SETUP.zh-TW.md",
      "docs/CHANNEL-ACCESS.zh-TW.md",
    ]) {
      const text = read(file);
      expect(text, file).toContain('default_member_permissions="0"');
      expect(text, file).toContain("Integrations");
    }
    expect(read("docs/CHANNEL-ACCESS.md")).toMatch(/human.*OAuth|OAuth.*human/is);
    expect(read("docs/CHANNEL-ACCESS.md")).toMatch(/bot(?:'s own)? token.*cannot|bot-token.*cannot/is);
  });

  it("documents retry and explicit cleanup for Discord no-access", () => {
    for (const file of ["README.md", "INSTALL.md", "docs/CHANNEL-ACCESS.md"]) {
      const text = read(file);
      expect(text, file).toContain("thread-no-access");
      expect(text, file).toContain("/end thread:<id>");
      expect(text, file).toMatch(/retr(?:y|ies)/i);
    }
    for (const file of ["README.zh-TW.md", "INSTALL.zh-TW.md", "docs/CHANNEL-ACCESS.zh-TW.md"]) {
      const text = read(file);
      expect(text, file).toContain("thread-no-access");
      expect(text, file).toContain("/end thread:<id>");
      expect(text, file).toContain("重試");
    }
  });

  it("keeps positive/negative verification and obfuscation details actionable", () => {
    expect(read("INSTALL.md")).toContain("Positive verification");
    expect(read("INSTALL.md")).toContain("Negative verification");
    expect(read("INSTALL.zh-TW.md")).toContain("正向驗證");
    expect(read("INSTALL.zh-TW.md")).toContain("反向驗證");
    for (const file of ["docs/CHANNEL-ACCESS.md", "docs/CHANNEL-ACCESS.zh-TW.md"]) {
      const text = read(file);
      expect(text, file).toContain("CHANNEL_OBFUSCATED");
      expect(text, file).toContain('"___hidden___"');
    }
  });

  it("removes the exact stale blacklist and authorization-only claims", () => {
    const english = EN_DOCS.map(read).join("\n");
    const chinese = ZH_DOCS.map(read).join("\n");
    expect(english).not.toContain("shows **bot authorization** only");
    expect(english).not.toContain("Every other channel and category");
    expect(chinese).not.toContain("顯示的只是 **bot authorization**");
    expect(chinese).not.toContain("其他每一個頻道與分類");
    expect(english).not.toMatch(/recover fast, re-enable Administrator/i);
    expect(chinese).not.toContain("把 Administrator 打回去");
  });

  it("retains the authoritative three-plane terminology in each language", () => {
    const english = read("docs/CHANNEL-ACCESS.md");
    const chinese = read("docs/CHANNEL-ACCESS.zh-TW.md");
    expect(english).toContain("Bot authorization");
    expect(english).toContain("cross-checked against what the bot can currently see");
    expect(chinese).toMatch(/Bot 授權|bot 授權/);
    expect(chinese).toContain("實際看得到");
  });

  it("keeps contributor truth sources aligned with the implemented model", () => {
    const instructions = read(".github/copilot-instructions.md");
    const context = read("CONTEXT.md");
    const design = read("docs/PLAN.md");
    const changelog = read("CHANGELOG.md");

    expect(instructions).toContain(
      "initialized once from the configured `DISCORD_PARENT_CHANNEL_ID` default"
    );
    expect(instructions).toContain("thread-no-access");
    expect(context).toContain("_Accepted descriptive synonym (operator-facing docs)_: first-run default");
    expect(design).toContain("ChannelRegistry` schema v2");
    expect(design).not.toContain("seed 永遠 enabled");
    expect(changelog).toContain("Private-channel visibility as the primary Discord whitelist");
    expect(changelog).toContain("silently ignored");
  });
});
