import { describe, expect, test, mock } from "bun:test";
import { PhaseRunner, type PhaseRunnerConfig } from "./phase-runner";
import { DEFAULT_AUTH_POLICY } from "../security/policy";
import type { Phase, Task } from "../types";

describe("PhaseRunner CI_FIX guardrails", () => {
  const baseConfig: PhaseRunnerConfig = {
    mode: "AUTO",
    countdownSeconds: 0,
    activeAssignee: "MOCK_CLI",
    maxRecoveryAttempts: 0,
    testerCommand: "npm",
    testerArgs: ["test"],
    testerTimeoutMs: 1000,
    vcsProvider: "github" as const,
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
    ciFixMaxDepth: 2, // Low depth cap for testing
    projectRootDir: "/tmp/project",
    projectName: "test-project",
    policy: DEFAULT_AUTH_POLICY,
    role: "admin",
  };

  test("runTesterStep: fails fast when CI_FIX depth cap is exceeded", async () => {
    const phaseId = "11111111-1111-4111-8111-111111111111";
    const task1Id = "22222222-2222-4222-8222-222222222222";
    const task2Id = "33333333-3333-4333-8333-333333333333";
    const task3Id = "44444444-4444-4444-8444-444444444444";
    const task4Id = "55555555-5555-5555-8555-555555555555";

    const tasks: Task[] = [
      {
        id: task1Id,
        title: "Initial Task",
        description: "",
        status: "DONE",
        assignee: "UNASSIGNED",
        dependencies: [],
      },
      {
        id: task2Id,
        title: "CI_FIX: depth 1",
        description: "",
        status: "DONE",
        assignee: "UNASSIGNED",
        dependencies: [task1Id],
      },
      {
        id: task3Id,
        title: "CI_FIX: depth 2",
        description: "",
        status: "DONE",
        assignee: "UNASSIGNED",
        dependencies: [task2Id],
      },
      {
        id: task4Id,
        title: "CI_FIX: depth 3",
        description: "",
        status: "TODO",
        assignee: "UNASSIGNED",
        dependencies: [task3Id],
      },
    ];

    const phase: Phase = {
      id: phaseId,
      name: "Phase 1",
      branchName: "feat/phase-1",
      status: "CODING",
      tasks,
    };

    let getStateCallCount = 0;
    const mockControl = {
      getState: mock(async () => {
        getStateCallCount++;
        return {
          projectName: "test-project",
          rootDir: "/tmp/project",
          activePhaseIds: [phaseId],
          phases: [
            {
              ...phase,
              tasks: [
                tasks[0],
                tasks[1],
                tasks[2],
                {
                  ...tasks[3],
                  status: getStateCallCount > 10 ? "DONE" : "TODO",
                },
              ],
            },
          ],
        };
      }),
      reconcileInProgressTasks: mock(async () => 0),
      setPhaseStatus: mock(async () => {}),
      startActiveTaskAndWait: mock(async () => ({
        projectName: "test-project",
        rootDir: "/tmp/project",
        activePhaseIds: [phaseId],
        phases: [
          {
            ...phase,
            tasks: [
              tasks[0],
              tasks[1],
              tasks[2],
              { ...tasks[3], status: "DONE" },
            ],
          },
        ],
      })),
      createTask: mock(async () => {}),
    };

    const mockRunner = {
      run: mock(async (options: any) => {
        if (options.command === "git") {
          if (options.args[0] === "status") return { stdout: "", stderr: "" };
          if (
            options.args[0] === "branch" &&
            options.args[1] === "--show-current"
          )
            return { stdout: "feat/phase-1", stderr: "" };
          return { stdout: "", stderr: "" };
        }
        if (options.command === "npm" && options.args[0] === "test") {
          throw new Error("Tests failed");
        }
        return { stdout: "", stderr: "" };
      }),
    };

    const runner = new PhaseRunner(
      mockControl as any,
      { ...baseConfig, vcsProvider: "null" as const },
      undefined,
      undefined,
      mockRunner as any,
    );

    try {
      await runner.run();
      expect.unreachable("Should have thrown depth cap error");
    } catch (error: any) {
      expect(error.message).toContain("CI_FIX cascade depth cap exceeded (2)");
      expect(error.message).toContain("Manual intervention is required");
    }
  });
});
