import { type Gate, type GateContext, type GateResult } from "./gate";
import type { ProcessRunner } from "../process";

export type CommandGateConfig = {
  /** Shell command to execute (e.g. "npm"). */
  command: string;
  /** Arguments to pass (e.g. ["test"]). */
  args?: string[];
  /** Timeout in milliseconds. Defaults to 300_000 (5 minutes). */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * A gate that runs a configurable shell command.
 * Passes if exit code is 0; captures stdout/stderr for diagnostics.
 */
export class CommandGate implements Gate {
  readonly name: string;
  private readonly config: CommandGateConfig;
  private readonly runner: ProcessRunner;

  constructor(config: CommandGateConfig, runner: ProcessRunner) {
    this.name = `command:${config.command}`;
    this.config = config;
    this.runner = runner;
  }

  async evaluate(context: GateContext): Promise<GateResult> {
    try {
      const result = await this.runner.run({
        command: this.config.command,
        args: this.config.args ?? [],
        cwd: context.cwd,
        timeoutMs: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        approvedCommandBuilder: true,
      });

      const output = [result.stdout.trim(), result.stderr.trim()]
        .filter((s) => s.length > 0)
        .join("\n\n");

      if (result.exitCode === 0) {
        return {
          gate: this.name,
          passed: true,
          diagnostics: output || "Command completed successfully.",
          retryable: false,
        };
      }

      return {
        gate: this.name,
        passed: false,
        diagnostics: output || `Command exited with code ${result.exitCode}.`,
        retryable: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        gate: this.name,
        passed: false,
        diagnostics: `Command failed: ${message}`,
        retryable: true,
      };
    }
  }
}
