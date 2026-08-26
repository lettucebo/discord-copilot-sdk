import { describe, it, expect } from "vitest";
import { detectLang, formatMessage, normalizeLang, t, LANGS, MESSAGES, messageKeys } from "../scripts/lib/i18n.mjs";

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

  describe("formatMessage", () => {
    it("interpolates every referenced placeholder", () => {
      expect(formatMessage("Local {0}, remote {1}.", ["abc", "def"])).toBe("Local abc, remote def.");
    });

    it("fails closed when a referenced placeholder has no value", () => {
      expect(() => formatMessage("Local {0}, remote {1}.", ["abc"])).toThrow(/missing message value/i);
    });
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

  describe("Discord private-channel installer guidance", () => {
    it("describes the seed default consistently in both languages", () => {
      expect(MESSAGES.en.promptParentChannelId).toContain("Seed default");
      expect(MESSAGES.en.promptParentChannelId).toContain("first-run default");
      expect(MESSAGES.en.promptParentChannelId).toContain("/channel list");
      expect(MESSAGES.zh.promptParentChannelId).toContain("種子預設值");
      expect(MESSAGES.zh.promptParentChannelId).toContain("首次啟動");
      expect(MESSAGES.zh.promptParentChannelId).toContain("/channel list");
    });

    it("ends with the private-channel audit and positive/negative checklist", () => {
      expect(MESSAGES.en.doneManual).toContain("private work channel");
      expect(MESSAGES.en.doneManual).toContain("/channel list");
      expect(MESSAGES.en.doneManual).toContain("positive/negative verification checklist");
      expect(MESSAGES.zh.doneManual).toContain("私密工作頻道");
      expect(MESSAGES.zh.doneManual).toContain("/channel list");
      expect(MESSAGES.zh.doneManual).toContain("正向／反向驗證清單");
    });
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
    "updateSourceIdentity",
    "updateRoot",
    "updateCheckout",
    "updateRequested",
    "updateStatusHeader",
    "updateStatusCurrentVersion",
    "updateStatusRepositoryRoot",
    "updateStatusCheckout",
    "updateStatusRequestedRef",
    "updateStatusInstance",
    "updatePlanHeader",
    "updatePlanCurrentVersion",
    "updatePlanTargetVersion",
    "updatePlanTargetInstances",
    "updatePlanInstanceState",
    "updateDryRunHeader",
    "updateDryRunFetch",
    "updateDryRunApply",
    "updateDryRunLimitations",
    "updateRestoreStatusHeader",
    "updateRestoreStatusSavedInstance",
    "updateRestoreStatusRepositoryRoot",
    "updateRestoreStatusSavedSource",
    "updateRestoreStatusCreatedAt",
    "updateRestoreStatusCurrentVersion",
    "updateIncompleteHeader",
    "updateIncompleteRestartLabel",
    "updateIncompleteRestart",
    "updateIncompleteRecoveryLabel",
    "updateInstanceStatus",
    "updateRunning",
    "updateStoppedState",
    "updateStopped",
    "updateResidencyEnabled",
    "updateResidencyDisabledState",
    "updateResidencyNotRegisteredState",
    "updateResidencyUnknownState",
    "updateResidencyDisabled",
    "updateResidencyNotRegistered",
    "updatePendingRestore",
    "updateAvailable",
    "updateApplyHint",
    "updateTargetNotes",
    "updateTargetNotesOmitted",
    "updateCompareLink",
    "updatePhaseStop",
    "updatePhaseSource",
    "updatePhaseSetup",
    "updatePhaseRestore",
    "updateRestoreSummary",
    "updateForeignRestoreState",
    "updateStopped",
    "updateResidencyDisabled",
    "updateResidencyNotRegistered",
    "updateResidencyWasDisabled",
    "updateResidencyRestored",
    "updateNotRunningBefore",
    "updateRestarted",
    "updateNoRestartInstance",
    "updateDryRun",
    "updateManagedDangling",
    "updateApplied",
    "updateNoRestart",
    "updateComplete",
    "updateFailed",
    "updateRestoreDone",
    "updateCancelled",
  ])("defines the bilingual %s update message", (key) => {
    for (const lang of LANGS) expect(t(key, lang)).not.toBe(key);
  });

  it.each([
    "updateAlreadyCurrent",
    "updateInstanceStatus",
    "updateAvailable",
    "updateApplyHint",
    "updateTargetNotes",
    "updateTargetNotesOmitted",
    "updateCompareLink",
  ])("keeps zh/en placeholder arity aligned for %s", (key) => {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{(\d+)\}/g)].map((match) => Number(match[1])).sort((a, b) => a - b);

    expect(placeholders(MESSAGES.zh[key])).toEqual(placeholders(MESSAGES.en[key]));
  });

  it("uses phase-neutral recovery wording in both languages while preserving restore guidance", () => {
    expect(MESSAGES.en.updateIncompleteRestartLabel).toBe("Update finalization");
    expect(MESSAGES.en.updateIncompleteRestart).toBe("did not complete");
    expect(MESSAGES.en.updatePendingRestore).toBe("Warning: a previous update left a recovery record; run {0}.");
    expect(MESSAGES.en.updateFailed).toBe("Update did not complete; update finalization did not complete. Fix the cause, then run {0}.");
    expect(MESSAGES.en.updatePendingRestore).not.toContain("automatic recovery");
    expect(MESSAGES.en.updateFailed).not.toContain("automatic recovery");

    expect(MESSAGES.zh.updateIncompleteRestartLabel).toBe("更新收尾");
    expect(MESSAGES.zh.updateIncompleteRestart).toBe("未完成");
    expect(MESSAGES.zh.updatePendingRestore).toBe("警告：先前的更新留下了復原記錄；請執行 {0}。");
    expect(MESSAGES.zh.updateFailed).toBe("更新未完成；更新收尾未完成。修正原因後執行 {0}。");
    expect(MESSAGES.zh.updatePendingRestore).not.toContain("自動復原");
    expect(MESSAGES.zh.updateFailed).not.toContain("自動復原");
  });

  it("warns bilingually when a private fetch ref cannot be cleaned", () => {
    expect(MESSAGES.en.updatePrivateRefCleanupFailed).toBe(
      "Warning: private update ref {0} could not be removed; remove it manually."
    );
    expect(MESSAGES.zh.updatePrivateRefCleanupFailed).toBe(
      "警告：無法刪除私有更新 ref {0}；請手動移除。"
    );
  });
});

describe("skill source messages", () => {
  it.each(["promptRepoSkills", "promptUserSkills", "errSkillSourceSwitch"])(
    "defines the bilingual %s skill-source message",
    (key) => {
      for (const lang of LANGS) expect(t(key, lang)).not.toBe(key);
    }
  );
});

describe("setup information architecture messages", () => {
  it.each([
    "planHeader",
    "planPackageVersion",
    "planRepositoryRoot",
    "planEnvPath",
    "planStateDir",
    "planInstanceId",
    "planDryRun",
    "stagePrereqs",
    "stageConfig",
    "stageBuild",
    "stageValidateWrite",
    "stageResidency",
    "buildStepStarting",
    "buildStepDone",
    "buildStepFailed",
    "buildLogPath",
    "buildRecentLogTail",
    "prereqNodeLabel",
    "prereqGitLabel",
    "prereqCopilotLabel",
    "prereqAuthLabel",
    "prereqPresentPath",
    "summaryHeader",
  ])("defines the bilingual %s setup message", (key) => {
    for (const lang of LANGS) expect(t(key, lang)).not.toBe(key);
  });

  it("keeps zh/en placeholder arity aligned for every message key", () => {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{(\d+)\}/g)].map((match) => Number(match[1])).sort((a, b) => a - b);

    for (const key of messageKeys()) {
      expect(placeholders(MESSAGES.zh[key]), key).toEqual(placeholders(MESSAGES.en[key]));
    }
  });
});
