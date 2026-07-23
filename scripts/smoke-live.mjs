// LIVE end-to-end smoke: drives the REAL SessionActor (real Copilot SDK session)
// through a real shell tool + permission request, auto-approved via a fake
// transport, proving the whole orchestration (SDK ⇄ broker ⇄ renderer ⇄
// transport) runs correctly. Requires the local Copilot to be logged in.
import { createCopilotClient } from "../dist/copilot/sdk.js";
import { SessionActor } from "../dist/copilot/session-actor.js";
import { PendingInteractionBroker } from "../dist/core/broker.js";
import { ApprovalPolicy } from "../dist/core/approval-policy.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "C:\\Source\\Repos\\discopilot";

class FakeTransport {
  constructor() {
    this.permissions = [];
    this.notices = [];
    this.lastState = undefined;
    this.autoApprove = true;
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
    if (this.autoApprove && this._decision) this._decision(view.nonce, "once", "smoke-user");
  }
  async notice(_key, text) { this.notices.push(text); console.log(`  <notice> ${text}`); }
  onDecision(h) { this._decision = h; return () => { this._decision = undefined; }; }
  onChoice(_h) { return () => {}; }
  onPlan(_h) { return () => {}; }
}

let pass = 0, fail = 0;
const chk = (name, ok, extra = "") => { console.log(`${ok ? "OK  ✅" : "FAIL ❌"}  ${name}${extra ? "  " + extra : ""}`); ok ? pass++ : fail++; };

const client = createCopilotClient({ workingDirectory: REPO });
await client.start();
console.log("client.start() OK");

const broker = new PendingInteractionBroker();
const transport = new FakeTransport();
const actor = await SessionActor.create(client, {
  sessionKey: "smoke",
  workingDirectory: REPO,
  contextTier: "long_context",
  broker,
  transport,
  policy: new ApprovalPolicy(join(tmpdir(), `discopilot-smoke-approvals-${Date.now()}.json`)),
});
console.log("SessionActor created; sending prompt …");

await actor.runTurn(
  "Run the shell command `git rev-parse --abbrev-ref HEAD` using the shell tool, then tell me the current branch name in one short sentence. Do not modify any files.",
  90_000
);

const state = actor.state();
console.log(`\nfinal assistantText: ${JSON.stringify((state.assistantText || "").slice(0, 160))}`);
console.log(`tools: ${JSON.stringify(state.tools)}`);

chk("a shell permission was surfaced through the broker", transport.permissions.some((p) => p.kind === "shell"));
chk("a tool executed", state.tools.length > 0);
chk("assistant produced output", (state.assistantText || "").trim().length > 0);
chk("no pending prompts remain (settled)", broker.size === 0, `size=${broker.size}`);

// /stop must be safe and clear pending prompts
await actor.stop();
chk("stop() clears the broker", broker.size === 0);

await actor.disconnect();
await client.stop();
console.log(`\n=== ${pass} passed / ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
