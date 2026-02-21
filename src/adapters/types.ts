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

type BaseAdapterInit = {
  id: CLIAdapterId;
  command: string;
  baseArgs: string[];
  runner: ProcessRunner;
};

export abstract class BaseCliAdapter implements TaskAdapter {
  readonly id: CLIAdapterId;
  readonly contract: CLIAdapter;

  protected readonly command: string;
  protected readonly baseArgs: string[];
  protected readonly runner: ProcessRunner;

  constructor(init: BaseAdapterInit) {
    this.id = init.id;
    this.command = init.command.trim();
    this.baseArgs = [...init.baseArgs];
    this.runner = init.runner;

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

    return this.runner.run({
      command: this.command,
      args: [...this.baseArgs, input.prompt],
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
    });
  }
}
