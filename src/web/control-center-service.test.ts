import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StateEngine } from "../state";
import { MockProcessRunner } from "../test-utils";
import {
  ControlCenterService,
  resolveTaskCompletionSideEffectContracts,
} from "./control-center-service";

function buildPassingGitHubPreflightRunner(): MockProcessRunner {
  return new MockProcessRunner([
    { stdout: "gh version 2.50.0\n" },
    { stdout: "github.com\n  Logged in to github.com as ixado\n" },
    { stdout: "deadbeef\trefs/heads/HEAD\n" },
  ]);
}

describe("ControlCenterService", () => {
  let sandboxDir: string;
  let stateFilePath: string;
  let tasksMarkdownPath: string;
  let service: ControlCenterService;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-web-control-"));
    stateFilePath = join(sandboxDir, "state.json");
    tasksMarkdownPath = join(sandboxDir, "TASKS.md");
    service = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
    );
    await service.ensureInitialized("IxADO", "C:/repo");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("creates phases and tasks", async () => {
    const afterPhase = await service.createPhase({
      name: "Phase 6",
      branchName: "phase-6-web-interface",
    });
    expect(afterPhase.phases).toHaveLength(1);

    const phaseId = afterPhase.phases[0].id;
    const afterTask = await service.createTask({
      phaseId,
      title: "Build dashboard",
      description: "Create control center page",
      assignee: "CODEX_CLI",
    });

    expect(afterTask.phases[0].tasks).toHaveLength(1);
    expect(afterTask.phases[0].tasks[0].title).toBe("Build dashboard");
    expect(afterTask.phases[0].tasks[0].assignee).toBe("CODEX_CLI");
  });

  test("updates task title, description, and dependencies", async () => {
    const phaseState = await service.createPhase({
      name: "Phase 6",
      branchName: "phase-6-web-interface",
    });
    const phaseId = phaseState.phases[0].id;
    const firstTaskState = await service.createTask({
      phaseId,
      title: "Task A",
      description: "First task",
    });
    const dependencyTaskId = firstTaskState.phases[0].tasks[0].id;
    const secondTaskState = await service.createTask({
      phaseId,
      title: "Task B",
      description: "Second task",
    });
    const taskId = secondTaskState.phases[0].tasks[1].id;

    const updated = await service.updateTask({
      phaseId,
      taskId,
      title: "Task B updated",
      description: "Second task updated",
      dependencies: [dependencyTaskId],
    });

    expect(updated.phases[0].tasks[1].title).toBe("Task B updated");
    expect(updated.phases[0].tasks[1].description).toBe("Second task updated");
    expect(updated.phases[0].tasks[1].dependencies).toEqual([dependencyTaskId]);
  });

  test("fails fast when updating task with missing dependency", async () => {
    const phaseState = await service.createPhase({
      name: "Phase 6",
      branchName: "phase-6-web-interface",
    });
    const phaseId = phaseState.phases[0].id;
    const taskState = await service.createTask({
      phaseId,
      title: "Task A",
      description: "First task",
    });
    const taskId = taskState.phases[0].tasks[0].id;

    await expect(
      service.updateTask({
        phaseId,
        taskId,
        title: "Task A updated",
        description: "Still first task",
        dependencies: ["missing-dependency-id"],
      }),
    ).rejects.toThrow("Task has invalid dependency reference");
  });

  test("fails fast on invalid task target phase", async () => {
    await expect(
      service.createTask({
        phaseId: "missing",
        title: "x",
        description: "y",
      }),
    ).rejects.toThrow("Phase not found");
  });

  test("imports phases and tasks from TASKS.md", async () => {
    await writeFile(
      tasksMarkdownPath,
      [
        "# IxADO Task Plan",
        "",
        "## Phase 1: Foundation",
        "- [x] `P1-001` Initialize project. Deps: none.",
        "- [ ] `P1-002` Add schemas. Deps: `P1-001`.",
        "",
        "## Phase 2: Execution",
        "- [ ] `P2-001` Wire runtime. Deps: `P1-002`.",
        "",
      ].join("\n"),
      "utf8",
    );

    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async (input) => {
        expect(input.assignee).toBe("MOCK_CLI");
        expect(input.prompt).toContain("TASKS.md");
        expect(input.prompt).toContain("Phase 1: Foundation");

        return {
          command: "mock-cli",
          args: ["run", "transform"],
          stdout: [
            "```json",
            JSON.stringify(
              {
                phases: [
                  {
                    name: "Phase 1: Foundation",
                    branchName: "phase-1-foundation",
                    tasks: [
                      {
                        code: "P1-001",
                        title: "P1-001 Initialize project",
                        description: "Initialize project",
                        status: "DONE",
                        assignee: "UNASSIGNED",
                        dependencies: [],
                      },
                      {
                        code: "P1-002",
                        title: "P1-002 Add schemas",
                        description: "Add schemas",
                        status: "TODO",
                        assignee: "CODEX_CLI",
                        dependencies: ["P1-001"],
                      },
                    ],
                  },
                  {
                    name: "Phase 2: Execution",
                    branchName: "phase-2-execution",
                    tasks: [
                      {
                        code: "P2-001",
                        title: "P2-001 Wire runtime",
                        description: "Wire runtime",
                        status: "TODO",
                        assignee: "GEMINI_CLI",
                        dependencies: ["P1-002"],
                      },
                    ],
                  },
                ],
              },
              null,
              2,
            ),
            "```",
          ].join("\n"),
          stderr: "",
          durationMs: 12,
        };
      },
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const imported =
      await serviceWithRunner.importFromTasksMarkdown("MOCK_CLI");
    expect(imported.importedPhaseCount).toBe(2);
    expect(imported.importedTaskCount).toBe(3);
    expect(imported.assignee).toBe("MOCK_CLI");
    expect(imported.state.phases).toHaveLength(2);

    const phase1 = imported.state.phases.find(
      (phase) => phase.name === "Phase 1: Foundation",
    );
    expect(phase1).toBeDefined();
    if (!phase1) {
      throw new Error("Phase 1 was not imported");
    }
    expect(phase1.tasks).toHaveLength(2);
    expect(phase1.tasks[0].status).toBe("DONE");
    expect(phase1.tasks[1].dependencies).toEqual([phase1.tasks[0].id]);

    const phase2 = imported.state.phases.find(
      (phase) => phase.name === "Phase 2: Execution",
    );
    expect(phase2).toBeDefined();
    if (!phase2) {
      throw new Error("Phase 2 was not imported");
    }
    expect(phase2.tasks).toHaveLength(1);
    expect(phase2.tasks[0].dependencies).toEqual([phase1.tasks[1].id]);

    const secondImport =
      await serviceWithRunner.importFromTasksMarkdown("MOCK_CLI");
    expect(secondImport.importedPhaseCount).toBe(0);
    expect(secondImport.importedTaskCount).toBe(0);
  });

  test("fails fast when internal work runner is not configured", async () => {
    await expect(
      service.runInternalWork({
        assignee: "CODEX_CLI",
        prompt: "hello",
      }),
    ).rejects.toThrow("Internal work runner is not configured.");
  });

  test("starts a TODO task and marks it DONE when adapter succeeds", async () => {
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async (input) => {
        expect(input.assignee).toBe("CODEX_CLI");
        expect(input.prompt).toContain("Task: Build execution flow");
        return {
          command: "codex",
          args: ["exec", "prompt"],
          stdout: "implemented",
          stderr: "",
          durationMs: 100,
        };
      },
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const created = await serviceWithRunner.createPhase({
      name: "Phase 2",
      branchName: "phase-2-exec",
    });
    const phaseId = created.phases[0].id;
    const withTask = await serviceWithRunner.createTask({
      phaseId,
      title: "Build execution flow",
      description: "Run adapter and store result",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    const finished = await serviceWithRunner.startTaskAndWait({
      phaseId,
      taskId,
      assignee: "CODEX_CLI",
    });

    const task = finished.phases[0].tasks[0];
    expect(task.status).toBe("DONE");
    expect(task.assignee).toBe("CODEX_CLI");
    expect(task.resultContext).toContain("implemented");
  });

  test("fails completion when PR side effect cannot be verified", async () => {
    const preflightRunner = buildPassingGitHubPreflightRunner();
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async () => ({
        command: "codex",
        args: ["exec", "prompt"],
        stdout: "created pull request",
        stderr: "",
        durationMs: 50,
      }),
      undefined,
      undefined,
      preflightRunner,
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const created = await serviceWithRunner.createPhase({
      name: "Phase PR Gate",
      branchName: "phase-pr-gate",
    });
    const phaseId = created.phases[0].id;
    const withTask = await serviceWithRunner.createTask({
      phaseId,
      title: "Create PR Task",
      description: "Open pull request for this phase",
      assignee: "CODEX_CLI",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    const finished = await serviceWithRunner.startTaskAndWait({
      phaseId,
      taskId,
      assignee: "CODEX_CLI",
    });
    const task = finished.phases[0].tasks[0];

    expect(task.status).toBe("FAILED");
    expect(task.errorLogs).toContain(
      "Completion side-effect verification failed",
    );
    expect(task.completionVerification?.status).toBe("FAILED");
    expect(task.completionVerification?.contracts).toEqual(["PR_CREATION"]);
    expect(task.completionVerification?.missingSideEffects[0]).toContain(
      "phase.prUrl is missing",
    );
  });

  test("fails fast before worker run when GitHub capability preflight fails", async () => {
    let runCount = 0;
    const missingGh = new Error("spawn gh ENOENT") as NodeJS.ErrnoException;
    missingGh.code = "ENOENT";
    const preflightRunner = new MockProcessRunner([
      missingGh,
      { stdout: "deadbeef\trefs/heads/HEAD\n" },
    ]);
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async () => {
        runCount += 1;
        return {
          command: "codex",
          args: ["exec", "prompt"],
          stdout: "should not run",
          stderr: "",
          durationMs: 50,
        };
      },
      undefined,
      undefined,
      preflightRunner,
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const created = await serviceWithRunner.createPhase({
      name: "Phase PR Preflight",
      branchName: "phase-pr-preflight",
    });
    const phaseId = created.phases[0].id;
    const withTask = await serviceWithRunner.createTask({
      phaseId,
      title: "Create PR Task",
      description: "Open pull request for this phase",
      assignee: "CODEX_CLI",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    const finished = await serviceWithRunner.startTaskAndWait({
      phaseId,
      taskId,
      assignee: "CODEX_CLI",
    });
    const task = finished.phases[0].tasks[0];

    expect(runCount).toBe(0);
    expect(task.status).toBe("FAILED");
    expect(task.errorCategory).toBe("AGENT_FAILURE");
    expect(task.adapterFailureKind).toBe("missing-binary");
    expect(task.errorLogs).toContain(
      "Runtime capability preflight failed for GitHub-bound task",
    );
    expect(task.completionVerification?.status).toBe("FAILED");
    expect(task.completionVerification?.contracts).toEqual(["PR_CREATION"]);
    expect(task.completionVerification?.missingSideEffects.join(" ")).toContain(
      "Install GitHub CLI",
    );
  });

  test("persists DONE when PR side effect verification passes", async () => {
    const preflightRunner = buildPassingGitHubPreflightRunner();
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async () => ({
        command: "codex",
        args: ["exec", "prompt"],
        stdout: "pr opened",
        stderr: "",
        durationMs: 50,
      }),
      undefined,
      undefined,
      preflightRunner,
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const created = await serviceWithRunner.createPhase({
      name: "Phase PR Pass",
      branchName: "phase-pr-pass",
    });
    const phaseId = created.phases[0].id;
    await serviceWithRunner.setPhasePrUrl({
      phaseId,
      prUrl: "https://github.com/org/repo/pull/123",
    });
    const withTask = await serviceWithRunner.createTask({
      phaseId,
      title: "Create PR Task",
      description: "Open pull request for this phase",
      assignee: "CODEX_CLI",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    const finished = await serviceWithRunner.startTaskAndWait({
      phaseId,
      taskId,
      assignee: "CODEX_CLI",
    });
    const task = finished.phases[0].tasks[0];

    expect(task.status).toBe("DONE");
    expect(task.completionVerification?.status).toBe("PASSED");
    expect(task.completionVerification?.contracts).toEqual(["PR_CREATION"]);
    expect(task.completionVerification?.missingSideEffects).toEqual([]);
  });

  test("runs worker when GitHub capability preflight passes", async () => {
    let runCount = 0;
    const preflightRunner = buildPassingGitHubPreflightRunner();
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async () => {
        runCount += 1;
        return {
          command: "codex",
          args: ["exec", "prompt"],
          stdout: "pr opened",
          stderr: "",
          durationMs: 50,
        };
      },
      undefined,
      undefined,
      preflightRunner,
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const created = await serviceWithRunner.createPhase({
      name: "Phase PR Preflight Pass",
      branchName: "phase-pr-preflight-pass",
    });
    const phaseId = created.phases[0].id;
    await serviceWithRunner.setPhasePrUrl({
      phaseId,
      prUrl: "https://github.com/org/repo/pull/124",
    });
    const withTask = await serviceWithRunner.createTask({
      phaseId,
      title: "Create PR Task",
      description: "Open pull request for this phase",
      assignee: "CODEX_CLI",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    const finished = await serviceWithRunner.startTaskAndWait({
      phaseId,
      taskId,
      assignee: "CODEX_CLI",
    });
    const task = finished.phases[0].tasks[0];

    expect(runCount).toBe(1);
    expect(task.status).toBe("DONE");
  });

  test("fails completion when CI-triggered update side effect cannot be verified", async () => {
    let runCount = 0;
    const preflightRunner = buildPassingGitHubPreflightRunner();
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async () => {
        runCount += 1;
        return {
          command: "codex",
          args: ["exec", "prompt"],
          stdout: "applied update",
          stderr: "",
          durationMs: 50,
        };
      },
      undefined,
      undefined,
      preflightRunner,
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const created = await serviceWithRunner.createPhase({
      name: "Phase CI Signal Gate",
      branchName: "phase-ci-signal-gate",
    });
    const phaseId = created.phases[0].id;
    const withTask = await serviceWithRunner.createTask({
      phaseId,
      title: "Apply CI-triggered updates",
      description: "Trigger CI status updates for this phase",
      assignee: "CODEX_CLI",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    const finished = await serviceWithRunner.startTaskAndWait({
      phaseId,
      taskId,
      assignee: "CODEX_CLI",
    });
    const task = finished.phases[0].tasks[0];

    expect(runCount).toBe(1);
    expect(task.status).toBe("FAILED");
    expect(task.errorLogs).toContain(
      "Completion side-effect verification failed",
    );
    expect(task.completionVerification?.status).toBe("FAILED");
    expect(task.completionVerification?.contracts).toEqual([
      "CI_TRIGGERED_UPDATE",
    ]);
    expect(task.completionVerification?.missingSideEffects.join(" ")).toContain(
      "phase has no CI signal",
    );
    expect(
      task.completionVerification?.probes.some(
        (probe) => probe.name === "phase CI signal" && probe.success === false,
      ),
    ).toBe(true);
  });

  test("fails fast before worker run when GitHub capability preflight fails for remote push tasks", async () => {
    let runCount = 0;
    const missingGh = new Error("spawn gh ENOENT") as NodeJS.ErrnoException;
    missingGh.code = "ENOENT";
    const preflightRunner = new MockProcessRunner([
      missingGh,
      { stdout: "deadbeef\trefs/heads/HEAD\n" },
    ]);
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async () => {
        runCount += 1;
        return {
          command: "codex",
          args: ["exec", "prompt"],
          stdout: "should not run",
          stderr: "",
          durationMs: 50,
        };
      },
      undefined,
      undefined,
      preflightRunner,
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const created = await serviceWithRunner.createPhase({
      name: "Phase Push Preflight",
      branchName: "phase-push-preflight",
    });
    const phaseId = created.phases[0].id;
    const withTask = await serviceWithRunner.createTask({
      phaseId,
      title: "Remote push task",
      description: "Push to origin after local changes",
      assignee: "CODEX_CLI",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    const finished = await serviceWithRunner.startTaskAndWait({
      phaseId,
      taskId,
      assignee: "CODEX_CLI",
    });
    const task = finished.phases[0].tasks[0];

    expect(runCount).toBe(0);
    expect(task.status).toBe("FAILED");
    expect(task.errorCategory).toBe("AGENT_FAILURE");
    expect(task.adapterFailureKind).toBe("missing-binary");
    expect(task.errorLogs).toContain(
      "Runtime capability preflight failed for GitHub-bound task",
    );
    expect(task.completionVerification?.status).toBe("FAILED");
    expect(task.completionVerification?.contracts).toEqual(["REMOTE_PUSH"]);
    expect(task.completionVerification?.missingSideEffects.join(" ")).toContain(
      "Install GitHub CLI",
    );
  });

  test("resolves side-effect verification contracts from task text", () => {
    const contracts = resolveTaskCompletionSideEffectContracts({
      title: "Create PR Task and remote push",
      description: "After merge prep, perform CI-triggered updates",
    });
    expect(contracts).toEqual([
      "PR_CREATION",
      "REMOTE_PUSH",
      "CI_TRIGGERED_UPDATE",
    ]);
  });

  test("fails fast if task dependencies are not DONE", async () => {
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async () => ({
        command: "codex",
        args: ["run"],
        stdout: "ok",
        stderr: "",
        durationMs: 10,
      }),
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const created = await serviceWithRunner.createPhase({
      name: "Phase 2",
      branchName: "phase-2-exec",
    });
    const phaseId = created.phases[0].id;
    const withTaskA = await serviceWithRunner.createTask({
      phaseId,
      title: "A",
      description: "Task A",
    });
    const taskAId = withTaskA.phases[0].tasks[0].id;
    const withTaskB = await serviceWithRunner.createTask({
      phaseId,
      title: "B",
      description: "Task B",
      dependencies: [taskAId],
    });
    const taskBId = withTaskB.phases[0].tasks[1].id;

    await expect(
      serviceWithRunner.startTask({
        phaseId,
        taskId: taskBId,
        assignee: "CODEX_CLI",
      }),
    ).rejects.toThrow("Task has incomplete dependency");
  });

  test("marks task FAILED when adapter throws", async () => {
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async () => {
        throw new Error("adapter failed");
      },
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const created = await serviceWithRunner.createPhase({
      name: "Phase 2",
      branchName: "phase-2-exec",
    });
    const phaseId = created.phases[0].id;
    const withTask = await serviceWithRunner.createTask({
      phaseId,
      title: "C",
      description: "Task C",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    const finished = await serviceWithRunner.startTaskAndWait({
      phaseId,
      taskId,
      assignee: "CODEX_CLI",
    });
    const task = finished.phases[0].tasks[0];
    expect(task.status).toBe("FAILED");
    expect(task.errorLogs).toContain("adapter failed");
  });

  test("appends truncation marker to errorLogs when error message exceeds storage limit", async () => {
    const oversizedMessage = "x".repeat(5_000);
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async () => {
        throw new Error(oversizedMessage);
      },
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const created = await serviceWithRunner.createPhase({
      name: "Phase Trunc Error",
      branchName: "phase-trunc-error",
    });
    const phaseId = created.phases[0].id;
    const withTask = await serviceWithRunner.createTask({
      phaseId,
      title: "Trunc task",
      description: "Task that fails with oversized error",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    const finished = await serviceWithRunner.startTaskAndWait({
      phaseId,
      taskId,
      assignee: "CODEX_CLI",
    });
    const task = finished.phases[0].tasks[0];

    expect(task.status).toBe("FAILED");
    expect(task.errorLogs).toEndWith("\n... [truncated]");
    expect(task.errorLogs!.length).toBe(4_000);
  });

  test("appends truncation marker to resultContext when worker output exceeds storage limit", async () => {
    const oversizedOutput = "y".repeat(5_000);
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async () => ({
        command: "codex",
        args: [],
        stdout: oversizedOutput,
        stderr: "",
        durationMs: 10,
      }),
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const created = await serviceWithRunner.createPhase({
      name: "Phase Trunc Result",
      branchName: "phase-trunc-result",
    });
    const phaseId = created.phases[0].id;
    const withTask = await serviceWithRunner.createTask({
      phaseId,
      title: "Trunc result task",
      description: "Task that completes with oversized output",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    const finished = await serviceWithRunner.startTaskAndWait({
      phaseId,
      taskId,
      assignee: "CODEX_CLI",
    });
    const task = finished.phases[0].tasks[0];

    expect(task.status).toBe("DONE");
    expect(task.resultContext).toEndWith("\n... [truncated]");
    expect(task.resultContext!.length).toBe(4_000);
  });

  test("does not append truncation marker when output is at or below storage limit", async () => {
    const exactOutput = "z".repeat(4_000);
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async () => ({
        command: "codex",
        args: [],
        stdout: exactOutput,
        stderr: "",
        durationMs: 10,
      }),
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const created = await serviceWithRunner.createPhase({
      name: "Phase No Trunc",
      branchName: "phase-no-trunc",
    });
    const phaseId = created.phases[0].id;
    const withTask = await serviceWithRunner.createTask({
      phaseId,
      title: "No trunc task",
      description: "Task at exact storage limit",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    const finished = await serviceWithRunner.startTaskAndWait({
      phaseId,
      taskId,
      assignee: "CODEX_CLI",
    });
    const task = finished.phases[0].tasks[0];

    expect(task.status).toBe("DONE");
    expect(task.resultContext).not.toContain("[truncated]");
    expect(task.resultContext!.length).toBe(4_000);
  });

  test("sets active phase", async () => {
    const createdA = await service.createPhase({
      name: "Phase A",
      branchName: "phase-a",
    });
    const firstPhaseId = createdA.phases[0].id;
    const createdB = await service.createPhase({
      name: "Phase B",
      branchName: "phase-b",
    });
    const secondPhaseId = createdB.phases[1].id;

    expect(createdB.activePhaseId).toBe(secondPhaseId);

    const updated = await service.setActivePhase({ phaseId: firstPhaseId });
    expect(updated.activePhaseId).toBe(firstPhaseId);
  });

  test("sets active phase by 1-based phase number", async () => {
    const createdA = await service.createPhase({
      name: "Phase A",
      branchName: "phase-a",
    });
    const firstPhaseId = createdA.phases[0].id;
    await service.createPhase({
      name: "Phase B",
      branchName: "phase-b",
    });

    const updated = await service.setActivePhase({ phaseId: "1" });
    expect(updated.activePhaseId).toBe(firstPhaseId);
  });

  test("fails fast when phase number is out of range", async () => {
    await service.createPhase({
      name: "Phase A",
      branchName: "phase-a",
    });

    await expect(service.setActivePhase({ phaseId: "5" })).rejects.toThrow(
      "Phase not found: 5",
    );
  });

  test("stores phase pull request URL", async () => {
    const created = await service.createPhase({
      name: "Phase PR",
      branchName: "phase-pr",
    });
    const phaseId = created.phases[0].id;

    const updated = await service.setPhasePrUrl({
      phaseId,
      prUrl: "https://github.com/org/repo/pull/999",
    });

    expect(updated.phases[0].prUrl).toBe(
      "https://github.com/org/repo/pull/999",
    );
  });

  test("updates phase status and CI context", async () => {
    const created = await service.createPhase({
      name: "Phase Status",
      branchName: "phase-status",
    });
    const phaseId = created.phases[0].id;

    const failed = await service.setPhaseStatus({
      phaseId,
      status: "CI_FAILED",
      ciStatusContext: "Validation loop exceeded retries.",
    });
    expect(failed.phases[0].status).toBe("CI_FAILED");
    expect(failed.phases[0].ciStatusContext).toBe(
      "Validation loop exceeded retries.",
    );

    const recovered = await service.setPhaseStatus({
      phaseId,
      status: "READY_FOR_REVIEW",
    });
    expect(recovered.phases[0].status).toBe("READY_FOR_REVIEW");
    expect(recovered.phases[0].ciStatusContext).toBeUndefined();
  });

  // P26-001: failureKind semantics
  test("setPhaseStatus persists failureKind when transitioning to CI_FAILED", async () => {
    const created = await service.createPhase({
      name: "Phase FailureKind",
      branchName: "phase-failure-kind",
    });
    const phaseId = created.phases[0].id;

    const failed = await service.setPhaseStatus({
      phaseId,
      status: "CI_FAILED",
      failureKind: "LOCAL_TESTER",
    });
    expect(failed.phases[0].status).toBe("CI_FAILED");
    expect(failed.phases[0].failureKind).toBe("LOCAL_TESTER");
  });

  test("setPhaseStatus clears failureKind when leaving CI_FAILED", async () => {
    const created = await service.createPhase({
      name: "Phase ClearKind",
      branchName: "phase-clear-kind",
    });
    const phaseId = created.phases[0].id;

    await service.setPhaseStatus({
      phaseId,
      status: "CI_FAILED",
      failureKind: "REMOTE_CI",
    });

    const recovered = await service.setPhaseStatus({
      phaseId,
      status: "READY_FOR_REVIEW",
    });
    expect(recovered.phases[0].status).toBe("READY_FOR_REVIEW");
    expect(recovered.phases[0].failureKind).toBeUndefined();
  });

  test("setPhaseStatus preserves existing failureKind when none is provided", async () => {
    const created = await service.createPhase({
      name: "Phase PreserveKind",
      branchName: "phase-preserve-kind",
    });
    const phaseId = created.phases[0].id;

    await service.setPhaseStatus({
      phaseId,
      status: "CI_FAILED",
      failureKind: "AGENT_FAILURE",
    });

    // Transition again to CI_FAILED without a new failureKind — must preserve it
    const updated = await service.setPhaseStatus({
      phaseId,
      status: "CI_FAILED",
      ciStatusContext: "Additional context",
    });
    expect(updated.phases[0].failureKind).toBe("AGENT_FAILURE");
    expect(updated.phases[0].ciStatusContext).toBe("Additional context");
  });

  test("setPhaseStatus supports all three valid failureKind values", async () => {
    for (const kind of [
      "LOCAL_TESTER",
      "REMOTE_CI",
      "AGENT_FAILURE",
    ] as const) {
      const created = await service.createPhase({
        name: `Phase ${kind}`,
        branchName: `phase-${kind.toLowerCase().replace("_", "-")}`,
      });
      const phaseId = created.phases[0].id;
      const result = await service.setPhaseStatus({
        phaseId,
        status: "CI_FAILED",
        failureKind: kind,
      });
      expect(result.phases[0].failureKind).toBe(kind);
    }
  });

  test("records recovery attempt on task and phase", async () => {
    const created = await service.createPhase({
      name: "Phase Recovery Record",
      branchName: "phase-recovery-record",
    });
    const phaseId = created.phases[0].id;
    const withTask = await service.createTask({
      phaseId,
      title: "Task A",
      description: "do work",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    const withTaskRecovery = await service.recordRecoveryAttempt({
      phaseId,
      taskId,
      attemptNumber: 1,
      exception: {
        category: "AGENT_FAILURE",
        message: "worker failed",
        phaseId,
        taskId,
      },
      result: {
        status: "fixed",
        reasoning: "retry completed",
      },
    });
    expect(withTaskRecovery.phases[0].tasks[0].recoveryAttempts).toHaveLength(
      1,
    );

    const withPhaseRecovery = await service.recordRecoveryAttempt({
      phaseId,
      attemptNumber: 2,
      exception: {
        category: "MISSING_COMMIT",
        message: "commit required",
        phaseId,
      },
      result: {
        status: "unfixable",
        reasoning: "manual intervention needed",
      },
    });
    expect(withPhaseRecovery.phases[0].recoveryAttempts).toHaveLength(1);
  });

  test("recovers phase from CI_FAILED after successful CI_FIX task", async () => {
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async () => ({
        command: "codex",
        args: ["run"],
        stdout: "fixed",
        stderr: "",
        durationMs: 5,
      }),
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");
    const created = await serviceWithRunner.createPhase({
      name: "Phase Recover",
      branchName: "phase-recover",
    });
    const phaseId = created.phases[0].id;
    await serviceWithRunner.createTask({
      phaseId,
      title: "Fix tests after Task A",
      description: "Repair failing test",
      assignee: "CODEX_CLI",
      status: "CI_FIX",
    });
    await serviceWithRunner.setPhaseStatus({
      phaseId,
      status: "CI_FAILED",
      ciStatusContext: "Tests failed in CI",
    });

    const finished = await serviceWithRunner.startActiveTaskAndWait({
      taskNumber: 1,
      assignee: "CODEX_CLI",
    });
    const phase = finished.phases[0];
    expect(phase.status).toBe("CODING");
    expect(phase.ciStatusContext).toBeUndefined();
    expect(phase.tasks[0].status).toBe("DONE");
  });

  test("does not clear CI_FAILED when non-fix task succeeds", async () => {
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async () => ({
        command: "codex",
        args: ["run"],
        stdout: "done",
        stderr: "",
        durationMs: 5,
      }),
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");
    const created = await serviceWithRunner.createPhase({
      name: "Phase Keep Failed",
      branchName: "phase-keep-failed",
    });
    const phaseId = created.phases[0].id;
    await serviceWithRunner.createTask({
      phaseId,
      title: "Regular follow-up task",
      description: "Not a CI fix task",
      assignee: "CODEX_CLI",
      status: "TODO",
    });
    await serviceWithRunner.setPhaseStatus({
      phaseId,
      status: "CI_FAILED",
      ciStatusContext: "Still failing",
    });

    const finished = await serviceWithRunner.startActiveTaskAndWait({
      taskNumber: 1,
      assignee: "CODEX_CLI",
    });
    const phase = finished.phases[0];
    expect(phase.status).toBe("CI_FAILED");
    expect(phase.ciStatusContext).toBe("Still failing");
    expect(phase.tasks[0].status).toBe("DONE");
  });

  test("lists active phase tasks with 1-based numbers", async () => {
    const created = await service.createPhase({
      name: "Phase Numbers",
      branchName: "phase-numbers",
    });
    const phaseId = created.phases[0].id;
    await service.createTask({
      phaseId,
      title: "Task One",
      description: "First",
    });
    await service.createTask({
      phaseId,
      title: "Task Two",
      description: "Second",
    });

    const list = await service.listActivePhaseTasks();
    expect(list.phaseId).toBe(phaseId);
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject({ number: 1, title: "Task One" });
    expect(list.items[1]).toMatchObject({ number: 2, title: "Task Two" });
  });

  test("fails fast when activePhaseId is missing", async () => {
    const created = await service.createPhase({
      name: "Phase Missing Active",
      branchName: "phase-missing-active",
    });
    const phaseId = created.phases[0].id;
    await service.createTask({
      phaseId,
      title: "Task One",
      description: "First",
    });

    const raw = await Bun.file(stateFilePath).json();
    raw.activePhaseId = undefined;
    await Bun.write(stateFilePath, JSON.stringify(raw, null, 2));

    await expect(service.listActivePhaseTasks()).rejects.toThrow(
      "Active phase ID is not set",
    );
  });

  test("starts active task by number", async () => {
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async () => ({
        command: "codex",
        args: ["run"],
        stdout: "done",
        stderr: "",
        durationMs: 10,
      }),
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const created = await serviceWithRunner.createPhase({
      name: "Phase Active Start",
      branchName: "phase-active-start",
    });
    const phaseId = created.phases[0].id;
    await serviceWithRunner.createTask({
      phaseId,
      title: "One",
      description: "First",
    });
    await serviceWithRunner.createTask({
      phaseId,
      title: "Two",
      description: "Second",
    });

    const finished = await serviceWithRunner.startActiveTaskAndWait({
      taskNumber: 2,
      assignee: "CODEX_CLI",
    });
    const activePhase = finished.phases.find((phase) => phase.id === phaseId);
    if (!activePhase) {
      throw new Error("Active phase not found");
    }

    expect(activePhase.tasks[0].status).toBe("TODO");
    expect(activePhase.tasks[1].status).toBe("DONE");
    expect(activePhase.tasks[1].assignee).toBe("CODEX_CLI");
  });

  test("supports explicit resume for sequential active tasks", async () => {
    const resumeFlags: boolean[] = [];
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async (input) => {
        resumeFlags.push(Boolean(input.resume));
        return {
          command: "codex",
          args: ["run"],
          stdout: "ok",
          stderr: "",
          durationMs: 10,
        };
      },
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const created = await serviceWithRunner.createPhase({
      name: "Phase Session",
      branchName: "phase-session",
    });
    const phaseId = created.phases[0].id;
    await serviceWithRunner.createTask({
      phaseId,
      title: "One",
      description: "First",
    });
    await serviceWithRunner.createTask({
      phaseId,
      title: "Two",
      description: "Second",
    });

    await serviceWithRunner.startActiveTaskAndWait({
      taskNumber: 1,
      assignee: "CODEX_CLI",
    });
    await serviceWithRunner.startActiveTaskAndWait({
      taskNumber: 2,
      assignee: "CODEX_CLI",
      resume: true,
    });

    expect(resumeFlags).toEqual([false, true]);
  });

  test("allows cross-phase dependency when dependency task is DONE", async () => {
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async () => ({
        command: "codex",
        args: ["run"],
        stdout: "ok",
        stderr: "",
        durationMs: 10,
      }),
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const phaseA = await serviceWithRunner.createPhase({
      name: "Phase A",
      branchName: "phase-a",
    });
    const phaseAId = phaseA.phases[0].id;
    const phaseATaskState = await serviceWithRunner.createTask({
      phaseId: phaseAId,
      title: "A1",
      description: "done dependency",
      assignee: "CODEX_CLI",
    });
    const dependencyTaskId = phaseATaskState.phases[0].tasks[0].id;
    await serviceWithRunner.startTaskAndWait({
      phaseId: phaseAId,
      taskId: dependencyTaskId,
      assignee: "CODEX_CLI",
    });

    const phaseB = await serviceWithRunner.createPhase({
      name: "Phase B",
      branchName: "phase-b",
    });
    const phaseBId = phaseB.phases[1].id;
    const phaseBTaskState = await serviceWithRunner.createTask({
      phaseId: phaseBId,
      title: "B1",
      description: "depends on A1",
      dependencies: [dependencyTaskId],
    });
    const dependentTaskId = phaseBTaskState.phases[1].tasks[0].id;

    const result = await serviceWithRunner.startTaskAndWait({
      phaseId: phaseBId,
      taskId: dependentTaskId,
      assignee: "CLAUDE_CLI",
    });
    const phaseBResult = result.phases.find((phase) => phase.id === phaseBId);
    if (!phaseBResult) {
      throw new Error("Phase B missing after task run");
    }
    expect(phaseBResult.tasks[0].status).toBe("DONE");
  });

  test("fails fast when retrying FAILED task with different assignee", async () => {
    let runCount = 0;
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async () => {
        runCount += 1;
        if (runCount === 1) {
          throw new Error("first run failed");
        }

        return {
          command: "codex",
          args: ["run"],
          stdout: "second run passed",
          stderr: "",
          durationMs: 10,
        };
      },
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const created = await serviceWithRunner.createPhase({
      name: "Phase Retry",
      branchName: "phase-retry",
    });
    const phaseId = created.phases[0].id;
    const withTask = await serviceWithRunner.createTask({
      phaseId,
      title: "Retry me",
      description: "Task that should fail once",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    const failedState = await serviceWithRunner.startTaskAndWait({
      phaseId,
      taskId,
      assignee: "CODEX_CLI",
    });
    expect(failedState.phases[0].tasks[0].status).toBe("FAILED");
    expect(failedState.phases[0].tasks[0].assignee).toBe("CODEX_CLI");

    await expect(
      serviceWithRunner.startTaskAndWait({
        phaseId,
        taskId,
        assignee: "CLAUDE_CLI",
      }),
    ).rejects.toThrow("FAILED task must be retried with the same assignee");
  });

  test("retries FAILED task with same assignee using resume mode", async () => {
    let runCount = 0;
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async (input) => {
        runCount += 1;
        if (runCount === 1) {
          throw new Error("first run failed");
        }
        expect(input.resume).toBe(true);

        return {
          command: "codex",
          args: ["exec", "resume", "--last", "-"],
          stdout: "second run passed",
          stderr: "",
          durationMs: 10,
        };
      },
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const created = await serviceWithRunner.createPhase({
      name: "Phase Retry Resume",
      branchName: "phase-retry-resume",
    });
    const phaseId = created.phases[0].id;
    const withTask = await serviceWithRunner.createTask({
      phaseId,
      title: "Retry me",
      description: "Task that should fail once",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    await serviceWithRunner.startTaskAndWait({
      phaseId,
      taskId,
      assignee: "CODEX_CLI",
    });

    const retriedState = await serviceWithRunner.startTaskAndWait({
      phaseId,
      taskId,
      assignee: "CODEX_CLI",
    });
    expect(retriedState.phases[0].tasks[0].status).toBe("DONE");
  });

  test("resetTaskToTodo hard-resets repository and clears failed task", async () => {
    let resetCalled = 0;
    const serviceWithRunner = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      async () => {
        throw new Error("adapter failed");
      },
      async () => {
        resetCalled += 1;
      },
    );
    await serviceWithRunner.ensureInitialized("IxADO", "C:/repo");

    const created = await serviceWithRunner.createPhase({
      name: "Phase Reset",
      branchName: "phase-reset",
    });
    const phaseId = created.phases[0].id;
    const withTask = await serviceWithRunner.createTask({
      phaseId,
      title: "Reset me",
      description: "Task to fail and reset",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    await serviceWithRunner.startTaskAndWait({
      phaseId,
      taskId,
      assignee: "CODEX_CLI",
    });
    const afterReset = await serviceWithRunner.resetTaskToTodo({
      phaseId,
      taskId,
    });

    expect(resetCalled).toBe(1);
    expect(afterReset.phases[0].tasks[0].status).toBe("TODO");
    expect(afterReset.phases[0].tasks[0].assignee).toBe("UNASSIGNED");
    expect(afterReset.phases[0].tasks[0].errorLogs).toBeUndefined();
  });

  test("calls onStateChange hook when state is written", async () => {
    let callCount = 0;
    let lastProjectName = "";
    const serviceWithHook = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
      undefined,
      undefined,
      (projectName) => {
        callCount += 1;
        lastProjectName = projectName;
      },
    );
    await serviceWithHook.ensureInitialized("IxADO", "C:/repo");

    await serviceWithHook.createPhase({
      name: "Phase 1",
      branchName: "phase-1",
    });

    expect(callCount).toBe(1);
    expect(lastProjectName).toBe("IxADO");
  });
});

// ---------------------------------------------------------------------------
// P20-002: reconcileInProgressTasks – restart/resume reliability
// ---------------------------------------------------------------------------

describe("ControlCenterService – reconcileInProgressTasks (P20-002)", () => {
  let sandboxDir: string;
  let stateFilePath: string;
  let tasksMarkdownPath: string;
  let service: ControlCenterService;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-reconcile-"));
    stateFilePath = join(sandboxDir, "state.json");
    tasksMarkdownPath = join(sandboxDir, "TASKS.md");
    service = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
    );
    await service.ensureInitialized("IxADO", "C:/repo");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("returns 0 and makes no changes when no IN_PROGRESS tasks exist", async () => {
    const phaseState = await service.createPhase({
      name: "Phase 1",
      branchName: "phase-1",
    });
    const phaseId = phaseState.phases[0].id;
    await service.createTask({
      phaseId,
      title: "Task A",
      description: "First task",
    });
    await service.createTask({
      phaseId,
      title: "Task B",
      description: "Second task",
    });

    const count = await service.reconcileInProgressTasks();

    expect(count).toBe(0);
    const state = await service.getState();
    expect(state.phases[0].tasks[0].status).toBe("TODO");
    expect(state.phases[0].tasks[1].status).toBe("TODO");
  });

  test("resets a single IN_PROGRESS task to TODO", async () => {
    const phaseState = await service.createPhase({
      name: "Phase 1",
      branchName: "phase-1",
    });
    const phaseId = phaseState.phases[0].id;
    await service.createTask({
      phaseId,
      title: "Task A",
      description: "First task",
    });

    // Directly write IN_PROGRESS into state to simulate a crash mid-task
    const engineForManipulation = new StateEngine(stateFilePath);
    const raw = await engineForManipulation.readProjectState();
    raw.phases[0].tasks[0] = {
      ...raw.phases[0].tasks[0],
      status: "IN_PROGRESS",
    };
    await engineForManipulation.writeProjectState(raw);

    const count = await service.reconcileInProgressTasks();

    expect(count).toBe(1);
    const state = await service.getState();
    expect(state.phases[0].tasks[0].status).toBe("TODO");
    expect(state.phases[0].tasks[0].errorLogs).toBeUndefined();
    expect(state.phases[0].tasks[0].resultContext).toBeUndefined();
  });

  test("resets multiple IN_PROGRESS tasks and leaves others unchanged", async () => {
    const phaseState = await service.createPhase({
      name: "Phase 1",
      branchName: "phase-1",
    });
    const phaseId = phaseState.phases[0].id;
    await service.createTask({ phaseId, title: "Task A", description: "desc" });
    await service.createTask({ phaseId, title: "Task B", description: "desc" });
    await service.createTask({ phaseId, title: "Task C", description: "desc" });

    // Simulate crash: Task A=DONE, Task B=IN_PROGRESS, Task C=IN_PROGRESS
    const engineForManipulation = new StateEngine(stateFilePath);
    const raw = await engineForManipulation.readProjectState();
    raw.phases[0].tasks[0] = { ...raw.phases[0].tasks[0], status: "DONE" };
    raw.phases[0].tasks[1] = {
      ...raw.phases[0].tasks[1],
      status: "IN_PROGRESS",
    };
    raw.phases[0].tasks[2] = {
      ...raw.phases[0].tasks[2],
      status: "IN_PROGRESS",
    };
    await engineForManipulation.writeProjectState(raw);

    const count = await service.reconcileInProgressTasks();

    expect(count).toBe(2);
    const state = await service.getState();
    expect(state.phases[0].tasks[0].status).toBe("DONE");
    expect(state.phases[0].tasks[1].status).toBe("TODO");
    expect(state.phases[0].tasks[2].status).toBe("TODO");
  });

  test("reconciles IN_PROGRESS tasks across non-active phases", async () => {
    const first = await service.createPhase({
      name: "Phase 1",
      branchName: "phase-1",
    });
    const phase1Id = first.phases[0].id;
    await service.createTask({
      phaseId: phase1Id,
      title: "Phase 1 Task",
      description: "desc",
    });

    const second = await service.createPhase({
      name: "Phase 2",
      branchName: "phase-2",
    });
    const phase2Id = second.phases.find((phase) => phase.id !== phase1Id)?.id;
    if (!phase2Id) {
      throw new Error("Expected second phase ID");
    }
    await service.createTask({
      phaseId: phase2Id,
      title: "Phase 2 Task",
      description: "desc",
    });

    // Keep phase 2 active to prove phase 1 is also reconciled.
    await service.setActivePhase({ phaseId: phase2Id });

    const engineForManipulation = new StateEngine(stateFilePath);
    const raw = await engineForManipulation.readProjectState();
    raw.phases[0].tasks[0] = {
      ...raw.phases[0].tasks[0],
      status: "IN_PROGRESS",
    };
    raw.phases[1].tasks[0] = {
      ...raw.phases[1].tasks[0],
      status: "IN_PROGRESS",
    };
    await engineForManipulation.writeProjectState(raw);

    const count = await service.reconcileInProgressTasks();

    expect(count).toBe(2);
    const state = await service.getState();
    expect(state.phases[0].tasks[0].status).toBe("TODO");
    expect(state.phases[1].tasks[0].status).toBe("TODO");
  });

  test("is idempotent: second call on already-TODO tasks returns 0", async () => {
    const phaseState = await service.createPhase({
      name: "Phase 1",
      branchName: "phase-1",
    });
    const phaseId = phaseState.phases[0].id;
    await service.createTask({ phaseId, title: "Task A", description: "desc" });

    const engineForManipulation = new StateEngine(stateFilePath);
    const raw = await engineForManipulation.readProjectState();
    raw.phases[0].tasks[0] = {
      ...raw.phases[0].tasks[0],
      status: "IN_PROGRESS",
    };
    await engineForManipulation.writeProjectState(raw);

    const firstCount = await service.reconcileInProgressTasks();
    const secondCount = await service.reconcileInProgressTasks();

    expect(firstCount).toBe(1);
    expect(secondCount).toBe(0);
  });

  test("returns 0 when there are no phases", async () => {
    const count = await service.reconcileInProgressTasks();
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P26-004: reconcileInProgressTaskToTodo – per-task reconciliation for
// UI-initiated agent restart flows
// ---------------------------------------------------------------------------

describe("ControlCenterService – reconcileInProgressTaskToTodo (P26-004)", () => {
  let sandboxDir: string;
  let stateFilePath: string;
  let tasksMarkdownPath: string;
  let service: ControlCenterService;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-reconcile-task-"));
    stateFilePath = join(sandboxDir, "state.json");
    tasksMarkdownPath = join(sandboxDir, "TASKS.md");
    service = new ControlCenterService(
      new StateEngine(stateFilePath),
      tasksMarkdownPath,
    );
    await service.ensureInitialized("IxADO", "C:/repo");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("resets an IN_PROGRESS task to TODO by taskId", async () => {
    const phaseState = await service.createPhase({
      name: "Phase 1",
      branchName: "phase-1",
    });
    const phaseId = phaseState.phases[0].id;
    await service.createTask({
      phaseId,
      title: "Task A",
      description: "First task",
    });

    const engineForManipulation = new StateEngine(stateFilePath);
    const raw = await engineForManipulation.readProjectState();
    const taskId = raw.phases[0].tasks[0].id;
    raw.phases[0].tasks[0] = {
      ...raw.phases[0].tasks[0],
      status: "IN_PROGRESS",
    };
    await engineForManipulation.writeProjectState(raw);

    await service.reconcileInProgressTaskToTodo({ taskId });

    const state = await service.getState();
    expect(state.phases[0].tasks[0].status).toBe("TODO");
    expect(state.phases[0].tasks[0].errorLogs).toBeUndefined();
    expect(state.phases[0].tasks[0].resultContext).toBeUndefined();
  });

  test("leaves non-IN_PROGRESS tasks unchanged (idempotent)", async () => {
    const phaseState = await service.createPhase({
      name: "Phase 1",
      branchName: "phase-1",
    });
    const phaseId = phaseState.phases[0].id;
    await service.createTask({ phaseId, title: "Task A", description: "desc" });

    const engineForManipulation = new StateEngine(stateFilePath);
    const raw = await engineForManipulation.readProjectState();
    const taskId = raw.phases[0].tasks[0].id;
    // Task is already TODO – calling reconcile should be a no-op.
    await service.reconcileInProgressTaskToTodo({ taskId });

    const state = await service.getState();
    expect(state.phases[0].tasks[0].status).toBe("TODO");
  });

  test("is a no-op when taskId is not found", async () => {
    await service.createPhase({ name: "Phase 1", branchName: "phase-1" });

    // Should not throw.
    await expect(
      service.reconcileInProgressTaskToTodo({ taskId: "nonexistent-id" }),
    ).resolves.toBeUndefined();
  });

  test("is a no-op when taskId is empty string", async () => {
    await expect(
      service.reconcileInProgressTaskToTodo({ taskId: "" }),
    ).resolves.toBeUndefined();
  });

  test("only resets the target task, leaving others unchanged", async () => {
    const phaseState = await service.createPhase({
      name: "Phase 1",
      branchName: "phase-1",
    });
    const phaseId = phaseState.phases[0].id;
    await service.createTask({ phaseId, title: "Task A", description: "desc" });
    await service.createTask({ phaseId, title: "Task B", description: "desc" });

    const engineForManipulation = new StateEngine(stateFilePath);
    const raw = await engineForManipulation.readProjectState();
    const taskAId = raw.phases[0].tasks[0].id;
    raw.phases[0].tasks[0] = {
      ...raw.phases[0].tasks[0],
      status: "IN_PROGRESS",
    };
    raw.phases[0].tasks[1] = {
      ...raw.phases[0].tasks[1],
      status: "IN_PROGRESS",
    };
    await engineForManipulation.writeProjectState(raw);

    await service.reconcileInProgressTaskToTodo({ taskId: taskAId });

    const state = await service.getState();
    expect(state.phases[0].tasks[0].status).toBe("TODO");
    expect(state.phases[0].tasks[1].status).toBe("IN_PROGRESS");
  });

  test("finds the task across non-active phases", async () => {
    const first = await service.createPhase({
      name: "Phase 1",
      branchName: "phase-1",
    });
    const phase1Id = first.phases[0].id;
    await service.createTask({
      phaseId: phase1Id,
      title: "Phase 1 Task",
      description: "desc",
    });

    const second = await service.createPhase({
      name: "Phase 2",
      branchName: "phase-2",
    });
    const phase2Id = second.phases.find((p) => p.id !== phase1Id)?.id;
    if (!phase2Id) {
      throw new Error("Expected second phase ID");
    }
    await service.setActivePhase({ phaseId: phase2Id });

    const engineForManipulation = new StateEngine(stateFilePath);
    const raw = await engineForManipulation.readProjectState();
    const taskId = raw.phases[0].tasks[0].id; // task in phase 1 (inactive)
    raw.phases[0].tasks[0] = {
      ...raw.phases[0].tasks[0],
      status: "IN_PROGRESS",
    };
    await engineForManipulation.writeProjectState(raw);

    await service.reconcileInProgressTaskToTodo({ taskId });

    const state = await service.getState();
    expect(state.phases[0].tasks[0].status).toBe("TODO");
  });
});
