import type { ChatInputCommandInteraction } from "discord.js";

/**
 * A slash-command interaction that acknowledges the way discord.js does.
 *
 * The failure this exists to stop: the older ad-hoc fakes accepted `reply()`
 * after `deferReply()`. A command that deferred and then replied was therefore
 * green in the suite and threw `InteractionAlreadyReplied` in production — which
 * aborted `/end` partway, before it reclaimed anything. The bug was invisible
 * precisely because the fake was permissive, so the acknowledgement methods here
 * are NOT overridable: they are assigned after the caller's fields, and the
 * fields type excludes them, so neither a spread nor a well-meaning override can
 * quietly restore the permissive behaviour.
 *
 * The state machine mirrors discord.js:
 *   - `deferReply()`  — only from unacknowledged; sets `deferred`.
 *   - `reply()`       — only from unacknowledged; sets `replied`.
 *   - `editReply()`   — requires an acknowledgement, and SETS `replied`, which
 *                       is what discord.js does. Code that branches on
 *                       `interaction.replied` after an edit (`beginRebind`'s
 *                       `say`) then sees what production sees.
 *   - `followUp()`    — requires an acknowledgement. `/repo clone` has already
 *                       deferred AND edited, so the rebind confirmation card can
 *                       only reach that interaction as a follow-up.
 *
 * Because `editReply` sets `replied`, "did this branch call `reply()`?" is no
 * longer answerable from the flags: assert on `replyCalls`.
 */

/** The non-acknowledgement half of an interaction — the only part a test may
 *  supply. Everything to do with answering belongs to this module. */
export interface StrictInteractionFields {
  user?: { id: string };
  guildId?: string | null;
  channelId?: string;
  channel?: unknown;
  options?: unknown;
  commandName?: string;
}

/** What a test may read back. `answers` is every user-visible answer in order,
 *  whichever method produced it, so a test can assert "answered exactly once"
 *  without caring which call did it; the counters say WHICH method did. */
export interface StrictInteraction {
  readonly answers: string[];
  readonly deferred: boolean;
  readonly replied: boolean;
  readonly replyCalls: number;
  readonly editCalls: number;
  readonly followUpCalls: number;
  deferReply(options?: unknown): Promise<void>;
  reply(options: string | { content: string }): Promise<void>;
  editReply(options: string | { content: string }): Promise<void>;
  followUp(options: string | { content: string }): Promise<void>;
}

const textOf = (options: string | { content: string }): string =>
  typeof options === "string" ? options : options.content;

export function strictInteraction(
  fields: StrictInteractionFields = {}
): StrictInteraction & StrictInteractionFields {
  const answers: string[] = [];
  const self: StrictInteraction & StrictInteractionFields = {
    // Caller fields FIRST, acknowledgement behaviour after: the ordering is the
    // structural half of "cannot be overridden".
    user: { id: "u1" },
    guildId: "g1",
    channelId: "t1",
    ...fields,
    answers,
    deferred: false,
    replied: false,
    replyCalls: 0,
    editCalls: 0,
    followUpCalls: 0,
    async deferReply(): Promise<void> {
      if (self.deferred || self.replied) throw new Error("InteractionAlreadyReplied");
      mutable(self).deferred = true;
    },
    async reply(options: string | { content: string }): Promise<void> {
      if (self.deferred || self.replied) throw new Error("InteractionAlreadyReplied");
      mutable(self).replied = true;
      mutable(self).replyCalls++;
      answers.push(textOf(options));
    },
    async editReply(options: string | { content: string }): Promise<void> {
      if (!self.deferred && !self.replied) throw new Error("InteractionNotReplied");
      // discord.js sets this too: after an edit the interaction IS replied.
      mutable(self).replied = true;
      mutable(self).editCalls++;
      answers.push(textOf(options));
    },
    async followUp(options: string | { content: string }): Promise<void> {
      if (!self.deferred && !self.replied) throw new Error("InteractionNotReplied");
      mutable(self).followUpCalls++;
      answers.push(textOf(options));
    },
  };
  return self;
}

/** The one place the read-only view is written, rather than widening the type
 *  every test sees. */
function mutable(self: StrictInteraction): {
  deferred: boolean;
  replied: boolean;
  replyCalls: number;
  editCalls: number;
  followUpCalls: number;
} {
  return self as {
    deferred: boolean;
    replied: boolean;
    replyCalls: number;
    editCalls: number;
    followUpCalls: number;
  };
}

/** The single cast, kept here so no test file needs one. The app only ever
 *  touches the members declared above. */
export function asCommandInteraction(
  self: StrictInteraction & StrictInteractionFields
): ChatInputCommandInteraction {
  return self as unknown as ChatInputCommandInteraction;
}
