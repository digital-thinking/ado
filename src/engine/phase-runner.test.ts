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
});
