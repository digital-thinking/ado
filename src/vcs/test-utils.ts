import type { ProcessRunOptions, ProcessRunResult, ProcessRunner } from "../process";

type MockResponse =
  | {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      signal?: NodeJS.Signals | null;
      durationMs?: number;
    }
  | Error;

export class MockProcessRunner implements ProcessRunner {
  readonly calls: ProcessRunOptions[] = [];
  private readonly responses: MockResponse[];

  constructor(responses: MockResponse[] = []) {
    this.responses = [...responses];
  }

  enqueue(response: MockResponse): void {
    this.responses.push(response);
  }

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    this.calls.push(options);
    const next = this.responses.shift();

    if (next instanceof Error) {
      throw next;
    }

    return {
      command: options.command,
      args: options.args ?? [],
      cwd: options.cwd,
      exitCode: next?.exitCode ?? 0,
      signal: next?.signal ?? null,
      stdout: next?.stdout ?? "",
      stderr: next?.stderr ?? "",
      durationMs: next?.durationMs ?? 1,
    };
  }
}
