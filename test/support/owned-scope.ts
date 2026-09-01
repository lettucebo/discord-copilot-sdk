import type { LifecycleOwnership, OwnedScope } from "../../src/core/lifecycle-ownership.js";

/**
 * Drive a mutating handler the way the dispatch seam does.
 *
 * Every mutating inbound handler now takes a REQUIRED `OwnedScope`, because
 * production must hold one: the single-instance lock may not be released while
 * a `/new` is half-way through creating a worktree. Tests must therefore obtain
 * a REAL scope from the app's own coordinator rather than fabricating one — a
 * hand-rolled `{ lostReason: () => undefined }` would make every shutdown-race
 * assertion in this area vacuous.
 *
 * The key is per call and unique, mirroring `inboundOperationKey`: it is an
 * ownership handle, not a mutual-exclusion key, so it must not collide with a
 * thread id.
 */
let seq = 0;

export function ownershipOf(app: object): LifecycleOwnership {
  const ownership = (app as { ownership?: LifecycleOwnership }).ownership;
  if (!ownership) throw new Error("this app has no lifecycle coordinator");
  return ownership;
}

/** Run `body` as one owned inbound operation. Throws if the coordinator
 *  declines, because a test that silently did nothing is worse than a failure. */
export async function inOwnedScope<T>(
  app: object,
  body: (scope: OwnedScope) => Promise<T>
): Promise<T> {
  const outcome = await ownershipOf(app).runExclusive(`test:inbound:${++seq}`, body);
  if (!outcome.ran) throw new Error(`owned test operation was declined: ${outcome.reason}`);
  return outcome.value;
}

/** Same, but hands back the decline instead of throwing — for the tests that
 *  are ABOUT being declined. */
export function tryOwnedScope<T>(
  app: object,
  body: (scope: OwnedScope) => Promise<T>
): Promise<{ ran: true; value: T } | { ran: false; reason: string }> {
  return ownershipOf(app).runExclusive(`test:inbound:${++seq}`, body);
}
