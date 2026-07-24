import { describe, it, expect } from "vitest";
import { isMessageGone, renderChunks, type MinimalChannel, type MinimalMessage } from "../src/platforms/discord/render-chunks.js";

class FakeMsg implements MinimalMessage {
  edited?: string;
  deleted = false;
  editError?: unknown;
  deleteError?: unknown;
  constructor(
    public id: string,
    private store: Map<string, FakeMsg>
  ) {}
  async edit(opts: unknown): Promise<unknown> {
    if (this.editError) throw this.editError;
    this.edited = (opts as { content: string }).content;
    return {};
  }
  async delete(): Promise<unknown> {
    if (this.deleteError) throw this.deleteError;
    this.deleted = true;
    this.store.delete(this.id);
    return {};
  }
}

class FakeChannel implements MinimalChannel {
  store = new Map<string, FakeMsg>();
  sent: string[] = [];
  private n = 0;
  fetchError?: (id: string) => unknown; // override to force a fetch error
  seed(id: string): FakeMsg {
    const m = new FakeMsg(id, this.store);
    this.store.set(id, m);
    return m;
  }
  async send(opts: unknown): Promise<MinimalMessage> {
    const id = `new${++this.n}`;
    const m = new FakeMsg(id, this.store);
    this.store.set(id, m);
    this.sent.push((opts as { content: string }).content);
    return m;
  }
  messages = {
    fetch: async (id: string): Promise<MinimalMessage> => {
      const e = this.fetchError?.(id);
      if (e) throw e;
      const m = this.store.get(id);
      if (!m) throw { code: 10008 }; // Discord "Unknown Message"
      return m;
    },
  };
}

const opts = (content: string) => ({ content });
const always = () => true;

describe("isMessageGone", () => {
  it("treats Unknown Message (10008) and a bare 404 (no api code) as gone", () => {
    expect(isMessageGone({ code: 10008 })).toBe(true);
    expect(isMessageGone({ code: 10008, status: 404 })).toBe(true);
    expect(isMessageGone({ status: 404 })).toBe(true); // proxy/gateway 404, no api code
  });
  it("treats rate-limit / 5xx / network / Unknown Channel / null as TRANSIENT (not gone)", () => {
    expect(isMessageGone({ status: 429 })).toBe(false);
    expect(isMessageGone({ status: 500 })).toBe(false);
    expect(isMessageGone({ code: 10003, status: 404 })).toBe(false); // Unknown Channel, not message
    expect(isMessageGone(new Error("ECONNRESET"))).toBe(false);
    expect(isMessageGone(null)).toBe(false);
    expect(isMessageGone(undefined)).toBe(false);
  });
});

describe("renderChunks", () => {
  it("fresh turn: sends one message per chunk and records ids in order", async () => {
    const ch = new FakeChannel();
    const ids: string[] = [];
    await renderChunks(ch, ids, ["a", "b"], always, opts);
    expect(ch.sent).toEqual(["a", "b"]);
    expect(ids).toEqual(["new1", "new2"]);
  });

  it("re-flush: edits the existing anchors in place (no new sends)", async () => {
    const ch = new FakeChannel();
    const m1 = ch.seed("m1");
    const ids = ["m1"];
    await renderChunks(ch, ids, ["updated"], always, opts);
    expect(ch.sent).toEqual([]); // nothing new posted
    expect(m1.edited).toBe("updated");
    expect(ids).toEqual(["m1"]);
  });

  it("RE-ANCHORS when the only message is gone (404): posts a new one, records its id", async () => {
    const ch = new FakeChannel();
    // msgIds points at "m1" but it was deleted — fetch("m1") throws 10008.
    const ids = ["m1"];
    await renderChunks(ch, ids, ["still here"], always, opts);
    expect(ch.sent).toEqual(["still here"]); // content NOT dropped
    expect(ids).toEqual(["new1"]); // slot re-anchored to the new message
  });

  it("re-anchors when the EDIT (not the fetch) reports the message gone", async () => {
    const ch = new FakeChannel();
    const m1 = ch.seed("m1");
    m1.editError = { code: 10008 }; // exists at fetch, but gone by edit
    const ids = ["m1"];
    await renderChunks(ch, ids, ["recovered"], always, opts);
    expect(ch.sent).toEqual(["recovered"]);
    expect(ids).toEqual(["new1"]);
  });

  it("re-anchors the FIRST gone slot WITHOUT touching the surviving anchors", async () => {
    const ch = new FakeChannel();
    ch.seed("m1"); // reported gone
    const m2 = ch.seed("m2"); // survivor — must be edited in place, never deleted
    ch.fetchError = (id) => (id === "m1" ? { code: 10008 } : undefined);
    const ids = ["m1", "m2"];
    await renderChunks(ch, ids, ["A", "B"], always, opts);
    expect(ch.sent).toEqual(["A"]); // gone slot re-anchored (content preserved)
    expect(m2.edited).toBe("B"); // survivor edited in place
    expect(m2.deleted).toBe(false); // NEVER deleted → no content-loss risk
    expect(ids).toEqual(["new1", "m2"]); // A now at the tail (rare cosmetic re-order)
  });

  it("re-anchors a MIDDLE gone slot, keeping earlier + later survivors intact", async () => {
    const ch = new FakeChannel();
    const m1 = ch.seed("m1");
    ch.seed("m2"); // reported gone
    const m3 = ch.seed("m3");
    ch.fetchError = (id) => (id === "m2" ? { code: 10008 } : undefined);
    const ids = ["m1", "m2", "m3"];
    await renderChunks(ch, ids, ["A", "B", "C"], always, opts);
    expect(m1.edited).toBe("A"); // earlier survivor edited in place
    expect(m3.edited).toBe("C"); // later survivor edited in place (NOT deleted)
    expect(m3.deleted).toBe(false); // key: survivors are never deleted → no loss
    expect(ch.sent).toEqual(["B"]); // only the gone chunk is re-posted
    expect(ids).toEqual(["m1", "new1", "m3"]); // B's content preserved
  });

  it("a TRANSIENT delete failure of a survivor cannot lose content (survivors are never deleted)", async () => {
    // Regression for the rebuild content-loss bug: re-anchoring the FIRST slot
    // must not delete m2 at all, so a flaky delete can never drop m2's content.
    const ch = new FakeChannel();
    ch.seed("m1");
    const m2 = ch.seed("m2");
    ch.fetchError = (id) => (id === "m1" ? { code: 10008 } : undefined);
    m2.deleteError = { status: 500 }; // would matter only if we tried to delete it
    const ids = ["m1", "m2"];
    await renderChunks(ch, ids, ["A", "B"], always, opts);
    expect(m2.deleted).toBe(false); // we never even attempt to delete a survivor
    expect(m2.edited).toBe("B"); // its content stays, edited in place
    expect(ch.sent).toEqual(["A"]); // gone slot's content re-anchored
    expect(ids).toEqual(["new1", "m2"]);
  });

  it("does NOT re-anchor on a TRANSIENT edit failure (leaves the anchor as-is)", async () => {
    const ch = new FakeChannel();
    const m1 = ch.seed("m1");
    m1.editError = { status: 429 }; // rate-limited — message still exists
    const ids = ["m1"];
    await renderChunks(ch, ids, ["retry later"], always, opts);
    expect(ch.sent).toEqual([]); // no duplicate post
    expect(ids).toEqual(["m1"]); // slot unchanged
  });

  it("trims and deletes anchors the shorter final output no longer needs", async () => {
    const ch = new FakeChannel();
    const m1 = ch.seed("m1");
    const m2 = ch.seed("m2");
    const ids = ["m1", "m2"];
    await renderChunks(ch, ids, ["only one now"], always, opts);
    expect(m1.edited).toBe("only one now");
    expect(m2.deleted).toBe(true);
    expect(ids).toEqual(["m1"]);
  });

  it("epoch guard: a send for a turn that ended mid-write is deleted, not recorded", async () => {
    const ch = new FakeChannel();
    let calls = 0;
    const stillCurrent = () => {
      calls++;
      return calls < 2; // true at the loop guard, false right after the send
    };
    const ids: string[] = [];
    await renderChunks(ch, ids, ["late"], stillCurrent, opts);
    expect(ch.sent).toEqual(["late"]); // it was sent...
    expect(ids).toEqual([]); // ...but not recorded (superseded turn)
    // the orphaned message was cleaned up
    expect([...ch.store.values()].every((m) => m.deleted)).toBe(true);
  });
});
