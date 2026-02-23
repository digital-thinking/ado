/**
 * Unit tests for the authorization evaluator matrix.
 *
 * Coverage:
 *   - matchesPattern: exact match, global wildcard, prefix wildcard, non-match
 *   - evaluate: null-role deny, denylist-match deny, allowlist-match allow, default-deny
 *   - Role × action matrix using the DEFAULT_AUTH_POLICY
 *   - Conflict cases: allowlist + denylist overlap (denylist always wins)
 *   - Wildcard pattern interactions (wildcard allow vs. exact deny, exact allow vs. wildcard deny)
 *   - isAuthorized convenience helper
 *   - isOrchestratorActionAuthorized across all orchestrator actions and roles
 */

import { describe, expect, test } from "bun:test";

import { evaluate, isAuthorized } from "./auth-evaluator";
import {
  ACTIONS,
  type AuthPolicy,
  DEFAULT_AUTH_POLICY,
  matchesPattern,
} from "./policy";
import {
  isOrchestratorActionAuthorized,
  ORCHESTRATOR_ACTIONS,
} from "./workflow-profiles";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid AuthPolicy using provided role overrides. */
function makePolicy(overrides: Partial<AuthPolicy["roles"]> = {}): AuthPolicy {
  return {
    version: "1",
    roles: {
      owner: { allowlist: ["*"], denylist: [] },
      admin: { allowlist: ["admin:*"], denylist: [] },
      operator: { allowlist: ["operator:*"], denylist: [] },
      viewer: { allowlist: ["viewer:*"], denylist: [] },
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// matchesPattern
// ---------------------------------------------------------------------------

describe("matchesPattern", () => {
  describe("global wildcard '*'", () => {
    test("matches any action string", () => {
      expect(matchesPattern("*", "status:read")).toBe(true);
      expect(matchesPattern("*", "git:privileged:push")).toBe(true);
      expect(matchesPattern("*", "anything")).toBe(true);
    });
  });

  describe("prefix wildcard 'ns:*'", () => {
    test("matches action with the same prefix", () => {
      expect(matchesPattern("execution:*", "execution:start")).toBe(true);
      expect(matchesPattern("execution:*", "execution:stop")).toBe(true);
      expect(matchesPattern("execution:*", "execution:next")).toBe(true);
    });

    test("matches multi-segment suffix after prefix", () => {
      expect(matchesPattern("git:privileged:*", "git:privileged:push")).toBe(
        true,
      );
      expect(
        matchesPattern("git:privileged:*", "git:privileged:branch-create"),
      ).toBe(true);
      expect(matchesPattern("git:privileged:*", "git:privileged:pr-open")).toBe(
        true,
      );
    });

    test("does not match actions with a different prefix", () => {
      expect(matchesPattern("execution:*", "status:read")).toBe(false);
      expect(matchesPattern("git:privileged:*", "git:push")).toBe(false);
    });

    test("does not match the bare prefix without a suffix", () => {
      // "execution:*" means any string starting with "execution:" — the prefix
      // alone ("execution") does not start with "execution:" so it does not match
      expect(matchesPattern("execution:*", "execution")).toBe(false);
    });
  });

  describe("exact match", () => {
    test("matches only the identical action string", () => {
      expect(matchesPattern("status:read", "status:read")).toBe(true);
      expect(matchesPattern("config:write", "config:write")).toBe(true);
    });

    test("does not match a different action", () => {
      expect(matchesPattern("status:read", "tasks:read")).toBe(false);
      expect(matchesPattern("config:write", "config:read")).toBe(false);
    });

    test("does not match a prefix of the pattern", () => {
      expect(matchesPattern("status:read", "status")).toBe(false);
    });

    test("does not match an extension of the pattern", () => {
      expect(matchesPattern("status:read", "status:read:extra")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// evaluate — null role
// ---------------------------------------------------------------------------

describe("evaluate — null role (no-role deny)", () => {
  test("returns deny with reason 'no-role' for null role", () => {
    const result = evaluate(null, "status:read", DEFAULT_AUTH_POLICY);
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toBe("no-role");
      expect(result.role).toBeNull();
      expect(result.action).toBe("status:read");
    }
  });

  test("null role is denied even for a wildcard-covered action", () => {
    // owner policy allows '*', but role is null — should still deny
    const result = evaluate(null, "git:privileged:push", DEFAULT_AUTH_POLICY);
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toBe("no-role");
    }
  });

  test("isAuthorized returns false for null role", () => {
    expect(isAuthorized(null, "status:read", DEFAULT_AUTH_POLICY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluate — denylist-match
// ---------------------------------------------------------------------------

describe("evaluate — denylist-match deny", () => {
  test("denylist match overrides allowlist match (same exact action)", () => {
    const policy = makePolicy({
      viewer: {
        allowlist: ["status:read"],
        denylist: ["status:read"], // explicit conflict
      },
    });
    const result = evaluate("viewer", "status:read", policy);
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toBe("denylist-match");
    }
  });

  test("wildcard allowlist loses to specific denylist entry", () => {
    const policy = makePolicy({
      admin: {
        allowlist: ["status:*"], // matches status:read
        denylist: ["status:read"], // specific deny wins
      },
    });
    const result = evaluate("admin", "status:read", policy);
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toBe("denylist-match");
    }
  });

  test("specific allowlist loses to wildcard denylist pattern", () => {
    const policy = makePolicy({
      operator: {
        allowlist: ["execution:start"],
        denylist: ["execution:*"], // wildcard deny wins
      },
    });
    const result = evaluate("operator", "execution:start", policy);
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toBe("denylist-match");
    }
  });

  test("denylist match is reported with the correct role and action", () => {
    const policy = makePolicy({
      operator: {
        allowlist: ["status:read"],
        denylist: ["git:privileged:*"],
      },
    });
    const result = evaluate("operator", "git:privileged:push", policy);
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.role).toBe("operator");
      expect(result.action).toBe("git:privileged:push");
      expect(result.reason).toBe("denylist-match");
    }
  });

  // DEFAULT_AUTH_POLICY denylist cases
  test("operator: git:privileged:push is denied by denylist", () => {
    const result = evaluate("operator", ACTIONS.GIT_PUSH, DEFAULT_AUTH_POLICY);
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toBe("denylist-match");
    }
  });

  test("operator: config:write is denied by denylist", () => {
    const result = evaluate(
      "operator",
      ACTIONS.CONFIG_WRITE,
      DEFAULT_AUTH_POLICY,
    );
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toBe("denylist-match");
    }
  });

  test("operator: agent:kill is denied by denylist", () => {
    const result = evaluate(
      "operator",
      ACTIONS.AGENT_KILL,
      DEFAULT_AUTH_POLICY,
    );
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toBe("denylist-match");
    }
  });

  test("viewer: execution:start is denied by denylist", () => {
    const result = evaluate(
      "viewer",
      ACTIONS.EXECUTION_START,
      DEFAULT_AUTH_POLICY,
    );
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toBe("denylist-match");
    }
  });

  test("viewer: phase:create is denied by denylist", () => {
    const result = evaluate(
      "viewer",
      ACTIONS.PHASE_CREATE,
      DEFAULT_AUTH_POLICY,
    );
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toBe("denylist-match");
    }
  });
});

// ---------------------------------------------------------------------------
// evaluate — allowlist match (allow)
// ---------------------------------------------------------------------------

describe("evaluate — allowlist-match allow", () => {
  test("returns allow with matchedPattern for exact allowlist match", () => {
    const policy = makePolicy({
      viewer: { allowlist: ["status:read"], denylist: [] },
    });
    const result = evaluate("viewer", "status:read", policy);
    expect(result.decision).toBe("allow");
    if (result.decision === "allow") {
      expect(result.role).toBe("viewer");
      expect(result.action).toBe("status:read");
      expect(result.matchedPattern).toBe("status:read");
    }
  });

  test("returns allow for wildcard prefix match in allowlist", () => {
    const policy = makePolicy({
      admin: { allowlist: ["execution:*"], denylist: [] },
    });
    const result = evaluate("admin", "execution:start", policy);
    expect(result.decision).toBe("allow");
    if (result.decision === "allow") {
      expect(result.matchedPattern).toBe("execution:*");
    }
  });

  test("returns allow for global wildcard '*' allowlist", () => {
    const result = evaluate(
      "owner",
      "git:privileged:pr-merge",
      DEFAULT_AUTH_POLICY,
    );
    expect(result.decision).toBe("allow");
    if (result.decision === "allow") {
      expect(result.matchedPattern).toBe("*");
    }
  });

  test("matchedPattern reflects the first matching pattern", () => {
    const policy = makePolicy({
      admin: {
        allowlist: ["status:read", "status:*"], // both would match; first wins
        denylist: [],
      },
    });
    const result = evaluate("admin", "status:read", policy);
    expect(result.decision).toBe("allow");
    if (result.decision === "allow") {
      expect(result.matchedPattern).toBe("status:read");
    }
  });
});

// ---------------------------------------------------------------------------
// evaluate — default-deny (no allowlist match)
// ---------------------------------------------------------------------------

describe("evaluate — default-deny (no-allowlist-match)", () => {
  test("returns deny with reason 'no-allowlist-match' when no pattern matches", () => {
    const policy = makePolicy({
      viewer: { allowlist: ["status:read"], denylist: [] },
    });
    const result = evaluate("viewer", "tasks:read", policy);
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toBe("no-allowlist-match");
      expect(result.role).toBe("viewer");
      expect(result.action).toBe("tasks:read");
    }
  });

  test("action outside any allowlist pattern is denied", () => {
    const policy = makePolicy({
      operator: { allowlist: ["execution:start"], denylist: [] },
    });
    const result = evaluate("operator", "git:privileged:push", policy);
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toBe("no-allowlist-match");
    }
  });

  test("empty-pattern prefix does not accidentally match real actions", () => {
    // A pattern "status:*" should not match "tasks:read"
    const policy = makePolicy({
      viewer: { allowlist: ["status:*"], denylist: [] },
    });
    const result = evaluate("viewer", "tasks:read", policy);
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toBe("no-allowlist-match");
    }
  });
});

// ---------------------------------------------------------------------------
// Role × action matrix — DEFAULT_AUTH_POLICY
// ---------------------------------------------------------------------------

describe("DEFAULT_AUTH_POLICY — role × action matrix", () => {
  const readActions = [
    ACTIONS.STATUS_READ,
    ACTIONS.TASKS_READ,
    ACTIONS.LOGS_READ,
    ACTIONS.USAGE_READ,
  ] as const;

  const executionActions = [
    ACTIONS.EXECUTION_START,
    ACTIONS.EXECUTION_STOP,
    ACTIONS.EXECUTION_NEXT,
  ] as const;

  const planningActions = [
    ACTIONS.PHASE_CREATE,
    ACTIONS.TASK_CREATE,
    ACTIONS.TASK_UPDATE,
  ] as const;

  const privilegedGitActions = [
    ACTIONS.GIT_BRANCH_CREATE,
    ACTIONS.GIT_PUSH,
    ACTIONS.GIT_REBASE,
    ACTIONS.GIT_PR_OPEN,
    ACTIONS.GIT_PR_MERGE,
  ] as const;

  const adminActions = [
    ACTIONS.CONFIG_WRITE,
    ACTIONS.AGENT_KILL,
    ACTIONS.AGENT_RESTART,
  ] as const;

  // ── owner ──────────────────────────────────────────────────────────────────

  describe("owner", () => {
    test("is allowed to perform all read actions", () => {
      for (const action of readActions) {
        expect(isAuthorized("owner", action, DEFAULT_AUTH_POLICY)).toBe(true);
      }
    });

    test("is allowed to perform all execution actions", () => {
      for (const action of executionActions) {
        expect(isAuthorized("owner", action, DEFAULT_AUTH_POLICY)).toBe(true);
      }
    });

    test("is allowed to perform all planning actions", () => {
      for (const action of planningActions) {
        expect(isAuthorized("owner", action, DEFAULT_AUTH_POLICY)).toBe(true);
      }
    });

    test("is allowed to perform all privileged git actions", () => {
      for (const action of privilegedGitActions) {
        expect(isAuthorized("owner", action, DEFAULT_AUTH_POLICY)).toBe(true);
      }
    });

    test("is allowed to perform all admin actions", () => {
      for (const action of adminActions) {
        expect(isAuthorized("owner", action, DEFAULT_AUTH_POLICY)).toBe(true);
      }
    });
  });

  // ── admin ──────────────────────────────────────────────────────────────────

  describe("admin", () => {
    test("is allowed to perform all read actions", () => {
      for (const action of readActions) {
        expect(isAuthorized("admin", action, DEFAULT_AUTH_POLICY)).toBe(true);
      }
    });

    test("is allowed to perform all execution actions", () => {
      for (const action of executionActions) {
        expect(isAuthorized("admin", action, DEFAULT_AUTH_POLICY)).toBe(true);
      }
    });

    test("is allowed to perform all planning actions", () => {
      for (const action of planningActions) {
        expect(isAuthorized("admin", action, DEFAULT_AUTH_POLICY)).toBe(true);
      }
    });

    test("is allowed to perform all privileged git actions", () => {
      for (const action of privilegedGitActions) {
        expect(isAuthorized("admin", action, DEFAULT_AUTH_POLICY)).toBe(true);
      }
    });

    test("is allowed to perform all admin/config/agent actions", () => {
      for (const action of adminActions) {
        expect(isAuthorized("admin", action, DEFAULT_AUTH_POLICY)).toBe(true);
      }
    });
  });

  // ── operator ───────────────────────────────────────────────────────────────

  describe("operator", () => {
    test("is allowed to perform all read actions", () => {
      for (const action of readActions) {
        expect(isAuthorized("operator", action, DEFAULT_AUTH_POLICY)).toBe(
          true,
        );
      }
    });

    test("is allowed to perform all execution actions", () => {
      for (const action of executionActions) {
        expect(isAuthorized("operator", action, DEFAULT_AUTH_POLICY)).toBe(
          true,
        );
      }
    });

    test("is allowed to perform all planning actions", () => {
      for (const action of planningActions) {
        expect(isAuthorized("operator", action, DEFAULT_AUTH_POLICY)).toBe(
          true,
        );
      }
    });

    test("is DENIED all privileged git actions (denylist)", () => {
      for (const action of privilegedGitActions) {
        expect(isAuthorized("operator", action, DEFAULT_AUTH_POLICY)).toBe(
          false,
        );
      }
    });

    test("is DENIED config:write (denylist)", () => {
      expect(
        isAuthorized("operator", ACTIONS.CONFIG_WRITE, DEFAULT_AUTH_POLICY),
      ).toBe(false);
    });

    test("is DENIED agent:kill (denylist)", () => {
      expect(
        isAuthorized("operator", ACTIONS.AGENT_KILL, DEFAULT_AUTH_POLICY),
      ).toBe(false);
    });

    test("is DENIED agent:restart (denylist)", () => {
      expect(
        isAuthorized("operator", ACTIONS.AGENT_RESTART, DEFAULT_AUTH_POLICY),
      ).toBe(false);
    });
  });

  // ── viewer ─────────────────────────────────────────────────────────────────

  describe("viewer", () => {
    test("is allowed to perform all read actions", () => {
      for (const action of readActions) {
        expect(isAuthorized("viewer", action, DEFAULT_AUTH_POLICY)).toBe(true);
      }
    });

    test("is DENIED all execution actions (denylist)", () => {
      for (const action of executionActions) {
        expect(isAuthorized("viewer", action, DEFAULT_AUTH_POLICY)).toBe(false);
      }
    });

    test("is DENIED all planning actions (denylist)", () => {
      for (const action of planningActions) {
        expect(isAuthorized("viewer", action, DEFAULT_AUTH_POLICY)).toBe(false);
      }
    });

    test("is DENIED all privileged git actions (denylist)", () => {
      for (const action of privilegedGitActions) {
        expect(isAuthorized("viewer", action, DEFAULT_AUTH_POLICY)).toBe(false);
      }
    });

    test("is DENIED config:write (denylist)", () => {
      expect(
        isAuthorized("viewer", ACTIONS.CONFIG_WRITE, DEFAULT_AUTH_POLICY),
      ).toBe(false);
    });

    test("is DENIED all agent actions (denylist)", () => {
      for (const action of adminActions) {
        expect(isAuthorized("viewer", action, DEFAULT_AUTH_POLICY)).toBe(false);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Conflict cases — allowlist / denylist overlap
// ---------------------------------------------------------------------------

describe("conflict cases — denylist always wins", () => {
  test("global wildcard allowlist + specific denylist → deny", () => {
    // Simulate a policy where a role has '*' on allowlist but a specific deny
    // (note: owner cannot have a non-empty denylist per the schema; use admin)
    const policy: AuthPolicy = {
      version: "1",
      roles: {
        owner: { allowlist: ["*"], denylist: [] },
        admin: { allowlist: ["*"], denylist: ["config:write"] },
        operator: { allowlist: ["status:read"], denylist: [] },
        viewer: { allowlist: ["status:read"], denylist: [] },
      },
    };
    expect(isAuthorized("admin", "config:write", policy)).toBe(false);
    // Other actions not in the denylist are still allowed
    expect(isAuthorized("admin", "status:read", policy)).toBe(true);
  });

  test("wildcard allowlist + wildcard denylist covering same namespace → deny all in namespace", () => {
    const policy: AuthPolicy = {
      version: "1",
      roles: {
        owner: { allowlist: ["*"], denylist: [] },
        admin: { allowlist: ["execution:*"], denylist: ["execution:*"] },
        operator: { allowlist: ["status:read"], denylist: [] },
        viewer: { allowlist: ["status:read"], denylist: [] },
      },
    };
    expect(isAuthorized("admin", "execution:start", policy)).toBe(false);
    expect(isAuthorized("admin", "execution:stop", policy)).toBe(false);
    expect(isAuthorized("admin", "execution:next", policy)).toBe(false);
  });

  test("specific allowlist entry + overlapping wildcard denylist → deny", () => {
    const policy: AuthPolicy = {
      version: "1",
      roles: {
        owner: { allowlist: ["*"], denylist: [] },
        admin: { allowlist: ["status:read"], denylist: ["status:*"] },
        operator: { allowlist: ["status:read"], denylist: [] },
        viewer: { allowlist: ["status:read"], denylist: [] },
      },
    };
    expect(isAuthorized("admin", "status:read", policy)).toBe(false);
  });

  test("denylist entry not in allowlist → no-allowlist-match deny (not denylist-match)", () => {
    const policy = makePolicy({
      viewer: {
        allowlist: ["status:read"],
        denylist: ["execution:*"],
      },
    });
    // 'tasks:read' is not denied and not allowed → no-allowlist-match
    const result = evaluate("viewer", "tasks:read", policy);
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toBe("no-allowlist-match");
    }
  });

  test("action matching denylist is denied regardless of allowlist order", () => {
    // denylist check runs before allowlist — even if allowlist is listed first in code
    const policy = makePolicy({
      operator: {
        allowlist: ["git:privileged:push", "git:privileged:*"],
        denylist: ["git:privileged:push"],
      },
    });
    const result = evaluate("operator", "git:privileged:push", policy);
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toBe("denylist-match");
    }
  });
});

// ---------------------------------------------------------------------------
// isAuthorized convenience helper
// ---------------------------------------------------------------------------

describe("isAuthorized", () => {
  test("returns true when evaluate returns allow", () => {
    expect(isAuthorized("owner", "status:read", DEFAULT_AUTH_POLICY)).toBe(
      true,
    );
  });

  test("returns false when evaluate returns deny (no-role)", () => {
    expect(isAuthorized(null, "status:read", DEFAULT_AUTH_POLICY)).toBe(false);
  });

  test("returns false when evaluate returns deny (denylist-match)", () => {
    expect(
      isAuthorized("viewer", ACTIONS.EXECUTION_START, DEFAULT_AUTH_POLICY),
    ).toBe(false);
  });

  test("returns false when evaluate returns deny (no-allowlist-match)", () => {
    const policy = makePolicy({
      viewer: { allowlist: ["status:read"], denylist: [] },
    });
    expect(isAuthorized("viewer", "tasks:read", policy)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isOrchestratorActionAuthorized — role × orchestrator action matrix
// ---------------------------------------------------------------------------

describe("isOrchestratorActionAuthorized", () => {
  const readonlyOrchestratorActions = [
    ORCHESTRATOR_ACTIONS.STATUS_READ,
    ORCHESTRATOR_ACTIONS.TASKS_READ,
    ORCHESTRATOR_ACTIONS.LOGS_READ,
    ORCHESTRATOR_ACTIONS.USAGE_READ,
  ] as const;

  const planningOrchestratorActions = [
    ORCHESTRATOR_ACTIONS.PHASE_CREATE,
    ORCHESTRATOR_ACTIONS.TASK_CREATE,
    ORCHESTRATOR_ACTIONS.TASK_UPDATE,
  ] as const;

  const executionOrchestratorActions = [
    ORCHESTRATOR_ACTIONS.EXECUTION_START,
    ORCHESTRATOR_ACTIONS.EXECUTION_STOP,
    ORCHESTRATOR_ACTIONS.EXECUTION_NEXT,
    ORCHESTRATOR_ACTIONS.TESTER_RUN,
    ORCHESTRATOR_ACTIONS.CI_VALIDATION_RUN,
    ORCHESTRATOR_ACTIONS.EXCEPTION_RECOVERY_RUN,
  ] as const;

  const privilegedOrchestratorActions = [
    ORCHESTRATOR_ACTIONS.GIT_BRANCH_CREATE,
    ORCHESTRATOR_ACTIONS.GIT_PUSH,
    ORCHESTRATOR_ACTIONS.GIT_REBASE,
    ORCHESTRATOR_ACTIONS.GIT_PR_OPEN,
    ORCHESTRATOR_ACTIONS.GIT_PR_MERGE,
    ORCHESTRATOR_ACTIONS.CI_INTEGRATION_RUN,
    ORCHESTRATOR_ACTIONS.AGENT_KILL,
    ORCHESTRATOR_ACTIONS.AGENT_RESTART,
    ORCHESTRATOR_ACTIONS.CONFIG_WRITE,
  ] as const;

  // ── null role ─────────────────────────────────────────────────────────────

  describe("null role", () => {
    test("is denied all readonly orchestrator actions", () => {
      for (const action of readonlyOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized(null, action, DEFAULT_AUTH_POLICY),
        ).toBe(false);
      }
    });

    test("is denied all privileged orchestrator actions", () => {
      for (const action of privilegedOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized(null, action, DEFAULT_AUTH_POLICY),
        ).toBe(false);
      }
    });
  });

  // ── owner ─────────────────────────────────────────────────────────────────

  describe("owner", () => {
    test("is authorized for all readonly orchestrator actions", () => {
      for (const action of readonlyOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized("owner", action, DEFAULT_AUTH_POLICY),
        ).toBe(true);
      }
    });

    test("is authorized for all planning orchestrator actions", () => {
      for (const action of planningOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized("owner", action, DEFAULT_AUTH_POLICY),
        ).toBe(true);
      }
    });

    test("is authorized for all execution orchestrator actions", () => {
      for (const action of executionOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized("owner", action, DEFAULT_AUTH_POLICY),
        ).toBe(true);
      }
    });

    test("is authorized for all privileged orchestrator actions", () => {
      for (const action of privilegedOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized("owner", action, DEFAULT_AUTH_POLICY),
        ).toBe(true);
      }
    });
  });

  // ── admin ─────────────────────────────────────────────────────────────────

  describe("admin", () => {
    test("is authorized for all readonly orchestrator actions", () => {
      for (const action of readonlyOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized("admin", action, DEFAULT_AUTH_POLICY),
        ).toBe(true);
      }
    });

    test("is authorized for all planning orchestrator actions", () => {
      for (const action of planningOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized("admin", action, DEFAULT_AUTH_POLICY),
        ).toBe(true);
      }
    });

    test("is authorized for all execution orchestrator actions", () => {
      for (const action of executionOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized("admin", action, DEFAULT_AUTH_POLICY),
        ).toBe(true);
      }
    });

    test("is authorized for all privileged orchestrator actions", () => {
      for (const action of privilegedOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized("admin", action, DEFAULT_AUTH_POLICY),
        ).toBe(true);
      }
    });
  });

  // ── operator ──────────────────────────────────────────────────────────────

  describe("operator", () => {
    test("is authorized for all readonly orchestrator actions", () => {
      for (const action of readonlyOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized(
            "operator",
            action,
            DEFAULT_AUTH_POLICY,
          ),
        ).toBe(true);
      }
    });

    test("is authorized for all planning orchestrator actions", () => {
      for (const action of planningOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized(
            "operator",
            action,
            DEFAULT_AUTH_POLICY,
          ),
        ).toBe(true);
      }
    });

    test("is authorized for all execution orchestrator actions", () => {
      for (const action of executionOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized(
            "operator",
            action,
            DEFAULT_AUTH_POLICY,
          ),
        ).toBe(true);
      }
    });

    test("is DENIED all privileged orchestrator actions", () => {
      for (const action of privilegedOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized(
            "operator",
            action,
            DEFAULT_AUTH_POLICY,
          ),
        ).toBe(false);
      }
    });
  });

  // ── viewer ────────────────────────────────────────────────────────────────

  describe("viewer", () => {
    test("is authorized for all readonly orchestrator actions", () => {
      for (const action of readonlyOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized("viewer", action, DEFAULT_AUTH_POLICY),
        ).toBe(true);
      }
    });

    test("is DENIED all planning orchestrator actions", () => {
      for (const action of planningOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized("viewer", action, DEFAULT_AUTH_POLICY),
        ).toBe(false);
      }
    });

    test("is DENIED all execution orchestrator actions", () => {
      for (const action of executionOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized("viewer", action, DEFAULT_AUTH_POLICY),
        ).toBe(false);
      }
    });

    test("is DENIED all privileged orchestrator actions", () => {
      for (const action of privilegedOrchestratorActions) {
        expect(
          isOrchestratorActionAuthorized("viewer", action, DEFAULT_AUTH_POLICY),
        ).toBe(false);
      }
    });
  });
});
