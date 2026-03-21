import { describe, test, expect } from "bun:test";
import {
  runGateChain,
  type Gate,
  type GateContext,
  type GateResult,
} from "./gate";

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

function createGate(
  name: string,
  passed: boolean,
  diagnostics = "",
  retryable = false,
): Gate {
  return {
    name,
    async evaluate(_ctx: GateContext): Promise<GateResult> {
      return { gate: name, passed, diagnostics, retryable };
    },
  };
}

describe("runGateChain", () => {
  test("empty gate chain passes", async () => {
    const result = await runGateChain([], baseContext);
    expect(result.passed).toBe(true);
    expect(result.results).toEqual([]);
  });

  test("single passing gate returns passed", async () => {
    const result = await runGateChain(
      [createGate("check", true, "All good")],
      baseContext,
    );
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].gate).toBe("check");
    expect(result.results[0].passed).toBe(true);
  });

  test("single failing gate returns failed", async () => {
    const result = await runGateChain(
      [createGate("check", false, "Coverage below 80%")],
      baseContext,
    );
    expect(result.passed).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].diagnostics).toBe("Coverage below 80%");
  });

  test("multiple gates execute in order, all pass", async () => {
    const result = await runGateChain(
      [
        createGate("lint", true),
        createGate("coverage", true),
        createGate("ci", true),
      ],
      baseContext,
    );
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.results.map((r) => r.gate)).toEqual([
      "lint",
      "coverage",
      "ci",
    ]);
  });

  test("stops at first failure", async () => {
    const result = await runGateChain(
      [
        createGate("lint", true),
        createGate("coverage", false, "Too low"),
        createGate("ci", true),
      ],
      baseContext,
    );
    expect(result.passed).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].passed).toBe(true);
    expect(result.results[1].passed).toBe(false);
    // ci gate was never reached
  });

  test("retryable flag is preserved in result", async () => {
    const result = await runGateChain(
      [createGate("flaky", false, "Timeout", true)],
      baseContext,
    );
    expect(result.passed).toBe(false);
    expect(result.results[0].retryable).toBe(true);
  });

  test("calls onGateStart and onGateResult callbacks", async () => {
    const started: string[] = [];
    const finished: string[] = [];

    await runGateChain(
      [createGate("a", true), createGate("b", true)],
      baseContext,
      {
        onGateStart: (gate) => {
          started.push(gate.name);
        },
        onGateResult: (gate, result) => {
          finished.push(`${gate.name}:${result.passed}`);
        },
      },
    );

    expect(started).toEqual(["a", "b"]);
    expect(finished).toEqual(["a:true", "b:true"]);
  });

  test("onGateResult is called even on failure", async () => {
    const results: string[] = [];

    await runGateChain(
      [createGate("a", true), createGate("b", false, "fail")],
      baseContext,
      {
        onGateResult: (gate, result) => {
          results.push(`${gate.name}:${result.passed}`);
        },
      },
    );

    expect(results).toEqual(["a:true", "b:false"]);
  });
});
