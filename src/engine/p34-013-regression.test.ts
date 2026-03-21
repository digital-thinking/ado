import { describe, expect, test } from "bun:test";

import {
  ExecutionLoopSettingsSchema,
  GateConfigSchema,
  type GateConfig,
} from "../types";
import {
  createRuntimeEvent,
  formatRuntimeEventForCli,
  formatRuntimeEventForTelegram,
  shouldNotifyRuntimeEventForTelegram,
  type RuntimeEvent,
} from "../types/runtime-events";
import { createVcsProvider } from "../vcs/create-vcs-provider";
import { GitHubProvider } from "../vcs/github-provider";
import { LocalProvider } from "../vcs/local-provider";
import { NullProvider } from "../vcs/null-provider";
import { MockProcessRunner } from "../vcs/test-utils";

import { AiEvalGate } from "./ai-eval-gate";
import { CommandGate } from "./command-gate";
import { CoverageGate } from "./coverage-gate";
import type { Gate, GateContext, GateResult } from "./gate";
import { runGateChain } from "./gate";
import { createGatesFromConfig } from "./gate-factory";
import { PrCiGate } from "./pr-ci-gate";

describe("P34-013 regression: VcsProvider routing", () => {
  test("createVcsProvider routes 'github' to GitHubProvider", () => {
    const runner = new MockProcessRunner();
    const provider = createVcsProvider("github", runner);
    expect(provider).toBeInstanceOf(GitHubProvider);
  });

  test("createVcsProvider routes 'local' to LocalProvider", () => {
    const runner = new MockProcessRunner();
    const provider = createVcsProvider("local", runner);
    expect(provider).toBeInstanceOf(LocalProvider);
  });

  test("createVcsProvider routes 'null' to NullProvider", () => {
    const runner = new MockProcessRunner();
    const provider = createVcsProvider("null", runner);
    expect(provider).toBeInstanceOf(NullProvider);
  });
});

describe("P34-013 regression: gate factory", () => {
  test("createGatesFromConfig maps all gate types", () => {
    const configs: GateConfig[] = [
      { type: "command", command: "npm test" },
      { type: "coverage", reportPath: "coverage/lcov.info", minPct: 80 },
      {
        type: "ai_eval",
        command: "ai-review",
        rubric: "Code must be well-structured",
      },
      { type: "pr_ci" },
    ];
    const runner = new MockProcessRunner();
    const vcsProvider = createVcsProvider("github", runner);
    const gates = createGatesFromConfig(configs, runner, vcsProvider, "github");

    expect(gates).toHaveLength(4);
    expect(gates[0]).toBeInstanceOf(CommandGate);
    expect(gates[1]).toBeInstanceOf(CoverageGate);
    expect(gates[2]).toBeInstanceOf(AiEvalGate);
    expect(gates[3]).toBeInstanceOf(PrCiGate);
  });

  test("createGatesFromConfig returns empty array for no configs", () => {
    const runner = new MockProcessRunner();
    const vcsProvider = createVcsProvider("null", runner);
    const gates = createGatesFromConfig([], runner, vcsProvider, "null");
    expect(gates).toHaveLength(0);
  });

  test("gate names match their type identifiers", () => {
    const configs: GateConfig[] = [
      { type: "command", command: "echo ok" },
      { type: "coverage", reportPath: "cov.info", minPct: 50 },
      { type: "ai_eval", command: "eval", rubric: "Check quality" },
      { type: "pr_ci" },
    ];
    const runner = new MockProcessRunner();
    const vcsProvider = createVcsProvider("null", runner);
    const gates = createGatesFromConfig(configs, runner, vcsProvider, "null");

    expect(gates[0].name).toContain("command");
    expect(gates[1].name).toContain("coverage");
    expect(gates[2].name).toContain("ai_eval");
    expect(gates[3].name).toContain("pr_ci");
  });
});

describe("P34-013 regression: legacy config migration", () => {
  test("ciEnabled: true migrates to vcsProvider: github", () => {
    const result = ExecutionLoopSettingsSchema.parse({
      ciEnabled: true,
    });
    expect(result.vcsProvider).toBe("github");
  });

  test("ciEnabled: false keeps vcsProvider: null", () => {
    const result = ExecutionLoopSettingsSchema.parse({
      ciEnabled: false,
    });
    expect(result.vcsProvider).toBe("null");
  });

  test("vcsProvider: github with empty gates auto-adds pr_ci gate", () => {
    const result = ExecutionLoopSettingsSchema.parse({
      vcsProvider: "github",
    });
    expect(result.gates).toEqual([{ type: "pr_ci" }]);
  });

  test("vcsProvider: github with explicit gates does not auto-add pr_ci", () => {
    const result = ExecutionLoopSettingsSchema.parse({
      vcsProvider: "github",
      gates: [{ type: "command", command: "npm test" }],
    });
    expect(result.gates).toEqual([{ type: "command", command: "npm test" }]);
  });

  test("ciEnabled: true migrates to github and adds pr_ci gate in single pass", () => {
    const result = ExecutionLoopSettingsSchema.parse({
      ciEnabled: true,
      gates: [],
    });
    expect(result.vcsProvider).toBe("github");
    expect(result.gates).toEqual([{ type: "pr_ci" }]);
  });

  test("ciEnabled: true without explicit gates also adds pr_ci", () => {
    const result = ExecutionLoopSettingsSchema.parse({ ciEnabled: true });
    expect(result.vcsProvider).toBe("github");
    expect(result.gates).toEqual([{ type: "pr_ci" }]);
  });

  test("vcsProvider: local does not trigger auto-migration", () => {
    const result = ExecutionLoopSettingsSchema.parse({
      vcsProvider: "local",
    });
    expect(result.vcsProvider).toBe("local");
    expect(result.gates).toEqual([]);
  });
});

describe("P34-013 regression: GateConfig schema validation", () => {
  test("command gate validates required fields", () => {
    expect(() => GateConfigSchema.parse({ type: "command" })).toThrow();
    expect(() =>
      GateConfigSchema.parse({ type: "command", command: "" }),
    ).toThrow();
    const valid = GateConfigSchema.parse({
      type: "command",
      command: "npm test",
    });
    expect(valid.type).toBe("command");
  });

  test("coverage gate validates minPct range", () => {
    expect(() =>
      GateConfigSchema.parse({
        type: "coverage",
        reportPath: "cov.info",
        minPct: -1,
      }),
    ).toThrow();
    expect(() =>
      GateConfigSchema.parse({
        type: "coverage",
        reportPath: "cov.info",
        minPct: 101,
      }),
    ).toThrow();
    const valid = GateConfigSchema.parse({
      type: "coverage",
      reportPath: "cov.info",
      minPct: 80,
    });
    expect(valid.type).toBe("coverage");
    expect((valid as { minPct: number }).minPct).toBe(80);
  });

  test("ai_eval gate validates required rubric", () => {
    expect(() =>
      GateConfigSchema.parse({ type: "ai_eval", command: "eval" }),
    ).toThrow();
    const valid = GateConfigSchema.parse({
      type: "ai_eval",
      command: "eval",
      rubric: "Check code quality",
    });
    expect(valid.type).toBe("ai_eval");
    expect((valid as { rubric: string }).rubric).toBe("Check code quality");
  });

  test("pr_ci gate has no required fields beyond type", () => {
    const valid = GateConfigSchema.parse({ type: "pr_ci" });
    expect(valid.type).toBe("pr_ci");
  });

  test("unknown gate type is rejected", () => {
    expect(() => GateConfigSchema.parse({ type: "unknown_gate" })).toThrow();
  });
});

describe("P34-013 regression: gate chain sequencing", () => {
  function makeGate(name: string, passed: boolean, retryable = false): Gate {
    return {
      name,
      async evaluate(): Promise<GateResult> {
        return {
          gate: name,
          passed,
          diagnostics: passed ? "OK" : `${name} failed`,
          retryable,
        };
      },
    };
  }

  test("all gates pass → chain passes", async () => {
    const gates = [makeGate("a", true), makeGate("b", true)];
    const ctx = makeContext();
    const result = await runGateChain(gates, ctx);
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(2);
  });

  test("first gate fails → chain stops, second gate not evaluated", async () => {
    let bEvaluated = false;
    const gateB: Gate = {
      name: "b",
      async evaluate() {
        bEvaluated = true;
        return { gate: "b", passed: true, diagnostics: "OK", retryable: false };
      },
    };
    const gates = [makeGate("a", false), gateB];
    const result = await runGateChain(gates, makeContext());
    expect(result.passed).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(bEvaluated).toBe(false);
  });

  test("callbacks receive gate index", async () => {
    const startIndices: number[] = [];
    const resultIndices: number[] = [];
    const gates = [makeGate("a", true), makeGate("b", true)];
    await runGateChain(gates, makeContext(), {
      onGateStart: (_gate, index) => {
        startIndices.push(index);
      },
      onGateResult: (_gate, _result, index) => {
        resultIndices.push(index);
      },
    });
    expect(startIndices).toEqual([0, 1]);
    expect(resultIndices).toEqual([0, 1]);
  });

  test("async callbacks are awaited", async () => {
    const order: string[] = [];
    const gates = [makeGate("a", true)];
    await runGateChain(gates, makeContext(), {
      onGateStart: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push("start");
      },
      onGateResult: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push("result");
      },
    });
    expect(order).toEqual(["start", "result"]);
  });

  test("empty gate chain passes immediately", async () => {
    const result = await runGateChain([], makeContext());
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(0);
  });
});

describe("P34-013 regression: gate event emission", () => {
  test("gate.activity start event is valid", () => {
    const event = createRuntimeEvent({
      family: "gate-lifecycle",
      type: "gate.activity",
      payload: {
        stage: "start",
        gateName: "command",
        gateIndex: 0,
        totalGates: 2,
        summary: 'Starting gate "command" (1/2).',
      },
      context: { source: "PHASE_RUNNER", phaseId: "p1" },
    });
    expect(event.type).toBe("gate.activity");
    expect(event.payload.stage).toBe("start");
  });

  test("gate.activity pass event is valid", () => {
    const event = createRuntimeEvent({
      family: "gate-lifecycle",
      type: "gate.activity",
      payload: {
        stage: "pass",
        gateName: "coverage",
        gateIndex: 1,
        totalGates: 2,
        summary: 'Gate "coverage" passed (2/2).',
      },
      context: { source: "PHASE_RUNNER" },
    });
    expect(event.payload.stage).toBe("pass");
  });

  test("gate.activity fail event carries diagnostics and retryable flag", () => {
    const event = createRuntimeEvent({
      family: "gate-lifecycle",
      type: "gate.activity",
      payload: {
        stage: "fail",
        gateName: "coverage",
        gateIndex: 0,
        totalGates: 1,
        summary: "Coverage gate failed.",
        diagnostics: "Coverage 55% < 80%",
        retryable: false,
      },
      context: { source: "PHASE_RUNNER" },
    });
    expect(event.payload.diagnostics).toBe("Coverage 55% < 80%");
    expect(event.payload.retryable).toBe(false);
  });

  test("gate.activity retry event is valid", () => {
    const event = createRuntimeEvent({
      family: "gate-lifecycle",
      type: "gate.activity",
      payload: {
        stage: "retry",
        gateName: "ai_eval",
        gateIndex: 0,
        totalGates: 1,
        summary: "Retrying AI eval gate.",
      },
      context: { source: "PHASE_RUNNER" },
    });
    expect(event.payload.stage).toBe("retry");
  });
});

describe("P34-013 regression: gate failure surfacing in notifications", () => {
  function makeGateFailEvent(): RuntimeEvent {
    return createRuntimeEvent({
      family: "gate-lifecycle",
      type: "gate.activity",
      payload: {
        stage: "fail",
        gateName: "coverage",
        gateIndex: 1,
        totalGates: 3,
        summary: 'Gate "coverage" failed (2/3): Coverage 72% below 80%.',
        diagnostics: "Coverage 72% below 80%.",
        retryable: false,
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-34",
        phaseName: "Phase 34",
      },
    });
  }

  test("gate failure formatted for Telegram includes 'Gate:' prefix", () => {
    const formatted = formatRuntimeEventForTelegram(makeGateFailEvent());
    expect(formatted).toContain("Gate:");
    expect(formatted).toContain("coverage");
  });

  test("gate failure formatted for CLI returns summary", () => {
    const formatted = formatRuntimeEventForCli(makeGateFailEvent());
    expect(formatted).toContain("coverage");
    expect(formatted).toContain("72%");
  });

  test("gate failure notifies at all Telegram levels", () => {
    const event = makeGateFailEvent();
    expect(shouldNotifyRuntimeEventForTelegram(event, "all")).toBe(true);
    expect(shouldNotifyRuntimeEventForTelegram(event, "important")).toBe(true);
    expect(shouldNotifyRuntimeEventForTelegram(event, "critical")).toBe(true);
  });

  test("gate start is suppressed at important and critical levels", () => {
    const event = createRuntimeEvent({
      family: "gate-lifecycle",
      type: "gate.activity",
      payload: {
        stage: "start",
        gateName: "command",
        gateIndex: 0,
        totalGates: 1,
        summary: 'Starting gate "command".',
      },
      context: { source: "PHASE_RUNNER" },
    });
    expect(shouldNotifyRuntimeEventForTelegram(event, "all")).toBe(true);
    expect(shouldNotifyRuntimeEventForTelegram(event, "important")).toBe(false);
    expect(shouldNotifyRuntimeEventForTelegram(event, "critical")).toBe(false);
  });

  test("gate pass notifies at important but not critical level", () => {
    const event = createRuntimeEvent({
      family: "gate-lifecycle",
      type: "gate.activity",
      payload: {
        stage: "pass",
        gateName: "pr_ci",
        gateIndex: 0,
        totalGates: 1,
        summary: 'Gate "pr_ci" passed.',
      },
      context: { source: "PHASE_RUNNER" },
    });
    expect(shouldNotifyRuntimeEventForTelegram(event, "all")).toBe(true);
    expect(shouldNotifyRuntimeEventForTelegram(event, "important")).toBe(true);
    expect(shouldNotifyRuntimeEventForTelegram(event, "critical")).toBe(false);
  });
});

function makeContext(): GateContext {
  return {
    phaseId: "phase-test",
    phaseName: "Test Phase",
    phase: {
      id: "phase-test",
      name: "Test Phase",
      status: "IN_PROGRESS",
      branchName: "feat/test",
      tasks: [],
    } as unknown as GateContext["phase"],
    cwd: "/tmp/test",
    baseBranch: "main",
    headBranch: "feat/test",
    vcsProviderType: "null",
  };
}
