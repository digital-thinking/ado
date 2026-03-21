import { describe, expect, mock, test } from "bun:test";

import { PhaseRunner, type PhaseRunnerConfig } from "./phase-runner";
import { DEFAULT_AUTH_POLICY } from "../security/policy";
import type { ProcessRunner } from "../process";
import type { RuntimeEvent } from "../types/runtime-events";
import type { ControlCenterService } from "../web";

function createBaseConfig(): PhaseRunnerConfig {
  return {
    mode: "AUTO",
    countdownSeconds: 0,
    activeAssignee: "CODEX_CLI",
    maxRecoveryAttempts: 1,
    testerCommand: null,
    testerArgs: null,
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

describe("P35-004 integration coverage", () => {
  test("fans out raced task execution, judges a winner, applies it, and prunes race worktrees", async () => {
    const phaseId = "a1111111-1111-4111-8111-111111111111";
    const taskId = "a2222222-2222-4222-8222-222222222222";
    const phaseBranch = "phase-35-race-mode";
    const phaseWorktreePath = `/tmp/project/.ixado/worktrees/${phaseId}`;
    const raceBranch1 = `${phaseBranch}-race-${taskId}-1`;
    const raceBranch2 = `${phaseBranch}-race-${taskId}-2`;
    const racePath1 = `/tmp/project/.ixado/worktrees/${phaseId}--race-${taskId}-1`;
    const racePath2 = `/tmp/project/.ixado/worktrees/${phaseId}--race-${taskId}-2`;
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 35 Race Mode",
          branchName: phaseBranch,
          status: "PLANNING",
          worktreePath: null as string | null,
          tasks: [
            {
              id: taskId,
              title: "P35-004 wire race orchestration",
              description:
                "Run the same task in parallel branches and pick a winner.",
              race: 2,
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
              resultContext: undefined as string | undefined,
            },
          ],
        },
      ],
    };

    const control = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => state),
      setPhaseStatus: mock(async (input: any) => {
        const phase = state.phases[0] as any;
        phase.status = input.status;
        if (input.worktreePath !== undefined) {
          phase.worktreePath = input.worktreePath;
        }
        return state;
      }),
      startActiveTaskAndWait: mock(async () => state),
      prepareTaskExecution: mock(async (input: any) => {
        const phase = state.phases[0] as any;
        const task = phase.tasks[0] as any;
        const startedFromStatus = task.status;
        task.status = "IN_PROGRESS";
        task.assignee = input.assignee;
        task.resolvedAssignee = input.resolvedAssignee;
        task.routingReason = input.routingReason;
        task.resultContext = undefined;
        task.errorLogs = undefined;
        const taskForPrompt = input.taskDescriptionOverride
          ? { ...task, description: input.taskDescriptionOverride }
          : { ...task };
        return {
          projectName: state.projectName,
          phase: { ...phase },
          task: { ...task },
          taskForPrompt,
          rootDir: input.cwd ?? phase.worktreePath ?? state.rootDir,
          resume: Boolean(input.resume),
          startedFromStatus,
        };
      }),
      completeTaskExecution: mock(async (input: any) => {
        const task = state.phases[0].tasks[0] as any;
        task.status = input.status;
        task.resultContext = input.resultContext;
        task.errorLogs = input.errorLogs;
        return state;
      }),
      updateTaskRaceState: mock(async (input: any) => {
        const task = state.phases[0].tasks[0] as any;
        task.raceState = input.raceState;
        return state;
      }),
      createTask: mock(async () => state),
      recordRecoveryAttempt: mock(async () => state),
      runInternalWork: mock(async (input: any) => {
        if (input.prompt.startsWith("Race Judge")) {
          return {
            stdout: "PICK 2\nCandidate 2 is the most coherent implementation.",
            stderr: "",
          };
        }
        if (input.cwd === racePath1) {
          return {
            stdout: "branch 1 output",
            stderr: "",
          };
        }
        if (input.cwd === racePath2) {
          return {
            stdout: "branch 2 output",
            stderr: "",
          };
        }
        return {
          stdout: "",
          stderr: "",
        };
      }),
    } as unknown as ControlCenterService;

    const runtimeEvents: RuntimeEvent[] = [];

    const runner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.command !== "git") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "rev-parse") {
          throw new Error("missing local branch");
        }
        if (input.args[0] === "status" && input.args.includes("--porcelain")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (
          input.args[0] === "branch" &&
          input.args.includes("--show-current")
        ) {
          if (input.cwd === "/tmp/project") {
            return { exitCode: 0, stdout: "main\n", stderr: "" };
          }
          if (input.cwd === phaseWorktreePath) {
            return { exitCode: 0, stdout: `${phaseBranch}\n`, stderr: "" };
          }
          if (input.cwd === racePath1) {
            return { exitCode: 0, stdout: `${raceBranch1}\n`, stderr: "" };
          }
          if (input.cwd === racePath2) {
            return { exitCode: 0, stdout: `${raceBranch2}\n`, stderr: "" };
          }
        }
        if (input.args[0] === "fetch" || input.args[0] === "pull") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "worktree" && input.args[1] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "worktree" && input.args[1] === "remove") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "diff" && input.args[1] === "--no-color") {
          if (input.args[4] === phaseBranch && input.cwd === racePath1) {
            return {
              exitCode: 0,
              stdout: "diff --git a/src/branch-1.ts b/src/branch-1.ts",
              stderr: "",
            };
          }
          if (input.args[4] === phaseBranch && input.cwd === racePath2) {
            return {
              exitCode: 0,
              stdout: "diff --git a/src/branch-2.ts b/src/branch-2.ts",
              stderr: "",
            };
          }
        }
        if (input.args[0] === "rev-list" && input.args[1] === "--reverse") {
          if (input.args[2] === `${phaseBranch}..${raceBranch2}`) {
            return {
              exitCode: 0,
              stdout: "commit-2a\ncommit-2b\n",
              stderr: "",
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "apply") {
          expect((state.phases[0].tasks[0] as any).raceState).toMatchObject({
            status: "judged",
            pickedBranchIndex: 2,
            judgeAdapter: "CLAUDE_CLI",
            reasoning: "Candidate 2 is the most coherent implementation.",
          });
          expect(input.stdin).toContain(
            "diff --git a/src/branch-2.ts b/src/branch-2.ts",
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const phaseRunner = new PhaseRunner(
      control,
      {
        ...createBaseConfig(),
        worktrees: {
          enabled: true,
          baseDir: ".ixado/worktrees",
        },
      },
      undefined,
      async (event) => {
        runtimeEvents.push(event);
      },
      runner,
    );

    await phaseRunner.run();

    expect(control.startActiveTaskAndWait).not.toHaveBeenCalled();
    expect(control.prepareTaskExecution).toHaveBeenCalledTimes(1);
    expect(control.completeTaskExecution).toHaveBeenCalledTimes(1);
    expect(control.updateTaskRaceState).toHaveBeenCalled();
    expect(state.phases[0]?.tasks[0]?.status).toBe("DONE");
    expect(state.phases[0]?.tasks[0]?.resultContext).toContain(
      `Race mode selected candidate 2 (${raceBranch2}).`,
    );
    expect(state.phases[0]?.tasks[0]?.resultContext).toContain(
      "Candidate 2 is the most coherent implementation.",
    );
    expect((state.phases[0]?.tasks[0] as any)?.raceState).toMatchObject({
      status: "applied",
      pickedBranchIndex: 2,
      commitCount: 2,
      judgeAdapter: "CLAUDE_CLI",
      reasoning: "Candidate 2 is the most coherent implementation.",
    });

    const internalCalls = (
      control.runInternalWork as ReturnType<typeof mock>
    ).mock.calls.map((entry: any[]) => entry[0]);
    expect(
      internalCalls.filter((call: any) => call.cwd === racePath1),
    ).toHaveLength(1);
    expect(
      internalCalls.filter((call: any) => call.cwd === racePath2),
    ).toHaveLength(1);
    expect(
      internalCalls.some((call: any) => call.prompt.startsWith("Race Judge")),
    ).toBe(true);

    const gitCalls = (runner.run as ReturnType<typeof mock>).mock.calls.map(
      (entry: any[]) => entry[0],
    );
    expect(
      gitCalls.some(
        (call: any) =>
          call.command === "git" &&
          call.args[0] === "apply" &&
          call.args.slice(1).join(",") === "--index,--binary,-" &&
          call.cwd === phaseWorktreePath,
      ),
    ).toBe(true);
    expect(
      gitCalls.filter(
        (call: any) =>
          call.command === "git" &&
          call.args[0] === "worktree" &&
          call.args[1] === "remove" &&
          (call.args[3] === racePath1 ||
            call.args[3] === racePath2 ||
            call.args[3] === phaseWorktreePath),
      ),
    ).toHaveLength(3);

    const raceStartIndex = runtimeEvents.findIndex(
      (event) => event.type === "race:start",
    );
    const raceJudgeIndex = runtimeEvents.findIndex(
      (event) => event.type === "race:judge",
    );
    const racePickIndex = runtimeEvents.findIndex(
      (event) => event.type === "race:pick",
    );
    const raceBranchEvents = runtimeEvents.filter(
      (event) => event.type === "race:branch",
    );

    expect(raceStartIndex).toBeGreaterThanOrEqual(0);
    expect(raceJudgeIndex).toBeGreaterThan(raceStartIndex);
    expect(racePickIndex).toBeGreaterThan(raceJudgeIndex);
    expect(raceBranchEvents).toHaveLength(2);
    expect(
      raceBranchEvents.every(
        (event) =>
          event.type === "race:branch" && event.payload.status === "fulfilled",
      ),
    ).toBe(true);
    expect(
      raceBranchEvents.some(
        (event) =>
          event.type === "race:branch" &&
          event.payload.branchName === raceBranch1,
      ),
    ).toBe(true);
    expect(
      raceBranchEvents.some(
        (event) =>
          event.type === "race:branch" &&
          event.payload.branchName === raceBranch2,
      ),
    ).toBe(true);

    const judgeEvent = runtimeEvents[raceJudgeIndex];
    expect(judgeEvent?.type).toBe("race:judge");
    if (judgeEvent?.type === "race:judge") {
      expect(judgeEvent.payload.judgeAdapter).toBe("CLAUDE_CLI");
      expect(judgeEvent.payload.pickedBranchIndex).toBe(2);
      expect(judgeEvent.payload.reasoning).toBe(
        "Candidate 2 is the most coherent implementation.",
      );
    }

    const pickEvent = runtimeEvents[racePickIndex];
    expect(pickEvent?.type).toBe("race:pick");
    if (pickEvent?.type === "race:pick") {
      expect(pickEvent.payload.branchIndex).toBe(2);
      expect(pickEvent.payload.branchName).toBe(raceBranch2);
      expect(pickEvent.payload.commitCount).toBe(2);
    }
  });

  test("falls back to the single-run path when race is 1", async () => {
    const phaseId = "b1111111-1111-4111-8111-111111111111";
    const taskId = "b2222222-2222-4222-8222-222222222222";
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 35 Single Run Fallback",
          branchName: "phase-35-single-run",
          status: "PLANNING",
          tasks: [
            {
              id: taskId,
              title: "P35-004 fallback",
              description: "Use the normal execution path when race is 1.",
              race: 1,
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
          ],
        },
      ],
    };

    const control = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => state),
      setPhaseStatus: mock(async (input: any) => {
        state.phases[0].status = input.status;
        return state;
      }),
      startActiveTaskAndWait: mock(async () => {
        const task = state.phases[0].tasks[0] as any;
        task.status = "DONE";
        task.resultContext = "single-run result";
        return state;
      }),
      prepareTaskExecution: mock(async () => state),
      completeTaskExecution: mock(async () => state),
      createTask: mock(async () => state),
      recordRecoveryAttempt: mock(async () => state),
      runInternalWork: mock(async () => ({ stdout: "", stderr: "" })),
    } as unknown as ControlCenterService;

    const runner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.command === "git" && input.args.includes("--porcelain")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (
          input.command === "git" &&
          input.args.includes("branch") &&
          input.args.includes("--show-current")
        ) {
          return {
            exitCode: 0,
            stdout: "phase-35-single-run\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const phaseRunner = new PhaseRunner(
      control,
      createBaseConfig(),
      undefined,
      undefined,
      runner,
    );

    await phaseRunner.run();

    expect(control.startActiveTaskAndWait).toHaveBeenCalledTimes(1);
    expect(control.prepareTaskExecution).not.toHaveBeenCalled();
    expect(control.completeTaskExecution).not.toHaveBeenCalled();
    expect(state.phases[0]?.tasks[0]?.status).toBe("DONE");
  });

  test("merges the winning branch, records rejected losers, and prunes all race worktrees", async () => {
    const phaseId = "c1111111-1111-4111-8111-111111111111";
    const taskId = "c2222222-2222-4222-8222-222222222222";
    const phaseBranch = "phase-35-race-mode";
    const phaseWorktreePath = `/tmp/project/.ixado/worktrees/${phaseId}`;
    const raceBranch1 = `${phaseBranch}-race-${taskId}-1`;
    const raceBranch2 = `${phaseBranch}-race-${taskId}-2`;
    const racePath1 = `/tmp/project/.ixado/worktrees/${phaseId}--race-${taskId}-1`;
    const racePath2 = `/tmp/project/.ixado/worktrees/${phaseId}--race-${taskId}-2`;
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 35 Race Mode Rejected Loser",
          branchName: phaseBranch,
          status: "PLANNING",
          worktreePath: null as string | null,
          tasks: [
            {
              id: taskId,
              title: "P35-007 rejected loser coverage",
              description:
                "Pick the successful race branch and prune the failed loser.",
              race: 2,
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
              resultContext: undefined as string | undefined,
            },
          ],
        },
      ],
    };

    const control = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => state),
      setPhaseStatus: mock(async (input: any) => {
        const phase = state.phases[0] as any;
        phase.status = input.status;
        if (input.worktreePath !== undefined) {
          phase.worktreePath = input.worktreePath;
        }
        return state;
      }),
      startActiveTaskAndWait: mock(async () => state),
      prepareTaskExecution: mock(async (input: any) => {
        const phase = state.phases[0] as any;
        const task = phase.tasks[0] as any;
        const startedFromStatus = task.status;
        task.status = "IN_PROGRESS";
        task.assignee = input.assignee;
        task.resolvedAssignee = input.resolvedAssignee;
        task.routingReason = input.routingReason;
        task.resultContext = undefined;
        task.errorLogs = undefined;
        const taskForPrompt = input.taskDescriptionOverride
          ? { ...task, description: input.taskDescriptionOverride }
          : { ...task };
        return {
          projectName: state.projectName,
          phase: { ...phase },
          task: { ...task },
          taskForPrompt,
          rootDir: input.cwd ?? phase.worktreePath ?? state.rootDir,
          resume: Boolean(input.resume),
          startedFromStatus,
        };
      }),
      completeTaskExecution: mock(async (input: any) => {
        const task = state.phases[0].tasks[0] as any;
        task.status = input.status;
        task.resultContext = input.resultContext;
        task.errorLogs = input.errorLogs;
        return state;
      }),
      updateTaskRaceState: mock(async (input: any) => {
        const task = state.phases[0].tasks[0] as any;
        task.raceState = input.raceState;
        return state;
      }),
      createTask: mock(async () => state),
      recordRecoveryAttempt: mock(async () => state),
      runInternalWork: mock(async (input: any) => {
        if (input.prompt.startsWith("Race Judge")) {
          return {
            stdout:
              "PICK 2\nReasoning: Candidate 2 succeeded while candidate 1 failed.",
            stderr: "",
          };
        }
        if (input.cwd === racePath1) {
          throw new Error("branch 1 execution failed");
        }
        if (input.cwd === racePath2) {
          return {
            stdout: "branch 2 output",
            stderr: "",
          };
        }
        return {
          stdout: "",
          stderr: "",
        };
      }),
    } as unknown as ControlCenterService;

    const runtimeEvents: RuntimeEvent[] = [];

    const runner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.command !== "git") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "rev-parse") {
          throw new Error("missing local branch");
        }
        if (input.args[0] === "status" && input.args.includes("--porcelain")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (
          input.args[0] === "branch" &&
          input.args.includes("--show-current")
        ) {
          if (input.cwd === "/tmp/project") {
            return { exitCode: 0, stdout: "main\n", stderr: "" };
          }
          if (input.cwd === phaseWorktreePath) {
            return { exitCode: 0, stdout: `${phaseBranch}\n`, stderr: "" };
          }
          if (input.cwd === racePath1) {
            return { exitCode: 0, stdout: `${raceBranch1}\n`, stderr: "" };
          }
          if (input.cwd === racePath2) {
            return { exitCode: 0, stdout: `${raceBranch2}\n`, stderr: "" };
          }
        }
        if (input.args[0] === "fetch" || input.args[0] === "pull") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "worktree" && input.args[1] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "worktree" && input.args[1] === "remove") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "diff" && input.args[1] === "--no-color") {
          if (input.args[4] === phaseBranch && input.cwd === racePath2) {
            return {
              exitCode: 0,
              stdout: "diff --git a/src/branch-2.ts b/src/branch-2.ts",
              stderr: "",
            };
          }
        }
        if (input.args[0] === "rev-list" && input.args[1] === "--reverse") {
          if (input.args[2] === `${phaseBranch}..${raceBranch2}`) {
            return {
              exitCode: 0,
              stdout: "commit-2a\n",
              stderr: "",
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "apply") {
          expect(input.cwd).toBe(phaseWorktreePath);
          expect(input.args.slice(1)).toEqual(["--index", "--binary", "-"]);
          expect(input.stdin).toContain(
            "diff --git a/src/branch-2.ts b/src/branch-2.ts",
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const phaseRunner = new PhaseRunner(
      control,
      {
        ...createBaseConfig(),
        worktrees: {
          enabled: true,
          baseDir: ".ixado/worktrees",
        },
      },
      undefined,
      async (event) => {
        runtimeEvents.push(event);
      },
      runner,
    );

    await phaseRunner.run();

    expect(control.startActiveTaskAndWait).not.toHaveBeenCalled();
    expect(state.phases[0]?.tasks[0]?.status).toBe("DONE");
    expect(state.phases[0]?.tasks[0]?.resultContext).toContain(
      `Race mode selected candidate 2 (${raceBranch2}).`,
    );
    expect((state.phases[0]?.tasks[0] as any)?.raceState).toMatchObject({
      status: "applied",
      pickedBranchIndex: 2,
      commitCount: 1,
      judgeAdapter: "CLAUDE_CLI",
      reasoning: "Candidate 2 succeeded while candidate 1 failed.",
      branches: [
        {
          index: 1,
          branchName: raceBranch1,
          status: "rejected",
          error: "branch 1 execution failed",
        },
        {
          index: 2,
          branchName: raceBranch2,
          status: "picked",
        },
      ],
    });

    const gitCalls = (runner.run as ReturnType<typeof mock>).mock.calls.map(
      (entry: any[]) => entry[0],
    );
    expect(
      gitCalls.filter(
        (call: any) =>
          call.command === "git" &&
          call.args[0] === "worktree" &&
          call.args[1] === "remove" &&
          (call.args[3] === racePath1 ||
            call.args[3] === racePath2 ||
            call.args[3] === phaseWorktreePath),
      ),
    ).toHaveLength(3);

    const raceBranchEvents = runtimeEvents.filter(
      (event) => event.type === "race:branch",
    );
    expect(raceBranchEvents).toHaveLength(2);

    const rejectedEvent = raceBranchEvents.find(
      (event) =>
        event.type === "race:branch" && event.payload.branchIndex === 1,
    );
    expect(rejectedEvent?.type).toBe("race:branch");
    if (rejectedEvent?.type === "race:branch") {
      expect(rejectedEvent.payload.status).toBe("rejected");
      expect(rejectedEvent.payload.error).toBe("branch 1 execution failed");
    }

    const fulfilledEvent = raceBranchEvents.find(
      (event) =>
        event.type === "race:branch" && event.payload.branchIndex === 2,
    );
    expect(fulfilledEvent?.type).toBe("race:branch");
    if (fulfilledEvent?.type === "race:branch") {
      expect(fulfilledEvent.payload.status).toBe("fulfilled");
    }

    const judgeEvent = runtimeEvents.find(
      (event) => event.type === "race:judge",
    );
    expect(judgeEvent?.type).toBe("race:judge");
    if (judgeEvent?.type === "race:judge") {
      expect(judgeEvent.payload.pickedBranchIndex).toBe(2);
      expect(judgeEvent.payload.reasoning).toBe(
        "Candidate 2 succeeded while candidate 1 failed.",
      );
    }

    const pickEvent = runtimeEvents.find((event) => event.type === "race:pick");
    expect(pickEvent?.type).toBe("race:pick");
    if (pickEvent?.type === "race:pick") {
      expect(pickEvent.payload.branchIndex).toBe(2);
      expect(pickEvent.payload.commitCount).toBe(1);
    }
  });

  test("applies the winning race diff even when the winner produced no commits", async () => {
    const phaseId = "d1111111-1111-4111-8111-111111111111";
    const taskId = "d2222222-2222-4222-8222-222222222222";
    const phaseBranch = "phase-35-race-no-commit";
    const phaseWorktreePath = `/tmp/project/.ixado/worktrees/${phaseId}`;
    const raceBranch1 = `${phaseBranch}-race-${taskId}-1`;
    const raceBranch2 = `${phaseBranch}-race-${taskId}-2`;
    const racePath1 = `/tmp/project/.ixado/worktrees/${phaseId}--race-${taskId}-1`;
    const racePath2 = `/tmp/project/.ixado/worktrees/${phaseId}--race-${taskId}-2`;
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 35 Race No Commit",
          branchName: phaseBranch,
          status: "PLANNING",
          worktreePath: null as string | null,
          tasks: [
            {
              id: taskId,
              title: "Apply uncommitted winner diff",
              description:
                "Keep winner changes even without race-branch commits.",
              race: 2,
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
              resultContext: undefined as string | undefined,
            },
          ],
        },
      ],
    };

    const control = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => state),
      setPhaseStatus: mock(async (input: any) => {
        const phase = state.phases[0] as any;
        phase.status = input.status;
        if (input.worktreePath !== undefined) {
          phase.worktreePath = input.worktreePath;
        }
        return state;
      }),
      startActiveTaskAndWait: mock(async () => state),
      prepareTaskExecution: mock(async (input: any) => {
        const phase = state.phases[0] as any;
        const task = phase.tasks[0] as any;
        const startedFromStatus = task.status;
        task.status = "IN_PROGRESS";
        task.assignee = input.assignee;
        return {
          projectName: state.projectName,
          phase: { ...phase },
          task: { ...task },
          taskForPrompt: { ...task },
          rootDir: input.cwd ?? phase.worktreePath ?? state.rootDir,
          resume: Boolean(input.resume),
          startedFromStatus,
        };
      }),
      completeTaskExecution: mock(async (input: any) => {
        const task = state.phases[0].tasks[0] as any;
        task.status = input.status;
        task.resultContext = input.resultContext;
        return state;
      }),
      updateTaskRaceState: mock(async (input: any) => {
        const task = state.phases[0].tasks[0] as any;
        task.raceState = input.raceState;
        return state;
      }),
      createTask: mock(async () => state),
      recordRecoveryAttempt: mock(async () => state),
      runInternalWork: mock(async (input: any) => {
        if (input.prompt.startsWith("Race Judge")) {
          return {
            stdout: "PICK 2\nCandidate 2 made the only meaningful changes.",
            stderr: "",
          };
        }
        if (input.cwd === racePath1) {
          return { stdout: "branch 1 output", stderr: "" };
        }
        if (input.cwd === racePath2) {
          return { stdout: "branch 2 output", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      }),
    } as unknown as ControlCenterService;

    const runner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.command !== "git") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "rev-parse") {
          throw new Error("missing local branch");
        }
        if (input.args[0] === "status" && input.args.includes("--porcelain")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (
          input.args[0] === "branch" &&
          input.args.includes("--show-current")
        ) {
          if (input.cwd === "/tmp/project") {
            return { exitCode: 0, stdout: "main\n", stderr: "" };
          }
          if (input.cwd === phaseWorktreePath) {
            return { exitCode: 0, stdout: `${phaseBranch}\n`, stderr: "" };
          }
          if (input.cwd === racePath1) {
            return { exitCode: 0, stdout: `${raceBranch1}\n`, stderr: "" };
          }
          if (input.cwd === racePath2) {
            return { exitCode: 0, stdout: `${raceBranch2}\n`, stderr: "" };
          }
        }
        if (input.args[0] === "fetch" || input.args[0] === "pull") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "worktree" && input.args[1] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "worktree" && input.args[1] === "remove") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "diff" && input.args[1] === "--no-color") {
          if (input.cwd === racePath1) {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (input.cwd === racePath2) {
            return {
              exitCode: 0,
              stdout: "diff --git a/src/no-commit.ts b/src/no-commit.ts",
              stderr: "",
            };
          }
        }
        if (input.args[0] === "rev-list" && input.args[1] === "--reverse") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "apply") {
          expect(input.stdin).toContain(
            "diff --git a/src/no-commit.ts b/src/no-commit.ts",
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const phaseRunner = new PhaseRunner(
      control,
      {
        ...createBaseConfig(),
        worktrees: {
          enabled: true,
          baseDir: ".ixado/worktrees",
        },
      },
      undefined,
      undefined,
      runner,
    );

    await phaseRunner.run();

    expect(state.phases[0]?.tasks[0]?.status).toBe("DONE");
    expect((state.phases[0]?.tasks[0] as any)?.raceState).toMatchObject({
      status: "applied",
      pickedBranchIndex: 2,
      commitCount: 0,
      reasoning: "Candidate 2 made the only meaningful changes.",
    });

    const gitCalls = (runner.run as ReturnType<typeof mock>).mock.calls.map(
      (entry: any[]) => entry[0],
    );
    expect(
      gitCalls.some(
        (call: any) =>
          call.command === "git" &&
          call.args[0] === "apply" &&
          call.cwd === phaseWorktreePath,
      ),
    ).toBe(true);
  });

  test("tears down provisioned race worktrees when failure happens before branch execution results are collected", async () => {
    const phaseId = "e1111111-1111-4111-8111-111111111111";
    const taskId = "e2222222-2222-4222-8222-222222222222";
    const phaseBranch = "phase-35-race-cleanup";
    const phaseWorktreePath = `/tmp/project/.ixado/worktrees/${phaseId}`;
    const racePath1 = `/tmp/project/.ixado/worktrees/${phaseId}--race-${taskId}-1`;
    const racePath2 = `/tmp/project/.ixado/worktrees/${phaseId}--race-${taskId}-2`;
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 35 Race Cleanup",
          branchName: phaseBranch,
          status: "PLANNING",
          worktreePath: null as string | null,
          tasks: [
            {
              id: taskId,
              title: "Cleanup leaked branches",
              description:
                "Tear down provisioned race branches on early failure.",
              race: 2,
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
          ],
        },
      ],
    };

    let raceStateWriteCount = 0;
    const control = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => state),
      setPhaseStatus: mock(async (input: any) => {
        const phase = state.phases[0] as any;
        phase.status = input.status;
        if (input.worktreePath !== undefined) {
          phase.worktreePath = input.worktreePath;
        }
        return state;
      }),
      startActiveTaskAndWait: mock(async () => state),
      prepareTaskExecution: mock(async (input: any) => {
        const phase = state.phases[0] as any;
        const task = phase.tasks[0] as any;
        const startedFromStatus = task.status;
        task.status = "IN_PROGRESS";
        task.assignee = input.assignee;
        return {
          projectName: state.projectName,
          phase: { ...phase },
          task: { ...task },
          taskForPrompt: { ...task },
          rootDir: input.cwd ?? phase.worktreePath ?? state.rootDir,
          resume: Boolean(input.resume),
          startedFromStatus,
        };
      }),
      completeTaskExecution: mock(async (input: any) => {
        const task = state.phases[0].tasks[0] as any;
        task.status = input.status;
        task.errorLogs = input.errorLogs;
        return state;
      }),
      updateTaskRaceState: mock(async (_input: any) => {
        raceStateWriteCount += 1;
        if (raceStateWriteCount === 1) {
          throw new Error("race state write failed");
        }
        return state;
      }),
      createTask: mock(async () => state),
      recordRecoveryAttempt: mock(async () => state),
      runInternalWork: mock(async () => ({ stdout: "", stderr: "" })),
    } as unknown as ControlCenterService;

    const runner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.command !== "git") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "rev-parse") {
          throw new Error("missing local branch");
        }
        if (input.args[0] === "status" && input.args.includes("--porcelain")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (
          input.args[0] === "branch" &&
          input.args.includes("--show-current")
        ) {
          if (input.cwd === "/tmp/project") {
            return { exitCode: 0, stdout: "main\n", stderr: "" };
          }
          if (input.cwd === phaseWorktreePath) {
            return { exitCode: 0, stdout: `${phaseBranch}\n`, stderr: "" };
          }
        }
        if (input.args[0] === "fetch" || input.args[0] === "pull") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "worktree" && input.args[1] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "worktree" && input.args[1] === "remove") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const phaseRunner = new PhaseRunner(
      control,
      {
        ...createBaseConfig(),
        worktrees: {
          enabled: true,
          baseDir: ".ixado/worktrees",
        },
      },
      undefined,
      undefined,
      runner,
    );

    await expect(phaseRunner.run()).rejects.toThrow(
      "Exception is not recoverable by policy: race state write failed",
    );

    expect(state.phases[0]?.tasks[0]?.status).toBe("FAILED");
    const gitCalls = (runner.run as ReturnType<typeof mock>).mock.calls.map(
      (entry: any[]) => entry[0],
    );
    expect(
      gitCalls.filter(
        (call: any) =>
          call.command === "git" &&
          call.args[0] === "worktree" &&
          call.args[1] === "remove" &&
          (call.args[3] === racePath1 ||
            call.args[3] === racePath2 ||
            call.args[3] === phaseWorktreePath),
      ),
    ).toHaveLength(3);
  });
});
