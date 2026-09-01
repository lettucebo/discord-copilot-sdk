import path from "node:path";
import { ApprovalPolicy } from "../../src/core/approval-policy.js";
import { ChannelRegistry } from "../../src/core/channel-registry.js";
import { SessionStore } from "../../src/core/session-store.js";
import type { DiscordCopilotAppTestDependencies } from "../../src/app.js";

/**
 * The home-backed dependencies `DiscordCopilotApp.createForTest` REQUIRES,
 * built from a suite-scoped directory.
 *
 * Every default this replaces resolves through `os.homedir()`, so an app built
 * without them reads — and in several cases creates — the state of whoever runs
 * the suite: the session store, the channel registry and `approvals.json`.
 * Vitest also redirects `HOME`/`USERPROFILE` for the whole run, but that is one
 * process-wide setting away from being removed, and it fails OPEN: nothing about
 * it makes a missing injection visible. The required parameter is the part that
 * cannot silently regress, and this helper exists so honouring it does not mean
 * copying the same object into a hundred call sites.
 *
 * Defaults are resolved with `??`, never by spreading the overrides: a caller
 * that passes an explicit `undefined` must still get the suite-scoped fixture,
 * not the real home-backed collaborator.
 */
export interface AppTestDependencyOverrides extends Partial<DiscordCopilotAppTestDependencies> {
  /** No default: a store is per-test state, and sharing one file across tests
   *  in a suite silently couples them. */
  store: SessionStore;
}

export interface AppTestDependencyOptions {
  /** A suite-scoped directory that already exists. Defaults live inside it. */
  directory: string;
  /** Seed channel + guild for the default channel registry. */
  parentChannelId?: string;
  guildId?: string;
  /** Distinguishes fixture files when one suite builds several apps. */
  label?: string;
}

export function appTestDependencies(
  options: AppTestDependencyOptions,
  over: AppTestDependencyOverrides
): DiscordCopilotAppTestDependencies {
  const suffix = options.label === undefined ? "" : `-${options.label}`;
  return {
    store: over.store,
    channels:
      over.channels ??
      new ChannelRegistry(
        options.parentChannelId ?? "c1",
        options.guildId ?? "g1",
        path.join(options.directory, `channels${suffix}.json`)
      ),
    approvals: over.approvals ?? new ApprovalPolicy(path.join(options.directory, `approvals${suffix}.json`)),
    ...(over.fileDeliveryPlatform === undefined
      ? {}
      : { fileDeliveryPlatform: over.fileDeliveryPlatform }),
  };
}
