import type { RenderState } from "./turn-render.js";

/** A user's response to a permission prompt. `once`/`session`/`always` are
 *  escalating approval scopes; `deny` refuses. For shell these map to the SDK's
 *  approve-once / approve-for-session (commands) / approve-for-location
 *  (commands, persisted to the repo) / denied-interactively-by-user. */
export type Decision = "once" | "session" | "always" | "deny";

/** What a permission prompt shows. `summary` is the COMPLETE structured request
 *  the SDK supplied (never truncated for approval). */
export interface PermissionView {
  nonce: string;
  sessionKey: string;
  kind: string;
  summary: string;
  /** false ⇒ discopilot has no UI for this kind and it will be denied. */
  supported: boolean;
  /** true ⇒ the request can be approved for the session / repo, so the wider
   *  approval buttons (session/always) are offered. */
  canOfferSession: boolean;
  /** The command identifiers a session/always approval would cover (e.g.
   *  ["git"]). Disclosed on the card so the user knows the wider scope grants
   *  more than the single displayed command. */
  scopeCommands: string[];
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
  /** Present an ask_user question (choices as buttons + optional freeform). */
  showUserInput(view: UserInputView): Promise<void>;
  /** Present an exit-plan-mode prompt (actions as buttons + reject). */
  showPlan(view: PlanView): Promise<void>;
  /** Post a plain notice (errors, auto-denials, aborts). */
  notice(sessionKey: string, text: string): Promise<void>;
  /** Register the sink that receives user decisions (wired to broker.settle).
   *  Returns an unsubscribe function so a torn-down session's handler doesn't
   *  leak or keep receiving broadcasts. */
  onDecision(handler: (nonce: string, decision: Decision, userId: string) => void): () => void;
  /** Register the sink for ask_user choice-button selections. */
  onChoice(handler: (nonce: string, index: number, userId: string) => void): () => void;
  /** Register the sink for exit-plan action/reject selections. */
  onPlan(handler: (nonce: string, action: number | "reject", userId: string) => void): () => void;
  /** Deliver a user permission decision to all registered onDecision sinks. */
  deliverDecision(nonce: string, decision: Decision, userId: string): void;
  /** Deliver an ask_user choice-button selection to all onChoice sinks. */
  deliverChoice(nonce: string, index: number, userId: string): void;
  /** Deliver an exit-plan action/reject to all onPlan sinks. */
  deliverPlan(nonce: string, action: number | "reject", userId: string): void;
  /** Flush the latest render for a session immediately (e.g. at turn end). */
  flush(sessionKey: string): Promise<void>;
  /** Begin a fresh turn's message set for a session. */
  resetTurn(sessionKey: string): void;
  /** Release all per-session render state/timers (on session teardown). */
  dispose(sessionKey: string): void;
}

/** ask_user prompt: a question with optional multiple-choice buttons; freeform
 *  answers arrive as a normal thread message when `allowFreeform`. */
export interface UserInputView {
  nonce: string;
  sessionKey: string;
  question: string;
  choices: string[];
  allowFreeform: boolean;
}

/** exit-plan prompt: a plan summary + optional full content, with the runtime's
 *  available actions (buttons) and its recommended one. */
export interface PlanView {
  nonce: string;
  sessionKey: string;
  summary: string;
  planContent?: string;
  actions: string[];
  recommendedAction: string;
}
