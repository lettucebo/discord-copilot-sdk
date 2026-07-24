import { describe, it, expect } from "vitest";
import { isMessageGone, renderChunks, type MinimalChannel, type MinimalMessage } from "../src/platforms/discord/render-chunks.js";

class FakeMsg implements MinimalMessage {
  edited?: string;
  deleted = false;
  editError?: unknown;
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

  it("preserves ORDER when the FIRST of several anchors is gone (re-posts all)", async () => {
    const ch = new FakeChannel();
    ch.seed("m1"); // will be reported gone
    const m2 = ch.seed("m2");
    ch.fetchError = (id) => (id === "m1" ? { code: 10008 } : undefined);
    const ids = ["m1", "m2"];
    await renderChunks(ch, ids, ["A", "B"], always, opts);
    // m1 gone → rebuild from slot 0: delete the stale m2, re-post A then B at the tail.
    expect(ch.sent).toEqual(["A", "B"]); // correct order, nothing reversed
    expect(ids).toEqual(["new1", "new2"]);
    expect(m2.deleted).toBe(true); // stale later anchor removed
  });

  it("preserves ORDER when a MIDDLE anchor is gone (keeps earlier, re-posts from the gap)", async () => {
    const ch = new FakeChannel();
    const m1 = ch.seed("m1");
    ch.seed("m2"); // reported gone
    const m3 = ch.seed("m3");
    ch.fetchError = (id) => (id === "m2" ? { code: 10008 } : undefined);
    const ids = ["m1", "m2", "m3"];
    await renderChunks(ch, ids, ["A", "B", "C"], always, opts);
    expect(m1.edited).toBe("A"); // earlier anchor kept + edited in place
    expect(m3.deleted).toBe(true); // stale later anchor removed
    expect(ch.sent).toEqual(["B", "C"]); // re-posted in order after A
    expect(ids).toEqual(["m1", "new1", "new2"]);
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
