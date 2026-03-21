import type { Phase, VcsProviderType } from "../types";

/**
 * Context passed to each gate during evaluation.
 */
export type GateContext = {
  phaseId: string;
  phaseName: string;
  phase: Phase;
  cwd: string;
  baseBranch: string;
  headBranch: string;
  vcsProviderType: VcsProviderType;
  prUrl?: string;
  prNumber?: number;
};

/**
 * Result of a single gate evaluation.
 */
export type GateResult = {
  gate: string;
  passed: boolean;
  diagnostics: string;
  /** If true, the gate chain runner may retry this gate after recovery. */
  retryable: boolean;
};

/**
 * A gate is a post-execution-loop check that must pass before a phase
 * can reach a terminal success state.
 */
export interface Gate {
  /** Short identifier for logging and events (e.g. "command", "coverage", "pr_ci"). */
  readonly name: string;
  evaluate(context: GateContext): Promise<GateResult>;
}

/**
 * Result of running the full gate chain.
 */
export type GateChainResult = {
  passed: boolean;
  results: GateResult[];
};

/**
 * Executes a sequence of gates in order. Stops at the first failure.
 */
export async function runGateChain(
  gates: Gate[],
  context: GateContext,
  options?: {
    onGateStart?: (gate: Gate, index: number) => void | Promise<void>;
    onGateResult?: (
      gate: Gate,
      result: GateResult,
      index: number,
    ) => void | Promise<void>;
  },
): Promise<GateChainResult> {
  const results: GateResult[] = [];

  for (let i = 0; i < gates.length; i++) {
    const gate = gates[i];
    await options?.onGateStart?.(gate, i);
    const result = await gate.evaluate(context);
    results.push(result);
    await options?.onGateResult?.(gate, result, i);

    if (!result.passed) {
      return { passed: false, results };
    }
  }

  return { passed: true, results };
}
