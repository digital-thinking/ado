import { spawn } from "node:child_process";

import type { ProcessRunOptions, ProcessRunResult, SpawnFn } from "./types";

export class ProcessExecutionError extends Error {
  readonly result: ProcessRunResult;

  constructor(message: string, result: ProcessRunResult) {
    super(message);
    this.name = "ProcessExecutionError";
    this.result = result;
  }
}

export class ProcessManager {
  private readonly spawnFn: SpawnFn;

  constructor(spawnFn: SpawnFn = spawn) {
    this.spawnFn = spawnFn;
  }

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const command = options.command.trim();
    const args = options.args ?? [];

    if (!command) {
      throw new Error("command must not be empty.");
    }

    return new Promise<ProcessRunResult>((resolve, reject) => {
      const startedAt = Date.now();
      const child = this.spawnFn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: "pipe",
        shell: false,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutHandle);
        reject(error);
      });

      child.on("close", (exitCode, signal) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutHandle);

        const result: ProcessRunResult = {
          command,
          args,
          cwd: options.cwd,
          exitCode: exitCode ?? -1,
          signal,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
        };

        if (result.exitCode !== 0) {
          reject(
            new ProcessExecutionError(
              `Command failed with exit code ${result.exitCode}: ${command} ${args.join(" ")}`.trim(),
              result
            )
          );
          return;
        }

        resolve(result);
      });

      if (options.stdin !== undefined) {
        child.stdin?.write(options.stdin);
      }
      child.stdin?.end();

      if (options.timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          if (settled) {
            return;
          }

          child.kill();
          settled = true;

          reject(new Error(`Command timed out after ${options.timeoutMs}ms: ${command}`));
        }, options.timeoutMs);
      }
    });
  }
}
