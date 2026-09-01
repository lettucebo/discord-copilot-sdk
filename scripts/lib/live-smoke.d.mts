import type { PermissionView } from "../../src/core/transport.js";

export function matchesExpectedShellPermission(
  view: PermissionView,
  expectedCommand: string
): boolean;
