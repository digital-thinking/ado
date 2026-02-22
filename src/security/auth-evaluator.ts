/**
 * Authorization evaluator for IxADO.
 *
 * Evaluation rules (applied in order):
 *   1. Null role  → DENY  (unrecognized session; no role assigned).
 *   2. Denylist   → DENY  if any denylist pattern for the resolved role matches
 *                         the action. Denylist always wins over an allowlist match.
 *   3. Allowlist  → ALLOW if any allowlist pattern for the resolved role matches.
 *   4. Default    → DENY  if no allowlist pattern matched (default-deny).
 *
 * The owner role is always granted because the policy schema enforces that its
 * allowlist is ["*"] and its denylist is [].  The general evaluation path
 * handles this automatically.
 */

import { matchesPattern, type AuthPolicy, type Role } from "./policy";

// ---------------------------------------------------------------------------
// Decision type
// ---------------------------------------------------------------------------

export type AuthDecision =
  | { decision: "allow"; role: Role; action: string; matchedPattern: string }
  | { decision: "deny"; role: Role | null; action: string; reason: DenyReason };

export type DenyReason =
  | "no-role"          // null role — unrecognized session
  | "denylist-match"   // explicit denylist pattern matched
  | "no-allowlist-match"; // default-deny — no allowlist pattern matched

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluates whether `role` is authorized to perform `action` under `policy`.
 *
 * @param role    The resolved role for the current session, or `null` when the
 *                session has no recognized identity.
 * @param action  The fully-qualified action string (e.g. `"git:privileged:push"`).
 * @param policy  The loaded {@link AuthPolicy} to evaluate against.
 * @returns       An {@link AuthDecision} describing the outcome.
 */
export function evaluate(
  role: Role | null,
  action: string,
  policy: AuthPolicy,
): AuthDecision {
  // Rule 1: no role → deny immediately (fail-closed for unknown sessions)
  if (role === null) {
    return {
      decision: "deny",
      role: null,
      action,
      reason: "no-role",
    };
  }

  const ruleSet = policy.roles[role];

  // Rule 2: denylist check — denylist always wins
  for (const pattern of ruleSet.denylist) {
    if (matchesPattern(pattern, action)) {
      return {
        decision: "deny",
        role,
        action,
        reason: "denylist-match",
      };
    }
  }

  // Rule 3: allowlist check
  for (const pattern of ruleSet.allowlist) {
    if (matchesPattern(pattern, action)) {
      return {
        decision: "allow",
        role,
        action,
        matchedPattern: pattern,
      };
    }
  }

  // Rule 4: default-deny — no allowlist match
  return {
    decision: "deny",
    role,
    action,
    reason: "no-allowlist-match",
  };
}

// ---------------------------------------------------------------------------
// Convenience helper
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the session is authorized, `false` otherwise.
 * Use {@link evaluate} directly when you need the structured decision.
 */
export function isAuthorized(
  role: Role | null,
  action: string,
  policy: AuthPolicy,
): boolean {
  return evaluate(role, action, policy).decision === "allow";
}
