import type { RenderState } from "./turn-render.js";

export type Decision = "allow" | "deny";

/** What a permission prompt shows. `summary` is the COMPLETE structured request
 *  the SDK supplied (never truncated for approval). */
export interface PermissionView {
  nonce: string;
  sessionKey: string;
  kind: string;
  summary: string;
  /** false ⇒ discopilot has no UI for this kind and it will be denied. */
  supported: boolean;
}

/**
 * Chat surface abstraction. The Discord implementation posts messages/buttons;
 * tests use a fake. Keeping this seam lets the whole orchestration
 * (SDK ⇄ broker ⇄ renderer) be exercised live without a human clicking buttons.
 */
export interface Transport {
  /** Render/refresh a session's assistant output + tool statuses. */
  render(sessionKey: string, state: RenderState): Promise<void>;
  /** Present a permission prompt; the transport later delivers the decision via
   *  the handler registered with `onDecision`. */
  showPermission(view: PermissionView): Promise<void>;
  /** Post a plain notice (errors, auto-denials, aborts). */
  notice(sessionKey: string, text: string): Promise<void>;
  /** Register the sink that receives user decisions (wired to broker.settle). */
  onDecision(handler: (nonce: string, decision: Decision, userId: string) => void): void;
}
