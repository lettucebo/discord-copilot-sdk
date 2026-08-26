# discord-copilot-sdk

A Discord bot that drives a local GitHub Copilot session per thread. This glossary covers the vocabulary for where the bot's commands and content are allowed to reach, as distinct from where the bot is authorized to act.

## Language

**Authorization plane**:
The layer that decides whether the bot will actually act on a request — enforced by the bot itself (`/channel`), independent of anything Discord shows or delivers.
_Avoid_: permission plane, security layer

**Bot visibility plane**:
The layer that decides which channels the bot is a member of and therefore receives events from — controlled entirely by Discord channel membership/permissions, not by this bot's own configuration.
_Avoid_: read plane, membership plane

**Command visibility plane**:
The layer that decides whether a user's `/` picker lists the bot's commands in a given channel — primarily a consequence of the bot visibility plane, with an optional secondary override in Discord's Integrations settings.
_Avoid_: picker visibility, slash-command visibility

**Enabled channel**:
A channel recorded in the bot's own registry as authorized for it to act on — the unit the authorization plane reasons about, independent of whether the bot can currently see that channel.
_Avoid_: authorized channel, whitelisted channel

**Visible channel**:
A channel the bot is currently a member of and receives events from — the unit the bot visibility plane reasons about, independent of whether that channel is enabled.
_Avoid_: readable channel

**Obfuscated channel**:
A channel the bot cannot see, represented to it as a placeholder with a hidden name and cleared fields rather than omitted or denied outright — a state of the bot visibility plane, not a decision the bot makes.
_Avoid_: hidden channel, redacted channel

**Seed default**:
The one channel automatically recorded as enabled the first time a bot instance ever starts, so it is never authorization-less out of the box — a starting value, not a permanently protected or undisableable channel.
_Accepted descriptive synonym (operator-facing docs)_: first-run default
_Avoid_: seed channel, primary channel, default channel

**Bot instance**:
One Discord application (with its own bot user, token, and command registrations) running one copy of this program — the unit that owns a distinct membership set across channels, separate from any other instance in the same server.
_Avoid_: bot app, deployment, installation
