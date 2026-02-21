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
      activePhaseId: phaseId,
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

  test("fails fast when state file is missing", async () => {
    const engine = new StateEngine(stateFilePath);

    await expect(engine.readProjectState()).rejects.toThrow(
      `State file not found: ${stateFilePath}`
    );
  });

  test("fails fast when state file is invalid JSON", async () => {
    const engine = new StateEngine(stateFilePath);
    await writeFile(stateFilePath, "{invalid", "utf8");

    await expect(engine.readProjectState()).rejects.toThrow(
      `State file contains invalid JSON: ${stateFilePath}`
    );
  });

  test("fails fast when state file does not match schema", async () => {
    const engine = new StateEngine(stateFilePath);
    await writeFile(stateFilePath, JSON.stringify({ projectName: "IxADO" }), "utf8");

    await expect(engine.readProjectState()).rejects.toThrow();
  });
});
