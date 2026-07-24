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
 *  - if that anchor is GONE (deleted), RE-ANCHOR — because a new message can only
 *    be posted at the channel TAIL (Discord has no insert-in-place), re-posting
 *    just the gone chunk would put it AFTER later chunks. So on the first gone
 *    anchor we switch to REBUILD mode: delete the now-stale later anchors and
 *    re-post this chunk and every following one fresh, preserving chunk order;
 *  - a TRANSIENT edit failure is left as-is (best effort; never duplicate);
 *  - append fresh anchors for added chunks; delete + trim anchors no longer used.
 *
 * `stillCurrent()` is checked before every mutation so a new turn started
 * mid-write (epoch bump) abandons cleanly: an in-flight send for a superseded
 * turn is deleted rather than recorded. Mutates `msgIds` in place.
 */
export async function renderChunks(
  channel: MinimalChannel,
  msgIds: string[],
  chunks: string[],
  stillCurrent: () => boolean,
  sendOpts: (content: string) => unknown
): Promise<void> {
  let rebuilding = false; // once an anchor is found gone, re-post the rest at the tail
  for (let i = 0; i < chunks.length; i++) {
    if (!stillCurrent()) return; // a new turn started mid-write
    const content = chunks[i]!;
    const existing = rebuilding ? undefined : msgIds[i];
    if (existing) {
      try {
        const m = await channel.messages.fetch(existing);
        await m.edit(sendOpts(content));
        continue; // edited in place
      } catch (err) {
        if (!isMessageGone(err)) continue; // transient: leave the anchor as-is
        // Definitive: this anchor was deleted. Preserve order by re-posting this
        // and every following chunk at the tail; drop the stale later anchors.
        rebuilding = true;
        await deleteAnchors(channel, msgIds, i + 1);
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
  // Trim anchors the shorter final output no longer needs.
  await deleteAnchors(channel, msgIds, chunks.length);
  if (msgIds.length > chunks.length) msgIds.length = chunks.length;
}

/** Best-effort delete of anchor messages at slots [from, end). Missing ones are
 *  ignored (already gone). Does not shrink `msgIds` (the caller trims). */
async function deleteAnchors(channel: MinimalChannel, msgIds: string[], from: number): Promise<void> {
  for (let i = from; i < msgIds.length; i++) {
    const id = msgIds[i];
    if (!id) continue;
    try {
      const m = await channel.messages.fetch(id);
      await m.delete();
    } catch {
      /* already gone */
    }
  }
}
