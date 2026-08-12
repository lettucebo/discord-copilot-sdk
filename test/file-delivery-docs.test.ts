import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), "utf8");
const EN_AVAILABILITY = "Outbound Discord file delivery is available only on Windows.";
const ZH_AVAILABILITY = "對外 Discord 檔案傳送僅支援 Windows。";

describe("file-delivery documentation", () => {
  it("states the Windows-only availability boundary in every required document", () => {
    expect(read("README.md")).toContain(EN_AVAILABILITY);
    expect(read("README.zh-TW.md")).toContain(ZH_AVAILABILITY);
    expect(read("docs", "DISCORD-SETUP.md")).toContain(EN_AVAILABILITY);
    expect(read("docs", "DISCORD-SETUP.zh-TW.md")).toContain(ZH_AVAILABILITY);
    expect(read("docs", "PLAN.md")).toContain(ZH_AVAILABILITY);
    expect(read(".github", "copilot-instructions.md")).toContain(EN_AVAILABILITY);
  });
});
