import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StateEngine } from "../state";
import { ControlCenterService } from "./control-center-service";

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
