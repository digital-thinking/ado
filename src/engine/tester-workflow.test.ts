import { describe, expect, test } from "bun:test";

import { ProcessExecutionError, type ProcessRunner } from "../process";
import { runTesterWorkflow } from "./tester-workflow";

describe("runTesterWorkflow", () => {
  test("passes when tester command succeeds", async () => {
    const runner: ProcessRunner = {
      async run() {
        return {
          command: "npm",
          args: ["run", "test"],
          cwd: "C:/repo",
          exitCode: 0,
          signal: null,
          stdout: "all green",
          stderr: "",
          durationMs: 100,
        };
      },
    };
    let fixTaskCreated = false;

    const result = await runTesterWorkflow({
      phaseId: "11111111-1111-4111-8111-111111111111",
      phaseName: "Phase 5",
      completedTask: {
        id: "22222222-2222-4222-8222-222222222222",
        title: "P5-004 Implement Tester workflow",
      },
      cwd: "C:/repo",
      testerCommand: "npm",
      testerArgs: ["run", "test"],
      testerTimeoutMs: 120_000,
      runner,
      createFixTask: async () => {
        fixTaskCreated = true;
      },
    });

    expect(result.status).toBe("PASSED");
    if (result.status !== "PASSED") {
      throw new Error("Expected PASSED tester result");
    }
    expect(fixTaskCreated).toBe(false);
    expect(result.output).toContain("all green");
  });

  test("creates fix task when tester command fails", async () => {
    const runner: ProcessRunner = {
      async run() {
        throw new ProcessExecutionError("test failed", {
          command: "npm",
          args: ["run", "test"],
          cwd: "C:/repo",
          exitCode: 1,
          signal: null,
          stdout: "failing test output",
          stderr: "stack trace",
          durationMs: 10,
        });
      },
    };
    const createdFixTasks: Array<{
      phaseId: string;
      title: string;
      description: string;
      dependencies: string[];
      status: "CI_FIX";
    }> = [];

    const result = await runTesterWorkflow({
      phaseId: "11111111-1111-4111-8111-111111111111",
      phaseName: "Phase 5",
      completedTask: {
        id: "22222222-2222-4222-8222-222222222222",
        title: "P5-003 Implement session persistence",
      },
      cwd: "C:/repo",
      testerCommand: "npm",
      testerArgs: ["run", "test"],
      testerTimeoutMs: 120_000,
      runner,
      createFixTask: async (input) => {
        createdFixTasks.push(input);
      },
    });

    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") {
      throw new Error("Expected FAILED tester result");
    }
    expect(result.fixTaskTitle).toContain("Fix tests after");
    expect(createdFixTasks).toHaveLength(1);
    expect(createdFixTasks[0]?.dependencies).toEqual([
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(createdFixTasks[0]?.status).toBe("CI_FIX");
    expect(createdFixTasks[0]?.description).toContain("failing test output");
    expect(createdFixTasks[0]?.description).toContain("stack trace");
  });

  test("truncates large tester output in fix task description", async () => {
    const runner: ProcessRunner = {
      async run() {
        throw new ProcessExecutionError("test failed", {
          command: "npm",
          args: ["run", "test"],
          cwd: "C:/repo",
          exitCode: 1,
          signal: null,
          stdout: "x".repeat(200),
          stderr: "",
          durationMs: 10,
        });
      },
    };
    let capturedDescription = "";

    await runTesterWorkflow({
      phaseId: "11111111-1111-4111-8111-111111111111",
      phaseName: "Phase 5",
      completedTask: {
        id: "22222222-2222-4222-8222-222222222222",
        title: "P5-003 Implement session persistence",
      },
      cwd: "C:/repo",
      testerCommand: "npm",
      testerArgs: ["run", "test"],
      testerTimeoutMs: 120_000,
      runner,
      maxOutputLength: 50,
      createFixTask: async (input) => {
        capturedDescription = input.description;
      },
    });

    expect(capturedDescription).toContain("[truncated]");
  });
});
