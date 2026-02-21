import type { ChildProcess, SpawnOptions } from "node:child_process";

export type ProcessRunOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
};

export type ProcessRunResult = {
  command: string;
  args: string[];
  cwd?: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export interface ProcessRunner {
  run(options: ProcessRunOptions): Promise<ProcessRunResult>;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess;
