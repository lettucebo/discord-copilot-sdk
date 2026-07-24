// Pure installer decision helpers, extracted from setup.mjs so their boundaries
// are unit-testable in isolation. Node built-ins only (runs before npm install).

/**
 * Does this Node satisfy discopilot's engines (^20.19 || >=22.12)? The boundary
 * versions matter: 20.18 is too old, 20.19 is the first supported 20.x; 21.x is
 * unsupported (odd/non-LTS); 22.11 is too old, 22.12 is the first supported 22.x.
 * @param {string} v e.g. process.versions.node ("22.12.0")
 */
export function nodeVersionOk(v = process.versions.node) {
  const [maj, min] = String(v).split(".").map(Number);
  if (!Number.isFinite(maj) || !Number.isFinite(min)) return false;
  if (maj === 20) return min >= 19; // ^20.19
  if (maj >= 22) return maj > 22 || min >= 12; // >=22.12
  return false; // <20, 20.<19, or 21.x
}
