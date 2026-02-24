import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ProcessExecutionError, type ProcessRunner } from "../process";
import { detectTesterCommand, runTesterWorkflow } from "./tester-workflow";

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

  test("P17-003: skips tester and does not create CI_FIX when tester defaults are null and no package.json exists", async () => {
    const tempCwd = await mkdtemp(join(tmpdir(), "ixado-no-pkg-"));
    await expect(access(join(tempCwd, "package.json"))).rejects.toBeDefined();
    let runnerCalled = false;
    let fixTaskCreated = false;

    const runner: ProcessRunner = {
      async run() {
        runnerCalled = true;
        throw new Error("runner should not be called when tester is skipped");
      },
    };

    try {
      const result = await runTesterWorkflow({
        phaseId: "11111111-1111-4111-8111-111111111111",
        phaseName: "Phase 17",
        completedTask: {
          id: "22222222-2222-4222-8222-222222222222",
          title: "P17 Task",
        },
        cwd: tempCwd,
        testerCommand: null,
        testerArgs: null,
        testerTimeoutMs: 120_000,
        runner,
        createFixTask: async () => {
          fixTaskCreated = true;
        },
      });

      expect(result.status).toBe("SKIPPED");
      if (result.status !== "SKIPPED") {
        throw new Error("Expected SKIPPED tester result");
      }
      expect(result.reason).toContain("No tester configured");
      expect(runnerCalled).toBe(false);
      expect(fixTaskCreated).toBe(false);
    } finally {
      await rm(tempCwd, { recursive: true, force: true });
    }
  });
});

describe("detectTesterCommand", () => {
  test("P19-001: returns npm test when package.json is present", async () => {
    const tempCwd = await mkdtemp(join(tmpdir(), "ixado-detect-node-"));
    try {
      await writeFile(join(tempCwd, "package.json"), '{"name":"test"}', "utf8");
      const detected = await detectTesterCommand(tempCwd);
      expect(detected).not.toBeNull();
      expect(detected?.command).toBe("npm");
      expect(detected?.args).toEqual(["test"]);
    } finally {
      await rm(tempCwd, { recursive: true, force: true });
    }
  });

  test("P19-001: returns make test when Makefile is present (no package.json)", async () => {
    const tempCwd = await mkdtemp(join(tmpdir(), "ixado-detect-make-"));
    try {
      await writeFile(join(tempCwd, "Makefile"), "test:\n\techo ok\n", "utf8");
      const detected = await detectTesterCommand(tempCwd);
      expect(detected).not.toBeNull();
      expect(detected?.command).toBe("make");
      expect(detected?.args).toEqual(["test"]);
    } finally {
      await rm(tempCwd, { recursive: true, force: true });
    }
  });

  test("P19-001: returns null when neither package.json nor Makefile is present (non-Node repo)", async () => {
    const tempCwd = await mkdtemp(join(tmpdir(), "ixado-detect-none-"));
    try {
      const detected = await detectTesterCommand(tempCwd);
      expect(detected).toBeNull();
    } finally {
      await rm(tempCwd, { recursive: true, force: true });
    }
  });

  test("P19-001: package.json takes precedence over Makefile when both are present", async () => {
    const tempCwd = await mkdtemp(join(tmpdir(), "ixado-detect-both-"));
    try {
      await writeFile(join(tempCwd, "package.json"), '{"name":"test"}', "utf8");
      await writeFile(join(tempCwd, "Makefile"), "test:\n\techo ok\n", "utf8");
      const detected = await detectTesterCommand(tempCwd);
      expect(detected?.command).toBe("npm");
    } finally {
      await rm(tempCwd, { recursive: true, force: true });
    }
  });
});

describe("runTesterWorkflow auto-detection", () => {
  test("P19-001: auto-detects npm test when package.json present and testerCommand/testerArgs are null", async () => {
    const tempCwd = await mkdtemp(join(tmpdir(), "ixado-auto-node-"));
    try {
      await writeFile(join(tempCwd, "package.json"), '{"name":"test"}', "utf8");

      let ranCommand = "";
      let ranArgs: string[] = [];
      const runner: ProcessRunner = {
        async run(input) {
          ranCommand = input.command;
          ranArgs = input.args ?? [];
          return {
            command: input.command,
            args: input.args ?? [],
            cwd: input.cwd ?? "",
            exitCode: 0,
            signal: null,
            stdout: "all tests passed",
            stderr: "",
            durationMs: 50,
          };
        },
      };

      const result = await runTesterWorkflow({
        phaseId: "11111111-1111-4111-8111-111111111111",
        phaseName: "Phase 19",
        completedTask: {
          id: "22222222-2222-4222-8222-222222222222",
          title: "P19 Task",
        },
        cwd: tempCwd,
        testerCommand: null,
        testerArgs: null,
        testerTimeoutMs: 120_000,
        runner,
        createFixTask: async () => {},
      });

      expect(result.status).toBe("PASSED");
      expect(ranCommand).toBe("npm");
      expect(ranArgs).toEqual(["test"]);
    } finally {
      await rm(tempCwd, { recursive: true, force: true });
    }
  });

  test("P19-001: auto-detects make test when Makefile present and testerCommand/testerArgs are null", async () => {
    const tempCwd = await mkdtemp(join(tmpdir(), "ixado-auto-make-"));
    try {
      await writeFile(join(tempCwd, "Makefile"), "test:\n\techo ok\n", "utf8");

      let ranCommand = "";
      const runner: ProcessRunner = {
        async run(input) {
          ranCommand = input.command;
          return {
            command: input.command,
            args: input.args ?? [],
            cwd: input.cwd ?? "",
            exitCode: 0,
            signal: null,
            stdout: "make test passed",
            stderr: "",
            durationMs: 50,
          };
        },
      };

      const result = await runTesterWorkflow({
        phaseId: "11111111-1111-4111-8111-111111111111",
        phaseName: "Phase 19",
        completedTask: {
          id: "22222222-2222-4222-8222-222222222222",
          title: "P19 Task",
        },
        cwd: tempCwd,
        testerCommand: null,
        testerArgs: null,
        testerTimeoutMs: 120_000,
        runner,
        createFixTask: async () => {},
      });

      expect(result.status).toBe("PASSED");
      expect(ranCommand).toBe("make");
    } finally {
      await rm(tempCwd, { recursive: true, force: true });
    }
  });

  test("P19-001: skips tester without CI_FIX when no known test runner detected (non-Node repo)", async () => {
    const tempCwd = await mkdtemp(join(tmpdir(), "ixado-auto-none-"));
    let runnerCalled = false;
    let fixTaskCreated = false;

    const runner: ProcessRunner = {
      async run() {
        runnerCalled = true;
        throw new Error("runner should not be called");
      },
    };

    try {
      const result = await runTesterWorkflow({
        phaseId: "11111111-1111-4111-8111-111111111111",
        phaseName: "Phase 19",
        completedTask: {
          id: "22222222-2222-4222-8222-222222222222",
          title: "P19 Task",
        },
        cwd: tempCwd,
        testerCommand: null,
        testerArgs: null,
        testerTimeoutMs: 120_000,
        runner,
        createFixTask: async () => {
          fixTaskCreated = true;
        },
      });

      expect(result.status).toBe("SKIPPED");
      if (result.status !== "SKIPPED") {
        throw new Error("Expected SKIPPED");
      }
      expect(result.reason).toContain("no known test runner detected");
      expect(runnerCalled).toBe(false);
      expect(fixTaskCreated).toBe(false);
    } finally {
      await rm(tempCwd, { recursive: true, force: true });
    }
  });
});
