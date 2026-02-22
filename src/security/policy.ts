/**
 * Authorization policy schema for IxADO.
 *
 * Roles (least → most privileged):
 *   viewer   – read-only status/task queries
 *   operator – everything viewer can do + start/stop/next execution controls
 *   admin    – everything operator can do + privileged git actions and project config writes
 *   owner    – super-set; cannot be restricted by policy (always granted)
 *
 * Evaluation order (a request is ALLOW only when ALL three are satisfied):
 *   1. Role is known and at or above the required minimum.
 *   2. The action matches at least one allowlist pattern for that role.
 *   3. The action does NOT match any denylist pattern for that role.
 *
 * Default-deny: if no allowlist rule matches → DENY.
 * Denylist wins: a matching denylist rule always overrides an allowlist match.
 *
 * Patterns support a single trailing wildcard `*` (e.g. `git:privileged:*`).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const RoleSchema = z.enum(["owner", "admin", "operator", "viewer"]);
export type Role = z.infer<typeof RoleSchema>;

/** Ordered from least to most privileged — index is the privilege level. */
export const ROLE_HIERARCHY: Role[] = ["viewer", "operator", "admin", "owner"];

// ---------------------------------------------------------------------------
// Action namespaces
//
// Actions follow the pattern `<namespace>:<verb>` or `<namespace>:<sub>:<verb>`.
// The `*` suffix matches any suffix after a colon-separated prefix.
// ---------------------------------------------------------------------------

export const ActionPatternSchema = z
  .string()
  .min(1)
  .regex(
    /^\*$|^[a-z][a-z0-9]*(?::[a-z][a-z0-9]*)*(?::\*)?$/,
    "Action pattern must be lower-kebab identifiers separated by ':' with an optional trailing '*'"
  );
export type ActionPattern = z.infer<typeof ActionPatternSchema>;

// ---------------------------------------------------------------------------
// Per-role rule set
// ---------------------------------------------------------------------------

export const RoleRuleSetSchema = z.object({
  /**
   * Actions this role is allowed to perform.
   * Must contain at least one pattern; supports trailing `*` wildcard.
   * Default-deny semantics apply — only explicitly listed actions are allowed.
   */
  allowlist: z.array(ActionPatternSchema).min(1),

  /**
   * Actions explicitly denied for this role regardless of allowlist matches.
   * Denylist always wins over an allowlist match.
   * May be empty (no explicit denials beyond default-deny).
   */
  denylist: z.array(ActionPatternSchema).default([]),
});
export type RoleRuleSet = z.infer<typeof RoleRuleSetSchema>;

// ---------------------------------------------------------------------------
// Full policy document
// ---------------------------------------------------------------------------

export const AuthPolicySchema = z
  .object({
    /**
     * Schema version — must be "1" for this release.
     * Future breaking changes will bump this.
     */
    version: z.literal("1"),

    /**
     * Per-role rule sets.  All four roles MUST be present; the owner role
     * always has an implicit allow-all and its rules are still validated.
     */
    roles: z.object({
      owner: RoleRuleSetSchema,
      admin: RoleRuleSetSchema,
      operator: RoleRuleSetSchema,
      viewer: RoleRuleSetSchema,
    }),
  })
  .superRefine((policy, ctx) => {
    // owner's allowlist must contain the wildcard that grants everything
    const ownerAllowlist = policy.roles.owner.allowlist;
    if (!ownerAllowlist.includes("*")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "roles.owner.allowlist must contain '*' to grant all actions.",
        path: ["roles", "owner", "allowlist"],
      });
    }

    // owner must have an empty denylist — it cannot be restricted
    if (policy.roles.owner.denylist.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "roles.owner.denylist must be empty — the owner role cannot be denied any action.",
        path: ["roles", "owner", "denylist"],
      });
    }
  });
export type AuthPolicy = z.infer<typeof AuthPolicySchema>;

// ---------------------------------------------------------------------------
// Well-known action constants
// ---------------------------------------------------------------------------

/** Read-only informational queries (safe for viewer+). */
export const ACTIONS = {
  // status / task queries
  STATUS_READ: "status:read",
  TASKS_READ: "tasks:read",
  LOGS_READ: "logs:read",
  USAGE_READ: "usage:read",

  // execution controls (operator+)
  EXECUTION_NEXT: "execution:next",
  EXECUTION_STOP: "execution:stop",
  EXECUTION_START: "execution:start",

  // project / phase management (operator+)
  PHASE_CREATE: "phase:create",
  TASK_CREATE: "task:create",
  TASK_UPDATE: "task:update",

  // privileged git actions (admin+)
  GIT_BRANCH_CREATE: "git:privileged:branch-create",
  GIT_PUSH: "git:privileged:push",
  GIT_REBASE: "git:privileged:rebase",
  GIT_PR_OPEN: "git:privileged:pr-open",
  GIT_PR_MERGE: "git:privileged:pr-merge",

  // system configuration (admin+)
  CONFIG_WRITE: "config:write",
  AGENT_KILL: "agent:kill",
  AGENT_RESTART: "agent:restart",
} as const;

export type ActionName = (typeof ACTIONS)[keyof typeof ACTIONS];

// ---------------------------------------------------------------------------
// Default built-in policy
//
// Generous allowlists: roles can do everything appropriate for their level.
// Explicit denylists: lower roles are blocked from privileged namespaces.
// ---------------------------------------------------------------------------

export const DEFAULT_AUTH_POLICY: AuthPolicy = {
  version: "1",
  roles: {
    owner: {
      // owner can do everything
      allowlist: ["*"],
      denylist: [],
    },

    admin: {
      allowlist: [
        // all read queries
        "status:read",
        "tasks:read",
        "logs:read",
        "usage:read",
        // execution controls
        "execution:*",
        // project / phase / task management
        "phase:*",
        "task:*",
        // privileged git
        "git:privileged:*",
        // system config
        "config:write",
        "agent:*",
      ],
      // admin cannot elevate itself to owner-only operations (reserved for future use)
      denylist: [],
    },

    operator: {
      allowlist: [
        // read
        "status:read",
        "tasks:read",
        "logs:read",
        "usage:read",
        // execution controls
        "execution:next",
        "execution:stop",
        "execution:start",
        // basic task/phase management
        "phase:create",
        "task:create",
        "task:update",
      ],
      // operators may never touch git or system config
      denylist: [
        "git:privileged:*",
        "config:write",
        "agent:kill",
        "agent:restart",
      ],
    },

    viewer: {
      allowlist: [
        "status:read",
        "tasks:read",
        "logs:read",
        "usage:read",
      ],
      // viewers are blocked from everything mutating
      denylist: [
        "execution:*",
        "phase:*",
        "task:*",
        "git:privileged:*",
        "config:write",
        "agent:*",
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Pattern matching helper
// ---------------------------------------------------------------------------

/**
 * Returns true if `action` matches `pattern`.
 *
 * Rules:
 *  - `"*"` matches any action string.
 *  - `"foo:bar:*"` matches any action whose prefix up to and including `"foo:bar:"` equals the pattern prefix.
 *  - All other patterns are exact string matches.
 */
export function matchesPattern(pattern: ActionPattern, action: string): boolean {
  if (pattern === "*") {
    return true;
  }

  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1); // strip trailing '*'
    return action.startsWith(prefix);
  }

  return pattern === action;
}
