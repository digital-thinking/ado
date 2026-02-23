import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ClaudeAdapter } from "../adapters/claude-adapter";
import { CodexAdapter } from "../adapters/codex-adapter";
import { GeminiAdapter } from "../adapters/gemini-adapter";
import { InteractiveModeError } from "../adapters/types";
import { runCiIntegration } from "./ci-integration";
import { DEFAULT_AUTH_POLICY, type AuthPolicy } from "../security/policy";
import {
  OrchestrationAuthorizationDeniedError,
  authorizeOrchestratorAction,
} from "../security/orchestration-authorizer";
import { ORCHESTRATOR_ACTIONS } from "../security/workflow-profiles";
import { MockProcessRunner } from "../vcs/test-utils";

const TEST_CWD = process.cwd();

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
      adapter.run({ prompt: "continue", cwd: TEST_CWD }),
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
        cwd: TEST_CWD,
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
        cwd: TEST_CWD,
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
      { stdout: "" },
      { stdout: "src/a.ts\n" },
      { stdout: "" },
      { stdout: "feature/p11-008\n" },
      { stdout: "" },
      { stdout: "https://github.com/org/repo/pull/1108\n" },
    ]);

    const capturedPrUrls: string[] = [];
    const result = await runCiIntegration({
      phaseId: PHASE.id,
      phaseName: PHASE.name,
      cwd: TEST_CWD,
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

    expect(runner.calls[4]?.command).toBe("git");
    expect(runner.calls[4]?.args).toEqual([
      "push",
      "-u",
      "origin",
      "feature/p11-008",
    ]);
    expect(runner.calls[5]?.command).toBe("gh");
    expect(runner.calls[5]?.args).toContain("pr");
    expect(runner.calls[5]?.args).toContain("create");
  });

  test("audit log writes to target project cwd even when process cwd is elsewhere", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "ixado-p11-008-project-"));
    const externalCwd = await mkdtemp(
      join(tmpdir(), "ixado-p11-008-external-"),
    );
    const originalCwd = process.cwd();
    const previousAuditPath = process.env.IXADO_AUDIT_LOG_FILE;

    const runner = new MockProcessRunner([
      { stdout: "" },
      { stdout: "src/a.ts\n" },
      { stdout: "" },
      { stdout: "feature/p11-008\n" },
      { stdout: "" },
      { stdout: "https://github.com/org/repo/pull/1108\n" },
    ]);

    try {
      delete process.env.IXADO_AUDIT_LOG_FILE;
      process.chdir(externalCwd);

      await runCiIntegration({
        phaseId: PHASE.id,
        phaseName: PHASE.name,
        cwd: projectDir,
        baseBranch: "main",
        runner,
        role: "admin",
        policy: clonePolicy(DEFAULT_AUTH_POLICY),
        setPhasePrUrl: async () => {},
      });

      const projectAuditLog = join(projectDir, ".ixado", "audit.log");
      const externalAuditLog = join(externalCwd, ".ixado", "audit.log");

      const rawLog = await readFile(projectAuditLog, "utf8");
      expect(rawLog.length).toBeGreaterThan(0);
      await expect(
        access(externalAuditLog, fsConstants.F_OK),
      ).rejects.toThrow();
    } finally {
      process.chdir(originalCwd);
      if (previousAuditPath === undefined) {
        delete process.env.IXADO_AUDIT_LOG_FILE;
      } else {
        process.env.IXADO_AUDIT_LOG_FILE = previousAuditPath;
      }
      await rm(projectDir, { recursive: true, force: true });
      await rm(externalCwd, { recursive: true, force: true });
    }
  });

  test("fail-closed startup/runtime paths deny on policy-load and role-resolution failures", async () => {
    const startupDecision = await authorizeOrchestratorAction({
      action: ORCHESTRATOR_ACTIONS.CI_INTEGRATION_RUN,
      auditCwd: TEST_CWD,
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
        cwd: TEST_CWD,
        baseBranch: "main",
        runner,
        role: null,
        policy: clonePolicy(DEFAULT_AUTH_POLICY),
        setPhasePrUrl: async () => {},
      }),
    ).rejects.toThrow("reason: role-resolution-failed");
  });

  // ---------------------------------------------------------------------------
  // Non-interactive enforcement — cross-adapter runtime tamper detection
  // ---------------------------------------------------------------------------

  describe("non-interactive enforcement — cross-adapter runtime tamper detection", () => {
    test("ClaudeAdapter — removing --print after construction causes InteractiveModeError on run()", async () => {
      const runner = new MockProcessRunner([{ stdout: "should-not-run" }]);
      const adapter = new ClaudeAdapter(runner);

      // Tamper: strip the required --print flag from baseArgs after valid construction.
      const baseArgs = (adapter as unknown as { baseArgs: string[] }).baseArgs;
      baseArgs.splice(baseArgs.indexOf("--print"), 1);

      await expect(
        adapter.run({ prompt: "do work", cwd: TEST_CWD }),
      ).rejects.toBeInstanceOf(InteractiveModeError);
      expect(runner.calls).toHaveLength(0);
    });

    test("GeminiAdapter — removing --yolo after construction causes InteractiveModeError on run()", async () => {
      const runner = new MockProcessRunner([{ stdout: "should-not-run" }]);
      const adapter = new GeminiAdapter(runner);

      // Tamper: strip the required --yolo flag from baseArgs after valid construction.
      const baseArgs = (adapter as unknown as { baseArgs: string[] }).baseArgs;
      baseArgs.splice(baseArgs.indexOf("--yolo"), 1);

      await expect(
        adapter.run({ prompt: "generate output", cwd: TEST_CWD }),
      ).rejects.toBeInstanceOf(InteractiveModeError);
      expect(runner.calls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Role gating — operator and viewer denied at orchestration level
  // ---------------------------------------------------------------------------

  describe("role gating — operator and viewer denied at CI integration orchestration level", () => {
    test("operator role is denied — denylist-match on git:privileged:*, no subprocess runs", async () => {
      const runner = new MockProcessRunner();

      await expect(
        runCiIntegration({
          phaseId: PHASE.id,
          phaseName: PHASE.name,
          cwd: TEST_CWD,
          baseBranch: "main",
          runner,
          role: "operator",
          policy: clonePolicy(DEFAULT_AUTH_POLICY),
          setPhasePrUrl: async () => {},
        }),
      ).rejects.toBeInstanceOf(OrchestrationAuthorizationDeniedError);

      expect(runner.calls).toHaveLength(0);
    });

    test("viewer role is denied — denylist blocks privileged actions, no subprocess runs", async () => {
      const runner = new MockProcessRunner();

      await expect(
        runCiIntegration({
          phaseId: PHASE.id,
          phaseName: PHASE.name,
          cwd: TEST_CWD,
          baseBranch: "main",
          runner,
          role: "viewer",
          policy: clonePolicy(DEFAULT_AUTH_POLICY),
          setPhasePrUrl: async () => {},
        }),
      ).rejects.toBeInstanceOf(OrchestrationAuthorizationDeniedError);

      expect(runner.calls).toHaveLength(0);
    });

    test("OrchestrationAuthorizationDeniedError carries correct action, role, and reason for operator", async () => {
      const err = await runCiIntegration({
        phaseId: PHASE.id,
        phaseName: PHASE.name,
        cwd: TEST_CWD,
        baseBranch: "main",
        runner: new MockProcessRunner(),
        role: "operator",
        policy: clonePolicy(DEFAULT_AUTH_POLICY),
        setPhasePrUrl: async () => {},
      }).catch((e) => e);

      expect(err).toBeInstanceOf(OrchestrationAuthorizationDeniedError);
      const denied = err as OrchestrationAuthorizationDeniedError;
      expect(denied.name).toBe("OrchestrationAuthorizationDeniedError");
      expect(denied.action).toBe(ORCHESTRATOR_ACTIONS.CI_INTEGRATION_RUN);
      expect(denied.role).toBe("operator");
      expect(denied.reason).toBe("denylist-match");
    });

    test("OrchestrationAuthorizationDeniedError message includes action and reason", async () => {
      const err = await runCiIntegration({
        phaseId: PHASE.id,
        phaseName: PHASE.name,
        cwd: TEST_CWD,
        baseBranch: "main",
        runner: new MockProcessRunner(),
        role: "viewer",
        policy: clonePolicy(DEFAULT_AUTH_POLICY),
        setPhasePrUrl: async () => {},
      }).catch((e) => e);

      expect(err).toBeInstanceOf(OrchestrationAuthorizationDeniedError);
      const denied = err as OrchestrationAuthorizationDeniedError;
      expect(denied.message).toContain(ORCHESTRATOR_ACTIONS.CI_INTEGRATION_RUN);
      expect(denied.message).toContain("denylist-match");
    });
  });

  // ---------------------------------------------------------------------------
  // Owner role — wildcard allowlist succeeds through full CI integration
  // ---------------------------------------------------------------------------

  describe("owner role — wildcard allowlist permits full CI integration flow", () => {
    test("owner succeeds: push and PR create execute, result contains prUrl", async () => {
      const runner = new MockProcessRunner([
        { stdout: "" },
        { stdout: "src/a.ts\n" },
        { stdout: "" },
        { stdout: "feature/p11-008\n" },
        { stdout: "" },
        { stdout: "https://github.com/org/repo/pull/42\n" },
      ]);

      const result = await runCiIntegration({
        phaseId: PHASE.id,
        phaseName: PHASE.name,
        cwd: TEST_CWD,
        baseBranch: "main",
        runner,
        role: "owner",
        policy: clonePolicy(DEFAULT_AUTH_POLICY),
        setPhasePrUrl: async () => {},
      });

      expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");
      expect(result.phaseId).toBe(PHASE.id);
      expect(result.baseBranch).toBe("main");
      expect(runner.calls).toHaveLength(6);
      expect(runner.calls[4]?.command).toBe("git");
      expect(runner.calls[5]?.command).toBe("gh");
    });

    test("owner setPhasePrUrl callback receives the correct prUrl", async () => {
      const runner = new MockProcessRunner([
        { stdout: "" },
        { stdout: "src/a.ts\n" },
        { stdout: "" },
        { stdout: "feature/p11-008\n" },
        { stdout: "" },
        { stdout: "https://github.com/org/repo/pull/99\n" },
      ]);

      const captured: string[] = [];
      await runCiIntegration({
        phaseId: PHASE.id,
        phaseName: PHASE.name,
        cwd: TEST_CWD,
        baseBranch: "main",
        runner,
        role: "owner",
        policy: clonePolicy(DEFAULT_AUTH_POLICY),
        setPhasePrUrl: async ({ prUrl }) => {
          captured.push(prUrl);
        },
      });

      expect(captured).toEqual(["https://github.com/org/repo/pull/99"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Fail-closed — additional denial reasons in authorizeOrchestratorAction
  // ---------------------------------------------------------------------------

  describe("fail-closed — additional denial reasons surfaced by authorizeOrchestratorAction", () => {
    test("role-resolution-failed when resolveSessionRole throws (not just returns null)", async () => {
      const decision = await authorizeOrchestratorAction({
        action: ORCHESTRATOR_ACTIONS.CI_INTEGRATION_RUN,
        auditCwd: TEST_CWD,
        settingsFilePath: "<in-memory>",
        session: { source: "cli" },
        roleConfig: {},
        loadPolicy: async () => DEFAULT_AUTH_POLICY,
        resolveSessionRole: () => {
          throw new Error("role resolver crashed");
        },
      });

      expect(decision.decision).toBe("deny");
      if (decision.decision === "deny") {
        expect(decision.reason).toBe("role-resolution-failed");
        expect(decision.message).toContain("role resolver crashed");
      }
    });

    test("evaluator-error when getRequiredActions throws during profile evaluation", async () => {
      const decision = await authorizeOrchestratorAction({
        action: ORCHESTRATOR_ACTIONS.CI_INTEGRATION_RUN,
        auditCwd: TEST_CWD,
        settingsFilePath: "<in-memory>",
        session: { source: "cli" },
        roleConfig: {},
        loadPolicy: async () => DEFAULT_AUTH_POLICY,
        resolveSessionRole: () => "admin",
        getRequiredActions: () => {
          throw new Error("profile lookup failed");
        },
      });

      expect(decision.decision).toBe("deny");
      if (decision.decision === "deny") {
        expect(decision.reason).toBe("evaluator-error");
        expect(decision.message).toContain("profile lookup failed");
      }
    });

    test("missing-action-mapping for an unregistered orchestrator action", async () => {
      const decision = await authorizeOrchestratorAction({
        // Cast an unregistered action string into the typed parameter.
        action:
          "orchestrator:unknown:action" as typeof ORCHESTRATOR_ACTIONS.CI_INTEGRATION_RUN,
        auditCwd: TEST_CWD,
        settingsFilePath: "<in-memory>",
        session: { source: "cli" },
        roleConfig: {},
        loadPolicy: async () => DEFAULT_AUTH_POLICY,
        resolveSessionRole: () => "admin",
      });

      expect(decision.decision).toBe("deny");
      if (decision.decision === "deny") {
        expect(decision.reason).toBe("missing-action-mapping");
        expect(decision.role).toBe("admin");
      }
    });

    test("policy-load-failed decision carries the original error message", async () => {
      const decision = await authorizeOrchestratorAction({
        action: ORCHESTRATOR_ACTIONS.STATUS_READ,
        auditCwd: TEST_CWD,
        settingsFilePath: "<in-memory>",
        session: { source: "cli" },
        roleConfig: {},
        loadPolicy: async () => {
          throw new Error("ENOENT: policy file not found");
        },
      });

      expect(decision.decision).toBe("deny");
      if (decision.decision === "deny") {
        expect(decision.reason).toBe("policy-load-failed");
        expect(decision.role).toBeNull();
        expect(decision.message).toContain("ENOENT");
      }
    });
  });
});
