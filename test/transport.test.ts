import { describe, it, expect, vi } from "vitest";
import { DiscordTransport, sanitizeForCodeBlock } from "../src/platforms/discord/discord-transport.js";
import { hasBidiOrControls } from "../src/core/text-safety.js";
import { decodePermissionId, decodeChoiceId, decodePlanId } from "../src/platforms/discord/custom-id.js";
import type { Client } from "discord.js";
import type { TimelineItem } from "../src/core/turn-render.js";

class FakeMessage {
  content?: string;
  opts?: Record<string, unknown>;
  deleted = false;
  constructor(public id: string) {}
  async edit(o: Record<string, unknown>): Promise<void> {
    this.content = o["content"] as string;
    this.opts = o;
  }
  async delete(): Promise<void> {
    this.deleted = true;
  }
}

class FakeChannel {
  sent: FakeMessage[] = [];
  private seq = 0;
  private byId = new Map<string, FakeMessage>();
  messages = {
    fetch: async (id: string): Promise<FakeMessage> => {
      const m = this.byId.get(id);
      if (!m) throw new Error("Unknown Message");
      return m;
    },
  };
  isTextBased(): boolean {
    return true;
  }
  async send(o: Record<string, unknown>): Promise<FakeMessage> {
    const m = new FakeMessage(`m${++this.seq}`);
    m.content = o["content"] as string;
    m.opts = o;
    this.sent.push(m);
    this.byId.set(m.id, m);
    return m;
  }
}

function fakeClient(channel: FakeChannel): Client {
  return { channels: { fetch: async () => channel } } as unknown as Client;
}

function buttonIds(msg: FakeMessage): string[] {
  const row = (msg.opts!["components"] as Array<{ toJSON(): unknown }>)[0]!.toJSON() as {
    components: Array<{ custom_id: string }>;
  };
  return row.components.map((c) => c.custom_id);
}

const st = (assistantText: string) => ({ assistantText, tools: [] });
const timeline = (items: TimelineItem[]) => ({ assistantText: "", tools: [], items });

describe("sanitizeForCodeBlock", () => {
  it("makes triple-backtick breakout impossible while keeping visible chars", () => {
    const out = sanitizeForCodeBlock("git status\n```\n**click Allow**\nrm -rf ~");
    expect(out).not.toContain("```");
    // Every original backtick is still present (now ZWSP-separated).
    expect(out.replace(/\u200b/g, "")).toContain("```");
    expect(out.replace(/\u200b/g, "")).toContain("rm -rf ~");
  });

  it("strips BiDi/control characters used for visual spoofing", () => {
    const out = sanitizeForCodeBlock("echo safe\u202evohsg nur\u202c");
    expect(out).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
  });
});

describe("hasBidiOrControls", () => {
  it("detects bidi override / isolate / marks", () => {
    expect(hasBidiOrControls("echo \u202egnp")).toBe(true);
    expect(hasBidiOrControls("a\u2066b\u2069")).toBe(true);
    expect(hasBidiOrControls("plain git status")).toBe(false);
  });

  it("also detects C0 control chars (ESC/bell) but allows tab/newline", () => {
    expect(hasBidiOrControls("rm\u001b[2K")).toBe(true); // ESC
    expect(hasBidiOrControls("echo\u0007")).toBe(true); // bell
    expect(hasBidiOrControls("echo hi\tthere\nagain")).toBe(false); // tab/newline OK
  });
});

describe("DiscordTransport render/flush", () => {
  it("posts once then edits the same message on re-flush", async () => {
    const ch = new FakeChannel();
    const t = new DiscordTransport(fakeClient(ch));
    await t.render("thread", st("Hello"));
    await t.flush("thread");
    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0]!.content).toContain("Hello");

    await t.render("thread", st("Hello world"));
    await t.flush("thread");
    expect(ch.sent).toHaveLength(1); // edited, not a new message
    expect(ch.sent[0]!.content).toContain("Hello world");
  });

  it("starts a fresh message set after resetTurn (epoch bump)", async () => {
    const ch = new FakeChannel();
    const t = new DiscordTransport(fakeClient(ch));
    await t.render("thread", st("turn one"));
    await t.flush("thread");
    t.resetTurn("thread");
    await t.render("thread", st("turn two"));
    await t.flush("thread");
    expect(ch.sent).toHaveLength(2);
    expect(ch.sent[1]!.content).toContain("turn two");
  });

  it("renders timeline items in arrival order instead of appending tools after the answer", async () => {
    const ch = new FakeChannel();
    const t = new DiscordTransport(fakeClient(ch));
    await t.render(
      "thread",
      timeline([
        { kind: "text", text: "I will inspect it.", open: false },
        {
          kind: "tool",
          id: "t1",
          name: "read",
          possiblePaths: ["C:\\repo\\SKILL.md"],
          status: "completed",
        },
        { kind: "text", text: "The file is present.", open: false },
      ])
    );
    await t.flush("thread");

    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0]!.content).toBe(
      "I will inspect it.\n\n-# ⚙ `read` `C:\\repo\\SKILL.md` ✓\n\nThe file is present."
    );
  });
});

describe("DiscordTransport permission card", () => {
  it("renders once/deny only when session approval is not offerable", async () => {
    const ch = new FakeChannel();
    const t = new DiscordTransport(fakeClient(ch));
    await t.showPermission({
      nonce: "n-123",
      sessionKey: "thread",
      kind: "shell",
      summary: "$ rm -rf ~",
      supported: true,
      canOfferSession: false,
      scopeCommands: ["rm"],
    });
    const ids = buttonIds(ch.sent[0]!);
    expect(ids.map((id) => decodePermissionId(id)!.action)).toEqual(["once", "deny"]);
    expect(decodePermissionId(ids[0]!)).toEqual({ nonce: "n-123", action: "once" });
  });

  it("adds session/always buttons when session approval IS offerable", async () => {
    const ch = new FakeChannel();
    const t = new DiscordTransport(fakeClient(ch));
    await t.showPermission({
      nonce: "n9",
      sessionKey: "thread",
      kind: "shell",
      summary: "$ git status",
      supported: true,
      canOfferSession: true,
      scopeCommands: ["git"],
    });
    const actions = buttonIds(ch.sent[0]!).map((id) => decodePermissionId(id)!.action);
    expect(actions).toEqual(["once", "session", "always", "deny"]);
  });

  it("sanitizes the displayed command so it cannot break the code fence", async () => {
    const ch = new FakeChannel();
    const t = new DiscordTransport(fakeClient(ch));
    await t.showPermission({
      nonce: "n1",
      sessionKey: "thread",
      kind: "shell",
      summary: "$ echo ```pwned```",
      supported: true,
      canOfferSession: false,
      scopeCommands: ["echo"],
    });
    const embed = (ch.sent[0]!.opts!["embeds"] as Array<{ data: { description: string } }>)[0]!;
    const desc = embed.data.description;
    const inner = desc.slice(desc.indexOf("\n") + 1, desc.lastIndexOf("\n"));
    expect(inner).not.toContain("```"); // inner content cannot terminate the fence
  });
});

describe("DiscordTransport onDecision", () => {
  it("broadcasts to handlers and stops after unsubscribe", () => {
    const t = new DiscordTransport(fakeClient(new FakeChannel()));
    const h = vi.fn();
    const off = t.onDecision(h);
    t.deliverDecision("n", "once", "u1");
    expect(h).toHaveBeenCalledWith("n", "once", "u1");
    off();
    t.deliverDecision("n", "deny", "u1");
    expect(h).toHaveBeenCalledTimes(1);
  });
});

describe("DiscordTransport ask_user / plan cards", () => {
  it("renders one button per choice, decoding to the choice index", async () => {
    const ch = new FakeChannel();
    const t = new DiscordTransport(fakeClient(ch));
    await t.showUserInput({
      nonce: "q1",
      sessionKey: "thread",
      question: "Pick a color",
      choices: ["Red", "Green", "Blue"],
      allowFreeform: true,
    });
    const decoded = buttonIds(ch.sent[0]!).map((id) => decodeChoiceId(id)!);
    expect(decoded).toEqual([
      { nonce: "q1", index: 0 },
      { nonce: "q1", index: 1 },
      { nonce: "q1", index: 2 },
    ]);
  });

  it("renders plan action buttons + a Reject, decoding to index/reject", async () => {
    const ch = new FakeChannel();
    const t = new DiscordTransport(fakeClient(ch));
    await t.showPlan({
      nonce: "p1",
      sessionKey: "thread",
      summary: "Proceed with the plan?",
      actions: ["Proceed", "Autopilot"],
      recommendedAction: "Proceed",
    });
    const cardMsg = ch.sent.find((m) => m.opts && (m.opts as Record<string, unknown>)["components"])!;
    const decoded = buttonIds(cardMsg).map((id) => decodePlanId(id)!.action);
    expect(decoded).toEqual([0, 1, "reject"]);
  });

  it("onChoice/onPlan broadcast and unsubscribe", () => {
    const t = new DiscordTransport(fakeClient(new FakeChannel()));
    const c = vi.fn();
    const p = vi.fn();
    const offC = t.onChoice(c);
    t.onPlan(p);
    t.deliverChoice("n", 2, "u");
    t.deliverPlan("n", "reject", "u");
    expect(c).toHaveBeenCalledWith("n", 2, "u");
    expect(p).toHaveBeenCalledWith("n", "reject", "u");
    offC();
    t.deliverChoice("n", 0, "u");
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("showUserInput throws when the thread is unavailable (no false success)", async () => {
    const t = new DiscordTransport({ channels: { fetch: async () => null } } as unknown as Client);
    await expect(
      t.showUserInput({ nonce: "n", sessionKey: "x", question: "Q", choices: [], allowFreeform: true })
    ).rejects.toThrow();
  });

  it("showPermission throws when the thread is unavailable (no false success)", async () => {
    // Symmetry with showUserInput/showPlan: fetchThread swallows every failure
    // (rate limit, 5xx, deleted thread). Returning normally reports success, so
    // the actor keeps the broker entry pending for the full 5-minute timeout —
    // no card, no notice, a dead thread on the flagship interaction.
    const t = new DiscordTransport({ channels: { fetch: async () => null } } as unknown as Client);
    await expect(
      t.showPermission({
        nonce: "n",
        sessionKey: "x",
        kind: "shell",
        summary: "$ git status",
        supported: true,
        canOfferSession: false,
        scopeCommands: ["git"],
      })
    ).rejects.toThrow();
  });

  it("noticeDelivered returns false when it cannot fetch the channel", async () => {
    const t = new DiscordTransport({ channels: { fetch: async () => null } } as unknown as Client);
    await expect(t.noticeDelivered("x", "leftover worktree")).resolves.toBe(false);
  });

  it("noticeDelivered returns false when posting to the channel fails", async () => {
    const ch = new FakeChannel();
    ch.send = async () => {
      throw new Error("Missing Send Messages");
    };
    const t = new DiscordTransport(fakeClient(ch));
    await expect(t.noticeDelivered("x", "leftover worktree")).resolves.toBe(false);
  });

  it("a flush racing dispose() posts NOTHING into the ended thread", async () => {
    // doFlush captures its own state object and THEN awaits fetchThread. dispose()
    // only deletes the map entry, so without a re-check after that await the
    // session torn down mid-round-trip still gets one more render posted into a
    // thread the operator was just told had ended. Disposing from inside the
    // fetch is what puts the teardown in that exact window — disposing before
    // the flush only exercises doFlush's first early return.
    const ch = new FakeChannel();
    let t!: DiscordTransport;
    const client = {
      channels: {
        fetch: async () => {
          t.dispose("thread"); // torn down while the flush is mid-fetch
          return ch;
        },
      },
    } as unknown as Client;
    t = new DiscordTransport(client);
    await t.render("thread", st("hello"));
    await t.flush("thread");
    expect(ch.sent).toHaveLength(0);
  });

  it("dispose() landing INSIDE renderChunks stops the remaining chunks and deletes the one in flight", async () => {
    // The fetch-window guard is not enough: every actual write happens later,
    // inside renderChunks, whose liveness predicate used to be epoch-only. Since
    // dispose() never mutates the state object, a teardown landing mid-`send`
    // was invisible and the rest of the render went into the ended thread. This
    // window is WIDER than the fetch one and /end lands in it: cmdEnd awaits
    // actor.disconnect() before calling dispose, and a 1s debounce flush of a
    // streaming turn is far more likely to be mid-send than mid-fetch.
    const ch = new FakeChannel();
    let t!: DiscordTransport;
    const realSend = ch.send.bind(ch);
    let sends = 0;
    ch.send = async (o: Record<string, unknown>) => {
      const m = await realSend(o);
      if (++sends === 1) t.dispose("thread"); // torn down between chunk 0 and 1
      return m;
    };
    t = new DiscordTransport({ channels: { fetch: async () => ch } } as unknown as Client);
    await t.render("thread", st("C".repeat(4000))); // >1900 → at least two chunks
    await t.flush("thread");
    expect(sends).toBe(1); // chunk 1 must never be attempted
    expect(ch.sent[0]!.deleted).toBe(true); // and chunk 0 must be cleaned up
  });

  it("dispose() during an anchor re-fetch does not edit the old message", async () => {
    // Same hole on the edit path: a second flush re-fetches the existing anchor,
    // and a dispose during THAT await used to be followed by m.edit().
    const ch = new FakeChannel();
    let t!: DiscordTransport;
    t = new DiscordTransport({ channels: { fetch: async () => ch } } as unknown as Client);
    await t.render("thread", st("first"));
    await t.flush("thread");
    expect(ch.sent).toHaveLength(1);
    const realFetch = ch.messages.fetch;
    ch.messages.fetch = async (id: string) => {
      t.dispose("thread"); // torn down while re-fetching the anchor
      return realFetch(id);
    };
    await t.render("thread", st("SECOND WRITE AFTER DISPOSE"));
    await t.flush("thread");
    expect(ch.sent[0]!.content).toBe("first"); // never overwritten
  });

  it("showPlan publishes the FULL summary in chunks before the card (no truncation)", async () => {
    const ch = new FakeChannel();
    const t = new DiscordTransport(fakeClient(ch));
    const bigSummary = "S".repeat(5000); // larger than one message
    await t.showPlan({
      nonce: "p",
      sessionKey: "x",
      summary: bigSummary,
      actions: ["Go"],
      recommendedAction: "Go",
    });
    const textPosted = ch.sent
      .filter((m) => typeof m.content === "string")
      .map((m) => m.content)
      .join("");
    expect(textPosted).toContain("S".repeat(5000)); // ENTIRE summary present across chunks
    expect(ch.sent.some((m) => m.opts && (m.opts as Record<string, unknown>)["embeds"])).toBe(true); // card posted
  });
});
