import { afterEach, describe, expect, test } from "bun:test";

import { TestSandbox, runIxado } from "./test-helpers";

describe("task logs readability", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((sandbox) => sandbox.cleanup()));
    sandboxes.length = 0;
  });

  test("FAILED task logs include context, concise summary, and recovery trace links", async () => {
    const sandbox = await TestSandbox.create("ixado-task-logs-readable-");
    sandboxes.push(sandbox);

    expect(
      runIxado(
        ["phase", "create", "Phase 22", "phase-22-log-readable"],
        sandbox,
      ).exitCode,
    ).toBe(0);
    expect(
      runIxado(
        ["task", "create", "P22-004", "Improve per-agent logs", "CODEX_CLI"],
        sandbox,
      ).exitCode,
    ).toBe(0);

    const state = await sandbox.readProjectState();
    const phase = state.phases[0];
    if (!phase) {
      throw new Error("Missing phase in sandbox state.");
    }
    const task = phase.tasks[0];
    if (!task) {
      throw new Error("Missing task in sandbox state.");
    }

    task.status = "FAILED";
    task.errorLogs = [
      "stdout: booting",
      "Error: adapter command failed with exit code 2",
      "trace: stack here",
    ].join("\n");
    task.recoveryAttempts = [
      {
        id: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        attemptNumber: 1,
        exception: {
          category: "AGENT_FAILURE",
          message: "failed",
          phaseId: phase.id,
          taskId: task.id,
        },
        result: {
          status: "fixed",
          reasoning: "applied retry patch",
        },
      },
    ];

    await sandbox.writeProjectState(state);

    const result = runIxado(["task", "logs", "1"], sandbox);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Task #1: P22-004 [FAILED]");
    expect(result.stdout).toContain(
      "Context: phase: Phase 22 | task #1 P22-004",
    );
    expect(result.stdout).toContain(
      "Failure summary: Error: adapter command failed with exit code 2",
    );
    expect(result.stdout).toContain("Recovery traces: Task card=#task-card-");
    expect(result.stdout).toContain("Recovery attempt 1=#task-recovery-");
    expect(result.stdout).toContain(
      "Error: adapter command failed with exit code 2",
    );
  });
});
