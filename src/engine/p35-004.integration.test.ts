import { describe, expect, mock, test } from "bun:test";

import { PhaseRunner, type PhaseRunnerConfig } from "./phase-runner";
import { DEFAULT_AUTH_POLICY } from "../security/policy";
import type { ProcessRunner } from "../process";
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
    const racePath1 = `/tmp/project/.ixado/worktrees/${phaseId}/race-${taskId}-1`;
    const racePath2 = `/tmp/project/.ixado/worktrees/${phaseId}/race-${taskId}-2`;
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
          if (input.args[2] === `${phaseBranch}..${raceBranch1}`) {
            return {
              exitCode: 0,
              stdout: "diff --git a/src/branch-1.ts b/src/branch-1.ts",
              stderr: "",
            };
          }
          if (input.args[2] === `${phaseBranch}..${raceBranch2}`) {
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
        if (input.args[0] === "cherry-pick") {
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

    expect(control.startActiveTaskAndWait).not.toHaveBeenCalled();
    expect(control.prepareTaskExecution).toHaveBeenCalledTimes(1);
    expect(control.completeTaskExecution).toHaveBeenCalledTimes(1);
    expect(state.phases[0]?.tasks[0]?.status).toBe("DONE");
    expect(state.phases[0]?.tasks[0]?.resultContext).toContain(
      `Race mode selected candidate 2 (${raceBranch2}).`,
    );
    expect(state.phases[0]?.tasks[0]?.resultContext).toContain(
      "Candidate 2 is the most coherent implementation.",
    );

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
          call.args[0] === "cherry-pick" &&
          call.args.slice(1).join(",") === "commit-2a,commit-2b" &&
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
});
