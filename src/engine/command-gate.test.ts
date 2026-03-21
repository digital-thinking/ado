import { describe, test, expect } from "bun:test";
import { CommandGate } from "./command-gate";
import type { GateContext } from "./gate";
import type {
  ProcessRunOptions,
  ProcessRunResult,
  ProcessRunner,
} from "../process";
import { ProcessExecutionError } from "../process";

const baseContext: GateContext = {
  phaseId: "phase-1",
  phaseName: "Test Phase",
  phase: {
    id: "phase-1",
    name: "Test Phase",
    status: "CODING",
    branchName: "test-branch",
    tasks: [],
  } as any,
  cwd: "/tmp/project",
  baseBranch: "main",
  headBranch: "test-branch",
  vcsProviderType: "github",
};

function mockRunner(result: Partial<ProcessRunResult>): ProcessRunner {
  return {
    async run(_opts: ProcessRunOptions): Promise<ProcessRunResult> {
      return {
        command: "test",
        args: [],
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 100,
        ...result,
      };
    },
  };
}

function throwingRunner(error: Error): ProcessRunner {
  return {
    async run(_opts: ProcessRunOptions): Promise<ProcessRunResult> {
      throw error;
    },
  };
}

describe("CommandGate", () => {
  test("passes when exit code is 0", async () => {
    const gate = new CommandGate(
      { command: "npm", args: ["test"] },
      mockRunner({ exitCode: 0, stdout: "All tests passed\n" }),
    );
    const result = await gate.evaluate(baseContext);

    expect(result.passed).toBe(true);
    expect(result.gate).toBe("command:npm");
    expect(result.diagnostics).toContain("All tests passed");
    expect(result.retryable).toBe(false);
  });

  test("fails when exit code is non-zero", async () => {
    const gate = new CommandGate(
      { command: "npm", args: ["test"] },
      mockRunner({ exitCode: 1, stderr: "3 tests failed\n" }),
    );
    const result = await gate.evaluate(baseContext);

    expect(result.passed).toBe(false);
    expect(result.diagnostics).toContain("3 tests failed");
    expect(result.retryable).toBe(false);
  });

  test("captures combined stdout and stderr", async () => {
    const gate = new CommandGate(
      { command: "lint" },
      mockRunner({
        exitCode: 1,
        stdout: "Checking files...\n",
        stderr: "Error in main.ts:10\n",
      }),
    );
    const result = await gate.evaluate(baseContext);

    expect(result.passed).toBe(false);
    expect(result.diagnostics).toContain("Checking files...");
    expect(result.diagnostics).toContain("Error in main.ts:10");
  });

  test("returns retryable on exception", async () => {
    const gate = new CommandGate(
      { command: "flaky" },
      throwingRunner(new Error("ECONNRESET")),
    );
    const result = await gate.evaluate(baseContext);

    expect(result.passed).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.diagnostics).toContain("ECONNRESET");
  });

  test("treats process exit failures as non-retryable and surfaces output", async () => {
    const gate = new CommandGate(
      { command: "npm", args: ["test"] },
      throwingRunner(
        new ProcessExecutionError("Command failed", {
          command: "npm",
          args: ["test"],
          cwd: "/tmp/project",
          exitCode: 1,
          signal: null,
          stdout: "Checking...\n",
          stderr: "3 tests failed\n",
          durationMs: 10,
        }),
      ),
    );
    const result = await gate.evaluate(baseContext);

    expect(result.passed).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.diagnostics).toContain("Checking...");
    expect(result.diagnostics).toContain("3 tests failed");
  });

  test("passes cwd from context", async () => {
    let capturedCwd: string | undefined;
    const runner: ProcessRunner = {
      async run(opts: ProcessRunOptions): Promise<ProcessRunResult> {
        capturedCwd = opts.cwd;
        return {
          command: "test",
          args: [],
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 10,
        };
      },
    };

    const gate = new CommandGate({ command: "check" }, runner);
    await gate.evaluate({ ...baseContext, cwd: "/custom/dir" });

    expect(capturedCwd).toBe("/custom/dir");
  });

  test("uses default timeout when not configured", async () => {
    let capturedTimeout: number | undefined;
    const runner: ProcessRunner = {
      async run(opts: ProcessRunOptions): Promise<ProcessRunResult> {
        capturedTimeout = opts.timeoutMs;
        return {
          command: "test",
          args: [],
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 10,
        };
      },
    };

    const gate = new CommandGate({ command: "check" }, runner);
    await gate.evaluate(baseContext);

    expect(capturedTimeout).toBe(300_000);
  });

  test("uses custom timeout when configured", async () => {
    let capturedTimeout: number | undefined;
    const runner: ProcessRunner = {
      async run(opts: ProcessRunOptions): Promise<ProcessRunResult> {
        capturedTimeout = opts.timeoutMs;
        return {
          command: "test",
          args: [],
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 10,
        };
      },
    };

    const gate = new CommandGate(
      { command: "check", timeoutMs: 60_000 },
      runner,
    );
    await gate.evaluate(baseContext);

    expect(capturedTimeout).toBe(60_000);
  });

  test("name includes command", () => {
    const gate = new CommandGate(
      { command: "bun", args: ["test"] },
      mockRunner({}),
    );
    expect(gate.name).toBe("command:bun");
  });
});
