# Harness Evaluation

> **English** · [繁體中文](HARNESS-EVALUATION.zh-TW.md)

Date: 2026-08-24 · Status: decided · Repository base: `v1.1.0` (`48aa0e0`)

Inspected for this evaluation: GitHub Copilot CLI `1.0.81-8`,
`@github/copilot-sdk` `1.0.7-preview.3`, Oh My Pi `v18.0.4` (source
`4854db8`), Paseo `4f79618`. The baseline SDK measurement cited below was
recorded with Copilot CLI `1.0.74-1`; the ACP probe was run with `1.0.81-8`.

## 1. Why this document exists

This project was compared with existing Discord agent frontends before investing
further in a custom bridge. The goal was not to defend sunk cost: it was to find
an existing product that could replace this repository without losing its hard
requirements. This record preserves the requirements, evidence, rejected
alternatives, and decision outside the conversation that produced them.

The implementation that follows from this decision is tracked in
[#27](https://github.com/lettucebo/discord-copilot-sdk/issues/27). This document
explains *why*; the issue explains *how*.

## 2. Requirements that drove the decision

These are product requirements, not a retrospective description of one
implementation.

| Requirement | Meaning | Why it is hard |
| --- | --- | --- |
| Discord thread = persistent session | One thread maps to one long-lived agent session that survives restarts. | A Discord message handler must preserve and reconcile provider-owned session identity. |
| Thread = fixed worktree | A thread always resumes into the same working directory. | Repository identity, worktree ownership, and cleanup must remain correct across crashes. |
| Multi-repo | Any repository under `REPOS_ROOT`. | The bridge cannot be configured for only one checkout. |
| Same-repo concurrency | Several threads on one repository via separate worktrees. | Sharing one checkout would race file and git operations. |
| Real harness | An actual coding-agent runtime, not a re-implementation; the target harnesses evaluated here are Copilot and OMP. | The harness owns its agent loop, tools, sessions, and provider-specific behavior. |
| Long-context models | A large context window is selectable and its capacity is reported truthfully. **This is the decision driver.** | A large display label does not prove that the request path receives the corresponding context tier. |
| Interactive control | Steering, queue, stop, approval, model, thinking, context, and usage. | A one-shot prompt/reply relay cannot expose a coding harness's live control plane. |

## 3. The long-context constraint

### 3.1 What “long context” measures in this project

The comparison uses the effective context window reported by the running
harness, not a model name or UI suffix:

```text
@github/copilot-sdk + contextTier: "long_context"  ~936K effective
copilot --acp 1.0.81-8, with --context             264K
```

The SDK value was measured on a real Copilot Enterprise session and is recorded
in the [baseline README](https://github.com/lettucebo/discord-copilot-sdk/blob/48aa0e09aa1ad4dfbe56180eba945b5cf59680bd/README.md#why-the-sdk-verified).
The application passes `contextTier` to the SDK in the
[baseline session actor](https://github.com/lettucebo/discord-copilot-sdk/blob/48aa0e09aa1ad4dfbe56180eba945b5cf59680bd/src/copilot/session-actor.ts#L545-L576).
The 264K ACP result is reproduced in [§7](#7-evidence-appendix-reproducible).

These numbers are observations for the pinned versions and account policy, not
universal model promises. Runtime model capabilities remain authoritative.

### 3.2 What OMP's `-1m` models actually are

OMP synthesizes a long-context sibling from the GitHub Copilot catalog. It does
not send the synthetic ID to Copilot:

```text
OMP catalog id                        claude-opus-5-1m
provider requestModelId               claude-opus-5
OMP contextWindow                     1,000,000
Copilot long_context effective tier     936,000
```

The mapping is asserted by OMP's pinned
[`issue-6664-repro.test.ts`](https://github.com/can1357/oh-my-pi/blob/4854db856c20e000a3760d793c56d78065dcf83f/packages/catalog/test/issue-6664-repro.test.ts)
and its
[GitHub Copilot model-limit tests](https://github.com/can1357/oh-my-pi/blob/4854db856c20e000a3760d793c56d78065dcf83f/packages/catalog/test/github-copilot-model-limits.test.ts).
The
[synthesis source](https://github.com/can1357/oh-my-pi/blob/4854db856c20e000a3760d793c56d78065dcf83f/packages/catalog/src/provider-models/openai-compat.ts#L5543-L5577)
describes this as a client-side context budget, not a served model ID, and
computes `contextWindow` as
`Math.min(fullContextWindow, longContextMax + maxTokens)`: 936,000 prompt
tokens plus 64,000 maximum output tokens produces the 1,000,000 application
window for the pinned fixture, whose `fullContextWindow` is also 1,000,000.
This evaluation verified the catalog implementation, not a real OMP turn
reaching that limit.
Therefore, a Paseo picker showing `(1M)` while using OMP is rendering OMP's
catalog. It is not evidence that stock `copilot --acp` advertises or accepts
`claude-opus-5-1m`.

## 4. Candidates evaluated

### 4.1 `discord-copilot-sdk` (incumbent)

**What it is.** A Discord frontend that drives the official
`@github/copilot-sdk`, with durable thread/session records and per-thread git
worktrees.

**What it gives.** At the pinned baseline it already implements every §2
requirement for Copilot, including native permission and user-input callbacks,
steering, application queueing, stop, model/effort/context controls, usage,
restart reconciliation, multi-repo routing, and same-repo worktree isolation.
The baseline behavior and measured long context are documented in the
[README](https://github.com/lettucebo/discord-copilot-sdk/blob/48aa0e09aa1ad4dfbe56180eba945b5cf59680bd/README.md#why-the-sdk-verified)
and enumerated in
[#27](https://github.com/lettucebo/discord-copilot-sdk/issues/27).

**What it costs.** The project owns its Discord orchestration and currently has
only one harness implementation.

**Verdict: Keep.** It is the only evaluated option already satisfying the full
requirement set.

### 4.2 Paseo daemon + `@getpaseo/client`

**What it is.** A general local coding-agent daemon with a TypeScript client.
Paseo owns sessions, provider integrations, workspaces, and worktrees.

**What it gives.** The daemon has cancellation, permission response, model, and
thinking operations. However, the stable high-level `PaseoAgentHandle` exposed
by `createPaseoClient()` has refresh, send/run/wait, archive, detach, subscribe,
a synchronous `current()` snapshot, and a timeline handle—but no cancellation,
permission-response, model, or thinking operations—at the evaluated commit
([source](https://github.com/getpaseo/paseo/blob/4f796181bf9d7e6b5ea2067ece4eace7213938cb/packages/client/src/index.ts#L248-L276)).
The lower-level operations are available only through the explicitly named
`./internal/daemon-client` package export, one of three `./internal/*` exports
([package metadata](https://github.com/getpaseo/paseo/blob/4f796181bf9d7e6b5ea2067ece4eace7213938cb/packages/client/package.json)).

**What it costs.** A production Discord adapter would either depend on an
internal API or re-create missing high-level controls and permission UX.

**Verdict: Not viable alone.** Revisit if the stable high-level client exposes
the complete live control plane.

### 4.3 Paseo daemon + OMP RPC provider

**What it is.** Paseo has a non-ACP OMP provider built on OMP's JSONL RPC
transport. Its evaluated runtime implements prompt, abort, model, thinking,
usage, steering, follow-up, host tools, and session operations
([runtime source](https://github.com/getpaseo/paseo/blob/4f796181bf9d7e6b5ea2067ece4eace7213938cb/packages/server/src/server/agent/providers/omp/cli-runtime.ts)).

**What it gives.** OMP model discovery can expose the catalog-asserted synthetic
1M variants described in §3.2, while Paseo supplies daemon and worktree
infrastructure. A real OMP turn at that capacity was not measured here.

**What it costs.** It still needs a bespoke Discord thread/session and approval
adapter. It also cannot provide the required Copilot harness path: Paseo's
Copilot provider explicitly launches `copilot --acp`
([source](https://github.com/getpaseo/paseo/blob/4f796181bf9d7e6b5ea2067ece4eace7213938cb/packages/server/src/server/agent/providers/copilot-acp-agent.ts)).

**Verdict: Deferred alternative.** Capable for OMP, but migration would replace
working orchestration while still requiring custom Discord work and leaving
Copilot blocked by ACP.

### 4.4 Paseo Hub Discord integration

**What it is.** An automation layer where a `discord.mention` starts a workflow
and posts an allowed `discord.reply`.

**What it gives.** Declarative routing, filters, time limits, agent selection,
and auditable automation. The evaluated docs define one trigger and the ordered
steps it starts
([workflow source](https://github.com/getpaseo/paseo/blob/4f796181bf9d7e6b5ea2067ece4eace7213938cb/public-docs/hub/workflows.md))
and a Discord mention/reply workflow
([Discord source](https://github.com/getpaseo/paseo/blob/4f796181bf9d7e6b5ea2067ece4eace7213938cb/public-docs/hub/triggers/discord.md)).

**What it costs.** Each mention is a workflow execution, not a durable
thread-owned interactive coding session. The documented Discord surface has no
thread-to-worktree identity, live steering queue, cancellation, or permission
round trip.

**Verdict: Automation only.** Useful beside this product, not a replacement for
it.

### 4.5 `seam-acp`

**What it is.** The closest existing Discord coding-agent bridge: one agent
session per thread, repository picker, cancellation, steering, model/mode/
effort controls, and Discord permission prompts
([pinned README](https://github.com/jbulpitt/seam-acp/blob/d0a720fda5d4f7f5b9d262b3d73de774e98544b8/README.md)).

**What it gives.** A mature multi-agent Discord UX with many of the same
interaction requirements.

**What it costs.** Its runtime is deliberately ACP-based, and its Copilot
profile spawns `copilot --acp`. Section 7 shows that this tested path cannot
select Copilot long context.

**Verdict: Excluded by the ACP constraint in §6.3.** If ACP gains verified
long-context parity, this is the strongest migration candidate to re-evaluate.

### 4.6 Direct OMP RPC-UI + custom Discord adapter

**What it is.** Spawn `omp --mode rpc-ui` directly and map its JSONL commands
and events to the existing Discord/session/worktree infrastructure. OMP accepts
`rpc-ui` in its pinned
[CLI flag table](https://github.com/can1357/oh-my-pi/blob/4854db856c20e000a3760d793c56d78065dcf83f/packages/coding-agent/src/cli/flag-tables.ts)
even though its protocol guide introduces the simpler `rpc` mode. OMP documents
model and thinking changes, steering, follow-up, abort, state, session resume,
and context statistics in its pinned
[RPC contract](https://github.com/can1357/oh-my-pi/blob/4854db856c20e000a3760d793c56d78065dcf83f/docs/rpc.md)
and
[types](https://github.com/can1357/oh-my-pi/blob/4854db856c20e000a3760d793c56d78065dcf83f/packages/coding-agent/src/modes/rpc/rpc-types.ts).

**What it gives.** A real, non-ACP OMP harness with OMP's synthesized
long-context catalog and full interactive control plane. Shipping the OMP path
remains conditional on #27's runtime-discovery and live-smoke gates.

**What it costs.** The adapter, process supervision, typed frame validation,
permission broker, and provider-neutral harness abstraction must be built and
maintained.

**Verdict: Adopt as the evolution path.** Add it beside the Copilot SDK harness
rather than replacing the working product; the implementation contract is
[#27](https://github.com/lettucebo/discord-copilot-sdk/issues/27).

### 4.7 `agy-discord-mcp`

**What it is.** A Discord relay and MCP tool surface for the Antigravity
`agy` CLI.

**What it gives.** Discord access control, per-channel conversation resume,
file delivery, and MCP tools.

**What it costs.** Relay mode invokes `agy --print`; its wrapper injects
`--dangerously-skip-permissions`, so every tool is auto-approved. It also has no
git worktree ownership or Copilot/OMP long-context control
([pinned README](https://github.com/Openclaw-Metis/agy-discord-mcp/blob/4d490efcb724805c4c8af44f63138e8baab57231/README.md)).

**Verdict: Rejected.** It is a different harness with a weaker approval and
repository-isolation model.

### 4.8 Pi Discord bridge family

The original research treated “Piscord” and “pi-discord-bridge” as names with
no usable project behind them. A fresh repository search on 2026-08-24
disproved that statement. Several real bridges now build on upstream Pi,
through `@earendil-works/pi-coding-agent` package integration. Crokily runs
agent turns through the `pi` binary; notdezzi also uses that binary as a
detached new-session launcher:

- [`Crokily/pi-discord-gateway`](https://github.com/Crokily/pi-discord-gateway/tree/72df4f0e035da284cfaf743d45b87555d7112721)
  (`piscord`) has per-channel persistence, queueing, working-directory overrides,
  model and thinking controls.
- [`joelhooks/pi-discord-threads`](https://github.com/joelhooks/pi-discord-threads/tree/947ab38704aa89648fae37f30e0dd51478c2cd7d)
  has durable Discord thread records, steering, follow-up, and cancellation.
- The
  [`frankhildebrandt`](https://github.com/frankhildebrandt/pi-discord-bridge/tree/c189f8b5baef4f031733527e30f4057fd4e89ae2),
  [`rpo130`](https://github.com/rpo130/pi-discord-bridge/tree/454490e1c7aea2d66b862535aecea4f6256c549d),
  and
  [`notdezzi`](https://github.com/notdezzi/pi-discord-bridge/tree/14c2572b00b319c255e8c2036ee69f1618ac5470)
  bridges provide different combinations of session persistence, abort,
  compact, model, thinking, and usage.

OMP is itself a
[fork of Pi](https://github.com/can1357/oh-my-pi/blob/4854db856c20e000a3760d793c56d78065dcf83f/README.md#the-pi-you-love-with-batteries-included),
so these are close architectural relatives rather than unrelated tools.
All five are package-coupled to `@earendil-works/pi-coding-agent`: `joelhooks`
and `frankhildebrandt` declare direct dependencies, while `Crokily`, `rpo130`,
and `notdezzi` declare peer dependencies. `Crokily/pi-discord-gateway` is
hybrid: it additionally spawns the `pi` binary for agent turns while importing
`AuthStorage`, `ModelRegistry`, and `SettingsManager` from the package for model
discovery. OMP publishes `@oh-my-pi/pi-coding-agent`; drop-in package
compatibility was not tested, nor was running Crokily's turns with `omp` while
its package integration remained on upstream Pi. None of the evaluated
implementations provides the full combination of fixed git worktrees, approval
round trips, and verified long-context-tier selection.

**Verdict: Valuable references, not replacements.** Their existence corrects
the earlier search conclusion, but their harness and isolation boundaries do
not satisfy §2. Embedding upstream Pi into this repository's existing
Discord/worktree infrastructure remains a deferred adapter alternative; OMP is
preferred because the pinned OMP fork supplies RPC-UI and the GitHub Copilot
catalog evaluated in §3.2, while that combination was not demonstrated for the
upstream Pi package.

### 4.9 Custom ACP-to-Copilot-SDK proxy

**What it is.** A new ACP server that advertises synthetic `(1M)` choices but
drives `@github/copilot-sdk` with `contextTier: "long_context"` behind the
protocol.

**What it gives.** It could make an ACP client display and select the same SDK
capability the incumbent already uses.

**What it costs.** It is not stock `copilot --acp`; it is another custom
harness adapter with session, permission, model, and compatibility obligations.
It adds a protocol layer without removing this project's maintenance burden.

**Verdict: Noted, not chosen.** Directly retaining the SDK and adding OMP RPC-UI
has fewer moving parts.

## 5. Capability matrix

`✅` means the evaluated product directly supplies the requirement. `⚠️` means
partial support or custom adapter work. `❔` means not evaluated. `❌` means the
cited candidate design does not supply it. ACP status is derived from §3 and is
not scored as an independent requirement. Columns saying “reuse current”
evaluate an incumbent-plus-adapter path; the other product columns are assessed
as standalone replacements.

| Requirement | incumbent | Paseo client | Paseo + OMP | Hub | seam-acp | direct OMP | agy relay | Pi bridges | ACP→SDK proxy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Persistent Discord thread session | ✅ | ⚠️ adapter | ⚠️ adapter | ❌ execution | ✅ | ⚠️ build | ⚠️ channel | ⚠️ mixed | ⚠️ build |
| Fixed per-thread worktree | ✅ | ⚠️ adapter binding | ⚠️ adapter binding | ❌ | ❔ not evaluated | ✅ reuse current | ❌ | ❌ | ✅ reuse current |
| Multi-repo + same-repo concurrency | ✅ | ✅ daemon | ✅ daemon | ⚠️ workflow routing | ⚠️ repo sessions | ✅ reuse current | ❌ fixed cwd | ⚠️ mixed, no worktrees | ✅ reuse current |
| Real harness | ✅ Copilot SDK | ✅ provider-dependent | ✅ OMP | ✅ provider-dependent | ✅ Copilot via ACP | ✅ OMP | ✅ agy | ✅ Pi | ✅ Copilot SDK |
| Verified selectable long context | ✅ ~936K | ⚠️ OMP catalog only | ⚠️ catalog-asserted, not session-measured | ❌ no session control | ❌ ACP 264K | ⚠️ catalog-asserted, not session-measured | ❌ | ❔ not evaluated | ⚠️ custom |
| Full interactive controls | ✅ | ⚠️ internal API | ✅ daemon, adapter needed | ❌ | ✅ except long context | ✅ RPC, adapter needed | ❌ auto-approved | ⚠️ varies | ⚠️ build |

## 6. Decision

1. **Keep `discord-copilot-sdk` as the product.** It is the only evaluated
   option that already satisfies every hard requirement, including a measured
   long-context Copilot session.
2. **Evolve it into a dual-harness architecture.** Preserve
   `@github/copilot-sdk` and add direct OMP RPC-UI behind a provider-neutral
   session contract, as specified in
   [#27](https://github.com/lettucebo/discord-copilot-sdk/issues/27). This reuses
   the difficult Discord, worktree, persistence, and approval infrastructure
   instead of rebuilding it around Paseo.
3. **Exclude stock ACP-backed routes while stock `copilot --acp` cannot present
   verified long context.** The custom ACP-to-SDK proxy in §4.9 is rejected
   separately because it adds a protocol and maintenance layer without removing
   custom harness work. `omp acp` is also not selected: OMP's RPC-UI directly
   exposes the tool cards, selectors, and dialogs this adapter needs, so ACP
   would add a protocol layer without adding control-plane capability. The probe
   below and the triggers in §8 define when to reconsider stock Copilot ACP.

## 7. Evidence appendix (reproducible)

### 7.1 Stock Copilot ACP catalog and configuration probe

Run from an empty directory with Node.js and an authenticated Copilot CLI:

```javascript
// npm install @agentclientprotocol/sdk
import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

const child = spawn("copilot", ["--acp", "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
  shell: process.platform === "win32",
});
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const connection = new acp.ClientSideConnection(() => ({
  async requestPermission() { return { outcome: { outcome: "cancelled" } }; },
  async sessionUpdate() {},
}), stream);

await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });

console.log("models:", session.models.availableModels.map((m) => m.modelId));
console.log("configOptions:", session.configOptions.map((o) => o.id));

for (const [configId, value] of [["model", "claude-opus-5-1m"], ["contextTier", "long_context"]]) {
  try {
    await connection.setSessionConfigOption({ sessionId: session.sessionId, configId, value });
    console.log(configId, "accepted");
  } catch (error) {
    console.log(configId, "rejected:", error.message);
  }
}

child.stdin.end();
child.kill();
```

Observed with Copilot CLI `1.0.81-8`:

1. 24 models advertised; **zero** IDs or names contained `1m`, `1M`, or `long`.
2. `model = claude-opus-5-1m` → `Invalid model 'claude-opus-5-1m'.`
3. `contextTier = long_context` → `Unknown config option 'contextTier'.`

### 7.2 ACP startup flag probe

Result 4 requires a real turn and is not produced by the catalog script:

1. Set `COPILOT_HOME` to a new empty throwaway directory.
2. Change the child arguments to
   `["--acp", "--stdio", "--model", "claude-opus-5", "--context", "long_context"]`.
3. Create the ACP session and send one ordinary prompt so the agent context is
   initialized.
4. Send `/context` as the next prompt and inspect the reply.
5. Delete the throwaway directory.

The isolated home is mandatory because `--context` writes the selected tier to
`settings.json`; using the operator's normal home would mutate later runs.

Observed output: `16k/264k tokens`.

Honesty note: `/context` labelled the model `claude-sonnet-5`, while the ACP
session reported `currentModelId: claude-opus-5`. The label is therefore not
reliable. The load-bearing observation is the 264K window, corroborated by the
catalog and two rejected configuration writes above.

Upstream tracks the missing ACP option in
[`github/copilot-cli#4275`](https://github.com/github/copilot-cli/issues/4275),
which was OPEN on 2026-08-24 with the title “ACP: expose contextTier as a
session config option (parity with interactive /model picker).”

### 7.3 Repository-search correction

The following discovery commands were also re-run on 2026-08-24:

```powershell
gh search repos Piscord --limit 100 --json fullName
gh search repos pi-discord-bridge --limit 100 --json fullName
```

They returned 22 and 14 repositories respectively, including the Pi coding
agent bridges in §4.8. This is why this record does not repeat the earlier,
incorrect claim that those names identify no projects.

## 8. What would change this decision

The durable decision stays here. Moving dependency states and exact rechecks
belong in
[#28](https://github.com/lettucebo/discord-copilot-sdk/issues/28).

Re-evaluate when any of these named triggers occurs:

- Copilot ACP exposes and accepts `contextTier`.
- Copilot ACP advertises and successfully runs a long-context model.
- OMP changes its RPC-UI or synthetic long-context model contract.
- An OMP release documents compatibility with Pi extensions built against
  `@earendil-works/pi-coding-agent`, or an evaluated Pi bridge documents support
  for `@oh-my-pi/pi-coding-agent` or running turns with `omp`.
- A real OMP session using the GitHub Copilot provider validates the discovered
  `-1m` variant, reported context window, and effective long-context behavior.
- A Copilot SDK preview breaks the verified SDK-native path.
- Paseo promotes the required controls from its internal daemon client to its
  stable high-level client.
- A Pi/OMP Discord bridge adds the missing fixed-worktree, approval, and
  verified long-context guarantees.

Until a trigger is demonstrated by a real session rather than a label, the
decision in §6 remains in force.
