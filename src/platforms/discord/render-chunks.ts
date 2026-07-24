// The per-turn message anchor reconciler, extracted from DiscordTransport.doFlush
// so its re-anchor + trim behavior is unit-testable with a fake channel (no live
// Discord). Owns exactly one rule the SDK stream depends on: a streamed chunk is
// NEVER silently dropped — if its anchor message was deleted, we re-anchor.

/** The slice of a discord.js Message this reconciler needs. */
export interface MinimalMessage {
  id: string;
  edit(opts: unknown): Promise<unknown>;
  delete(): Promise<unknown>;
}

/** The slice of a discord.js text channel/thread this reconciler needs. */
export interface MinimalChannel {
  send(opts: unknown): Promise<MinimalMessage>;
  messages: { fetch(id: string): Promise<MinimalMessage> };
}

/**
 * Is this error a DEFINITIVE "the message is gone" (deleted)? Discord replies
 * with API error code 10008 (Unknown Message). We also accept a bare HTTP 404
 * with NO api code (a proxy/gateway 404). We deliberately do NOT treat a 404
 * that carries a different api code as message-gone — e.g. 10003 (Unknown
 * Channel) is `{code:10003,status:404}`, and re-posting into a dead channel is
 * futile (that case is handled upstream by fetchThread returning undefined).
 * Anything else — 429 rate-limit, 5xx, network — is TRANSIENT: the message
 * almost certainly still exists, so we must NOT re-anchor (a fresh post would
 * duplicate the output). Mirrors app.ts's channel classifier (`e?.code`/`status`).
 */
export function isMessageGone(err: unknown): boolean {
  const e = err as { code?: number; status?: number } | null | undefined;
  return e?.code === 10008 || (e?.code == null && e?.status === 404);
}

/**
 * Reconcile the on-screen anchor messages (`msgIds`) with the latest `chunks`:
 *  - edit an existing anchor in place;
 *  - if that anchor is GONE (deleted), RE-ANCHOR it: post a NEW message and
 *    record its id in that slot, so the chunk's content is never lost;
 *  - a TRANSIENT edit failure is left as-is (best effort; never duplicate);
 *  - append fresh anchors for added chunks; best-effort trim anchors no longer used.
 *
 * `stillCurrent()` is checked before every mutation so a new turn started
 * mid-write (epoch bump) abandons cleanly: an in-flight send for a superseded
 * turn is deleted rather than recorded. Mutates `msgIds` in place.
 *
 * DESIGN (why not rebuild the whole suffix): Discord has no insert-in-place, so a
 * re-anchored message lands at the channel TAIL. We deliberately DO NOT delete
 * and re-post the surviving later anchors to "fix" ordering — deleting messages
 * we can't atomically re-post risks LOSING content if a delete transiently fails
 * mid-way (worse than the pre-fix behavior). Instead we only ever ADD a
 * replacement for the gone slot. Result: content is never lost and never
 * duplicated. Residuals (accepted, single-owner tool): (1) if the user manually
 * deletes a NON-last streamed message, its replacement appears at the tail, so a
 * multi-chunk response can read OUT OF ORDER until the next turn (content is all
 * present); (2) like any debounced best-effort renderer, a transient edit/delete
 * failure is retried on the next flush and only lingers if it happens on the
 * turn's FINAL flush. See docs/PLAN.md §9.1.
 */
export async function renderChunks(
  channel: MinimalChannel,
  msgIds: string[],
  chunks: string[],
  stillCurrent: () => boolean,
  sendOpts: (content: string) => unknown
): Promise<void> {
  for (let i = 0; i < chunks.length; i++) {
    if (!stillCurrent()) return; // a new turn started mid-write
    const content = chunks[i]!;
    const existing = msgIds[i];
    if (existing) {
      try {
        const m = await channel.messages.fetch(existing);
        await m.edit(sendOpts(content));
        continue; // edited in place
      } catch (err) {
        if (!isMessageGone(err)) continue; // transient: leave the anchor as-is
        // definitive: the anchor was deleted — re-anchor this slot (post below).
      }
    }
    const m = await channel.send(sendOpts(content));
    if (!stillCurrent()) {
      // resetTurn/dispose landed while the send was in flight: this message
      // belongs to a turn that no longer exists — delete it, don't record it.
      try {
        await m.delete();
      } catch {
        /* best effort */
      }
      return;
    }
    msgIds[i] = m.id;
  }
  // Trim anchors the shorter final output no longer needs, from the END. Only
  // drop an id from tracking once its message is confirmed deleted (or already
  // gone); on a TRANSIENT delete failure, stop and keep tracking it so the next
  // flush retries — never truncate past an unconfirmed delete (that would orphan
  // an untracked message → a visible duplicate that never gets cleaned).
  while (msgIds.length > chunks.length) {
    const id = msgIds[msgIds.length - 1];
    if (id) {
      try {
        const m = await channel.messages.fetch(id);
        await m.delete();
      } catch (err) {
        if (!isMessageGone(err)) break; // transient: retain tracking, retry next flush
      }
    }
    msgIds.pop();
  }
}
