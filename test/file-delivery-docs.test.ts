import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), "utf8");
const EN_AVAILABILITY = "Outbound Discord file delivery is available only on Windows.";
const ZH_AVAILABILITY = "對外 Discord 檔案傳送僅支援 Windows。";
const EN_YOLO_FILE_REVOCATION =
  "Already-posted ordinary permission cards are not retroactively changed by YOLO; file-delivery cards are different";
const ZH_YOLO_FILE_REVOCATION =
  "已貼出的一般 permission card 不會因 YOLO 被追溯改寫；檔案傳送卡則不同";
const EN_MASKS = [
  "**Windows normal:** `326417632256`",
  "**Non-Windows normal:** `326417599488`",
  "**Windows lean:** `309237763072`",
  "**Non-Windows lean:** `309237730304`",
];
const ZH_MASKS = [
  "Windows 一般版：** `326417632256`",
  "非 Windows 一般版：** `326417599488`",
  "Windows 精簡版：** `309237763072`",
  "非 Windows 精簡版：** `309237730304`",
];
const EN_WINDOWS_LOCKDOWN_MASK = "`395137371200`";
const EN_NON_WINDOWS_LOCKDOWN_MASK = "`395137338432`";
const ZH_WINDOWS_LOCKDOWN_MASK = "`395137371200`";
const ZH_NON_WINDOWS_LOCKDOWN_MASK = "`395137338432`";

describe("file-delivery documentation", () => {
  it("states the Windows-only availability boundary in every required document", () => {
    expect(read("README.md")).toContain(EN_AVAILABILITY);
    expect(read("README.zh-TW.md")).toContain(ZH_AVAILABILITY);
    expect(read("docs", "DISCORD-SETUP.md")).toContain(EN_AVAILABILITY);
    expect(read("docs", "DISCORD-SETUP.zh-TW.md")).toContain(ZH_AVAILABILITY);
    expect(read("docs", "PLAN.md")).toContain(ZH_AVAILABILITY);
    expect(read(".github", "copilot-instructions.md")).toContain(EN_AVAILABILITY);
  });

  it("lists platform-specific invite masks in both Discord setup twins", () => {
    const en = read("docs", "DISCORD-SETUP.md");
    const zh = read("docs", "DISCORD-SETUP.zh-TW.md");
    for (const mask of EN_MASKS) expect(en).toContain(mask);
    for (const mask of ZH_MASKS) expect(zh).toContain(mask);
  });

  it("keeps Attach Files and its channel-lockdown mask Windows-only in both setup twins", () => {
    const en = read("docs", "DISCORD-SETUP.md");
    const zh = read("docs", "DISCORD-SETUP.zh-TW.md");
    const enLockdown = en.slice(en.indexOf("## 4b."), en.indexOf("## 5."));
    const zhLockdown = zh.slice(zh.indexOf("## 4b."), zh.indexOf("## 5."));

    expect(enLockdown).toContain("**Windows:**");
    expect(enLockdown).toContain("**Non-Windows:**");
    expect(enLockdown).toContain("without `Attach Files`");
    expect(enLockdown).toContain(EN_WINDOWS_LOCKDOWN_MASK);
    expect(enLockdown).toContain(EN_NON_WINDOWS_LOCKDOWN_MASK);

    expect(zhLockdown).toContain("**Windows：**");
    expect(zhLockdown).toContain("**非 Windows：**");
    expect(zhLockdown).toContain("不含 `Attach Files`");
    expect(zhLockdown).toContain(ZH_WINDOWS_LOCKDOWN_MASK);
    expect(zhLockdown).toContain(ZH_NON_WINDOWS_LOCKDOWN_MASK);
  });

  it("distinguishes ordinary pending YOLO cards from revoked file-delivery cards in both READMEs", () => {
    expect(read("README.md")).toContain(EN_YOLO_FILE_REVOCATION);
    expect(read("README.zh-TW.md")).toContain(ZH_YOLO_FILE_REVOCATION);
  });
});
