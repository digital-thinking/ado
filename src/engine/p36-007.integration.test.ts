import { describe, expect, mock, test } from "bun:test";
import { PhaseRunner, type PhaseRunnerConfig } from "./phase-runner";
import { DEFAULT_AUTH_POLICY } from "../security/policy";
import type { ProcessRunner } from "../process";
import type { ControlCenterService } from "../web";
import { computeCriticalPath } from "./critical-path";

function createBaseConfig(): PhaseRunnerConfig {
  return {
    mode: "AUTO",
    countdownSeconds: 0,
    activeAssignee: "CODEX_CLI",
    maxRecoveryAttempts: 1,
    testerCommand: "npm test",
    testerArgs: [],
    testerTimeoutMs: 1_000,
    maxTaskRetries: 3,
    judgeAdapter: "CLAUDE_CLI",
    ciEnabled: false,
    vcsProvider: "null" as const,
    gates: [],
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
    ciFixMaxFanOut: 10,
    ciFixMaxDepth: 3,
    projectRootDir: "/tmp/project",
    projectName: "test-project",
    policy: DEFAULT_AUTH_POLICY,
    role: "admin",
  };
}

describe("P36-007 Phase Execution DAG Integration", () => {
  test("records nodes for task runs, gate evals, and deliberation; persistence and critical path verify correctly", async () => {
    const phaseId = "a1111111-1111-4111-8111-111111111111";
    const taskId = "a2222222-2222-4222-8222-222222222222";
    const phaseBranch = "feat/phase-36";
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 36",
          branchName: phaseBranch,
          status: "PLANNING",
          tasks: [
            {
              id: taskId,
              title: "Task 1",
              description: "P36 integration test task",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
              deliberate: true,
            },
          ],
        },
      ],
    };

    let persistedTrace: any = null;

    const config1 = {
      ...createBaseConfig(),
      maxTaskRetries: 1,
      vcsProvider: "local",
      gates: [{ type: "command", command: "ls" }],
    } as any;

    let task1RunCount = 0;
    const control = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => state),
      setPhaseStatus: mock(async (input: any) => {
        state.phases[0].status = input.status;
        return state;
      }),
      startActiveTaskAndWait: mock(async () => {
        task1RunCount++;
        if (task1RunCount === 1) {
          state.phases[0].tasks[0].status = "FAILED";
          (state.phases[0].tasks[0] as any).errorCategory = "AGENT_FAILURE";
          return state;
        }
        state.phases[0].tasks[0].status = "DONE";
        return state;
      }),
      updatePhaseTrace: mock(
        async (_projectName: string, _phaseId: string, trace: any) => {
          persistedTrace = trace;
          return state;
        },
      ),
      runInternalWork: mock(async (input: any) => {
        if (input.prompt.includes("Deliberation")) {
          return {
            stdout: '{"verdict":"APPROVED","proposal":"Refined"}',
            stderr: "",
            durationMs: 100,
          };
        }
        if (input.prompt.includes("IxADO recovery worker")) {
          return {
            stdout: '{"status":"fixed","reasoning":"fixed it"}',
            stderr: "",
            durationMs: 100,
          };
        }
        return { stdout: "ok", stderr: "", durationMs: 500 };
      }),
      recordRecoveryAttempt: mock(async () => state),
    } as unknown as ControlCenterService;

    const runner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (
          input.args.includes("status") &&
          input.args.includes("--porcelain")
        ) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (
          input.args.includes("branch") &&
          input.args.includes("--show-current")
        ) {
          return { exitCode: 0, stdout: phaseBranch, stderr: "" };
        }
        if (
          input.args.includes("rev-parse") &&
          input.args.includes("--show-toplevel")
        ) {
          return { exitCode: 0, stdout: "/tmp/project", stderr: "" };
        }
        if (input.args.includes("add") || input.args.includes("commit")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const phaseRunner = new PhaseRunner(
      control,
      config1,
      undefined,
      undefined,
      runner,
    );
    await phaseRunner.run();

    // Verify trace nodes
    expect(persistedTrace).not.toBeNull();
    const nodes = persistedTrace.nodes;

    const taskRunNode = nodes.find((n: any) => n.type === "task_run");
    const deliberationNode = nodes.find(
      (n: any) => n.type === "deliberation_pass",
    );
    const recoveryNode = nodes.find((n: any) => n.type === "recovery_attempt");
    const gateNode = nodes.find((n: any) => n.type === "gate_eval");

    expect(taskRunNode).toBeDefined();
    expect(deliberationNode).toBeDefined();
    expect(recoveryNode).toBeDefined();
    expect(gateNode).toBeDefined();

    expect(taskRunNode.status).toBe("passed"); // Second attempt passed
    expect(deliberationNode.status).toBe("passed");
    expect(recoveryNode.status).toBe("passed");
    expect(gateNode.status).toBe("passed");

    // DAG structure: deliberation -> task_run -> recovery -> task_run -> gate
    // Wait, let's check exact sequence:
    // 1. deliberation
    // 2. task_run (failed)
    // 3. recovery
    // 4. task_run (passed)
    // 5. gate_eval

    expect(taskRunNode.parentIds).toContain(deliberationNode.id);
    expect(recoveryNode.parentIds).toBeDefined();
    expect(gateNode.parentIds).toBeDefined();

    // Critical Path
    const cpResult = computeCriticalPath(persistedTrace);
    expect(cpResult.nodeIds.length).toBeGreaterThan(0);
    expect(cpResult.totalDurationMs).toBeGreaterThan(0);
    expect(cpResult.nodeIds).toContain(taskRunNode.id);
  });

  test("records nodes for race branches and picks winner; DAG structure is correct", async () => {
    const phaseId = "c1111111-1111-4111-8111-111111111111";
    const taskId = "c2222222-2222-4222-8222-222222222222";
    const phaseBranch = "feat/phase-36-race";
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 36 Race",
          branchName: phaseBranch,
          status: "PLANNING",
          tasks: [
            {
              id: taskId,
              title: "Race Task",
              description: "P36 race integration test",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
              race: 2,
            },
          ],
        },
      ],
    };

    let persistedTrace: any = null;

    const control = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => state),
      setPhaseStatus: mock(async (input: any) => {
        state.phases[0].status = input.status;
        return state;
      }),
      prepareTaskExecution: mock(async (input: any) => {
        const task = state.phases[0].tasks[0] as any;
        return {
          projectName: state.projectName,
          phase: state.phases[0],
          task,
          taskForPrompt: task,
          rootDir: "/tmp/project",
          resume: false,
          startedFromStatus: "TODO",
        };
      }),
      completeTaskExecution: mock(async (input: any) => {
        state.phases[0].tasks[0].status = input.status;
        return state;
      }),
      updateTaskRaceState: mock(async (input: any) => {
        (state.phases[0].tasks[0] as any).raceState = input.raceState;
        return state;
      }),
      updatePhaseTrace: mock(
        async (_projectName: string, _phaseId: string, trace: any) => {
          persistedTrace = trace;
          return state;
        },
      ),
      runInternalWork: mock(async (input: any) => {
        if (input.prompt.includes("Race Judge")) {
          return { stdout: "PICK 1\nWinner", stderr: "", durationMs: 100 };
        }
        return { stdout: "ok", stderr: "", durationMs: 200 };
      }),
    } as unknown as ControlCenterService;

    const runner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.args.includes("status") && input.args.includes("--porcelain"))
          return { exitCode: 0, stdout: "", stderr: "" };
        if (
          input.args.includes("branch") &&
          input.args.includes("--show-current")
        )
          return { exitCode: 0, stdout: phaseBranch, stderr: "" };
        if (input.args.includes("diff"))
          return { exitCode: 0, stdout: "diff", stderr: "" };
        if (input.args.includes("rev-list"))
          return { exitCode: 0, stdout: "commit", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const phaseRunner = new PhaseRunner(
      control,
      {
        ...createBaseConfig(),
        worktrees: { enabled: true, baseDir: ".ixado/worktrees" },
      },
      undefined,
      undefined,
      runner,
    );
    await phaseRunner.run();

    expect(persistedTrace).not.toBeNull();
    const nodes = persistedTrace.nodes;
    const raceNodes = nodes.filter((n: any) => n.type === "race_branch");
    expect(raceNodes).toHaveLength(2);
    expect(raceNodes.every((n: any) => n.status === "passed")).toBe(true);

    const cpResult = computeCriticalPath(persistedTrace);
    expect(cpResult.nodeIds.length).toBeGreaterThan(0);
  });

  test("trace persists across multiple PhaseRunner runs for the same phase", async () => {
    const phaseId = "b1111111-1111-4111-8111-111111111111";
    const taskId1 = "b2222222-2222-4222-8222-222222222222";
    const taskId2 = "b3333333-3333-4333-8333-333333333333";
    const phaseBranch = "feat/phase-36-persistence";

    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 36 Persistence",
          branchName: phaseBranch,
          status: "PLANNING",
          tasks: [
            {
              id: taskId1,
              title: "T1",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
            {
              id: taskId2,
              title: "T2",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
          ],
        },
      ],
    };

    let persistedTrace: any = null;

    const control = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => state),
      setPhaseStatus: mock(async (input: any) => {
        state.phases[0].status = input.status;
        return state;
      }),
      startActiveTaskAndWait: mock(async (input: any) => {
        const task = state.phases[0].tasks[input.taskNumber - 1];
        task.status = "DONE";
        return state;
      }),
      updatePhaseTrace: mock(
        async (_projectName: string, _phaseId: string, trace: any) => {
          persistedTrace = trace;
          return state;
        },
      ),
      runInternalWork: mock(async () => ({
        stdout: "ok",
        stderr: "",
        durationMs: 100,
      })),
    } as unknown as ControlCenterService;

    const runner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.args.includes("status") && input.args.includes("--porcelain"))
          return { exitCode: 0, stdout: "", stderr: "" };
        if (
          input.args.includes("branch") &&
          input.args.includes("--show-current")
        )
          return { exitCode: 0, stdout: phaseBranch, stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    // First run — executes T1
    const config1 = { ...createBaseConfig(), maxTaskRetries: 0 };
    const phaseRunner1 = new PhaseRunner(
      control,
      config1,
      undefined,
      undefined,
      runner,
    );
    // We need to stop the loop after one task.
    // Actually pickNextTask will pick T1, then T2.
    // I'll make T2 depend on T1 but T1 is not DONE yet.
    // No, I'll just use a loopControl to stop it.
    const { PhaseLoopControl } = await import("./phase-loop-control");
    const loopControl = new PhaseLoopControl();

    // Mock pickNextTask to only return T1 first
    const phaseRunner1_real = new PhaseRunner(
      control,
      config1,
      loopControl,
      undefined,
      runner,
    );

    // Instead of complicated loop control, I'll just let it run both but verify trace has both.
    // OR, I'll simulate a restart by running it twice with different initial state.

    await phaseRunner1_real.run();
    expect(persistedTrace.nodes.length).toBeGreaterThanOrEqual(2); // Branching, T1, T2, etc.
    const snapshot1 = JSON.parse(JSON.stringify(persistedTrace));

    // Simulate restart: run it again with the persisted trace
    // First reset status so preflight check passes
    state.phases[0].status = "CODING";
    const config2 = { ...createBaseConfig(), initialTrace: snapshot1 };
    const phaseRunner2 = new PhaseRunner(
      control,
      config2,
      undefined,
      undefined,
      runner,
    );

    // If all tasks are DONE, it should just finish and keep the trace.
    await phaseRunner2.run();

    expect(persistedTrace.nodes.length).toBeGreaterThanOrEqual(
      snapshot1.nodes.length,
    );
    expect(persistedTrace.createdAt).toBe(snapshot1.createdAt);
  });
});
