import { afterEach, describe, expect, test } from "bun:test";
import { TestSandbox, runIxado } from "./test-helpers";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

describe("P20-005 CLI reliability regression tests", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((s) => s.cleanup()));
    sandboxes.length = 0;
  });

  test("P20-002: CLI reconciles stale RUNNING agents and IN_PROGRESS tasks on startup", async () => {
    const sandbox = await TestSandbox.create("ixado-p20-reconcile-");
    sandboxes.push(sandbox);

    const phaseId = randomUUID();
    const taskId = randomUUID();
    const now = new Date().toISOString();

    const initialState = {
      projectName: "test-project",
      rootDir: sandbox.projectDir,
      createdAt: now,
      updatedAt: now,
      activePhaseId: phaseId,
      phases: [
        {
          id: phaseId,
          name: "Phase 1",
          branchName: "feature/p1",
          status: "CODING",
          tasks: [
            {
              id: taskId,
              title: "Stale Task",
              description: "This task was left IN_PROGRESS",
              status: "IN_PROGRESS",
              assignee: "MOCK_CLI",
              dependencies: [],
            },
          ],
        },
      ],
    };

    const initialAgents = [
      {
        id: randomUUID(),
        name: "MOCK_CLI",
        command: "mock-command",
        args: [],
        cwd: sandbox.projectDir,
        status: "RUNNING",
        startedAt: now,
        outputTail: [],
      },
    ];

    await sandbox.writeProjectState(initialState as any);
    await sandbox.writeAgents(initialAgents);

    const result = runIxado(["phase", "run", "auto", "0"], sandbox);

    // Verify reconciliation messages are present in stdout
    expect(result.stdout).toContain(
      "reconciled 1 stale RUNNING agent(s) to STOPPED",
    );
    expect(result.stdout).toContain("reconciled 1 IN_PROGRESS task(s) to TODO");

    // Verify state files are updated
    const finalState = await sandbox.readProjectState();
    expect(finalState.phases[0].tasks[0].status).toBe("TODO");
  });

  test("P20-003: preflight checks fail for terminal status in CLI", async () => {
    const sandbox = await TestSandbox.create("ixado-p20-preflight-terminal-");
    sandboxes.push(sandbox);

    const phaseId = randomUUID();
    const initialState = {
      projectName: "test-project",
      rootDir: sandbox.projectDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activePhaseId: phaseId,
      phases: [
        {
          id: phaseId,
          name: "Phase 1",
          branchName: "feature/done",
          status: "DONE",
          tasks: [],
        },
      ],
    };

    await sandbox.writeProjectState(initialState as any);

    const result = runIxado(["phase", "run", "auto", "0"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('in terminal status "DONE"');
  });

  test("P20-003: preflight checks fail for missing branchName in CLI", async () => {
    const sandbox = await TestSandbox.create(
      "ixado-p20-preflight-missing-branch-",
    );
    sandboxes.push(sandbox);

    const phaseId = randomUUID();
    const initialState = {
      projectName: "test-project",
      rootDir: sandbox.projectDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activePhaseId: phaseId,
      phases: [
        {
          id: phaseId,
          name: "Phase 1",
          branchName: "",
          status: "PLANNING",
          tasks: [],
        },
      ],
    };

    await sandbox.writeProjectState(initialState as any);

    const result = runIxado(["phase", "run", "auto", "0"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("has an empty or missing branchName");
  });
});
