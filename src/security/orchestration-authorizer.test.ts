import { describe, expect, test } from "bun:test";

import { DEFAULT_AUTH_POLICY } from "./policy";
import { authorizeOrchestratorAction } from "./orchestration-authorizer";
import { ORCHESTRATOR_ACTIONS } from "./workflow-profiles";

describe("authorizeOrchestratorAction fail-closed behavior", () => {
  const baseInput = {
    action: ORCHESTRATOR_ACTIONS.STATUS_READ,
    auditCwd: "/repo",
    settingsFilePath: "/tmp/nonexistent.json",
    session: { source: "cli" as const },
    roleConfig: {},
  };

  test("denies on policy load failure", async () => {
    const decision = await authorizeOrchestratorAction({
      ...baseInput,
      loadPolicy: async () => {
        throw new Error("boom");
      },
    });

    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") {
      expect(decision.reason).toBe("policy-load-failed");
      expect(decision.message).toContain("boom");
    }
  });

  test("denies on role resolution failure", async () => {
    const decision = await authorizeOrchestratorAction({
      ...baseInput,
      loadPolicy: async () => DEFAULT_AUTH_POLICY,
      resolveSessionRole: () => null,
    });

    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") {
      expect(decision.reason).toBe("role-resolution-failed");
    }
  });

  test("denies on evaluator error", async () => {
    const decision = await authorizeOrchestratorAction({
      ...baseInput,
      loadPolicy: async () => DEFAULT_AUTH_POLICY,
      resolveSessionRole: () => "owner",
      getRequiredActions: () => {
        throw new Error("evaluator exploded");
      },
    });

    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") {
      expect(decision.reason).toBe("evaluator-error");
      expect(decision.message).toContain("evaluator exploded");
    }
  });

  test("denies on missing action mapping", async () => {
    const decision = await authorizeOrchestratorAction({
      ...baseInput,
      action: "orchestrator:missing" as typeof ORCHESTRATOR_ACTIONS.STATUS_READ,
      auditCwd: "/repo",
      loadPolicy: async () => DEFAULT_AUTH_POLICY,
      resolveSessionRole: () => "owner",
    });

    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") {
      expect(decision.reason).toBe("missing-action-mapping");
    }
  });
});
