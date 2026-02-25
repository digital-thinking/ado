/**
 * P16-007: Integration tests for end-to-end exception recovery flow (DIRTY_WORKTREE trigger).
 *
 * Verifies that:
 *   1. The full stack — PhaseRunner → dirty-tree detection → attemptExceptionRecovery →
 *      runExceptionRecovery → runInternalWork — delivers a policy-compliant (no bypass flag)
 *      adapter invocation for all supported assignees.
 *   2. Retries are not exhausted because of forced bypass arguments: with a safe-mode adapter,
 *      recovery succeeds on the first attempt and never burns through maxRecoveryAttempts.
 *   3. Even when maxRecoveryAttempts is greater than 1, only 1 attempt is made when recovery
 *      succeeds (the fix is not to retry just because of bypass-flag-induced failures).
 *   4. Direct invocation of runExceptionRecovery with a real adapter (built from
 *      DEFAULT_CLI_SETTINGS) produces no bypass flag in the underlying process call.
 */

import { describe, expect, test, mock } from "bun:test";

import { DEFAULT_CLI_SETTINGS } from "../cli/settings";
import { createAdapter } from "../adapters/factory";
import {
  classifyRecoveryException,
  runExceptionRecovery,
} from "./exception-recovery";
import { PhaseRunner, type PhaseRunnerConfig } from "./phase-runner";
import { DEFAULT_AUTH_POLICY } from "../security/policy";
import { type ControlCenterService } from "../web";
import { MockProcessRunner } from "../test-utils";

const BYPASS_FLAG = "--dangerously-bypass-approvals-and-sandbox";

// ---------------------------------------------------------------------------
// Shared PhaseRunner base config
// ---------------------------------------------------------------------------

const BASE_CONFIG: PhaseRunnerConfig = {
  mode: "AUTO",
  countdownSeconds: 0,
  activeAssignee: "CODEX_CLI",
  maxRecoveryAttempts: 1,
  testerCommand: "npm",
  testerArgs: ["test"],
  testerTimeoutMs: 1000,
  ciEnabled: false,
  ciBaseBranch: "main",
  ciPullRequest: {
    defaultTemplatePath: null,
    templateMappings: [],
    labels: [],
    assignees: [],
    createAsDraft: false,
    markReadyOnApproval: false,
  },
  validationMaxRetries: 1,
  projectRootDir: "/tmp/project",
  projectName: "test-project",
  policy: DEFAULT_AUTH_POLICY,
  role: "admin",
};

// ---------------------------------------------------------------------------
// Helper: build a minimal valid ProjectState for PhaseRunner tests
// ---------------------------------------------------------------------------

function buildMockState(phaseId: string, taskId: string) {
  return {
    projectName: "test-project",
    rootDir: "/tmp/project",
    activePhaseId: phaseId,
    phases: [
      {
        id: phaseId,
        name: "Phase 1",
        branchName: "feat/phase-1",
        status: "PLANNING",
        tasks: [
          {
            id: taskId,
            title: "Task 1",
            status: "TODO",
            assignee: "UNASSIGNED",
            dependencies: [],
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helper: a git ProcessRunner that is dirty on the first porcelain call,
// then clean on every subsequent call.
// ---------------------------------------------------------------------------

function buildDirtyThenCleanRunner(dirtyOutput: string) {
  let statusCallCount = 0;
  return {
    run: mock(async (input: any) => {
      if (input.args?.includes("--porcelain")) {
        statusCallCount++;
        return {
          exitCode: 0,
          stdout: statusCallCount === 1 ? dirtyOutput : "",
          stderr: "",
        };
      }
      if (input.args?.includes("--show-current")) {
        return { exitCode: 0, stdout: "feat/phase-1", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }),
    getCallCount: () => statusCallCount,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1 – End-to-end DIRTY_WORKTREE → recovery with CODEX_CLI
// Invocation must be policy-compliant (no bypass flag)
// ---------------------------------------------------------------------------

describe("P16-007 – end-to-end DIRTY_WORKTREE recovery: invocation is policy-compliant", () => {
  test("CODEX_CLI recovery invocation has no bypass flag (full PhaseRunner stack)", async () => {
    const phaseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const taskId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const mockState = buildMockState(phaseId, taskId);

    // adapterRunner captures the actual CLI args passed during recovery
    const adapterRunner = new MockProcessRunner([
      {
        stdout: JSON.stringify({
          status: "fixed",
          reasoning: "staged and committed all changes",
          actionsTaken: ["git add .", 'git commit -m "fix: clean worktree"'],
          filesTouched: [],
        }),
        exitCode: 0,
      },
    ]);

    const mockControl = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async () => {
        mockState.phases[0].tasks[0].status = "DONE";
        return mockState;
      }),
      recordRecoveryAttempt: mock(async () => mockState),
      // Simulate the real execution path: create adapter from DEFAULT_CLI_SETTINGS
      runInternalWork: mock(async (work: any) => {
        const agentSettings =
          DEFAULT_CLI_SETTINGS.agents[
            work.assignee as keyof typeof DEFAULT_CLI_SETTINGS.agents
          ];
        const adapter = createAdapter(work.assignee, adapterRunner, {
          bypassApprovalsAndSandbox: agentSettings.bypassApprovalsAndSandbox,
        });
        const result = await adapter.run({
          prompt: work.prompt,
          cwd: "/tmp/project",
        });
        return { stdout: result.stdout, stderr: result.stderr };
      }),
    } as unknown as ControlCenterService;

    const gitRunner = buildDirtyThenCleanRunner(" M src/file.ts\n");

    const runner = new PhaseRunner(
      mockControl,
      BASE_CONFIG,
      undefined,
      undefined,
      gitRunner as any,
    );
    await runner.run();

    // Recovery adapter was invoked exactly once
    expect(adapterRunner.calls).toHaveLength(1);
    // The bypass flag must NOT appear in the invocation args
    expect(adapterRunner.calls[0]?.args).not.toContain(BYPASS_FLAG);
    // Phase reached DONE
    const statusCalls = (mockControl.setPhaseStatus as ReturnType<typeof mock>)
      .mock.calls;
    const statuses = statusCalls.map((c: any[]) => c[0].status);
    expect(statuses).toContain("DONE");
  });

  test("CLAUDE_CLI recovery invocation has no bypass flag (full PhaseRunner stack)", async () => {
    const phaseId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const taskId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const mockState = buildMockState(phaseId, taskId);

    const adapterRunner = new MockProcessRunner([
      {
        stdout: JSON.stringify({
          status: "fixed",
          reasoning: "committed cleanly",
          actionsTaken: ["git add --all", 'git commit -m "fix"'],
          filesTouched: [],
        }),
        exitCode: 0,
      },
    ]);

    const mockControl = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async () => {
        mockState.phases[0].tasks[0].status = "DONE";
        return mockState;
      }),
      recordRecoveryAttempt: mock(async () => mockState),
      runInternalWork: mock(async (work: any) => {
        const agentSettings =
          DEFAULT_CLI_SETTINGS.agents[
            work.assignee as keyof typeof DEFAULT_CLI_SETTINGS.agents
          ];
        const adapter = createAdapter(work.assignee, adapterRunner, {
          bypassApprovalsAndSandbox: agentSettings.bypassApprovalsAndSandbox,
        });
        const result = await adapter.run({
          prompt: work.prompt,
          cwd: "/tmp/project",
        });
        return { stdout: result.stdout, stderr: result.stderr };
      }),
    } as unknown as ControlCenterService;

    const config: PhaseRunnerConfig = {
      ...BASE_CONFIG,
      activeAssignee: "CLAUDE_CLI",
    };
    const gitRunner = buildDirtyThenCleanRunner("?? src/new-file.ts\n");

    const runner = new PhaseRunner(
      mockControl,
      config,
      undefined,
      undefined,
      gitRunner as any,
    );
    await runner.run();

    expect(adapterRunner.calls).toHaveLength(1);
    expect(adapterRunner.calls[0]?.args).not.toContain(BYPASS_FLAG);
  });

  test("MOCK_CLI recovery invocation has no bypass flag (full PhaseRunner stack)", async () => {
    const phaseId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const taskId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const mockState = buildMockState(phaseId, taskId);

    const adapterRunner = new MockProcessRunner([
      {
        stdout: JSON.stringify({
          status: "fixed",
          reasoning: "cleaned up",
          actionsTaken: ["git add .", 'git commit -m "fix"'],
          filesTouched: [],
        }),
        exitCode: 0,
      },
    ]);

    const mockControl = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async () => {
        mockState.phases[0].tasks[0].status = "DONE";
        return mockState;
      }),
      recordRecoveryAttempt: mock(async () => mockState),
      runInternalWork: mock(async (work: any) => {
        const agentSettings =
          DEFAULT_CLI_SETTINGS.agents[
            work.assignee as keyof typeof DEFAULT_CLI_SETTINGS.agents
          ];
        const adapter = createAdapter(work.assignee, adapterRunner, {
          bypassApprovalsAndSandbox: agentSettings.bypassApprovalsAndSandbox,
        });
        const result = await adapter.run({
          prompt: work.prompt,
          cwd: "/tmp/project",
        });
        return { stdout: result.stdout, stderr: result.stderr };
      }),
    } as unknown as ControlCenterService;

    const config: PhaseRunnerConfig = {
      ...BASE_CONFIG,
      activeAssignee: "MOCK_CLI",
    };
    const gitRunner = buildDirtyThenCleanRunner(" M src/engine/runner.ts\n");

    const runner = new PhaseRunner(
      mockControl,
      config,
      undefined,
      undefined,
      gitRunner as any,
    );
    await runner.run();

    expect(adapterRunner.calls).toHaveLength(1);
    expect(adapterRunner.calls[0]?.args).not.toContain(BYPASS_FLAG);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 – Retries are not exhausted due to bypass-arg failures
// With safe-mode adapter, recovery succeeds on attempt 1 of N
// ---------------------------------------------------------------------------

describe("P16-007 – retries not exhausted by forced bypass args", () => {
  test("with maxRecoveryAttempts=3, only 1 attempt is made when safe-mode adapter succeeds", async () => {
    const phaseId = "11111111-1111-4111-8111-111111111111";
    const taskId = "22222222-2222-4222-8222-222222222222";
    const mockState = buildMockState(phaseId, taskId);

    let runInternalWorkCallCount = 0;

    const mockControl = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async () => {
        mockState.phases[0].tasks[0].status = "DONE";
        return mockState;
      }),
      recordRecoveryAttempt: mock(async () => mockState),
      runInternalWork: mock(async (work: any) => {
        runInternalWorkCallCount++;
        // Safe-mode adapter succeeds; no bypass flag → no forced failure
        const adapterRunner = new MockProcessRunner([
          {
            stdout: JSON.stringify({
              status: "fixed",
              reasoning: "safe-mode recovery succeeded",
              actionsTaken: ["git add .", 'git commit -m "fix"'],
              filesTouched: [],
            }),
            exitCode: 0,
          },
        ]);
        const agentSettings =
          DEFAULT_CLI_SETTINGS.agents[
            work.assignee as keyof typeof DEFAULT_CLI_SETTINGS.agents
          ];
        const adapter = createAdapter(work.assignee, adapterRunner, {
          bypassApprovalsAndSandbox: agentSettings.bypassApprovalsAndSandbox,
        });
        const result = await adapter.run({
          prompt: work.prompt,
          cwd: "/tmp/project",
        });
        return { stdout: result.stdout, stderr: result.stderr };
      }),
    } as unknown as ControlCenterService;

    // Allow up to 3 recovery attempts, but safe-mode should succeed on 1st
    const config: PhaseRunnerConfig = {
      ...BASE_CONFIG,
      activeAssignee: "CODEX_CLI",
      maxRecoveryAttempts: 3,
    };

    const gitRunner = buildDirtyThenCleanRunner(" M src/app.ts\n");

    const runner = new PhaseRunner(
      mockControl,
      config,
      undefined,
      undefined,
      gitRunner as any,
    );
    await runner.run();

    // With safe-mode, recovery succeeds on attempt 1 — retries are NOT exhausted
    expect(runInternalWorkCallCount).toBe(1);
    // Phase must reach DONE (not CI_FAILED from exhausted retries)
    const statusCalls = (mockControl.setPhaseStatus as ReturnType<typeof mock>)
      .mock.calls;
    const statuses = statusCalls.map((c: any[]) => c[0].status);
    expect(statuses).toContain("DONE");
    expect(statuses).not.toContain("CI_FAILED");
  });

  test("with maxRecoveryAttempts=5, recovery completes on attempt 1 with safe-mode CODEX_CLI", async () => {
    const phaseId = "33333333-3333-4333-8333-333333333333";
    const taskId = "44444444-4444-4444-8444-444444444444";
    const mockState = buildMockState(phaseId, taskId);

    let attemptsMade = 0;
    const capturedAdapterArgs: string[][] = [];

    const mockControl = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async () => {
        mockState.phases[0].tasks[0].status = "DONE";
        return mockState;
      }),
      recordRecoveryAttempt: mock(async () => mockState),
      runInternalWork: mock(async (work: any) => {
        attemptsMade++;
        const adapterRunner = new MockProcessRunner([
          {
            stdout: JSON.stringify({
              status: "fixed",
              reasoning: "no bypass needed",
              actionsTaken: ["git add --all", 'git commit -m "cleanup"'],
              filesTouched: [],
            }),
            exitCode: 0,
          },
        ]);
        const agentSettings = DEFAULT_CLI_SETTINGS.agents.CODEX_CLI;
        const adapter = createAdapter("CODEX_CLI", adapterRunner, {
          bypassApprovalsAndSandbox: agentSettings.bypassApprovalsAndSandbox,
        });
        await adapter.run({ prompt: work.prompt, cwd: "/tmp/project" });
        if (adapterRunner.calls[0]) {
          capturedAdapterArgs.push(adapterRunner.calls[0].args ?? []);
        }
        return {
          stdout: JSON.stringify({
            status: "fixed",
            reasoning: "no bypass needed",
            actionsTaken: ["git add --all", 'git commit -m "cleanup"'],
            filesTouched: [],
          }),
          stderr: "",
        };
      }),
    } as unknown as ControlCenterService;

    const config: PhaseRunnerConfig = {
      ...BASE_CONFIG,
      activeAssignee: "CODEX_CLI",
      maxRecoveryAttempts: 5,
    };

    const gitRunner = buildDirtyThenCleanRunner("?? src/new-module.ts\n");

    const runner = new PhaseRunner(
      mockControl,
      config,
      undefined,
      undefined,
      gitRunner as any,
    );
    await runner.run();

    // Only 1 of the 5 allowed attempts was needed
    expect(attemptsMade).toBe(1);
    // The single adapter invocation had no bypass flag
    expect(capturedAdapterArgs).toHaveLength(1);
    expect(capturedAdapterArgs[0]).not.toContain(BYPASS_FLAG);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 – Direct runExceptionRecovery integration with real adapter
// factory built from DEFAULT_CLI_SETTINGS
// ---------------------------------------------------------------------------

describe("P16-007 – runExceptionRecovery + real adapter factory: no bypass flag", () => {
  test("DIRTY_WORKTREE recovery with CODEX_CLI from DEFAULT_CLI_SETTINGS emits no bypass flag", async () => {
    const exception = classifyRecoveryException({
      message: "Git working tree is not clean.",
      category: "DIRTY_WORKTREE",
      phaseId: "55555555-5555-4555-8555-555555555555",
      taskId: "66666666-6666-4666-8666-666666666666",
    });

    const adapterRunner = new MockProcessRunner([
      {
        stdout: JSON.stringify({
          status: "fixed",
          reasoning: "committed all pending changes",
          actionsTaken: ["git add .", 'git commit -m "fix: clean up worktree"'],
          filesTouched: ["src/index.ts"],
        }),
        exitCode: 0,
      },
    ]);

    const attempt = await runExceptionRecovery({
      cwd: process.cwd(),
      assignee: "CODEX_CLI",
      exception,
      attemptNumber: 1,
      role: "admin",
      policy: DEFAULT_AUTH_POLICY,
      runInternalWork: async (work) => {
        const agentSettings = DEFAULT_CLI_SETTINGS.agents.CODEX_CLI;
        const adapter = createAdapter("CODEX_CLI", adapterRunner, {
          bypassApprovalsAndSandbox: agentSettings.bypassApprovalsAndSandbox,
        });
        const result = await adapter.run({
          prompt: work.prompt,
          cwd: process.cwd(),
        });
        return { stdout: result.stdout, stderr: result.stderr };
      },
    });

    // Recovery succeeded
    expect(attempt.result.status).toBe("fixed");
    // The adapter invocation must not contain the bypass flag
    expect(adapterRunner.calls).toHaveLength(1);
    expect(adapterRunner.calls[0]?.args).not.toContain(BYPASS_FLAG);
    // The command must be the Codex CLI entrypoint
    expect(adapterRunner.calls[0]?.command).toBe("codex");
  });

  test("attempt-1 DIRTY_WORKTREE recovery prompt is a plain cleanup nudge with no bypass flag text", async () => {
    const exception = classifyRecoveryException({
      message: "Git working tree is not clean.",
      category: "DIRTY_WORKTREE",
    });

    let capturedPrompt = "";

    await runExceptionRecovery({
      cwd: process.cwd(),
      assignee: "CODEX_CLI",
      exception,
      attemptNumber: 1,
      role: "admin",
      policy: DEFAULT_AUTH_POLICY,
      runInternalWork: async (work) => {
        capturedPrompt = work.prompt;
        return {
          stdout: JSON.stringify({
            status: "fixed",
            reasoning: "done",
            actionsTaken: ["git add ."],
            filesTouched: [],
          }),
          stderr: "",
        };
      },
    });

    expect(capturedPrompt).toBe(
      "You left uncommitted changes. Please `git add` and `git commit` all your work with a descriptive message, then verify the repository is clean.",
    );
    expect(capturedPrompt).not.toContain(BYPASS_FLAG);
  });

  test("recovery with GEMINI_CLI from DEFAULT_CLI_SETTINGS emits no bypass flag", async () => {
    const exception = classifyRecoveryException({
      message: "Git working tree is not clean.",
      category: "DIRTY_WORKTREE",
    });

    const adapterRunner = new MockProcessRunner([
      {
        stdout: JSON.stringify({
          status: "fixed",
          reasoning: "gemini committed",
          actionsTaken: ["git add --all", 'git commit -m "fix"'],
          filesTouched: [],
        }),
        exitCode: 0,
      },
    ]);

    await runExceptionRecovery({
      cwd: process.cwd(),
      assignee: "GEMINI_CLI",
      exception,
      attemptNumber: 1,
      role: "admin",
      policy: DEFAULT_AUTH_POLICY,
      runInternalWork: async (work) => {
        const agentSettings = DEFAULT_CLI_SETTINGS.agents.GEMINI_CLI;
        const adapter = createAdapter("GEMINI_CLI", adapterRunner, {
          bypassApprovalsAndSandbox: agentSettings.bypassApprovalsAndSandbox,
        });
        const result = await adapter.run({
          prompt: work.prompt,
          cwd: process.cwd(),
        });
        return { stdout: result.stdout, stderr: result.stderr };
      },
    });

    expect(adapterRunner.calls).toHaveLength(1);
    expect(adapterRunner.calls[0]?.args).not.toContain(BYPASS_FLAG);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 – Recovery flow preserves maxRecoveryAttempts contract
// (does not re-invoke on success; invocation count equals 1 not N)
// ---------------------------------------------------------------------------

describe("P16-007 – recovery attempt count matches policy (1-of-N, not all-N)", () => {
  test("recordRecoveryAttempt is called exactly once when first attempt succeeds", async () => {
    const phaseId = "77777777-7777-4777-8777-777777777777";
    const taskId = "88888888-8888-4888-8888-888888888888";
    const mockState = buildMockState(phaseId, taskId);

    const mockControl = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async () => {
        mockState.phases[0].tasks[0].status = "DONE";
        return mockState;
      }),
      recordRecoveryAttempt: mock(async () => mockState),
      runInternalWork: mock(async (_work: any) => ({
        stdout: JSON.stringify({
          status: "fixed",
          reasoning: "ok",
          actionsTaken: ["git add ."],
          filesTouched: [],
        }),
        stderr: "",
      })),
    } as unknown as ControlCenterService;

    const config: PhaseRunnerConfig = {
      ...BASE_CONFIG,
      maxRecoveryAttempts: 5,
    };

    const gitRunner = buildDirtyThenCleanRunner(" M src/main.ts\n");

    const runner = new PhaseRunner(
      mockControl,
      config,
      undefined,
      undefined,
      gitRunner as any,
    );
    await runner.run();

    // recordRecoveryAttempt is called once — the recovery loop stops after success
    expect(mockControl.recordRecoveryAttempt).toHaveBeenCalledTimes(1);
    // Phase must be DONE (not CI_FAILED)
    const statusCalls = (mockControl.setPhaseStatus as ReturnType<typeof mock>)
      .mock.calls;
    const statuses = statusCalls.map((c: any[]) => c[0].status);
    expect(statuses).toContain("DONE");
    expect(statuses).not.toContain("CI_FAILED");
  });
});
