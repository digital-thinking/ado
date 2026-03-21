import { describe, test, expect } from "bun:test";
import { AiEvalGate } from "./ai-eval-gate";
import type { GateContext } from "./gate";
import type {
  ProcessRunOptions,
  ProcessRunResult,
  ProcessRunner,
} from "../process";

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
        command: "ai",
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

function diffRunner(diff: string): ProcessRunner {
  return mockRunner({ stdout: diff });
}

function sequenceRunner(results: Partial<ProcessRunResult>[]): ProcessRunner {
  let callIndex = 0;
  return {
    async run(_opts: ProcessRunOptions): Promise<ProcessRunResult> {
      const result = results[callIndex++] ?? results[results.length - 1];
      return {
        command: "ai",
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

describe("AiEvalGate", () => {
  test("passes when response contains PASS keyword", async () => {
    const gate = new AiEvalGate(
      { command: "codex", rubric: "Code must be clean" },
      mockRunner({ stdout: "PASS - Code looks good" }),
      diffRunner("+ added line"),
    );
    const result = await gate.evaluate(baseContext);

    expect(result.passed).toBe(true);
    expect(result.diagnostics).toContain("PASS");
  });

  test("fails when response contains FAIL keyword", async () => {
    const gate = new AiEvalGate(
      { command: "codex", rubric: "No console.log" },
      mockRunner({ stdout: "FAIL - Found console.log on line 5" }),
      diffRunner("+ console.log('debug')"),
    );
    const result = await gate.evaluate(baseContext);

    expect(result.passed).toBe(false);
    expect(result.diagnostics).toContain("console.log");
  });

  test("passes with APPROVED keyword", async () => {
    const gate = new AiEvalGate(
      { command: "codex", rubric: "Check" },
      mockRunner({ stdout: "Changes are APPROVED" }),
      diffRunner("+ new code"),
    );
    const result = await gate.evaluate(baseContext);
    expect(result.passed).toBe(true);
  });

  test("fails with REJECTED keyword", async () => {
    const gate = new AiEvalGate(
      { command: "codex", rubric: "Check" },
      mockRunner({ stdout: "REJECTED due to security" }),
      diffRunner("+ eval(input)"),
    );
    const result = await gate.evaluate(baseContext);
    expect(result.passed).toBe(false);
  });

  test("custom pass/fail keywords", async () => {
    const gate = new AiEvalGate(
      {
        command: "codex",
        rubric: "Check",
        passKeywords: ["LGTM"],
        failKeywords: ["NOPE"],
      },
      mockRunner({ stdout: "LGTM, ship it" }),
      diffRunner("+ code"),
    );
    const result = await gate.evaluate(baseContext);
    expect(result.passed).toBe(true);
  });

  test("no keyword match returns retryable fail", async () => {
    const gate = new AiEvalGate(
      { command: "codex", rubric: "Check" },
      mockRunner({ stdout: "I'm not sure about this..." }),
      diffRunner("+ code"),
    );
    const result = await gate.evaluate(baseContext);

    expect(result.passed).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.diagnostics).toContain("No pass/fail keyword");
  });

  test("retries on FAIL up to maxRetries", async () => {
    let callCount = 0;
    const aiRunner: ProcessRunner = {
      async run(_opts: ProcessRunOptions): Promise<ProcessRunResult> {
        callCount++;
        return {
          command: "ai",
          args: [],
          exitCode: 0,
          signal: null,
          stdout: callCount <= 2 ? "FAIL - not yet" : "PASS - fixed",
          stderr: "",
          durationMs: 100,
        };
      },
    };

    const gate = new AiEvalGate(
      { command: "codex", rubric: "Check", maxRetries: 2 },
      aiRunner,
      diffRunner("+ code"),
    );
    const result = await gate.evaluate(baseContext);

    expect(result.passed).toBe(true);
    expect(callCount).toBe(3);
  });

  test("gives up after maxRetries exhausted", async () => {
    const gate = new AiEvalGate(
      { command: "codex", rubric: "Check", maxRetries: 1 },
      mockRunner({ stdout: "FAIL - bad code" }),
      diffRunner("+ code"),
    );
    const result = await gate.evaluate(baseContext);

    expect(result.passed).toBe(false);
    expect(result.retryable).toBe(false);
  });

  test("passes immediately when no diff", async () => {
    const gate = new AiEvalGate(
      { command: "codex", rubric: "Check" },
      mockRunner({ stdout: "should not be called" }),
      diffRunner(""),
    );
    const result = await gate.evaluate(baseContext);

    expect(result.passed).toBe(true);
    expect(result.diagnostics).toContain("No diff");
  });

  test("returns retryable on diff failure", async () => {
    const failDiff: ProcessRunner = {
      async run(_opts: ProcessRunOptions): Promise<ProcessRunResult> {
        throw new Error("git not found");
      },
    };

    const gate = new AiEvalGate(
      { command: "codex", rubric: "Check" },
      mockRunner({}),
      failDiff,
    );
    const result = await gate.evaluate(baseContext);

    expect(result.passed).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.diagnostics).toContain("git not found");
  });

  test("returns retryable on adapter failure", async () => {
    const failRunner: ProcessRunner = {
      async run(_opts: ProcessRunOptions): Promise<ProcessRunResult> {
        throw new Error("API timeout");
      },
    };

    const gate = new AiEvalGate(
      { command: "codex", rubric: "Check" },
      failRunner,
      diffRunner("+ code"),
    );
    const result = await gate.evaluate(baseContext);

    expect(result.passed).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.diagnostics).toContain("API timeout");
  });

  test("keyword matching is case-insensitive", async () => {
    const gate = new AiEvalGate(
      { command: "codex", rubric: "Check" },
      mockRunner({ stdout: "pass - looks fine" }),
      diffRunner("+ code"),
    );
    const result = await gate.evaluate(baseContext);
    expect(result.passed).toBe(true);
  });
});
