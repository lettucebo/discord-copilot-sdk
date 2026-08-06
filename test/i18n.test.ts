import { describe, it, expect } from "vitest";
import { detectLang, normalizeLang, t, LANGS, MESSAGES, messageKeys } from "../scripts/lib/i18n.mjs";

describe("detectLang", () => {
  it("uses DISCORD_COPILOT_SDK_LOCALE first (Windows path)", () => {
    expect(detectLang({ DISCORD_COPILOT_SDK_LOCALE: "zh-TW", LANG: "en_US.UTF-8" })).toBe("zh");
    expect(detectLang({ DISCORD_COPILOT_SDK_LOCALE: "en-US" })).toBe("en");
  });

  it("falls back through LC_ALL / LANG (unix)", () => {
    expect(detectLang({ LC_ALL: "zh_TW.UTF-8" })).toBe("zh");
    expect(detectLang({ LANG: "zh_TW.UTF-8" })).toBe("zh");
    expect(detectLang({ LANG: "en_GB.UTF-8" })).toBe("en");
  });

  it("defaults to English when no Chinese hint is present", () => {
    expect(detectLang({ LANG: "fr_FR.UTF-8" })).toBe("en");
    // no hints at all → whatever Intl says, but never throws and is a valid lang
    expect(LANGS).toContain(detectLang({}));
  });
});

describe("normalizeLang", () => {
  it("maps user overrides to a supported language", () => {
    expect(normalizeLang("zh")).toBe("zh");
    expect(normalizeLang("zh-TW")).toBe("zh");
    expect(normalizeLang("cht")).toBe("zh");
    expect(normalizeLang("en")).toBe("en");
    expect(normalizeLang("en-US")).toBe("en");
    expect(normalizeLang("de")).toBeUndefined();
    expect(normalizeLang("")).toBeUndefined();
    expect(normalizeLang(undefined)).toBeUndefined();
  });
});

describe("t", () => {
  it("returns the language-specific string", () => {
    expect(t("langChosen", "zh")).toContain("繁體中文");
    expect(t("langChosen", "en")).toContain("English");
  });

  it("falls back to English for an unknown language, then to the key", () => {
    expect(t("banner", "de")).toBe(MESSAGES.en.banner);
    expect(t("__nope__", "zh")).toBe("__nope__");
  });
});

describe("message table parity", () => {
  it("zh and en define exactly the same keys (no missing translation)", () => {
    const en = new Set(Object.keys(MESSAGES.en));
    const zh = new Set(Object.keys(MESSAGES.zh));
    const onlyEn = [...en].filter((k) => !zh.has(k));
    const onlyZh = [...zh].filter((k) => !en.has(k));
    expect(onlyEn).toEqual([]);
    expect(onlyZh).toEqual([]);
    expect(messageKeys().length).toBeGreaterThan(20);
  });

  it("no translated value is an empty string", () => {
    for (const lang of LANGS) {
      for (const [k, v] of Object.entries(MESSAGES[lang])) {
        expect(v, `${lang}.${k}`).toBeTruthy();
      }
    }
  });
});

describe("update messages", () => {
  it.each([
    "updateActiveThreads",
    "updateAlreadyCurrent",
    "updateCurrentRemote",
    "updateDryRun",
    "updateManagedDangling",
    "updateNoRestart",
    "updateComplete",
    "updateFailed",
    "updateRestoreDone",
  ])("defines the bilingual %s update message", (key) => {
    for (const lang of LANGS) expect(t(key, lang)).not.toBe(key);
  });
});
