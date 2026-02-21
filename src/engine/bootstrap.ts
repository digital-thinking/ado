import { CodexUsageTracker } from "../adapters";
import { createTelegramNotifier } from "../bot";
import { ProcessManager } from "../process";
import { StateEngine } from "../state";
import { GitHubManager, GitManager } from "../vcs";
import { PhaseExecutionEngine } from "./phase-execution-engine";

export type EngineBootstrapInput = {
  cwd: string;
  stateFilePath: string;
  telegram?: {
    token: string;
    ownerId: number;
  };
};

export function createPhaseExecutionEngine(input: EngineBootstrapInput): PhaseExecutionEngine {
  const runner = new ProcessManager();
  const notifier = input.telegram
    ? createTelegramNotifier(input.telegram.token, input.telegram.ownerId)
    : undefined;

  return new PhaseExecutionEngine({
    store: new StateEngine(input.stateFilePath),
    git: new GitManager(runner),
    github: new GitHubManager(runner),
    runner,
    usageTracker: new CodexUsageTracker(runner),
    notifier,
  });
}
