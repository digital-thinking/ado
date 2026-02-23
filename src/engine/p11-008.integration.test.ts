import { describe, expect, test } from "bun:test";

import { CodexAdapter } from "../adapters/codex-adapter";
import { InteractiveModeError } from "../adapters/types";
import { runCiIntegration } from "./ci-integration";
import { DEFAULT_AUTH_POLICY, type AuthPolicy } from "../security/policy";
import {
  OrchestrationAuthorizationDeniedError,
  authorizeOrchestratorAction,
} from "../security/orchestration-authorizer";
import { ORCHESTRATOR_ACTIONS } from "../security/workflow-profiles";
import { MockProcessRunner } from "../vcs/test-utils";

const PHASE = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Phase 11 Integration Security",
};

function clonePolicy(policy: AuthPolicy): AuthPolicy {
  return structuredClone(policy);
}

describe("P11-008 integration coverage", () => {
  test("non-interactive enforcement is fail-closed at runtime for adapters", async () => {
    const runner = new MockProcessRunner([{ stdout: "should-not-run" }]);
    const adapter = new CodexAdapter(runner);

    // Simulate a runtime regression/tampering after construction.
    (adapter as unknown as { baseArgs: string[] }).baseArgs.push("chat");

    await expect(
      adapter.run({ prompt: "continue", cwd: "/repo" }),
    ).rejects.toBeInstanceOf(InteractiveModeError);
    expect(runner.calls).toHaveLength(0);
  });

  test("denylist precedence blocks privileged CI integration before any subprocess runs", async () => {
    const runner = new MockProcessRunner([{ stdout: "feature/p11-008\n" }]);
    const policy = clonePolicy(DEFAULT_AUTH_POLICY);
    policy.roles.admin.denylist = ["git:privileged:push"];

    await expect(
      runCiIntegration({
        phaseId: PHASE.id,
        phaseName: PHASE.name,
        cwd: "C:/repo",
        baseBranch: "main",
        runner,
        role: "admin",
        policy,
        setPhasePrUrl: async () => {},
      }),
    ).rejects.toBeInstanceOf(OrchestrationAuthorizationDeniedError);

    await expect(
      runCiIntegration({
        phaseId: PHASE.id,
        phaseName: PHASE.name,
        cwd: "C:/repo",
        baseBranch: "main",
        runner: new MockProcessRunner([{ stdout: "feature/p11-008\n" }]),
        role: "admin",
        policy,
        setPhasePrUrl: async () => {},
      }),
    ).rejects.toThrow("reason: denylist-match");

    expect(runner.calls).toHaveLength(0);
  });

  test("privileged git actions are authorized and executed when policy allows", async () => {
    const runner = new MockProcessRunner([
      { stdout: "feature/p11-008\n" },
      { stdout: "" },
      { stdout: "https://github.com/org/repo/pull/1108\n" },
    ]);

    const capturedPrUrls: string[] = [];
    const result = await runCiIntegration({
      phaseId: PHASE.id,
      phaseName: PHASE.name,
      cwd: "C:/repo",
      baseBranch: "main",
      runner,
      role: "admin",
      policy: clonePolicy(DEFAULT_AUTH_POLICY),
      setPhasePrUrl: async ({ prUrl }) => {
        capturedPrUrls.push(prUrl);
      },
    });

    expect(result.prUrl).toBe("https://github.com/org/repo/pull/1108");
    expect(capturedPrUrls).toEqual(["https://github.com/org/repo/pull/1108"]);

    expect(runner.calls[1]?.command).toBe("git");
    expect(runner.calls[1]?.args).toEqual([
      "push",
      "-u",
      "origin",
      "feature/p11-008",
    ]);
    expect(runner.calls[2]?.command).toBe("gh");
    expect(runner.calls[2]?.args).toContain("pr");
    expect(runner.calls[2]?.args).toContain("create");
  });

  test("fail-closed startup/runtime paths deny on policy-load and role-resolution failures", async () => {
    const startupDecision = await authorizeOrchestratorAction({
      action: ORCHESTRATOR_ACTIONS.CI_INTEGRATION_RUN,
      settingsFilePath: "/tmp/settings.json",
      session: { source: "cli" },
      roleConfig: {},
      loadPolicy: async () => {
        throw new Error("cannot read policy");
      },
    });

    expect(startupDecision.decision).toBe("deny");
    if (startupDecision.decision === "deny") {
      expect(startupDecision.reason).toBe("policy-load-failed");
    }

    const runner = new MockProcessRunner([{ stdout: "feature/p11-008\n" }]);
    await expect(
      runCiIntegration({
        phaseId: PHASE.id,
        phaseName: PHASE.name,
        cwd: "C:/repo",
        baseBranch: "main",
        runner,
        role: null,
        policy: clonePolicy(DEFAULT_AUTH_POLICY),
        setPhasePrUrl: async () => {},
      }),
    ).rejects.toThrow("reason: role-resolution-failed");
  });
});
