// LIVE end-to-end smoke: drives the REAL SessionActor (real Copilot SDK session)
// through one allowlisted read-only shell request, approved via a fake
// transport, proving the whole orchestration (SDK ⇄ broker ⇄ renderer ⇄
// transport) runs correctly. Requires the local Copilot to be logged in.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCopilotClient, stopCopilotClient } from "../dist/copilot/sdk.js";
import { SessionActor } from "../dist/copilot/session-actor.js";
import { PendingInteractionBroker } from "../dist/core/broker.js";
import { ApprovalPolicy } from "../dist/core/approval-policy.js";
import { matchesExpectedShellPermission } from "./lib/live-smoke.mjs";

const EXPECTED_COMMAND = "git status --short";

class FakeTransport {
  constructor() {
    this.permissions = [];
    this.notices = [];
    this.lastState = undefined;
    this._decision = undefined;
  }
  async render(_key, state) { this.lastState = state; }
  async flush(_key) {}
  resetTurn(_key) {}
  dispose(_key) {}
  async showUserInput(_v) {}
  async showPlan(_v) {}
  async showPermission(view) {
    this.permissions.push(view);
    console.log(`  <permission> kind=${view.kind} supported=${view.supported}\n    ${view.summary.replace(/\n/g, "\n    ")}`);
    const isExpected = matchesExpectedShellPermission(view, EXPECTED_COMMAND);
    if (!isExpected) console.log("  <permission> denied: outside the live-smoke allowlist");
    this._decision?.(view.nonce, isExpected ? "once" : "deny", "smoke-user");
  }
  async notice(_key, text) { this.notices.push(text); console.log(`  <notice> ${text}`); }
  onDecision(h) { this._decision = h; return () => { this._decision = undefined; }; }
  onChoice(_h) { return () => {}; }
  onPlan(_h) { return () => {}; }
}

let pass = 0, fail = 0;
const chk = (name, ok, extra = "") => { console.log(`${ok ? "OK  ✅" : "FAIL ❌"}  ${name}${extra ? "  " + extra : ""}`); ok ? pass++ : fail++; };

const sandbox = mkdtempSync(join(tmpdir(), "discord-copilot-sdk-live-smoke-"));
const repo = join(sandbox, "repo");
const home = join(sandbox, "home");

let client;
let actor;
let broker;
let runError;
const cleanupErrors = [];
try {
  mkdirSync(repo);
  mkdirSync(home);
  execFileSync("git", ["init", "--quiet", repo]);

  client = createCopilotClient({ workingDirectory: repo });
  await client.start();
  console.log("client.start() OK");

  broker = new PendingInteractionBroker();
  const transport = new FakeTransport();
  actor = await SessionActor.create(client, {
    sessionKey: "smoke",
    workingDirectory: repo,
    contextTier: "long_context",
    broker,
    transport,
    policy: new ApprovalPolicy(join(home, "approvals.json")),
    initialFileDeliveryBytes: 0,
    fileDeliverySessionId: "smoke",
    reserveFileDeliveryBytes: () => false,
    auditLog: { append: () => true },
    skillsHomeDirectory: home,
  });
  console.log("SessionActor created; sending prompt …");

  await actor.runTurn(
    `Run exactly the shell command \`${EXPECTED_COMMAND}\` using the shell tool, then tell me whether the disposable repository is clean in one short sentence. Do not run any other command and do not modify any files.`,
    90_000
  );

  const state = actor.state();
  console.log(`\nfinal assistantText: ${JSON.stringify((state.assistantText || "").slice(0, 160))}`);
  console.log(`tools: ${JSON.stringify(state.tools)}`);

  chk(
    "every surfaced permission matched the expected shell command",
    transport.permissions.length >= 1 &&
      transport.permissions.every((view) =>
        matchesExpectedShellPermission(view, EXPECTED_COMMAND)
      )
  );
  chk("a tool executed", state.tools.length > 0);
  chk("assistant produced output", (state.assistantText || "").trim().length > 0);
  chk("no pending prompts remain (settled)", broker.size === 0, `size=${broker.size}`);
} catch (error) {
  runError = error;
} finally {
  if (actor) {
    try {
      await actor.stop();
      chk("stop() clears the broker", broker?.size === 0, `size=${broker?.size ?? "n/a"}`);
    } catch (error) {
      cleanupErrors.push(["actor.stop()", error]);
    }
    try {
      await actor.disconnect();
    } catch (error) {
      cleanupErrors.push(["actor.disconnect()", error]);
    }
  }
  if (client) {
    try {
      await stopCopilotClient(client);
    } catch (error) {
      cleanupErrors.push(["stopCopilotClient()", error]);
    }
  }
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    cleanupErrors.push(["temporary sandbox removal", error]);
  }
}

if (runError !== undefined) {
  chk(
    "live smoke completed without an exception",
    false,
    runError instanceof Error ? runError.message : String(runError)
  );
}
for (const [step, error] of cleanupErrors) {
  chk(
    `${step} completed`,
    false,
    error instanceof Error ? error.message : String(error)
  );
}

console.log(`\n=== ${pass} passed / ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
