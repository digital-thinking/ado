import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StateEngine } from "./engine";

describe("StateEngine", () => {
  let sandboxDir: string;
  let stateFilePath: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-state-engine-"));
    stateFilePath = join(sandboxDir, "state.json");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("initializes and reads state from disk", async () => {
    const engine = new StateEngine(stateFilePath);

    const initialized = await engine.initialize({
      projectName: "IxADO",
      rootDir: "C:/Users/chris/scm/ado",
    });

    const loaded = await engine.readProjectState();

    expect(loaded).toEqual(initialized);
    expect(loaded.phases).toEqual([]);
  });

  test("writes and reads tasks for a phase", async () => {
    const engine = new StateEngine(stateFilePath);
    const phaseId = randomUUID();
    const taskId = randomUUID();

    await engine.writeProjectState({
      projectName: "IxADO",
      rootDir: "C:/Users/chris/scm/ado",
      phases: [
        {
          id: phaseId,
          name: "Phase 1",
          branchName: "phase-1-foundation-state-management",
          status: "CODING",
          tasks: [],
        },
      ],
      activePhaseIds: [phaseId],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await engine.writeTasks(phaseId, [
      {
        id: taskId,
        title: "Implement state engine",
        description: "Persist and validate project state",
        status: "DONE",
        assignee: "CODEX_CLI",
        dependencies: [],
      },
    ]);

    const tasks = await engine.readTasks(phaseId);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(taskId);
    expect(tasks[0]?.status).toBe("DONE");
  });

  test("maps legacy activePhaseId to activePhaseIds on load", async () => {
    const phaseId = randomUUID();
    const now = new Date().toISOString();
    const engine = new StateEngine(stateFilePath);

    await writeFile(
      stateFilePath,
      JSON.stringify(
        {
          projectName: "IxADO",
          rootDir: "C:/Users/chris/scm/ado",
          phases: [
            {
              id: phaseId,
              name: "Phase Legacy",
              branchName: "phase-legacy",
              status: "PLANNING",
              tasks: [],
            },
          ],
          activePhaseId: phaseId,
          createdAt: now,
          updatedAt: now,
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = await engine.readProjectState();
    expect(loaded.activePhaseIds).toEqual([phaseId]);
  });

  test("serializes concurrent writeTasks across engine instances for the same file", async () => {
    const firstEngine = new StateEngine(stateFilePath);
    const secondEngine = new StateEngine(stateFilePath);
    const phaseAId = randomUUID();
    const phaseBId = randomUUID();
    const taskAId = randomUUID();
    const taskBId = randomUUID();

    await firstEngine.writeProjectState({
      projectName: "IxADO",
      rootDir: "C:/Users/chris/scm/ado",
      phases: [
        {
          id: phaseAId,
          name: "Phase A",
          branchName: "phase-a",
          status: "CODING",
          tasks: [],
        },
        {
          id: phaseBId,
          name: "Phase B",
          branchName: "phase-b",
          status: "CODING",
          tasks: [],
        },
      ],
      activePhaseIds: [phaseAId],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await Promise.all([
      firstEngine.writeTasks(phaseAId, [
        {
          id: taskAId,
          title: "Task A",
          description: "Update phase A",
          status: "DONE",
          assignee: "CODEX_CLI",
          dependencies: [],
        },
      ]),
      secondEngine.writeTasks(phaseBId, [
        {
          id: taskBId,
          title: "Task B",
          description: "Update phase B",
          status: "DONE",
          assignee: "CODEX_CLI",
          dependencies: [],
        },
      ]),
    ]);

    const loaded = await firstEngine.readProjectState();
    const phaseA = loaded.phases.find((phase) => phase.id === phaseAId);
    const phaseB = loaded.phases.find((phase) => phase.id === phaseBId);
    expect(phaseA?.tasks).toHaveLength(1);
    expect(phaseA?.tasks[0]?.id).toBe(taskAId);
    expect(phaseB?.tasks).toHaveLength(1);
    expect(phaseB?.tasks[0]?.id).toBe(taskBId);
  });

  test("fails fast when state file is missing", async () => {
    const engine = new StateEngine(stateFilePath);

    await expect(engine.readProjectState()).rejects.toThrow(
      `State file not found: ${stateFilePath}`,
    );
  });

  test("fails fast when state file is invalid JSON", async () => {
    const engine = new StateEngine(stateFilePath);
    await writeFile(stateFilePath, "{invalid", "utf8");

    await expect(engine.readProjectState()).rejects.toThrow(
      `State file contains invalid JSON: ${stateFilePath}`,
    );
  });

  test("fails fast when state file does not match schema", async () => {
    const engine = new StateEngine(stateFilePath);
    await writeFile(
      stateFilePath,
      JSON.stringify({ projectName: "IxADO" }),
      "utf8",
    );

    await expect(engine.readProjectState()).rejects.toThrow();
  });
});
