# discopilot

Control your **local GitHub Copilot** from **Discord** — with the full "GitHub Copilot app"
experience — from anywhere, including your phone.

`discopilot` is a Discord bot that drives the local Copilot engine through the official
[`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk) (JSON-RPC). Each
Discord thread maps to a Copilot session; the bot streams the agent's messages, reasoning,
tool calls, plans and usage into the thread, and surfaces permission / choice / plan prompts
as Discord buttons, selects and modals that you respond to from any device.

> Sibling project to [`seam-acp`](https://github.com/lettucebo/seam-acp): seam-acp bridges
> Discord to multiple agents over the ACP protocol; **discopilot is Copilot-only and
> SDK-native**, giving the fullest, most official Copilot experience (native ask_user,
> plan approval, usage, per-model context up to ~1M via `contextTier: long_context`).

## Status

🚧 **Early scaffold.** Architecture and phased plan in [`docs/PLAN.md`](docs/PLAN.md).

## ⚠️ Security model (read before running)

discopilot v1 is **lab-only**. It runs shell/file tools **as the user that starts the bot**,
against a single controlled repo — there is no sandbox in v1 (the isolated controller/worker
split is deferred). Run it only on a disposable machine/VM you don't mind the agent modifying.

Mitigations that **are** in place:

- **Approve-per-command**: every shell permission is surfaced as a Discord Allow/Deny card;
  Allow is settled only after Discord acknowledges the click, and every other permission kind
  and interactive callback (ask_user / exit-plan / elicitation) **fails closed** (deny/cancel).
- **Repo can't reconfigure the agent**: `enableFileHooks`, `enableConfigDiscovery` and
  `enableSkills` are disabled, so a controlled-repo `.github/hooks` file can't auto-approve
  ("`resolvedByHook`") a command behind your back.
- **Spoofing-resistant cards**: the command is shown escaped (no markdown/code-fence breakout),
  commands containing bidirectional/control characters are auto-denied, and an over-long command
  is auto-denied rather than shown partially.
- **Access gate**: only allow-listed user id(s), in the configured guild + parent channel/threads,
  can drive a session. (This gates *input*; anyone who can read the channel can read *output* — use
  a private channel.) Secrets (`DISCORD_*`/`DISCOPILOT_*`) are stripped from the agent's runtime env.

**Known limitation — inherited approvals:** the bot uses your logged-in Copilot (`~/.copilot`), so
any blanket "always allow" approval rules you've saved there apply and would bypass the per-command
Discord prompt. For a true approve-per-command demo, run under an account/home **without** saved
auto-approvals. Full isolation is the deferred controller/worker split.

## Why the SDK (verified)

Empirically confirmed on a real machine (Copilot Enterprise, copilot CLI 1.0.74-1):

- Drives a **local** session end-to-end: `listModels()`, `createSession()`, `send()`, full
  event stream (`assistant.message`/`reasoning`/deltas, `tool.execution_*`,
  `session.usage_info`/`plan_changed`/`idle`).
- Native interactive callbacks: `onPermissionRequest`, `onUserInputRequest` (ask_user),
  `onExitPlanMode`, `onElicitationRequest`.
- **`contextTier: "long_context"` unlocks a 936K effective window** (200K default) — something
  the raw ACP path could not do (capped at 264K).

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- GitHub Copilot CLI installed and signed in on the host (the bot uses the logged-in user)
- A Discord bot token; your Discord user id on the allow-list

## Quick start

_TBD — see [`docs/PLAN.md`](docs/PLAN.md) for the build phases._

```bash
cp .env.example .env   # fill in DISCORD_BOT_TOKEN + DISCORD_ALLOWED_USER_IDS
npm install
npm run dev
```

## License

MIT — see [LICENSE](LICENSE).
