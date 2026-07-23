import { describe, it, expect, vi } from "vitest";
import { DiscordTransport, sanitizeForCodeBlock } from "../src/platforms/discord/discord-transport.js";
import { hasBidiOrControls } from "../src/core/text-safety.js";
import { decodePermissionId } from "../src/platforms/discord/custom-id.js";
import type { Client } from "discord.js";

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

const st = (assistantText: string) => ({ assistantText, tools: [] });

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
});

describe("DiscordTransport permission card", () => {
  it("renders Allow/Deny buttons whose custom ids decode to this nonce", async () => {
    const ch = new FakeChannel();
    const t = new DiscordTransport(fakeClient(ch));
    await t.showPermission({
      nonce: "n-123",
      sessionKey: "thread",
      kind: "shell",
      summary: "$ rm -rf ~",
      supported: true,
    });
    const msg = ch.sent[0]!;
    const components = (msg.opts!["components"] as Array<{ toJSON(): unknown }>)[0]!.toJSON() as {
      components: Array<{ custom_id: string }>;
    };
    const ids = components.components.map((c) => c.custom_id);
    expect(decodePermissionId(ids[0]!)).toEqual({ nonce: "n-123", action: "allow" });
    expect(decodePermissionId(ids[1]!)).toEqual({ nonce: "n-123", action: "deny" });
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
    t.deliverDecision("n", "allow", "u1");
    expect(h).toHaveBeenCalledWith("n", "allow", "u1");
    off();
    t.deliverDecision("n", "deny", "u1");
    expect(h).toHaveBeenCalledTimes(1);
  });
});
