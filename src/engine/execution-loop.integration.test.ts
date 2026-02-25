import { describe, expect, test } from "bun:test";

import { ProcessExecutionError, type ProcessRunner } from "../process";
import type { Phase } from "../types";
import { MockProcessRunner } from "../vcs/test-utils";
import { runCiIntegration } from "./ci-integration";
import { runCiValidationLoop } from "./ci-validation-loop";
import { runTesterWorkflow } from "./tester-workflow";

const DEFAULT_PULL_REQUEST_SETTINGS = {
  defaultTemplatePath: null,
  templateMappings: [],
  labels: [],
  assignees: [],
  createAsDraft: false,
  markReadyOnApproval: false,
};

const TEST_PHASE: Phase = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Phase 5: CI Execution Loop",
  branchName: "phase-5-ci-execution-loop",
  status: "CODING",
  tasks: [],
};

describe("execution loop integration", () => {
  test("runs tester, creates PR, and completes review validation", async () => {
    const runner = new MockProcessRunner([
      { stdout: "tests passed\n" },
      { stdout: "" },
      { stdout: "src/a.ts\n" },
      { stdout: "" },
      { stdout: "phase-5-ci-execution-loop\n" },
      { stdout: "" },
      { stdout: "https://github.com/org/repo/pull/555\n" },
    ]);
    let fixTaskCalls = 0;
    const testerResult = await runTesterWorkflow({
      phaseId: TEST_PHASE.id,
      phaseName: TEST_PHASE.name,
      completedTask: {
        id: "22222222-2222-4222-8222-222222222222",
        title: "P5 Task",
      },
      cwd: "C:/repo",
      testerCommand: "npm",
      testerArgs: ["run", "test"],
      testerTimeoutMs: 60_000,
      runner,
      createFixTask: async () => {
        fixTaskCalls += 1;
      },
    });

    expect(testerResult.status).toBe("PASSED");
    expect(fixTaskCalls).toBe(0);

    const setPrCalls: Array<{ phaseId: string; prUrl: string }> = [];
    const ciResult = await runCiIntegration({
      phaseId: TEST_PHASE.id,
      phaseName: TEST_PHASE.name,
      cwd: "C:/repo",
      baseBranch: "main",
      pullRequest: DEFAULT_PULL_REQUEST_SETTINGS,
      runner,
      role: "admin",
      policy: {
        version: "1",
        roles: {
          owner: { allowlist: ["*"], denylist: [] },
          admin: { allowlist: ["*"], denylist: [] },
          operator: {
            allowlist: ["status:read"],
            denylist: ["git:privileged:*"],
          },
          viewer: {
            allowlist: ["status:read"],
            denylist: ["git:privileged:*"],
          },
        },
      },
      setPhasePrUrl: async (input) => {
        setPrCalls.push(input);
      },
    });
    expect(ciResult.prUrl).toBe("https://github.com/org/repo/pull/555");
    expect(setPrCalls).toHaveLength(1);

    const validationResult = await runCiValidationLoop({
      projectName: "IxADO",
      rootDir: "C:/repo",
      phase: TEST_PHASE,
      assignee: "CODEX_CLI",
      maxRetries: 2,
      readGitDiff: async () => "diff --git a/src/a.ts b/src/a.ts",
      runInternalWork: async () => ({
        stdout: '{"verdict":"APPROVED","comments":[]}',
        stderr: "",
      }),
    });

    expect(validationResult.status).toBe("APPROVED");
    expect(validationResult.fixAttempts).toBe(0);
  });

  test("denies CI integration in fail-closed mode when role resolution fails", async () => {
    const runner = new MockProcessRunner([
      { stdout: "phase-5-ci-execution-loop\n" },
    ]);

    await expect(
      runCiIntegration({
        phaseId: TEST_PHASE.id,
        phaseName: TEST_PHASE.name,
        cwd: "C:/repo",
        baseBranch: "main",
        pullRequest: DEFAULT_PULL_REQUEST_SETTINGS,
        runner,
        role: null,
        policy: {
          version: "1",
          roles: {
            owner: { allowlist: ["*"], denylist: [] },
            admin: { allowlist: ["*"], denylist: [] },
            operator: {
              allowlist: ["status:read"],
              denylist: ["git:privileged:*"],
            },
            viewer: {
              allowlist: ["status:read"],
              denylist: ["git:privileged:*"],
            },
          },
        },
        setPhasePrUrl: async () => {},
      }),
    ).rejects.toThrow("reason: role-resolution-failed");
  });

  test("stops at tester failure and skips CI/validation", async () => {
    const failingRunner: ProcessRunner = {
      async run() {
        throw new ProcessExecutionError("tests failed", {
          command: "npm",
          args: ["run", "test"],
          cwd: "C:/repo",
          exitCode: 1,
          signal: null,
          stdout: "failing test",
          stderr: "stack",
          durationMs: 10,
        });
      },
    };
    const ciRunner = new MockProcessRunner();
    let fixTaskCreated = false;

    const testerResult = await runTesterWorkflow({
      phaseId: TEST_PHASE.id,
      phaseName: TEST_PHASE.name,
      completedTask: {
        id: "22222222-2222-4222-8222-222222222222",
        title: "P5 Task",
      },
      cwd: "C:/repo",
      testerCommand: "npm",
      testerArgs: ["run", "test"],
      testerTimeoutMs: 60_000,
      runner: failingRunner,
      createFixTask: async () => {
        fixTaskCreated = true;
      },
    });

    expect(testerResult.status).toBe("FAILED");
    expect(fixTaskCreated).toBe(true);
    expect(ciRunner.calls).toHaveLength(0);
  });
});
