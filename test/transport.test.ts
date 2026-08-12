import { describe, it, expect, vi } from "vitest";
import { DiscordTransport, sanitizeForCodeBlock } from "../src/platforms/discord/discord-transport.js";
import { hasBidiOrControls } from "../src/core/text-safety.js";
import { decodePermissionId, decodeChoiceId, decodePlanId } from "../src/platforms/discord/custom-id.js";
import { AttachmentBuilder, PermissionFlagsBits, type Client } from "discord.js";
import type { TimelineItem } from "../src/core/turn-render.js";
import type { OutboundFile } from "../src/core/outbound-file.js";

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
  sendCalls = 0;
  sendGate?: Promise<void>;
  afterSend?: (message: FakeMessage) => void;
  permissionsForResult:
    | { has(flag: bigint): boolean }
    | null
    | undefined = undefined;
  sendError: unknown;
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
  permissionsFor(): { has(flag: bigint): boolean } | null | undefined {
    if (this.permissionsForResult === undefined) return undefined;
    return this.permissionsForResult;
  }
  async send(o: Record<string, unknown>): Promise<FakeMessage> {
    this.sendCalls++;
    if (this.sendGate) await this.sendGate;
    if (this.sendError !== undefined) throw this.sendError;
    const m = new FakeMessage(`m${++this.seq}`);
    m.content = o["content"] as string;
    m.opts = o;
    this.sent.push(m);
    this.byId.set(m.id, m);
    this.afterSend?.(m);
    return m;
  }
}

function fakeClient(
  channel: FakeChannel,
  fetch: () => Promise<FakeChannel | null> = async (): Promise<FakeChannel> => channel
): Client {
  return { channels: { fetch } } as unknown as Client;
}

function buttonIds(msg: FakeMessage): string[] {
  const row = (msg.opts!["components"] as Array<{ toJSON(): unknown }>)[0]!.toJSON() as {
    components: Array<{ custom_id: string }>;
  };
  return row.components.map((c) => c.custom_id);
}

const st = (assistantText: string) => ({ assistantText, tools: [] });
const timeline = (items: TimelineItem[]) => ({ assistantText: "", tools: [], items });
const outboundFile = (over: Partial<OutboundFile> = {}): OutboundFile => ({
  absPath: "C:\\repo\\report.txt",
  displayName: "report.txt",
  size: 3,
  fingerprint: "f",
  bytes: Buffer.from("abc"),
  ...over,
});

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

  it("sanitizes failed timeline tool errors while disabling mention parsing", async () => {
    const ch = new FakeChannel();
    const t = new DiscordTransport(fakeClient(ch));
    await t.render(
      "thread",
      timeline([
        {
          kind: "tool",
          id: "t1",
          name: "skill",
          status: "failed",
          error: "bad `code`\u202e\n@everyone",
        },
      ])
    );
    await t.flush("thread");

    expect(ch.sent[0]!.content).toBe("-# ⚙ `skill` ✗ — bad 'code' @everyone");
    expect(ch.sent[0]!.content).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    expect(ch.sent[0]!.opts!["allowedMentions"]).toEqual({ parse: [] });
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

  it("sendFile classifies Discord blocked-upload failures as blocked", async () => {
    const ch = new FakeChannel();
    ch.sendError = new Error("This upload has been blocked by Discord");
    const t = new DiscordTransport(fakeClient(ch));

    await expect(t.sendFile("thread", outboundFile())).resolves.toEqual({ ok: false, reason: "blocked" });
  });

  it("sendFile converts ordinary channel.send failures into transient without throwing", async () => {
    const ch = new FakeChannel();
    ch.sendError = new Error("socket hang up");
    const t = new DiscordTransport(fakeClient(ch));

    await expect(t.sendFile("thread", outboundFile())).resolves.toEqual({ ok: false, reason: "transient" });
  });

  it("sendFile returns blocked for representative platform-blocked upload errors", async () => {
    const ch = new FakeChannel();
    ch.sendError = new Error("Cannot send this file because Discord has flagged it for upload restrictions.");
    const t = new DiscordTransport(fakeClient(ch));

    await expect(t.sendFile("thread", outboundFile())).resolves.toEqual({ ok: false, reason: "blocked" });
  });

  it("sendFile returns transient when channel.send fails with an ordinary error", async () => {
    const ch = new FakeChannel();
    ch.sendError = new Error("socket hang up");
    const t = new DiscordTransport(fakeClient(ch));

    await expect(t.sendFile("thread", outboundFile())).resolves.toEqual({ ok: false, reason: "transient" });
  });
});

describe("DiscordTransport sendFile", () => {
  it("sends an attachment to the owning thread with no mentions and optional note", async () => {
    const ch = new FakeChannel();
    ch.permissionsForResult = { has: (flag) => flag === PermissionFlagsBits.AttachFiles };
    const t = new DiscordTransport(fakeClient(ch));

    const result = await t.sendFile("thread", outboundFile(), "已傳送 @everyone");

    expect(result).toEqual({ ok: true });
    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0]!.content).toBe("已傳送 @everyone");
    expect(ch.sent[0]!.opts!["allowedMentions"]).toEqual({ parse: [] });
    const files = ch.sent[0]!.opts!["files"] as AttachmentBuilder[];
    expect(files).toHaveLength(1);
    expect(files[0]).toBeInstanceOf(AttachmentBuilder);
  });

  it("returns unavailable when the thread cannot be fetched", async () => {
    const t = new DiscordTransport({ channels: { fetch: async () => null } } as unknown as Client);

    await expect(t.sendFile("thread", outboundFile())).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("cancels before fetching when the delivery is no longer current", async () => {
    const ch = new FakeChannel();
    const fetch = vi.fn(async (): Promise<FakeChannel> => ch);
    const t = new DiscordTransport(fakeClient(ch, fetch));

    await expect(
      t.sendFile("thread", outboundFile(), undefined, { canSend: () => false })
    ).resolves.toEqual({ ok: false, reason: "cancelled" });

    expect(fetch).not.toHaveBeenCalled();
    expect(ch.sendCalls).toBe(0);
  });

  it("does not send when currentness flips while the thread fetch is pending", async () => {
    const ch = new FakeChannel();
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetch = vi.fn(async (): Promise<FakeChannel> => {
      await fetchGate;
      return ch;
    });
    const t = new DiscordTransport(fakeClient(ch, fetch));
    let current = true;

    const sending = t.sendFile("thread", outboundFile(), undefined, { canSend: () => current });
    expect(fetch).toHaveBeenCalledTimes(1);
    current = false;
    releaseFetch();

    await expect(sending).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(ch.sendCalls).toBe(0);
  });

  it("deletes a late attachment and reports cancellation when currentness flips after send", async () => {
    const ch = new FakeChannel();
    let current = true;
    ch.afterSend = () => {
      current = false;
    };
    const t = new DiscordTransport(fakeClient(ch));

    await expect(
      t.sendFile("thread", outboundFile(), undefined, { canSend: () => current })
    ).resolves.toEqual({ ok: false, reason: "cancelled" });

    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0]!.deleted).toBe(true);
  });

  it("fails closed on missing Attach Files permission and posts one deduplicated Chinese notice", async () => {
    const ch = new FakeChannel();
    ch.permissionsForResult = { has: () => false };
    const t = new DiscordTransport(fakeClient(ch));

    await expect(t.sendFile("thread", outboundFile())).resolves.toEqual({
      ok: false,
      reason: "no-attach-permission",
    });
    await expect(t.sendFile("thread", outboundFile())).resolves.toEqual({
      ok: false,
      reason: "no-attach-permission",
    });

    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0]!.content).toContain("Attach Files");
    expect(ch.sent[0]!.content).toContain("326417632256");
    expect(ch.sent[0]!.opts!["allowedMentions"]).toEqual({ parse: [] });
  });

  it.each([
    [50013, "no-attach-permission"],
    [40005, "too-large"],
    [50045, "too-large"],
  ] as const)("maps Discord API code %s to %s", async (code, reason) => {
    const ch = new FakeChannel();
    ch.permissionsForResult = undefined;
    ch.sendError = { code, message: `discord ${code}` };
    const t = new DiscordTransport(fakeClient(ch));

    await expect(t.sendFile("thread", outboundFile())).resolves.toEqual({ ok: false, reason });
  });
});
