import type { ProcessRunner } from "../process";
import type { GateConfig, VcsProviderType } from "../types";
import type { VcsProvider } from "../vcs/vcs-provider";
import { AiEvalGate } from "./ai-eval-gate";
import { CommandGate } from "./command-gate";
import { CoverageGate } from "./coverage-gate";
import type { Gate } from "./gate";
import { PrCiGate } from "./pr-ci-gate";

export function createGatesFromConfig(
  configs: GateConfig[],
  runner: ProcessRunner,
  vcsProvider: VcsProvider,
  _vcsProviderType: VcsProviderType,
): Gate[] {
  return configs.map((config) => {
    switch (config.type) {
      case "command":
        return new CommandGate(
          {
            command: config.command,
            args: config.args,
            timeoutMs: config.timeoutMs,
          },
          runner,
        );
      case "coverage":
        return new CoverageGate({
          reportPath: config.reportPath,
          minPct: config.minPct,
          format: config.format,
        });
      case "ai_eval":
        return new AiEvalGate(
          {
            command: config.command,
            args: config.args,
            rubric: config.rubric,
            passKeywords: config.passKeywords,
            failKeywords: config.failKeywords,
            maxRetries: config.maxRetries,
            timeoutMs: config.timeoutMs,
          },
          runner,
        );
      case "pr_ci":
        return new PrCiGate(
          {
            intervalMs: config.intervalMs,
            timeoutMs: config.timeoutMs,
            terminalConfirmations: config.terminalConfirmations,
          },
          vcsProvider,
        );
      default: {
        const _exhaustive: never = config;
        throw new Error(`Unknown gate type: ${(_exhaustive as any).type}`);
      }
    }
  });
}
