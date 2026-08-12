import { describe, it, expect, vi } from "vitest";
import {
  encodePermissionId,
  decodePermissionId,
  encodeChoiceId,
  decodeChoiceId,
  encodePlanId,
  decodePlanId,
} from "../src/platforms/discord/custom-id.js";
import { isAuthorized, isOwner, type AuthContext, type AuthPolicy } from "../src/platforms/discord/auth.js";
import {
  resolveButtonAck,
  decisionBindsToChannel,
  applyYoloToggle,
  approvalScopeKeys,
  yoloOnWarning,
} from "../src/app.js";

describe("custom-id", () => {
  it("round-trips each action + nonce", () => {
    const id = encodePermissionId("abc-123", "once");
    expect(id).toBe("dp:perm:once:abc-123");
    for (const action of ["once", "session", "always", "deny"] as const) {
      expect(decodePermissionId(encodePermissionId("n", action))).toEqual({ nonce: "n", action });
    }
  });

  it("rejects malformed / foreign ids", () => {
    expect(decodePermissionId("other:perm:once:n")).toBeUndefined();
    expect(decodePermissionId("dp:x:once:n")).toBeUndefined();
    expect(decodePermissionId("dp:perm:maybe:n")).toBeUndefined();
    expect(decodePermissionId("dp:perm:allow:n")).toBeUndefined(); // old action name gone
    expect(decodePermissionId("dp:perm:once:")).toBeUndefined();
    expect(decodePermissionId("dp:perm:once")).toBeUndefined();
  });

  it("stays within Discord's 100-char custom id limit for a uuid nonce", () => {
    expect(encodePermissionId("123e4567-e89b-12d3-a456-426614174000", "always").length).toBeLessThanOrEqual(100);
  });
});

describe("choice + plan custom ids", () => {
  it("round-trips a choice index", () => {
    expect(encodeChoiceId("n", 3)).toBe("dp:ask:3:n");
    expect(decodeChoiceId(encodeChoiceId("nonce-1", 0))).toEqual({ nonce: "nonce-1", index: 0 });
    expect(decodeChoiceId("dp:ask:-1:n")).toBeUndefined();
    expect(decodeChoiceId("dp:ask:x:n")).toBeUndefined();
    expect(decodeChoiceId("dp:ask:1junk:n")).toBeUndefined(); // non-all-digit rejected
    expect(decodeChoiceId("dp:perm:once:n")).toBeUndefined();
  });

  it("round-trips a plan action (index or reject)", () => {
    expect(decodePlanId(encodePlanId("n", 2))).toEqual({ nonce: "n", action: 2 });
    expect(decodePlanId(encodePlanId("n", "reject"))).toEqual({ nonce: "n", action: "reject" });
    expect(decodePlanId("dp:plan:x:n")).toBeUndefined();
    expect(decodePlanId("dp:plan:2junk:n")).toBeUndefined(); // non-all-digit rejected
    expect(decodePlanId("dp:ask:0:n")).toBeUndefined();
  });
});

describe("Discord authorization", () => {
  const policy: AuthPolicy = {
    allowedUserIds: new Set(["u1"]),
    guildId: "g1",
    parentChannelIds: new Set(["c1", "c2"]),
  };

  const context = (overrides: Partial<AuthContext> = {}): AuthContext => ({
    userId: "u1",
    guildId: "g1",
    channelId: "c1",
    parentId: null,
    ...overrides,
  });

  it("allows an allow-listed user in either enabled parent channel", () => {
    for (const channelId of ["c1", "c2"]) {
      expect(isAuthorized(context({ channelId }), policy)).toBe(true);
    }
  });

  it("allows a thread under either enabled parent channel", () => {
    for (const parentId of ["c1", "c2"]) {
      expect(isAuthorized(context({ channelId: `thread-${parentId}`, parentId }), policy)).toBe(true);
    }
  });

  it("keeps an owner outside enabled channels authorized only for bootstrap", () => {
    const outsideEnabledChannels = context({ channelId: "cX" });
    expect(isOwner(outsideEnabledChannels, policy)).toBe(true);
    expect(isAuthorized(outsideEnabledChannels, policy)).toBe(false);

    expect(isOwner(context({ guildId: "gX" }), policy)).toBe(false);
    expect(isOwner(context({ userId: "u2" }), policy)).toBe(false);
  });

  it("denies a wrong guild, user, or foreign channel", () => {
    const denied: AuthContext[] = [
      context({ guildId: "gX" }),
      context({ guildId: null }),
      context({ userId: "u2" }),
      context({ channelId: "cX", parentId: "cY" }),
    ];

    for (const unauthorized of denied) {
      expect(isAuthorized(unauthorized, policy)).toBe(false);
    }
  });
});

describe("decisionBindsToChannel (cross-thread guard, §9)", () => {
  it("allows a decision from the nonce's OWNING thread", () => {
    expect(decisionBindsToChannel({ sessionKey: "tA" }, "tA")).toBe(true);
  });

  it("REJECTS a decision arriving from a different thread (cross-thread click can't resolve)", () => {
    expect(decisionBindsToChannel({ sessionKey: "tA" }, "tB")).toBe(false);
  });

  it("rejects when there is no pending request (expired / unknown nonce)", () => {
    expect(decisionBindsToChannel(undefined, "tA")).toBe(false);
  });
});

describe("applyYoloToggle (ack-before-allow for blanket approval)", () => {
  const ctl = (): { epoch: () => number; disable: () => void; enableIfCurrent: (e: number) => boolean; state: { on: boolean; epoch: number }; log: string[] } => {
    const state = { on: false, epoch: 0 };
    const log: string[] = [];
    return {
      state,
      log,
      epoch: () => state.epoch,
      disable: () => {
        state.epoch++;
        state.on = false;
        log.push("disable");
      },
      enableIfCurrent: (e: number) => {
        if (e !== state.epoch) {
          log.push("enable:superseded");
          return false;
        }
        state.on = true;
        log.push("enable");
        return true;
      },
    };
  };

  it("enables YOLO only AFTER Discord acknowledges the warning", async () => {
    const c = ctl();
    const applied = await applyYoloToggle(
      true,
      async () => {
        c.log.push("ack");
      },
      c
    );
    expect(c.log).toEqual(["ack", "enable"]); // ack strictly first
    expect(applied).toBe(true);
    expect(c.state.on).toBe(true);
  });

  it("does NOT enable YOLO when the warning fails to post (fail-safe)", async () => {
    const c = ctl();
    await expect(
      applyYoloToggle(
        true,
        async () => {
          throw new Error("interaction failed");
        },
        c
      )
    ).rejects.toThrow("interaction failed");
    expect(c.state.on).toBe(false); // stays OFF
    expect(c.log).toEqual([]);
  });

  it("disables YOLO FIRST, even if the confirmation cannot be posted", async () => {
    const c = ctl();
    const applied = await applyYoloToggle(
      false,
      async () => {
        c.log.push("ack");
        throw new Error("interaction failed");
      },
      c
    );
    expect(c.log).toEqual(["disable", "ack"]); // applied before (and despite) the ack
    expect(applied).toBe(false);
    expect(c.state.on).toBe(false);
  });

  it("RACE: a slow /yolo on cannot re-enable after a later /yolo off confirmed OFF", async () => {
    const c = ctl();
    let releaseAck: (() => void) | undefined;
    const slowAck = (): Promise<void> =>
      new Promise<void>((r) => {
        releaseAck = r;
      });
    const enabling = applyYoloToggle(true, slowAck, c); // ack still in flight
    // meanwhile the operator turns it OFF and sees the confirmation
    const disabling = await applyYoloToggle(false, async () => {}, c);
    expect(disabling).toBe(false);
    expect(c.state.on).toBe(false);
    releaseAck!(); // the older ON ack finally resolves
    expect(await enabling).toBe(false); // superseded — must NOT re-enable
    expect(c.state.on).toBe(false);
    expect(c.log).toContain("enable:superseded");
  });
});

describe("yoloOnWarning", () => {
  it("states that YOLO auto-approves other permissions but fast-denies discord_send_file", () => {
    const warning = yoloOnWarning(false);
    expect(warning).toMatch(/other permission requests are auto-approved/i);
    expect(warning).toMatch(/discord_send_file/i);
    expect(warning).toMatch(/fast-denied/i);
    expect(warning).toMatch(/\/file path:</i);
    expect(warning).not.toMatch(/already waiting still needs your decision/i);
    expect(warning).not.toMatch(/including file writes and other kinds that are normally refused/i);
  });

  it("preserves the repository-skill warning while staying truthful about file delivery", () => {
    const warning = yoloOnWarning(true);
    expect(warning).toMatch(/repository skills/i);
    expect(warning).toMatch(/YOLO/i);
    expect(warning).toMatch(/Discord approval gate/i);
    expect(warning).toMatch(/discord_send_file/i);
    expect(warning).toMatch(/\/file path:</i);
  });

  it("does not claim repository skills when none were loaded", () => {
    expect(yoloOnWarning(false)).not.toMatch(/repository skills/i);
  });
});

describe("approvalScopeKeys (/approvals must not lie about revocation)", () => {
  it("covers the live session even when the command is run from the parent channel", () => {
    // The bug: scoping to interaction.channelId meant /approvals clear:true from
    // the parent channel cleared only the on-disk repo rules, left the live
    // session's in-memory rules intact, and still replied "Cleared approvals …
    // Future commands will prompt again."
    expect(approvalScopeKeys(["thread-1"])).toEqual(["thread-1"]);
  });

  it("covers the session when run INSIDE its own thread (same answer)", () => {
    expect(approvalScopeKeys(["thread-1"])).toContain("thread-1");
  });

  it("is empty when nothing is live — there is genuinely nothing in memory to clear", () => {
    expect(approvalScopeKeys([])).toEqual([]);
  });

  it("de-duplicates", () => {
    expect(approvalScopeKeys(["a", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("resolveButtonAck (ack-before-settle)", () => {
  it("delivers the user's decision only after a successful Discord ack", async () => {
    const order: string[] = [];
    const deliver = (d: string) => order.push(`deliver:${d}`);
    await resolveButtonAck(
      async () => {
        order.push("ack");
      },
      deliver,
      "once"
    );
    expect(order).toEqual(["ack", "deliver:once"]); // ack strictly first
  });

  it("delivers DENY (never an approval) if the ack fails", async () => {
    const deliver = vi.fn();
    await resolveButtonAck(
      async () => {
        throw new Error("interaction failed");
      },
      deliver,
      "always"
    );
    expect(deliver).toHaveBeenCalledWith("deny");
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
