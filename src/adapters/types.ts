import type { ProcessRunResult, ProcessRunner } from "../process";
import { CLIAdapterSchema, type CLIAdapter, type CLIAdapterId } from "../types";

export type AdapterRunInput = {
  prompt: string;
  cwd: string;
  timeoutMs?: number;
};

export interface TaskAdapter {
  readonly id: CLIAdapterId;
  readonly contract: CLIAdapter;
  run(input: AdapterRunInput): Promise<ProcessRunResult>;
}

/**
 * Declares which args must be present (non-interactive enforcement) and which
 * must be absent (interactive-mode detection) for a given adapter.
 */
export type NonInteractiveConfig = {
  /** Args that MUST appear in baseArgs; absence means the adapter would run interactively. */
  requiredArgs: readonly string[];
  /** Args that MUST NOT appear in baseArgs; their presence explicitly requests interactive mode. */
  forbiddenArgs: readonly string[];
};

/**
 * Thrown when an adapter is constructed or invoked in a way that would enable
 * interactive mode.  All adapters managed by IxADO must run in batch/print mode.
 */
export class InteractiveModeError extends Error {
  constructor(adapterId: string, reason: string) {
    super(`[${adapterId}] Interactive mode rejected: ${reason}`);
    this.name = "InteractiveModeError";
  }
}

/**
 * Validates that `args` satisfies the given non-interactive policy.
 * Throws {@link InteractiveModeError} on the first violation found.
 */
export function assertNonInteractive(
  adapterId: string,
  args: readonly string[],
  config: NonInteractiveConfig,
): void {
  for (const required of config.requiredArgs) {
    if (!args.includes(required)) {
      throw new InteractiveModeError(
        adapterId,
        `required non-interactive flag "${required}" is missing from args`,
      );
    }
  }
  for (const forbidden of config.forbiddenArgs) {
    if (args.includes(forbidden)) {
      throw new InteractiveModeError(
        adapterId,
        `interactive flag "${forbidden}" is not permitted; only non-interactive (batch) execution is allowed`,
      );
    }
  }
}

type BaseAdapterInit = {
  id: CLIAdapterId;
  command: string;
  baseArgs: string[];
  runner: ProcessRunner;
  /**
   * When provided the adapter validates its baseArgs against this policy at
   * construction time and again before every `run()` call.
   */
  nonInteractiveConfig?: NonInteractiveConfig;
};

export abstract class BaseCliAdapter implements TaskAdapter {
  readonly id: CLIAdapterId;
  readonly contract: CLIAdapter;

  protected readonly command: string;
  protected readonly baseArgs: string[];
  protected readonly runner: ProcessRunner;
  protected readonly nonInteractiveConfig: NonInteractiveConfig | undefined;

  constructor(init: BaseAdapterInit) {
    this.id = init.id;
    this.command = init.command.trim();
    this.baseArgs = [...init.baseArgs];
    this.runner = init.runner;
    this.nonInteractiveConfig = init.nonInteractiveConfig;

    // Fail fast: validate at construction so misconfigured adapters are caught
    // immediately rather than at first execution.
    if (this.nonInteractiveConfig) {
      assertNonInteractive(this.id, this.baseArgs, this.nonInteractiveConfig);
    }

    this.contract = CLIAdapterSchema.parse({
      id: this.id,
      command: this.command,
      baseArgs: this.baseArgs,
    });
  }

  async run(input: AdapterRunInput): Promise<ProcessRunResult> {
    if (!input.prompt.trim()) {
      throw new Error("prompt must not be empty.");
    }
    if (!input.cwd.trim()) {
      throw new Error("cwd must not be empty.");
    }

    // Re-validate before every execution as a defence-in-depth measure.
    if (this.nonInteractiveConfig) {
      assertNonInteractive(this.id, this.baseArgs, this.nonInteractiveConfig);
    }

    return this.runner.run({
      command: this.command,
      args: [...this.baseArgs, input.prompt],
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
    });
  }
}
