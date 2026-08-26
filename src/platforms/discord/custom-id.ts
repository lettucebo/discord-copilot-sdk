/** Encode/decode Discord component custom ids. Only a namespace, an action and a
 *  random nonce ever go into a custom id — never secrets or payloads. */

const NS = "dp";

function decodeParts(customId: string, kind: string): { action: string; nonce: string } | undefined {
  const parts = customId.split(":");
  if (parts.length !== 4) return undefined;
  const [ns, actualKind, action, nonce] = parts;
  if (ns !== NS || actualKind !== kind || !action || !nonce) return undefined;
  return { action, nonce };
}

/** Permission button actions. Mirror the Transport `Decision` type. */
export type PermAction = "once" | "session" | "always" | "deny";

const ACTIONS: ReadonlySet<string> = new Set(["once", "session", "always", "deny"]);

export function encodePermissionId(nonce: string, action: PermAction): string {
  return `${NS}:perm:${action}:${nonce}`;
}

export interface DecodedPermission {
  nonce: string;
  action: PermAction;
}

export function decodePermissionId(customId: string): DecodedPermission | undefined {
  const decoded = decodeParts(customId, "perm");
  if (!decoded || !ACTIONS.has(decoded.action)) return undefined;
  return { nonce: decoded.nonce, action: decoded.action as PermAction };
}

// ---- ask_user (choice) buttons -----------------------------------------

export function encodeChoiceId(nonce: string, index: number): string {
  return `${NS}:ask:${index}:${nonce}`;
}

export interface DecodedChoice {
  nonce: string;
  index: number;
}

export function decodeChoiceId(customId: string): DecodedChoice | undefined {
  const decoded = decodeParts(customId, "ask");
  if (!decoded) return undefined;
  const { action: idx, nonce } = decoded;
  if (!idx || !/^\d+$/.test(idx)) return undefined; // all-digit index only
  const index = Number.parseInt(idx, 10);
  if (!Number.isInteger(index)) return undefined;
  return { nonce, index };
}

// ---- repo rebind confirmation ------------------------------------------

/** Confirm or cancel a repo/dev-mode rebind. `cancel` is the SAFE default that
 *  a timeout, an abort or an unacknowledged click resolves to. */
export type RebindAction = "confirm" | "cancel";

const REBIND_ACTIONS: ReadonlySet<string> = new Set(["confirm", "cancel"]);

export function encodeRepoId(nonce: string, action: RebindAction): string {
  return `${NS}:repo:${action}:${nonce}`;
}

export interface DecodedRepo {
  nonce: string;
  action: RebindAction;
}

export function decodeRepoId(customId: string): DecodedRepo | undefined {
  const decoded = decodeParts(customId, "repo");
  if (!decoded || !REBIND_ACTIONS.has(decoded.action)) return undefined;
  return { nonce: decoded.nonce, action: decoded.action as RebindAction };
}

// ---- exit-plan buttons --------------------------------------------------

/** Plan action: an index into the request's `actions`, or "reject". */
export type PlanAction = number | "reject";

export function encodePlanId(nonce: string, action: PlanAction): string {
  return `${NS}:plan:${action}:${nonce}`;
}

export interface DecodedPlan {
  nonce: string;
  action: PlanAction;
}

export function decodePlanId(customId: string): DecodedPlan | undefined {
  const decoded = decodeParts(customId, "plan");
  if (!decoded) return undefined;
  const { action, nonce } = decoded;
  if (action === "reject") return { nonce, action: "reject" };
  if (!/^\d+$/.test(action)) return undefined; // all-digit index only
  const index = Number.parseInt(action, 10);
  if (!Number.isInteger(index)) return undefined;
  return { nonce, action: index };
}
