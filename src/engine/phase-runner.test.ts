import { describe, expect, test, mock } from "bun:test";
import { PhaseRunner, type PhaseRunnerConfig } from "./phase-runner";
import { DEFAULT_AUTH_POLICY } from "../security/policy";
import { type ProcessRunner } from "../process";
import { type ControlCenterService } from "../web";
import { DirtyWorktreeError } from "../errors";

describe("PhaseRunner", () => {
  const mockConfig: PhaseRunnerConfig = {
    mode: "AUTO",
    countdownSeconds: 0,
    activeAssignee: "MOCK_CLI",
    maxRecoveryAttempts: 1,
    testerCommand: "npm",
    testerArgs: ["test"],
    testerTimeoutMs: 1000,
    ciEnabled: false,
    ciBaseBranch: "main",
    validationMaxRetries: 1,
    projectRootDir: "/tmp/project",
    projectName: "test-project",
    policy: DEFAULT_AUTH_POLICY,
    role: "admin",
  };

  test("happy path: execution flow completes", async () => {
    const phaseId = "11111111-1111-4111-8111-111111111111";
    const taskId = "22222222-2222-4222-8222-222222222222";
    const mockState = {
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

    const mockControl = {
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async () => {
        mockState.phases[0].tasks[0].status = "DONE";
        return mockState;
      }),
      createTask: mock(async () => mockState),
      recordRecoveryAttempt: mock(async () => mockState),
      runInternalWork: mock(async () => ({
        stdout: "task output",
        stderr: "",
      })),
    } as unknown as ControlCenterService;

    const mockRunner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.args.includes("status")) {
          if (input.args.includes("--porcelain")) {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return {
            exitCode: 0,
            stdout: "nothing to commit, working tree clean",
            stderr: "",
          };
        }
        if (
          input.args.includes("branch") &&
          input.args.includes("--show-current")
        ) {
          return { exitCode: 0, stdout: "feat/phase-1", stderr: "" };
        }
        if (input.args.includes("test")) {
          return { exitCode: 0, stdout: "tests passed", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const runner = new PhaseRunner(
      mockControl,
      mockConfig,
      undefined,
      undefined,
      mockRunner,
    );
    await runner.run();

    expect(mockControl.setPhaseStatus).toHaveBeenCalledWith({
      phaseId: phaseId,
      status: "BRANCHING",
    });
    expect(mockControl.startActiveTaskAndWait).toHaveBeenCalled();
    expect(mockControl.setPhaseStatus).toHaveBeenCalledWith({
      phaseId: phaseId,
      status: "DONE",
    });
  });

  test("recovery fallback: handles DirtyWorktreeError during branching", async () => {
    const phaseId = "11111111-1111-4111-8111-111111111111";
    const taskId = "22222222-2222-4222-8222-222222222222";
    const mockState = {
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

    let statusCallCount = 0;
    const mockControl = {
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async () => {
        mockState.phases[0].tasks[0].status = "DONE";
        return mockState;
      }),
      runInternalWork: mock(async () => ({
        stdout: JSON.stringify({
          status: "fixed",
          reasoning: "staged everything",
          actionsTaken: ["git add ."],
        }),
        stderr: "",
      })),
      recordRecoveryAttempt: mock(async () => mockState),
    } as unknown as ControlCenterService;

    const mockRunner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.args.includes("status")) {
          statusCallCount++;
          if (statusCallCount === 1) {
            // Simulate dirty worktree on first call
            return { exitCode: 0, stdout: "M modified.ts", stderr: "" };
          }
          // After recovery attempt, return clean
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (
          input.args.includes("branch") &&
          input.args.includes("--show-current")
        ) {
          return { exitCode: 0, stdout: "feat/phase-1", stderr: "" };
        }
        if (input.args.includes("test")) {
          return { exitCode: 0, stdout: "tests passed", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const runner = new PhaseRunner(
      mockControl,
      mockConfig,
      undefined,
      undefined,
      mockRunner,
    );
    await runner.run();

    expect(mockControl.recordRecoveryAttempt).toHaveBeenCalled();
    expect(statusCallCount).toBeGreaterThan(1);
    expect(mockControl.setPhaseStatus).toHaveBeenCalledWith({
      phaseId: phaseId,
      status: "DONE",
    });
  });

  test("P17-001: recovery loop breaks after failed postcondition re-check (no infinite retry)", async () => {
    const phaseId = "aa111111-1111-4111-8111-111111111111";
    const taskId = "bb222222-2222-4222-8222-222222222222";
    const mockState = {
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

    let porcelainCallCount = 0;
    const mockControl = {
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async () => mockState),
      createTask: mock(async () => mockState),
      recordRecoveryAttempt: mock(async () => mockState),
      // Recovery always claims "fixed" but tree remains dirty
      runInternalWork: mock(async () => ({
        stdout: JSON.stringify({
          status: "fixed",
          reasoning: "staged everything",
          actionsTaken: ["git add ."],
        }),
        stderr: "",
      })),
    } as unknown as ControlCenterService;

    const mockRunner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.args.includes("--porcelain")) {
          porcelainCallCount++;
          // Always return dirty — recovery never actually cleans it
          return {
            exitCode: 0,
            stdout: "?? src/dirty-file.ts\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const runner = new PhaseRunner(
      mockControl,
      mockConfig,
      undefined,
      undefined,
      mockRunner,
    );

    const error = await runner.run().catch((e) => e);

    // Must have thrown — cannot succeed with perpetually dirty tree
    expect(error).toBeInstanceOf(Error);

    // Phase must be set to CI_FAILED, not DONE
    const statusCalls = (mockControl.setPhaseStatus as ReturnType<typeof mock>)
      .mock.calls;
    const statuses = statusCalls.map((c: any[]) => c[0].status);
    expect(statuses).toContain("CI_FAILED");
    expect(statuses).not.toContain("DONE");

    // Recovery was invoked once (not in an infinite loop)
    expect(mockControl.recordRecoveryAttempt).toHaveBeenCalledTimes(1);

    // Postcondition re-check ran after recovery (porcelain called at least twice:
    // once for initial dirty check, once for postcondition)
    expect(porcelainCallCount).toBeGreaterThanOrEqual(2);
  });

  test('P17-002: "fixed" recovery is rejected when DIRTY_WORKTREE postcondition verifier fails', async () => {
    const phaseId = "99111111-1111-4111-8111-111111111111";
    const taskId = "99222222-2222-4222-8222-222222222222";
    const mockState = {
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
              errorCategory: undefined,
              errorLogs: undefined,
            },
          ],
        },
      ],
    };

    let porcelainCallCount = 0;
    const mockControl = {
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async () => {
        mockState.phases[0].tasks[0].status = "FAILED";
        (mockState.phases[0].tasks[0] as any).errorCategory = "DIRTY_WORKTREE";
        (mockState.phases[0].tasks[0] as any).errorLogs =
          "Git working tree is not clean.";
        return mockState;
      }),
      createTask: mock(async () => mockState),
      recordRecoveryAttempt: mock(async () => mockState),
      runInternalWork: mock(async () => ({
        stdout: JSON.stringify({
          status: "fixed",
          reasoning: "cleaned up",
          actionsTaken: ["git add ."],
        }),
        stderr: "",
      })),
    } as unknown as ControlCenterService;

    const mockRunner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.args.includes("--porcelain")) {
          porcelainCallCount += 1;
          // 1st call: prepareBranch precondition (clean)
          // 2nd call: recovery postcondition verifier (dirty -> fail)
          if (porcelainCallCount === 1) {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return {
            exitCode: 0,
            stdout: "?? src/still-dirty.ts\n",
            stderr: "",
          };
        }
        if (input.args.includes("--show-current")) {
          return { exitCode: 0, stdout: "feat/phase-1", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const runner = new PhaseRunner(
      mockControl,
      mockConfig,
      undefined,
      undefined,
      mockRunner,
    );

    const error = await runner.run().catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Recovery attempts exhausted");

    expect(mockControl.startActiveTaskAndWait).toHaveBeenCalledTimes(1);
    expect(mockControl.recordRecoveryAttempt).toHaveBeenCalledTimes(1);
    expect(mockControl.runInternalWork).toHaveBeenCalledTimes(1);
    expect(porcelainCallCount).toBeGreaterThanOrEqual(2);

    const statusCalls = (mockControl.setPhaseStatus as ReturnType<typeof mock>)
      .mock.calls;
    const statuses = statusCalls.map((c: any[]) => c[0].status);
    expect(statuses).toContain("CI_FAILED");
    expect(statuses).not.toContain("DONE");
  });

  test("clean-tree detection: untracked .ixado/ entries do not block phase run", async () => {
    const phaseId = "33333333-3333-4333-8333-333333333333";
    const taskId = "44444444-4444-4444-8444-444444444444";
    const mockState = {
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

    const mockControl = {
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async () => {
        mockState.phases[0].tasks[0].status = "DONE";
        return mockState;
      }),
      createTask: mock(async () => mockState),
      recordRecoveryAttempt: mock(async () => mockState),
      runInternalWork: mock(async () => ({
        stdout: "task output",
        stderr: "",
      })),
    } as unknown as ControlCenterService;

    // git status --porcelain returns only .ixado/ runtime artifacts
    const mockRunner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.args.includes("--porcelain")) {
          return {
            exitCode: 0,
            stdout: "?? .ixado/cli.log\n?? .ixado/state.json\n",
            stderr: "",
          };
        }
        if (input.args.includes("--show-current")) {
          return { exitCode: 0, stdout: "feat/phase-1", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const runner = new PhaseRunner(
      mockControl,
      mockConfig,
      undefined,
      undefined,
      mockRunner,
    );
    // Must complete without error — .ixado/ artifacts must not trigger DIRTY_WORKTREE
    await expect(runner.run()).resolves.toBeUndefined();

    // No recovery should have been invoked
    expect(mockControl.recordRecoveryAttempt).not.toHaveBeenCalled();
    // Phase must reach DONE
    expect(mockControl.setPhaseStatus).toHaveBeenCalledWith({
      phaseId,
      status: "DONE",
    });
  });

  test("clean-tree detection: untracked source file blocks phase run with DIRTY_WORKTREE", async () => {
    const phaseId = "55555555-5555-4555-8555-555555555555";
    const taskId = "66666666-6666-4666-8666-666666666666";
    const mockState = {
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

    const mockControl = {
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async () => mockState),
      createTask: mock(async () => mockState),
      recordRecoveryAttempt: mock(async () => mockState),
      runInternalWork: mock(async () => ({ stdout: "", stderr: "" })),
    } as unknown as ControlCenterService;

    // git status --porcelain shows an untracked real source file
    const mockRunner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.args.includes("--porcelain")) {
          return {
            exitCode: 0,
            stdout: "?? src/untracked-file.ts\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    // Disable recovery so DIRTY_WORKTREE propagates immediately
    const noRecoveryConfig: PhaseRunnerConfig = {
      ...mockConfig,
      maxRecoveryAttempts: 0,
    };

    const runner = new PhaseRunner(
      mockControl,
      noRecoveryConfig,
      undefined,
      undefined,
      mockRunner,
    );

    // Must reject — a real untracked source file must block phase run
    const error = await runner.run().catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    // Phase must have been set to CI_FAILED (not DONE)
    const statusCalls = (mockControl.setPhaseStatus as ReturnType<typeof mock>)
      .mock.calls;
    const statuses = statusCalls.map((c: any[]) => c[0].status);
    expect(statuses).toContain("CI_FAILED");
    expect(statuses).not.toContain("DONE");
  });

  test("clean-tree detection: modified tracked source file blocks phase run with DIRTY_WORKTREE", async () => {
    const phaseId = "77777777-7777-4777-8777-777777777777";
    const taskId = "88888888-8888-4888-8888-888888888888";
    const mockState = {
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

    const mockControl = {
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async () => mockState),
      createTask: mock(async () => mockState),
      recordRecoveryAttempt: mock(async () => mockState),
      runInternalWork: mock(async () => ({ stdout: "", stderr: "" })),
    } as unknown as ControlCenterService;

    // git status --porcelain shows a modified tracked source file
    const mockRunner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.args.includes("--porcelain")) {
          return {
            exitCode: 0,
            stdout: " M src/engine/phase-runner.ts\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    // Disable recovery so DIRTY_WORKTREE propagates immediately
    const noRecoveryConfig: PhaseRunnerConfig = {
      ...mockConfig,
      maxRecoveryAttempts: 0,
    };

    const runner = new PhaseRunner(
      mockControl,
      noRecoveryConfig,
      undefined,
      undefined,
      mockRunner,
    );

    // Must reject — a modified tracked source file must block phase run
    const error = await runner.run().catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    // Phase must have been set to CI_FAILED (not DONE)
    const statusCalls = (mockControl.setPhaseStatus as ReturnType<typeof mock>)
      .mock.calls;
    const statuses = statusCalls.map((c: any[]) => c[0].status);
    expect(statuses).toContain("CI_FAILED");
    expect(statuses).not.toContain("DONE");
  });
});
