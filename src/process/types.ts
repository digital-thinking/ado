import type { ChildProcess, SpawnOptions } from "node:child_process";

export type ProcessRunOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  /**
   * Runtime guard: must be set to `true` by an approved command builder class
   * (e.g. GitManager, GitHubManager, BaseCliAdapter).  Direct callers that
   * omit this flag will be rejected by ProcessManager, preventing raw shell
   * execution paths from bypassing the typed command-builder layer.
   */
  approvedCommandBuilder?: boolean;
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
  options: SpawnOptions,
) => ChildProcess;
