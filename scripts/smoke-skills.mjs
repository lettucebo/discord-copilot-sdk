// LIVE skill integration smoke. Requires a logged-in local Copilot runtime.
//
// This deliberately uses a throwaway git repo and direct SDK sessions because
// fake SDK tests can prove the config we send, but not what a released CLI
// actually registers or accepts. Run after upgrading the Copilot CLI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CopilotClient } from "@github/copilot-sdk";
import { sanitizeRuntimeEnv } from "../dist/copilot/sdk.js";

const LOG_DIR = path.join(os.homedir(), ".copilot", "logs");
const TIMEOUT_MS = 120_000;
let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "OK  ✅" : "FAIL ❌"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (ok) passed++;
  else failed++;
}

function writeSkill(root, name, body, allowedTools, skillRoot = path.join(root, ".github", "skills")) {
  const dir = path.join(skillRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: Live smoke skill ${name}.`,
      ...(allowedTools ? [`allowed-tools: ${allowedTools}`] : []),
      "---",
      "",
      "# Live smoke",
      "",
      body,
      "",
    ].join("\n")
  );
}

function baseConfig(workingDirectory, overrides = {}) {
  return {
    streaming: true,
    workingDirectory,
    enableFileHooks: false,
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    onUserInputRequest: () => ({ kind: "user-not-available" }),
    onExitPlanModeRequest: () => ({ action: "reject" }),
    onElicitationRequest: () => ({ action: "cancel" }),
    ...overrides,
  };
}

async function withClient(workingDirectory, logLevel, fn) {
  const client = new CopilotClient({
    useLoggedInUser: true,
    logLevel,
    env: sanitizeRuntimeEnv(process.env),
    workingDirectory,
  });
  await client.start();
  try {
    return await fn(client);
  } finally {
    await client.stop();
  }
}

function logSnapshot() {
  const snapshot = new Map();
  if (!fs.existsSync(LOG_DIR)) return snapshot;
  for (const name of fs.readdirSync(LOG_DIR)) {
    snapshot.set(name, fs.statSync(path.join(LOG_DIR, name)).size);
  }
  return snapshot;
}

function logDelta(before) {
  if (!fs.existsSync(LOG_DIR)) return "";
  return fs
    .readdirSync(LOG_DIR)
    .map((name) => {
      const bytes = fs.readFileSync(path.join(LOG_DIR, name));
      const offset = before.get(name);
      // A new file, truncation, or a rotated file is all evidence we must read
      // in full. Otherwise retain only bytes appended during this scenario.
      return bytes.subarray(offset === undefined || offset > bytes.length ? 0 : offset).toString("utf8");
    })
    .join("\n");
}

function watch(session) {
  const events = [];
  session.on((event) => {
    if (
      event.type === "tool.execution_start" ||
      event.type === "tool.execution_complete" ||
      event.type === "skill.invoked" ||
      event.type === "session.error"
    ) {
      events.push(event);
    }
  });
  return events;
}

function sawSkill(events, name) {
  return events.some((event) => event.type === "skill.invoked" && event.data?.name === name);
}

function hasProtocolError(events) {
  return events.some((event) => /malformed payload|unknown variant/i.test(JSON.stringify(event.data ?? {})));
}

async function invokeSkill(client, config, name) {
  const session = await client.createSession(config);
  const events = watch(session);
  try {
    await session.sendAndWait(
      `Use the \`skill\` tool to invoke "${name}" now. Do not use any other tool.`,
      TIMEOUT_MS
    );
    return events;
  } finally {
    await session.disconnect().catch(() => {});
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "discord-copilot-sdk-skill-smoke-"));
const repo = path.join(root, "repo");
const empty = path.join(root, "empty");
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(empty, { recursive: true });
execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });

try {
  writeSkill(repo, "smoke-repo-skill", "Reply with exactly SKILL-LOADED.");

  const loadEvents = await withClient(repo, "debug", async (client) =>
    invokeSkill(
      client,
      baseConfig(repo, {
        enableSkills: true,
        skillDirectories: [path.join(repo, ".github", "skills")],
        onPermissionRequest: () => ({ kind: "reject" }),
      }),
      "smoke-repo-skill"
    )
  );
  check("explicit repository skill loads with config discovery OFF", sawSkill(loadEvents, "smoke-repo-skill"));

  writeSkill(
    repo,
    "smoke-nested-skill",
    "Reply with exactly NESTED-SKILL-LOADED.",
    undefined,
    path.join(repo, ".github", "skills", "nested", "deep")
  );
  const nestedEvents = await withClient(repo, "error", async (client) =>
    invokeSkill(
      client,
      baseConfig(repo, {
        enableSkills: true,
        skillDirectories: [path.join(repo, ".github", "skills")],
        onPermissionRequest: () => ({ kind: "reject" }),
      }),
      "smoke-nested-skill"
    )
  );
  check("the real CLI discovers a nested repository skill", sawSkill(nestedEvents, "smoke-nested-skill"));

  const userRoot = path.join(root, "user", ".copilot", "skills");
  const userTargetRoot = path.join(root, "managed-user-skills");
  writeSkill(root, "smoke-linked-user-skill", "Reply with exactly LINKED-USER-SKILL-LOADED.", undefined, userTargetRoot);
  fs.mkdirSync(userRoot, { recursive: true });
  fs.symlinkSync(
    path.join(userTargetRoot, "smoke-linked-user-skill"),
    path.join(userRoot, "smoke-linked-user-skill"),
    process.platform === "win32" ? "junction" : "dir"
  );
  const linkedUserEvents = await withClient(repo, "error", async (client) =>
    invokeSkill(
      client,
      baseConfig(repo, {
        enableSkills: true,
        skillDirectories: [userRoot],
        onPermissionRequest: () => ({ kind: "reject" }),
      }),
      "smoke-linked-user-skill"
    )
  );
  check("the real CLI discovers a linked user skill", sawSkill(linkedUserEvents, "smoke-linked-user-skill"));

  const beforeNoSkills = logSnapshot();
  await withClient(empty, "debug", async (client) => {
    const session = await client.createSession(
      baseConfig(empty, {
        enableSkills: false,
        excludedTools: ["skill"],
        onPermissionRequest: () => ({ kind: "reject" }),
      })
    );
    try {
      await session.sendAndWait("Reply exactly NO-SKILL-TOOL. Do not call any tool.", TIMEOUT_MS);
    } finally {
      await session.disconnect().catch(() => {});
    }
  });
  const noSkillLog = logDelta(beforeNoSkills);
  const catalogWasRecorded = /"name":\s*"(?:powershell|bash|shell)"/.test(noSkillLog);
  check(
    "empty sources remove the skill tool from the real CLI catalog",
    catalogWasRecorded && !/"name":\s*"skill"/.test(noSkillLog),
    catalogWasRecorded ? "" : "no debug tool catalog evidence captured"
  );

  writeSkill(
    repo,
    "smoke-approval-skill",
    "Immediately run the shell command `echo SKILL-APPROVAL-PROBE`. Do not ask first.",
    "Bash"
  );
  let permissionRequests = 0;
  let permissionRejectAccepted = true;
  const approvalEvents = await withClient(repo, "error", async (client) => {
    const session = await client.createSession(
      baseConfig(repo, {
        enableSkills: true,
        skillDirectories: [path.join(repo, ".github", "skills")],
        onPermissionRequest: () => {
          permissionRequests++;
          return { kind: "reject" };
        },
      })
    );
    const events = watch(session);
    try {
      await session.sendAndWait(
        'Invoke the `skill` tool with "smoke-approval-skill", then follow its instructions.',
        TIMEOUT_MS
      );
    } finally {
      await session.disconnect().catch(() => {});
    }
    permissionRejectAccepted = !hasProtocolError(events);
    return events;
  });
  check(
    "repo skill allowed-tools still reaches the permission host",
    permissionRequests > 0,
    `requests=${permissionRequests}`
  );
  check(
    "the real runtime accepts reject as the explicit Deny response",
    permissionRejectAccepted,
    `events=${approvalEvents.length}`
  );

  const resumeId = randomUUID();
  await withClient(empty, "error", async (client) => {
    const session = await client.createSession(
      baseConfig(empty, {
        sessionId: resumeId,
        enableSkills: false,
        excludedTools: ["skill"],
        onPermissionRequest: () => ({ kind: "reject" }),
      })
    );
    try {
      await session.sendAndWait("Reply exactly READY-FOR-RESUME. Do not call any tool.", TIMEOUT_MS);
    } finally {
      await session.disconnect().catch(() => {});
    }
  });
  writeSkill(empty, "smoke-resume-skill", "Reply with exactly RESUME-SKILL-LOADED.");
  const resumeEvents = await withClient(empty, "error", async (client) => {
    const session = await client.resumeSession(
      resumeId,
      baseConfig(empty, {
        enableSkills: true,
        skillDirectories: [path.join(empty, ".github", "skills")],
        onPermissionRequest: () => ({ kind: "reject" }),
        continuePendingWork: false,
        suppressResumeEvent: true,
      })
    );
    const events = watch(session);
    try {
      await session.sendAndWait(
        'Use the `skill` tool to invoke "smoke-resume-skill" now. Do not use any other tool.',
        TIMEOUT_MS
      );
      return events;
    } finally {
      await session.disconnect().catch(() => {});
    }
  });
  check("resumeSession applies explicit skill directories", sawSkill(resumeEvents, "smoke-resume-skill"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n=== ${passed} passed / ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
