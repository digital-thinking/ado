import { describe, expect, test, mock } from "bun:test";
import {
  PhaseRunner,
  pickNextTask,
  type PhaseRunnerConfig,
} from "./phase-runner";
import { DEFAULT_AUTH_POLICY } from "../security/policy";
import { type ProcessRunner } from "../process";
import { type ControlCenterService } from "../web";
import { DirtyWorktreeError, PhasePreflightError } from "../errors";

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
      reconcileInProgressTasks: mock(async () => 0),
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
      reconcileInProgressTasks: mock(async () => 0),
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
      reconcileInProgressTasks: mock(async () => 0),
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
      reconcileInProgressTasks: mock(async () => 0),
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

  test("P19-003: each task uses its own persisted assignee instead of global default", async () => {
    const phaseId = "a0000000-0000-4000-8000-000000000001";
    const task1Id = "b0000000-0000-4000-8000-000000000001";
    const task2Id = "b0000000-0000-4000-8000-000000000002";
    const task3Id = "b0000000-0000-4000-8000-000000000003";

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
              id: task1Id,
              title: "Task 1 — uses global default",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
            {
              id: task2Id,
              title: "Task 2 — has own CLAUDE_CLI assignee",
              status: "TODO",
              assignee: "CLAUDE_CLI",
              dependencies: [],
            },
            {
              id: task3Id,
              title: "Task 3 — has own GEMINI_CLI assignee",
              status: "TODO",
              assignee: "GEMINI_CLI",
              dependencies: [],
            },
          ],
        },
      ],
    };

    const capturedAssignees: string[] = [];
    const mockControl = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async (input: any) => {
        capturedAssignees.push(input.assignee);
        const taskIdx = input.taskNumber - 1;
        mockState.phases[0].tasks[taskIdx].status = "DONE";
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
        if (input.args.includes("--porcelain")) {
          return { exitCode: 0, stdout: "", stderr: "" };
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
    await runner.run();

    // Task 1 (UNASSIGNED) must fall back to global default (MOCK_CLI)
    expect(capturedAssignees[0]).toBe("MOCK_CLI");
    // Task 2 must use its own CLAUDE_CLI assignee
    expect(capturedAssignees[1]).toBe("CLAUDE_CLI");
    // Task 3 must use its own GEMINI_CLI assignee
    expect(capturedAssignees[2]).toBe("GEMINI_CLI");

    expect(mockControl.setPhaseStatus).toHaveBeenCalledWith({
      phaseId,
      status: "DONE",
    });
  });

  test("P19-003: task with UNASSIGNED assignee falls back to global default", async () => {
    const phaseId = "c0000000-0000-4000-8000-000000000001";
    const taskId = "d0000000-0000-4000-8000-000000000001";

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

    let capturedAssignee: string | undefined;
    const mockControl = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async (input: any) => {
        capturedAssignee = input.assignee;
        mockState.phases[0].tasks[0].status = "DONE";
        return mockState;
      }),
      createTask: mock(async () => mockState),
      recordRecoveryAttempt: mock(async () => mockState),
      runInternalWork: mock(async () => ({ stdout: "ok", stderr: "" })),
    } as unknown as ControlCenterService;

    const mockRunner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.args.includes("--porcelain")) {
          return { exitCode: 0, stdout: "", stderr: "" };
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
    await runner.run();

    // UNASSIGNED task must use global default (MOCK_CLI from mockConfig.activeAssignee)
    expect(capturedAssignee).toBe("MOCK_CLI");
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
      reconcileInProgressTasks: mock(async () => 0),
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
      reconcileInProgressTasks: mock(async () => 0),
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
      reconcileInProgressTasks: mock(async () => 0),
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

// ---------------------------------------------------------------------------
// P20-002: PhaseRunner reconciles IN_PROGRESS tasks on startup
// ---------------------------------------------------------------------------

describe("PhaseRunner – P20-002 startup reconciliation", () => {
  const baseConfig: PhaseRunnerConfig = {
    mode: "AUTO",
    countdownSeconds: 0,
    activeAssignee: "MOCK_CLI",
    maxRecoveryAttempts: 0,
    testerCommand: null,
    testerArgs: null,
    testerTimeoutMs: 1000,
    ciEnabled: false,
    ciBaseBranch: "main",
    validationMaxRetries: 1,
    projectRootDir: "/tmp/project",
    projectName: "test-project",
    policy: DEFAULT_AUTH_POLICY,
    role: "admin",
  };

  test("calls reconcileInProgressTasks() before the execution loop", async () => {
    const phaseId = "d0000000-0000-4000-8000-000000000001";
    const taskId = "d1000000-0000-4000-8000-000000000001";

    // Start with a task in IN_PROGRESS (simulating a prior crash)
    const mockState = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseId: phaseId,
      phases: [
        {
          id: phaseId,
          name: "Phase 1",
          branchName: "feat/phase-1",
          status: "CODING",
          tasks: [
            {
              id: taskId,
              title: "Interrupted Task",
              status: "IN_PROGRESS",
              assignee: "MOCK_CLI",
              dependencies: [],
            },
          ],
        },
      ],
    };

    let reconcileCalled = false;
    const mockControl = {
      reconcileInProgressTasks: mock(async () => {
        reconcileCalled = true;
        // Simulate reconciliation resetting the task to TODO
        mockState.phases[0].tasks[0].status = "TODO";
        return 1;
      }),
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async () => {
        mockState.phases[0].tasks[0].status = "DONE";
        return mockState;
      }),
      createTask: mock(async () => mockState),
      recordRecoveryAttempt: mock(async () => mockState),
      runInternalWork: mock(async () => ({ stdout: "ok", stderr: "" })),
    } as unknown as ControlCenterService;

    const mockRunner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.args.includes("--porcelain")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args.includes("--show-current")) {
          return { exitCode: 0, stdout: "feat/phase-1", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const runner = new PhaseRunner(
      mockControl,
      baseConfig,
      undefined,
      undefined,
      mockRunner,
    );
    await runner.run();

    // reconcileInProgressTasks must have been called before the loop starts
    expect(reconcileCalled).toBe(true);
    // The task should have been executed after reconciliation reset it to TODO
    expect(mockControl.startActiveTaskAndWait).toHaveBeenCalledTimes(1);
  });

  test("proceeds normally when reconcileInProgressTasks returns 0", async () => {
    const phaseId = "d0000000-0000-4000-8000-000000000002";
    const taskId = "d1000000-0000-4000-8000-000000000002";

    const mockState = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseId: phaseId,
      phases: [
        {
          id: phaseId,
          name: "Phase 1",
          branchName: "feat/phase-1",
          status: "CODING",
          tasks: [
            {
              id: taskId,
              title: "Normal Task",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
          ],
        },
      ],
    };

    const mockControl = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async () => {
        mockState.phases[0].tasks[0].status = "DONE";
        return mockState;
      }),
      createTask: mock(async () => mockState),
      recordRecoveryAttempt: mock(async () => mockState),
      runInternalWork: mock(async () => ({ stdout: "ok", stderr: "" })),
    } as unknown as ControlCenterService;

    const mockRunner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.args.includes("--porcelain")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args.includes("--show-current")) {
          return { exitCode: 0, stdout: "feat/phase-1", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const runner = new PhaseRunner(
      mockControl,
      baseConfig,
      undefined,
      undefined,
      mockRunner,
    );
    await runner.run();

    expect(mockControl.reconcileInProgressTasks).toHaveBeenCalledTimes(1);
    expect(mockControl.startActiveTaskAndWait).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// P20-001: pickNextTask – deterministic task-pick ordering rules
// ---------------------------------------------------------------------------

describe("pickNextTask", () => {
  test("returns -1 when the task list is empty", () => {
    expect(pickNextTask([])).toBe(-1);
  });

  test("returns -1 when all tasks are DONE or IN_PROGRESS", () => {
    const tasks = [
      { status: "DONE" },
      { status: "IN_PROGRESS" },
      { status: "DONE" },
    ];
    expect(pickNextTask(tasks)).toBe(-1);
  });

  test("selects the first TODO when only TODO tasks are present", () => {
    const tasks = [{ status: "DONE" }, { status: "TODO" }, { status: "TODO" }];
    // Earliest TODO is at index 1
    expect(pickNextTask(tasks)).toBe(1);
  });

  test("selects the first CI_FIX when only CI_FIX tasks are present", () => {
    const tasks = [
      { status: "DONE" },
      { status: "CI_FIX" },
      { status: "CI_FIX" },
    ];
    // Earliest CI_FIX is at index 1
    expect(pickNextTask(tasks)).toBe(1);
  });

  test("prioritises CI_FIX over TODO regardless of array position", () => {
    // TODO appears before CI_FIX — CI_FIX must still win
    const tasks = [
      { status: "DONE" },
      { status: "TODO" }, // index 1
      { status: "TODO" }, // index 2
      { status: "CI_FIX" }, // index 3 — lower position but higher priority
    ];
    expect(pickNextTask(tasks)).toBe(3);
  });

  test("prioritises CI_FIX even when it is the very last entry", () => {
    const tasks = [
      { status: "TODO" },
      { status: "TODO" },
      { status: "TODO" },
      { status: "CI_FIX" }, // appended at the end by tester workflow
    ];
    expect(pickNextTask(tasks)).toBe(3);
  });

  test("selects the earliest CI_FIX when multiple CI_FIX tasks exist", () => {
    const tasks = [
      { status: "TODO" },
      { status: "CI_FIX" }, // index 1 — earliest
      { status: "TODO" },
      { status: "CI_FIX" }, // index 3
    ];
    expect(pickNextTask(tasks)).toBe(1);
  });

  test("falls back to the earliest TODO after all CI_FIX tasks are DONE", () => {
    const tasks = [
      { status: "DONE" },
      { status: "DONE" }, // was CI_FIX, now DONE
      { status: "TODO" }, // index 2 — earliest remaining TODO
      { status: "TODO" },
    ];
    expect(pickNextTask(tasks)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// P20-003: phase-loop preflight consistency
// ---------------------------------------------------------------------------

describe("PhaseRunner – P20-003 preflight consistency", () => {
  const phaseId = "a1000000-0000-4000-8000-000000000001";
  const taskId = "a2000000-0000-4000-8000-000000000001";

  /** Minimal mock control used for preflight tests — git runner never reached. */
  function makeMockControl(stateOverride: object) {
    return {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => stateOverride),
      setPhaseStatus: mock(async () => stateOverride),
      startActiveTaskAndWait: mock(async () => stateOverride),
      createTask: mock(async () => stateOverride),
      recordRecoveryAttempt: mock(async () => stateOverride),
      runInternalWork: mock(async () => ({ stdout: "", stderr: "" })),
    } as unknown as ControlCenterService;
  }

  /** Process runner that records whether it was ever called. */
  function makeSpyRunner() {
    let called = false;
    const runner: ProcessRunner = {
      run: mock(async () => {
        called = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;
    return { runner, wasCalled: () => called };
  }

  const baseConfig: PhaseRunnerConfig = {
    mode: "AUTO",
    countdownSeconds: 0,
    activeAssignee: "MOCK_CLI",
    maxRecoveryAttempts: 0,
    testerCommand: null,
    testerArgs: null,
    testerTimeoutMs: 1000,
    ciEnabled: false,
    ciBaseBranch: "main",
    validationMaxRetries: 1,
    projectRootDir: "/tmp/project",
    projectName: "test-project",
    policy: DEFAULT_AUTH_POLICY,
    role: "admin",
  };

  // --- Terminal status gate ---

  test.each([
    ["DONE", "AUTO"],
    ["DONE", "MANUAL"],
    ["AWAITING_CI", "AUTO"],
    ["AWAITING_CI", "MANUAL"],
    ["READY_FOR_REVIEW", "AUTO"],
    ["READY_FOR_REVIEW", "MANUAL"],
  ] as const)(
    "phase in terminal status %s throws PhasePreflightError in %s mode",
    async (terminalStatus, mode) => {
      const state = {
        projectName: "test-project",
        rootDir: "/tmp/project",
        activePhaseId: phaseId,
        phases: [
          {
            id: phaseId,
            name: "Phase 1",
            branchName: "feat/phase-1",
            status: terminalStatus,
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

      const { runner, wasCalled } = makeSpyRunner();
      const config = { ...baseConfig, mode };
      const pr = new PhaseRunner(
        makeMockControl(state),
        config,
        undefined,
        undefined,
        runner,
      );

      const error = await pr.run().catch((e) => e);

      expect(error).toBeInstanceOf(PhasePreflightError);
      expect((error as PhasePreflightError).message).toContain(terminalStatus);
      // No git operations should have been attempted
      expect(wasCalled()).toBe(false);
    },
  );

  test("AUTO and MANUAL modes produce identical PhasePreflightError for terminal phase status", async () => {
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseId: phaseId,
      phases: [
        {
          id: phaseId,
          name: "Phase Alpha",
          branchName: "feat/alpha",
          status: "DONE",
          tasks: [],
        },
      ],
    };

    const autoRunner = new PhaseRunner(
      makeMockControl(state),
      { ...baseConfig, mode: "AUTO" },
      undefined,
      undefined,
      makeSpyRunner().runner,
    );
    const manualRunner = new PhaseRunner(
      makeMockControl(state),
      { ...baseConfig, mode: "MANUAL" },
      undefined,
      undefined,
      makeSpyRunner().runner,
    );

    const autoError = await autoRunner.run().catch((e) => e);
    const manualError = await manualRunner.run().catch((e) => e);

    // Both modes must produce the same typed error with the same message
    expect(autoError).toBeInstanceOf(PhasePreflightError);
    expect(manualError).toBeInstanceOf(PhasePreflightError);
    expect((autoError as PhasePreflightError).message).toBe(
      (manualError as PhasePreflightError).message,
    );
  });

  // --- Non-terminal statuses are allowed through preflight ---

  test.each([
    "PLANNING",
    "BRANCHING",
    "CODING",
    "CI_FAILED",
    "CREATING_PR",
  ] as const)(
    "phase in non-terminal status %s is NOT blocked by preflight",
    async (allowedStatus) => {
      const state = {
        projectName: "test-project",
        rootDir: "/tmp/project",
        activePhaseId: phaseId,
        phases: [
          {
            id: phaseId,
            name: "Phase 1",
            branchName: "feat/phase-1",
            status: allowedStatus,
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

      const mockRunner: ProcessRunner = {
        run: mock(async (input: any) => {
          if (input.args.includes("--porcelain")) {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (input.args.includes("--show-current")) {
            return { exitCode: 0, stdout: "feat/phase-1", stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
      } as any;

      const control = {
        ...makeMockControl(state),
        getState: mock(async () => state),
        startActiveTaskAndWait: mock(async () => {
          state.phases[0].tasks[0].status = "DONE";
          return state;
        }),
        setPhaseStatus: mock(async () => state),
      } as unknown as ControlCenterService;

      const pr = new PhaseRunner(
        control,
        baseConfig,
        undefined,
        undefined,
        mockRunner,
      );
      const error = await pr.run().catch((e) => e);

      // Must NOT throw PhasePreflightError for non-terminal statuses
      expect(error).not.toBeInstanceOf(PhasePreflightError);
    },
  );

  // --- Branch name validation ---

  test("empty branchName throws PhasePreflightError before any git operation", async () => {
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseId: phaseId,
      phases: [
        {
          id: phaseId,
          name: "Phase 1",
          branchName: "",
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

    const { runner, wasCalled } = makeSpyRunner();
    const pr = new PhaseRunner(
      makeMockControl(state),
      baseConfig,
      undefined,
      undefined,
      runner,
    );

    const error = await pr.run().catch((e) => e);

    expect(error).toBeInstanceOf(PhasePreflightError);
    expect((error as PhasePreflightError).message).toContain("empty");
    expect(wasCalled()).toBe(false);
  });

  test("whitespace-only branchName throws PhasePreflightError before any git operation", async () => {
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseId: phaseId,
      phases: [
        {
          id: phaseId,
          name: "Phase 1",
          branchName: "   ",
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

    const { runner, wasCalled } = makeSpyRunner();
    const pr = new PhaseRunner(
      makeMockControl(state),
      baseConfig,
      undefined,
      undefined,
      runner,
    );

    const error = await pr.run().catch((e) => e);

    expect(error).toBeInstanceOf(PhasePreflightError);
    expect(wasCalled()).toBe(false);
  });

  // --- State integrity checks ---

  test("stale activePhaseId (set but not found) throws PhasePreflightError", async () => {
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      phases: [
        {
          id: phaseId, // different ID from activePhaseId
          name: "Phase 1",
          branchName: "feat/phase-1",
          status: "PLANNING",
          tasks: [],
        },
      ],
    };

    const { runner, wasCalled } = makeSpyRunner();
    const pr = new PhaseRunner(
      makeMockControl(state),
      baseConfig,
      undefined,
      undefined,
      runner,
    );

    const error = await pr.run().catch((e) => e);

    expect(error).toBeInstanceOf(PhasePreflightError);
    expect((error as PhasePreflightError).message).toContain(
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
    );
    expect(wasCalled()).toBe(false);
  });

  test("no phases in project state throws PhasePreflightError", async () => {
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      phases: [],
    };

    const { runner, wasCalled } = makeSpyRunner();
    const pr = new PhaseRunner(
      makeMockControl(state),
      baseConfig,
      undefined,
      undefined,
      runner,
    );

    const error = await pr.run().catch((e) => e);

    expect(error).toBeInstanceOf(PhasePreflightError);
    expect((error as PhasePreflightError).message).toContain("No phases found");
    expect(wasCalled()).toBe(false);
  });

  test("activePhaseId absent → falls back to first phase (no PhasePreflightError)", async () => {
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      // activePhaseId intentionally absent
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

    const mockRunner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.args.includes("--porcelain"))
          return { exitCode: 0, stdout: "", stderr: "" };
        if (input.args.includes("--show-current"))
          return { exitCode: 0, stdout: "feat/phase-1", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const control = {
      ...makeMockControl(state),
      getState: mock(async () => state),
      startActiveTaskAndWait: mock(async () => {
        state.phases[0].tasks[0].status = "DONE";
        return state;
      }),
      setPhaseStatus: mock(async () => state),
    } as unknown as ControlCenterService;

    const pr = new PhaseRunner(
      control,
      baseConfig,
      undefined,
      undefined,
      mockRunner,
    );
    // Must not throw PhasePreflightError — fallback to first phase is valid
    await expect(pr.run()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P20-001: phase loop respects CI_FIX priority over TODO
// ---------------------------------------------------------------------------

describe("PhaseRunner – P20-001 task-pick ordering", () => {
  const baseConfig: PhaseRunnerConfig = {
    mode: "AUTO",
    countdownSeconds: 0,
    activeAssignee: "MOCK_CLI",
    maxRecoveryAttempts: 0,
    testerCommand: null,
    testerArgs: null,
    testerTimeoutMs: 1000,
    ciEnabled: false,
    ciBaseBranch: "main",
    validationMaxRetries: 1,
    projectRootDir: "/tmp/project",
    projectName: "test-project",
    policy: DEFAULT_AUTH_POLICY,
    role: "admin",
  };

  test("executes CI_FIX task before remaining TODO tasks", async () => {
    const phaseId = "e0000000-0000-4000-8000-000000000001";
    const todoTask1Id = "e1000000-0000-4000-8000-000000000001";
    const todoTask2Id = "e1000000-0000-4000-8000-000000000002";
    const ciFixTaskId = "e1000000-0000-4000-8000-000000000003";

    // Scenario: tasks are [TODO, TODO, CI_FIX].
    // Loop should pick CI_FIX (index 2) before TODO (index 0/1).
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
              id: todoTask1Id,
              title: "TODO Task 1",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
            {
              id: todoTask2Id,
              title: "TODO Task 2",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
            {
              id: ciFixTaskId,
              title: "Fix tests",
              status: "CI_FIX",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
          ],
        },
      ],
    };

    const executionOrder: number[] = [];
    const mockControl = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async (input: any) => {
        executionOrder.push(input.taskNumber);
        mockState.phases[0].tasks[input.taskNumber - 1].status = "DONE";
        return mockState;
      }),
      createTask: mock(async () => mockState),
      recordRecoveryAttempt: mock(async () => mockState),
      runInternalWork: mock(async () => ({ stdout: "ok", stderr: "" })),
    } as unknown as ControlCenterService;

    const mockRunner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.args.includes("--porcelain")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args.includes("--show-current")) {
          return { exitCode: 0, stdout: "feat/phase-1", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const runner = new PhaseRunner(
      mockControl,
      baseConfig,
      undefined,
      undefined,
      mockRunner,
    );
    await runner.run();

    // CI_FIX task is at position 3 (taskNumber 3); it must be first
    expect(executionOrder[0]).toBe(3);
    // Remaining TODO tasks run in order after
    expect(executionOrder[1]).toBe(1);
    expect(executionOrder[2]).toBe(2);
    expect(mockControl.setPhaseStatus).toHaveBeenCalledWith({
      phaseId,
      status: "DONE",
    });
  });

  test("executes TODO tasks in stable array order when no CI_FIX tasks exist", async () => {
    const phaseId = "f0000000-0000-4000-8000-000000000001";
    const task1Id = "f1000000-0000-4000-8000-000000000001";
    const task2Id = "f1000000-0000-4000-8000-000000000002";
    const task3Id = "f1000000-0000-4000-8000-000000000003";

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
              id: task1Id,
              title: "Task 1",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
            {
              id: task2Id,
              title: "Task 2",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
            {
              id: task3Id,
              title: "Task 3",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
          ],
        },
      ],
    };

    const executionOrder: number[] = [];
    const mockControl = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => mockState),
      setPhaseStatus: mock(async () => mockState),
      startActiveTaskAndWait: mock(async (input: any) => {
        executionOrder.push(input.taskNumber);
        mockState.phases[0].tasks[input.taskNumber - 1].status = "DONE";
        return mockState;
      }),
      createTask: mock(async () => mockState),
      recordRecoveryAttempt: mock(async () => mockState),
      runInternalWork: mock(async () => ({ stdout: "ok", stderr: "" })),
    } as unknown as ControlCenterService;

    const mockRunner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.args.includes("--porcelain")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args.includes("--show-current")) {
          return { exitCode: 0, stdout: "feat/phase-1", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const runner = new PhaseRunner(
      mockControl,
      baseConfig,
      undefined,
      undefined,
      mockRunner,
    );
    await runner.run();

    // Tasks must run in stable array order: 1, 2, 3
    expect(executionOrder).toEqual([1, 2, 3]);
    expect(mockControl.setPhaseStatus).toHaveBeenCalledWith({
      phaseId,
      status: "DONE",
    });
  });
});
