/** Encode/decode Discord component custom ids. Only a namespace, an action and a
 *  random nonce ever go into a custom id — never secrets or payloads. */

const NS = "dp";

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
  const parts = customId.split(":");
  if (parts.length !== 4) return undefined;
  const [ns, kind, action, nonce] = parts;
  if (ns !== NS || kind !== "perm") return undefined;
  if (!action || !ACTIONS.has(action)) return undefined;
  if (!nonce) return undefined;
  return { nonce, action: action as PermAction };
}
