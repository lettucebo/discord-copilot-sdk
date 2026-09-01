import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLifecycleOwnershipForTest,
  type CleanupObligation,
  type LifecycleOwnershipOptions,
} from "../src/core/lifecycle-ownership.js";
import type { InstanceLock } from "../src/core/single-instance.js";

function fakeLock(): { lock: InstanceLock; releases: () => number } {
  let releases = 0;
  return {
    lock: {
      path: "(test)",
      release: async () => {
        releases++;
      },
    },
    releases: () => releases,
  };
}

function build(options: LifecycleOwnershipOptions = {}) {
  const held = fakeLock();
  const messages: string[] = [];
  const built = createLifecycleOwnershipForTest(held.lock, {
    joinTimeoutMs: 20,
    obligationTimeoutMs: 20,
    log: (m) => messages.push(m),
    ...options,
  });
  return { ...built, releases: held.releases, messages };
}

/** A cleanup whose outcome the test decides, holding a payload the way a real
 *  one holds an actor and its root. */
function obligation(
  name: string,
  behaviour: () => Promise<boolean> = async () => true
): CleanupObligation & { attempts: number } {
  const o = {
    attempts: 0,
    describe: () => name,
    attempt: async (): Promise<boolean> => {
      o.attempts++;
      return behaviour();
    },
  };
  return o;
}

const never = (): Promise<boolean> => new Promise<boolean>(() => {});

describe("lifecycle ownership — the release conclusion", () => {
  it("stays inert while the process is running, however much settles", async () => {
    const { ownership, inspect, releases } = build();

    const out = await ownership.runExclusive("t1", async (scope) => {
      expect(scope.lostReason()).toBeUndefined();
      return "done";
    });

    expect(out).toEqual({ ran: true, value: "done" });
    await ownership.runTeardown("t2", async () => {});
    expect(inspect.exclusiveThreads()).toEqual([]);
    expect(inspect.teardownClaims()).toEqual([]);
    // Everything is empty — and that is emphatically NOT a reason to let go of
    // the lock, because nobody asked this process to stop.
    expect(releases()).toBe(0);
    expect(inspect.released()).toBe(false);
  });

  it("releases exactly once on a healthy shutdown, after the armed teardown", async () => {
    const { ownership, inspect, releases } = build();
    const order: string[] = [];
    const cleanup = obligation("a discarded runtime", async () => {
      order.push("obligation");
      return true;
    });
    expect(ownership.arm(async () => void order.push("armed teardown"))).toBe(true);

    await ownership.runExclusive("t1", async (scope) => {
      scope.retain("runtime:t1", cleanup);
    });

    await ownership.shutdown();
    await ownership.shutdown(); // joining, not re-running

    expect(order).toEqual(["obligation", "armed teardown"]); // sweep BEFORE teardown
    expect(releases()).toBe(1);
    expect(inspect.obligationKeys()).toEqual([]);
    expect(inspect.released()).toBe(true);
  });

  it("defers the release when the bounded join expires, then releases on settle", async () => {
    const { ownership, inspect, releases } = build();
    ownership.arm(async () => {});
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });

    const running = ownership.runExclusive("t1", async () => {
      await held;
    });

    await ownership.shutdown();
    // The scope outlived the bound. Its work is already issued and cannot be
    // recalled, so the lock stays.
    expect(releases()).toBe(0);
    expect(inspect.exclusiveThreads()).toEqual(["t1"]);

    release();
    await running;
    await vi.waitFor(() => expect(releases()).toBe(1));
  });

  it("keeps the lock for an obligation retained AFTER the sweep has run", async () => {
    const { ownership, inspect, releases } = build();
    ownership.arm(async () => {});
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let late: CleanupObligation | undefined;

    const running = ownership.runExclusive("t1", async (scope) => {
      await held;
      // Retained after shutdown swept: the sweep is a bounded pass, not a
      // promise that nothing new can be owed.
      late = obligation("a runtime created after the sweep", never);
      scope.retain("runtime:t1", late);
    });

    await ownership.shutdown();
    expect(releases()).toBe(0);

    release();
    await running;

    expect(late?.describe()).toBe("a runtime created after the sweep");
    expect(inspect.obligationKeys()).toEqual(["runtime:t1"]);
    // The scope settled, so the OLD reason to hold is gone — and the lock is
    // still held, because a new one took its place.
    expect(inspect.exclusiveThreads()).toEqual([]);
    expect(releases()).toBe(0);
  });

  it("keeps the lock when an obligation reports failure, and lets go when it later succeeds", async () => {
    const { ownership, inspect, releases } = build();
    ownership.arm(async () => {});
    let confirmable = false;
    const stubborn = obligation("a runtime that will not answer", async () => confirmable);
    await ownership.runExclusive("t1", async (scope) => {
      scope.retain("runtime:t1", stubborn);
    });

    await ownership.shutdown();
    expect(stubborn.attempts).toBe(1);
    expect(releases()).toBe(0);
    expect(inspect.obligationKeys()).toEqual(["runtime:t1"]);

    confirmable = true;
    // A NEW teardown is declined after shutdown (that is the point of the
    // decline), but an obligation already retained can still be attempted — by
    // whoever kept its handle, or by a late-settling promise.
    const handle = inspect.obligation("runtime:t1");
    expect(handle).toBeDefined();
    await handle?.attempt();
    expect(await ownership.runTeardown("t1", async () => "nope")).toEqual({
      ran: false,
      reason: "shutdown has begun",
    });

    await vi.waitFor(() => expect(inspect.obligationKeys()).toEqual([]));
    await vi.waitFor(() => expect(releases()).toBe(1));
  });

  it("keeps the lock when an obligation HANGS rather than failing", async () => {
    const { ownership, inspect, releases, messages } = build();
    ownership.arm(async () => {});
    const wedged = obligation("a runtime that never answers", never);
    await ownership.runExclusive("t1", async (scope) => {
      scope.retain("runtime:t1", wedged);
    });

    await ownership.shutdown();

    expect(wedged.attempts).toBe(1); // bounded, not awaited for ever
    expect(releases()).toBe(0);
    expect(inspect.obligationKeys()).toEqual(["runtime:t1"]);
    expect(messages.join("\n")).toContain("could not be discharged");
  });

  it("keeps the FIRST obligation for a key and hands back its identity", async () => {
    const { ownership, inspect, releases } = build();
    ownership.arm(async () => {});
    const first = obligation("the older runtime", never);
    const second = obligation("a newer runtime", async () => true);

    const handles = await ownership.runExclusive("t1", async (scope) => {
      const a = scope.retain("runtime:t1", first);
      const b = scope.retain("runtime:t1", second);
      return { a, b };
    });
    expect(handles.ran).toBe(true);
    if (!handles.ran) return;
    expect(handles.value.b).toBe(handles.value.a); // identity, not a replacement

    await ownership.shutdown();
    expect(first.attempts).toBe(1);
    expect(second.attempts).toBe(0); // never registered, never attempted
    expect(inspect.obligationKeys()).toEqual(["runtime:t1"]);
    expect(releases()).toBe(0);
  });

  it("declines exclusive work for a thread an explicit teardown has claimed", async () => {
    const { ownership } = build();
    let observed: { ran: boolean; reason?: string } | undefined;

    await ownership.runTeardown("t1", async () => {
      observed = await ownership.runExclusive("t1", async () => "should not run");
      // …but a DIFFERENT thread is untouched.
      const other = await ownership.runExclusive("t2", async () => "fine");
      expect(other).toEqual({ ran: true, value: "fine" });
    });

    expect(observed?.ran).toBe(false);
    expect(observed?.reason).toMatch(/teardown claimed/);
    // Released with the command, so the thread is workable again.
    const after = await ownership.runExclusive("t1", async () => "now fine");
    expect(after).toEqual({ ran: true, value: "now fine" });
  });

  it("does NOT decline exclusive work merely because an obligation is outstanding", async () => {
    // The body's own first step is to attempt it; refusing admission would leave
    // the obligation with nobody to retry it.
    const { ownership } = build();
    const stubborn = obligation("an unconfirmed runtime", async () => false);
    await ownership.runExclusive("t1", async (scope) => {
      scope.retain("runtime:t1", stubborn);
    });

    const out = await ownership.runExclusive("t1", async (scope) => {
      return scope.obligation("runtime:t1") !== undefined;
    });

    expect(out).toEqual({ ran: true, value: true });
  });

  it("counts overlapping teardown claims so a nested one cannot release the outer", async () => {
    const { ownership, inspect } = build();
    let inner: { ran: boolean } | undefined;

    await ownership.runTeardown("t1", async () => {
      await ownership.runTeardown("t1", async () => {
        expect(inspect.teardownClaims()).toEqual(["t1"]);
      });
      // The inner claim is gone; the outer one still stands.
      inner = await ownership.runExclusive("t1", async () => "nope");
    });

    expect(inner?.ran).toBe(false);
    expect(inspect.teardownClaims()).toEqual([]);
  });

  it("lets a teardown join an exclusive scope, and tells it the truth when it cannot", async () => {
    const { ownership } = build({ joinTimeoutMs: 10 });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const running = ownership.runExclusive("t1", async () => {
      await held;
    });

    const joined = await ownership.runTeardown("t1", async (scope) => scope.joinExclusive("t1"));
    expect(joined).toEqual({ ran: true, value: false }); // still running ⇒ refuse

    release();
    await running;

    const joinedAgain = await ownership.runTeardown("t1", async (scope) => scope.joinExclusive("t1"));
    expect(joinedAgain).toEqual({ ran: true, value: true });
  });

  it("turns an arm that arrives after shutdown into an obligation and refuses it", async () => {
    const { ownership, inspect, releases } = build();
    ownership.arm(async () => {});
    await ownership.shutdown();
    expect(releases()).toBe(1);

    let cleaned = 0;
    const accepted = ownership.arm(async () => {
      cleaned++;
    });

    expect(accepted).toBe(false); // caller must abort construction
    await vi.waitFor(() => expect(cleaned).toBe(1)); // but the cleanup still happens
    await vi.waitFor(() => expect(inspect.obligationKeys()).toEqual([]));
    expect(releases()).toBe(1); // and never a second release
  });

  it("re-arms last-wins, and only the last teardown runs", async () => {
    const { ownership } = build();
    const ran: string[] = [];
    ownership.arm(async () => void ran.push("narrow"));
    ownership.arm(async () => void ran.push("wide"));

    await ownership.shutdown();

    expect(ran).toEqual(["wide"]);
  });

  it("tells a running body it has lost the thread, on shutdown and on teardown", async () => {
    const { ownership } = build();
    ownership.arm(async () => {});
    let seen: Array<string | undefined> = [];
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });

    const running = ownership.runExclusive("t1", async (scope) => {
      seen.push(scope.lostReason());
      await held;
      seen.push(scope.lostReason());
    });

    void ownership.shutdown();
    release();
    await running;

    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toMatch(/shutdown/);
  });

  it("refuses to release when the armed teardown could not prove it cleaned up", async () => {
    // "The three sets are empty" is a statement about bookkeeping. If the
    // teardown threw, it is not a statement about the world, and releasing on it
    // would hand the state directory to a successor on the strength of a cleanup
    // that failed.
    const { ownership, inspect, releases } = build();
    ownership.arm(async () => {
      throw new Error("could not destroy the gateway client");
    });

    await expect(ownership.shutdown()).rejects.toThrow(/could not destroy the gateway client/);

    expect(releases()).toBe(0);
    expect(inspect.exclusiveThreads()).toEqual([]);
    expect(inspect.teardownClaims()).toEqual([]);
    expect(inspect.obligationKeys()).toEqual(["armed-teardown"]); // the gate
    expect(inspect.released()).toBe(false);
  });

  it("does not retry a teardown that died half-way, and keeps holding for it", async () => {
    const { ownership, inspect, releases } = build();
    let runs = 0;
    ownership.arm(async () => {
      runs++;
      throw new Error("teardown exploded");
    });

    await expect(ownership.shutdown()).rejects.toThrow(/teardown exploded/);
    const handle = inspect.obligationKeys();
    expect(handle).toEqual(["armed-teardown"]);

    // Joining shutdown again must not re-run it: re-running a teardown that
    // died half-way is how a half-torn-down process does more damage.
    await expect(ownership.shutdown()).rejects.toThrow(/teardown exploded/);
    expect(runs).toBe(1);
    expect(releases()).toBe(0);
  });

  it("bounds the armed teardown, and keeps holding while it has not returned", async () => {
    // Shutdown's contract is bounded, and `copilot.stop()` is an RPC to a
    // runtime that can wedge. A teardown that has not RETURNED has proved no
    // more than one that threw.
    const { ownership, inspect, releases } = build({ teardownTimeoutMs: 20 });
    let finish: () => void = () => {};
    ownership.arm(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );

    await expect(ownership.shutdown()).rejects.toThrow(/timeout/);

    expect(releases()).toBe(0);
    expect(inspect.obligationKeys()).toEqual(["armed-teardown"]);
    expect(inspect.released()).toBe(false);
    void finish; // never called: this teardown does not come back
  });

  it("releases when a teardown that outran its bound finally returns", async () => {
    const { ownership, inspect, releases } = build({ teardownTimeoutMs: 20 });
    let finish: () => void = () => {};
    ownership.arm(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );

    await expect(ownership.shutdown()).rejects.toThrow(/timeout/);
    expect(releases()).toBe(0);

    finish(); // the runtime finally answered
    await vi.waitFor(() => expect(releases()).toBe(1));
    expect(inspect.obligationKeys()).toEqual([]);
  });

  it("does not release for a teardown that returns AFTER failing", async () => {
    const { ownership, inspect, releases } = build({ teardownTimeoutMs: 20 });
    let fail: (e: Error) => void = () => {};
    ownership.arm(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        })
    );

    await expect(ownership.shutdown()).rejects.toThrow(/timeout/);
    fail(new Error("could not destroy the gateway client"));
    await new Promise((r) => setTimeout(r, 20));

    expect(releases()).toBe(0); // a failure is not a completion
    expect(inspect.obligationKeys()).toEqual(["armed-teardown"]);
  });

  it("never arms a timer that could hold the process open", () => {
    // Every bound here is something we are WAITING on; if it were ref'd, a
    // wedged runtime would keep the process alive purely to watch its own
    // timeout, and the natural exit that hands the PID lock to a successor
    // would never happen.
    const src = readFileSync(join(process.cwd(), "src", "core", "lifecycle-ownership.ts"), "utf8");
    const timerSites = src.match(/setTimeout\(/g) ?? [];
    expect(timerSites).toHaveLength(1); // one place creates timers
    expect(src).toMatch(/setTimeout\(fn, ms\);\s*(?:\/\/[^\n]*\n\s*)*[\s\S]{0,400}?unref\?\.\(\)/);
  });
});

describe("an attempt that discharges its own handle", () => {
  /** The real shape this comes from: a detached rebind incarnation whose
   *  RUNTIME is confirmed stopped — which is what ends its claim on the process
   *  lock — while its worktree was kept because it was dirty. The app's
   *  teardown identity-discharges the handle on `confirmed`, and its bounded
   *  attempt then reports `confirmed && cleaned`, i.e. `false`. */
  function selfDischarging(): {
    obligation: CleanupObligation;
    bind(discharge: () => void): void;
  } {
    let discharge: () => void = () => {};
    return {
      obligation: {
        describe: () => "a detached incarnation whose tree was kept dirty",
        attempt: async () => {
          discharge();
          return false; // the cleanup did not fully complete…
        },
      },
      bind: (d) => {
        discharge = d;
      },
    };
  }

  it("reports the SET, not the body's return value", async () => {
    const { ownership, inspect } = build();
    const self = selfDischarging();

    await ownership.runTeardown("t1", async (scope) => {
      const handle = scope.retain("k", self.obligation);
      self.bind(() => handle.discharge());
      // …but the obligation is gone, so nothing is owed and `attempt` must not
      // claim otherwise. A caller that gates on this — `/end`'s barrier check —
      // would otherwise refuse for a runtime already proved stopped.
      await expect(handle.attempt()).resolves.toBe(true);
      expect(handle.retained).toBe(false);
    });

    expect(inspect.obligationKeys()).toEqual([]);
  });

  it("logs no false retention at shutdown, and releases the lock", async () => {
    const { ownership, inspect, releases, messages } = build();
    const self = selfDischarging();

    await ownership.runTeardown("t1", async (scope) => {
      const handle = scope.retain("k", self.obligation);
      self.bind(() => handle.discharge());
    });
    await ownership.shutdown();

    expect(messages.filter((m) => /could not be discharged/.test(m))).toEqual([]);
    expect(inspect.obligationKeys()).toEqual([]);
    expect(releases()).toBe(1);
  });

  it("still logs, and still holds, when the obligation is genuinely retained", async () => {
    // The other half: a body that returns false WITHOUT discharging is exactly
    // the case the message is for.
    const { ownership, releases, messages } = build();

    await ownership.runTeardown("t1", async (scope) => {
      scope.retain("k", obligation("a runtime nobody could confirm", async () => false));
    });
    await ownership.shutdown().catch(() => {});

    expect(messages.some((m) => /could not be discharged; lock retained/.test(m))).toBe(true);
    expect(releases()).toBe(0);
  });
});
