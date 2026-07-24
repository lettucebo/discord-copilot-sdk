import { describe, it, expect, vi } from "vitest";
import { PendingInteractionBroker } from "../src/core/broker.js";

const setup = () => new PendingInteractionBroker();
const opts = (over: Partial<Parameters<PendingInteractionBroker["register"]>[0]> = {}) => ({
  sessionKey: "s1",
  generation: 1,
  kind: "shell",
  timeoutMs: 10_000,
  onDefault: () => "deny" as const,
  ...over,
});

describe("PendingInteractionBroker", () => {
  it("settles exactly once with the user's decision", async () => {
    const b = setup();
    const { nonce, promise } = b.register(opts());
    expect(b.size).toBe(1);
    expect(b.settle(nonce, "allow")).toBe(true);
    await expect(promise).resolves.toBe("allow");
    // second settle is a no-op
    expect(b.settle(nonce, "deny")).toBe(false);
    expect(b.size).toBe(0);
  });

  it("times out with the safe default and rejects a late settle (deterministic clock)", async () => {
    // Deterministic clock (PLAN.md §9): drive the timeout with fake timers rather
    // than sleeping on a real one, so the test is exact and not wall-clock flaky.
    vi.useFakeTimers();
    try {
      const b = setup();
      const { nonce, promise } = b.register(opts({ timeoutMs: 10 }));
      expect(b.size).toBe(1);
      await vi.advanceTimersByTimeAsync(10); // fire the timeout at exactly t=10ms
      await expect(promise).resolves.toBe("deny"); // onDefault
      expect(b.settle(nonce, "allow")).toBe(false); // too late
      expect(b.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a settle from a stale generation", async () => {
    const b = setup();
    const { nonce, promise } = b.register(opts({ generation: 2 }));
    expect(b.settle(nonce, "allow", 1)).toBe(false); // stale gen
    expect(b.size).toBe(1); // still pending
    expect(b.settle(nonce, "allow", 2)).toBe(true); // matching gen
    await expect(promise).resolves.toBe("allow");
  });

  it("ignores an unknown nonce", () => {
    expect(setup().settle("nope", "allow")).toBe(false);
  });

  it("abort settles matching entries with the safe default and clears them", async () => {
    const b = setup();
    const a = b.register(opts({ sessionKey: "s1" }));
    const c = b.register(opts({ sessionKey: "s2" }));
    expect(b.abortSession("s1")).toBe(1);
    await expect(a.promise).resolves.toBe("deny");
    expect(b.size).toBe(1); // s2 still pending
    expect(b.abort()).toBe(1);
    await expect(c.promise).resolves.toBe("deny");
    expect(b.size).toBe(0);
  });

  it("exposes a read-only view while pending, hidden after settle", () => {
    const b = setup();
    const { nonce } = b.register(opts());
    const v = b.get(nonce);
    expect(v?.kind).toBe("shell");
    expect(v?.sessionKey).toBe("s1");
    b.settle(nonce, "allow");
    expect(b.get(nonce)).toBeUndefined();
  });

  it("supports many concurrent requests resolved out of order", async () => {
    const b = setup();
    const reqs = Array.from({ length: 5 }, (_, i) => b.register(opts({ kind: `k${i}` })));
    expect(b.size).toBe(5);
    // settle in reverse order
    for (let i = 4; i >= 0; i--) expect(b.settle(reqs[i]!.nonce, `r${i}`)).toBe(true);
    const results = await Promise.all(reqs.map((r) => r.promise));
    expect(results).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    expect(b.size).toBe(0);
  });

  it("settles concurrent CROSS-session requests out of order, each independently", async () => {
    // §9 "跨 session 併發亂序": interleave pending requests across two sessions and
    // settle them out of registration order; each nonce settles only its own
    // request, unaffected by the others' session or ordering.
    const b = setup();
    const a1 = b.register(opts({ sessionKey: "sA", kind: "a1" }));
    const b1 = b.register(opts({ sessionKey: "sB", kind: "b1" }));
    const a2 = b.register(opts({ sessionKey: "sA", kind: "a2" }));
    expect(b.size).toBe(3);
    expect(b.settle(b1.nonce, "rB1")).toBe(true); // sB first
    expect(b.settle(a2.nonce, "rA2")).toBe(true); // sA's SECOND before its first
    expect(b.settle(a1.nonce, "rA1")).toBe(true);
    expect(await a1.promise).toBe("rA1");
    expect(await a2.promise).toBe("rA2");
    expect(await b1.promise).toBe("rB1");
    expect(b.size).toBe(0);
  });
});
