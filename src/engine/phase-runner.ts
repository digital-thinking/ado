import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  classifyRecoveryException,
  isRecoverableException,
  runExceptionRecovery,
  verifyRecoveryPostcondition,
} from "./exception-recovery";
import {
  deriveTargetedCiFixTasks,
  formatCiDiagnostics,
} from "./ci-check-mapping";
import { runCiIntegration } from "./ci-integration";
import { runCiValidationLoop } from "./ci-validation-loop";
import { runGateChain, type GateContext } from "./gate";
import { createGatesFromConfig } from "./gate-factory";
import { PhaseLoopControl } from "./phase-loop-control";
import {
  waitForAutoAdvance as waitForAutoAdvanceGate,
  waitForManualAdvance as waitForManualAdvanceGate,
} from "./phase-loop-wait";
import { runTesterWorkflow } from "./tester-workflow";
import {
  runDeliberationPass,
  type DeliberationSummary,
} from "./deliberation-pass";
import { formatDeliberationSummaryForResultContext } from "./deliberation-summary";
import { buildRaceJudgePrompt, parseRaceJudgeVerdict } from "./race-judge";
import {
  RaceOrchestrator,
  type RaceBranch,
  type RaceBranchResult,
} from "./race-orchestrator";
import { buildWorkerPrompt } from "./worker-prompts";
import {
  AdapterCircuitBreaker,
  type AdapterCircuitBreakerConfig,
  type AdapterCircuitDecision,
} from "../adapters";
import { ProcessManager, type ProcessRunner } from "../process";
import {
  GitHubManager,
  GitManager,
  WorktreeManager,
  createVcsProvider,
  type CiPollTransition,
  type VcsProvider,
  parsePullRequestNumberFromUrl,
  PrivilegedGitActions,
} from "../vcs";
import { type ControlCenterService } from "../web";
import { type AuthPolicy, type Role } from "../security/policy";
import { PhasePreflightError } from "../errors";
import {
  ActivePhaseResolutionError,
  resolveActivePhaseStrict,
} from "../state/active-phase";
import {
  CLI_ADAPTER_IDS,
  TaskRoutingReasonSchema,
  type CLIAdapterId,
  type Phase,
  type PhaseFailureKind,
  type PullRequestAutomationSettings,
  type Task,
  type GateConfig,
  type TaskRoutingReason,
  type TaskRaceBranch,
  type TaskRaceState,
  type TaskType,
  type VcsProviderType,
} from "../types";
import { createRuntimeEvent, type RuntimeEvent } from "../types/runtime-events";

const TERMINAL_PHASE_STATUSES = [
  "DONE",
  "AWAITING_CI",
  "READY_FOR_REVIEW",
  "CI_FAILED",
  "TIMED_OUT",
] as const;

const ACTIONABLE_TASK_STATUSES = ["TODO", "CI_FIX"] as const;
const DEFAULT_ADAPTER_BREAKER_CONFIG: AdapterCircuitBreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 300_000,
};
export const RATE_LIMIT_INITIAL_BACKOFF_MS = 30_000;
export const RATE_LIMIT_MAX_BACKOFF_MS = 300_000;

function isActionableTaskStatus(status: string): boolean {
  return ACTIONABLE_TASK_STATUSES.some((candidate) => candidate === status);
}

function resolveRetryAtMs(task: Pick<Task, "rateLimitRetryAt">): number | null {
  if (!task.rateLimitRetryAt) {
    return null;
  }

  const retryAtMs = Date.parse(task.rateLimitRetryAt);
  return Number.isNaN(retryAtMs) ? null : retryAtMs;
}

function isTaskReadyForExecution(
  task: Pick<Task, "status" | "rateLimitRetryAt">,
  nowMs: number,
): boolean {
  if (!isActionableTaskStatus(task.status)) {
    return false;
  }

  const retryAtMs = resolveRetryAtMs(task);
  return retryAtMs === null || retryAtMs <= nowMs;
}

function resolveBlockedTaskDelayMs(
  tasks: readonly Pick<Task, "status" | "rateLimitRetryAt">[],
  status: (typeof ACTIONABLE_TASK_STATUSES)[number],
  nowMs: number,
): number | null {
  const blockedRetryAtMs = tasks
    .filter((task) => task.status === status)
    .map(resolveRetryAtMs)
    .filter((retryAtMs): retryAtMs is number => retryAtMs !== null)
    .filter((retryAtMs) => retryAtMs > nowMs);

  if (blockedRetryAtMs.length === 0) {
    return null;
  }

  return Math.max(0, Math.min(...blockedRetryAtMs) - nowMs);
}

/**
 * Picks the index of the next task to execute, applying explicit priority rules
 * for deterministic, stable ordering across TODO and CI_FIX task sets.
 *
 * Selection rules (highest priority first):
 *   1. Ready CI_FIX tasks — must be resolved before new work so the repository
 *      stays in a passing state after every tester run.
 *   2. Ready TODO tasks   — normal forward-progress work.
 *
 * A deferred CI_FIX task blocks TODO execution until its rate-limit backoff
 * expires. Deferred TODO tasks are skipped in favor of later ready TODO tasks.
 *
 * Returns the index of the selected task, or -1 when no actionable task is
 * currently ready to execute.
 */
export function pickNextTask(
  tasks: readonly Pick<Task, "status" | "rateLimitRetryAt">[],
  nowMs: number = Date.now(),
): number {
  const ciFixIndex = tasks.findIndex(
    (task) => task.status === "CI_FIX" && isTaskReadyForExecution(task, nowMs),
  );
  if (ciFixIndex >= 0) {
    return ciFixIndex;
  }
  if (tasks.some((task) => task.status === "CI_FIX")) {
    return -1;
  }

  return tasks.findIndex(
    (task) => task.status === "TODO" && isTaskReadyForExecution(task, nowMs),
  );
}

export function getNextTaskAvailabilityDelayMs(
  tasks: readonly Pick<Task, "status" | "rateLimitRetryAt">[],
  nowMs: number = Date.now(),
): number | null {
  const ciFixDelayMs = resolveBlockedTaskDelayMs(tasks, "CI_FIX", nowMs);
  if (ciFixDelayMs !== null) {
    return ciFixDelayMs;
  }

  return resolveBlockedTaskDelayMs(tasks, "TODO", nowMs);
}

export function computeRateLimitBackoffMs(retryCount: number): number {
  if (!Number.isInteger(retryCount) || retryCount <= 0) {
    throw new Error("retryCount must be a positive integer.");
  }

  return Math.min(
    RATE_LIMIT_MAX_BACKOFF_MS,
    RATE_LIMIT_INITIAL_BACKOFF_MS * 2 ** (retryCount - 1),
  );
}

export type PhaseExecutionGate = "OPEN" | "RESUMABLE" | "CLOSED";

export function resolvePhaseExecutionGate(
  phase: Pick<Phase, "status" | "tasks">,
): PhaseExecutionGate {
  const isTerminal = TERMINAL_PHASE_STATUSES.some(
    (status) => status === phase.status,
  );
  if (!isTerminal) {
    return "OPEN";
  }

  const hasActionableTask = phase.tasks.some((task) =>
    ACTIONABLE_TASK_STATUSES.some((status) => status === task.status),
  );
  return hasActionableTask ? "RESUMABLE" : "CLOSED";
}

export type PhaseRunnerConfig = {
  mode: "AUTO" | "MANUAL";
  countdownSeconds: number;
  activeAssignee: CLIAdapterId;
  enabledAdapters?: CLIAdapterId[];
  adapterAffinities?: Partial<Record<TaskType, CLIAdapterId>>;
  adapterCircuitBreakers?: Partial<
    Record<CLIAdapterId, AdapterCircuitBreakerConfig>
  >;
  maxRecoveryAttempts: number;
  testerCommand: string | null;
  testerArgs: string[] | null;
  testerTimeoutMs: number;
  defaultRace?: number;
  maxTaskRetries?: number;
  judgeAdapter?: CLIAdapterId;
  phaseTimeoutMs?: number;
  ciEnabled: boolean;
  vcsProvider: VcsProviderType;
  gates: GateConfig[];
  ciBaseBranch: string;
  ciPullRequest: PullRequestAutomationSettings;
  validationMaxRetries: number;
  ciFixMaxFanOut: number;
  ciFixMaxDepth: number;
  deliberation?: {
    reviewerAdapter: CLIAdapterId;
    maxRefinePasses: number;
  };
  projectRootDir: string;
  worktrees?: {
    enabled: boolean;
    baseDir: string;
  };
  phaseId?: string;
  projectName: string;
  policy: AuthPolicy;
  role: Role | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type RecoveryExhaustionReason = "failed" | "unfixable";

class RecoveryAttemptsExhaustedError extends Error {
  constructor(
    message: string,
    readonly reason: RecoveryExhaustionReason,
  ) {
    super(message);
    this.name = "RecoveryAttemptsExhaustedError";
  }
}

class PhaseTimedOutError extends Error {
  constructor(readonly diagnostics: string) {
    super(diagnostics);
    this.name = "PhaseTimedOutError";
  }
}

type PhaseTimeoutWatchdog = {
  phaseId: string;
  phaseName: string;
  startedAtMs: number;
  timeoutMs: number;
  deadlineMs: number;
  currentStep: string;
  tripped: boolean;
};

type RaceBranchExecutionOutput = {
  diff: string;
  stdout: string;
  stderr: string;
};

export class PhaseRunner {
  private git: GitManager;
  private github: GitHubManager;
  private privilegedGit: PrivilegedGitActions;
  private worktreeManager: WorktreeManager | null;
  private executionCwd: string;
  private adapterBreakers = new Map<CLIAdapterId, AdapterCircuitBreaker>();
  private enabledAdapters: CLIAdapterId[];
  private lastExecutedTaskContext:
    | {
        taskId: string;
        assignee: CLIAdapterId;
      }
    | undefined;
  private phaseTimeoutWatchdog: PhaseTimeoutWatchdog | undefined;

  constructor(
    private control: ControlCenterService,
    private config: PhaseRunnerConfig,
    private loopControl: PhaseLoopControl = new PhaseLoopControl(),
    private notifyLoopEvent?: (event: RuntimeEvent) => Promise<void>,
    private testerRunner: ProcessRunner = new ProcessManager(),
  ) {
    this.git = new GitManager(this.testerRunner);
    this.github = new GitHubManager(this.testerRunner);
    this.privilegedGit = new PrivilegedGitActions({
      git: this.git,
      github: this.github,
      role: config.role,
      policy: config.policy,
    });
    this.worktreeManager =
      config.worktrees?.enabled === true
        ? new WorktreeManager({
            git: this.git,
            projectRootDir: config.projectRootDir,
            baseDir: config.worktrees.baseDir,
          })
        : null;
    this.executionCwd = config.projectRootDir;
    this.enabledAdapters = this.resolveEnabledAdapters();
  }

  private nowMs(): number {
    return this.config.now ? this.config.now() : Date.now();
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }

    if (this.config.sleep) {
      await this.config.sleep(ms);
      return;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private startPhaseTimeoutWatchdog(phase: Phase): void {
    const timeoutMs = this.config.phaseTimeoutMs;
    if (!timeoutMs) {
      this.phaseTimeoutWatchdog = undefined;
      return;
    }

    const startedAtMs = this.nowMs();
    this.phaseTimeoutWatchdog = {
      phaseId: phase.id,
      phaseName: phase.name,
      startedAtMs,
      timeoutMs,
      deadlineMs: startedAtMs + timeoutMs,
      currentStep: "phase initialization",
      tripped: false,
    };
  }

  private setPhaseTimeoutStep(step: string): void {
    if (!this.phaseTimeoutWatchdog) {
      return;
    }

    this.phaseTimeoutWatchdog.currentStep = step;
  }

  private getRemainingPhaseTimeoutMs(): number | null {
    if (!this.phaseTimeoutWatchdog) {
      return null;
    }

    return this.phaseTimeoutWatchdog.deadlineMs - this.nowMs();
  }

  private async assertPhaseNotTimedOut(): Promise<void> {
    const watchdog = this.phaseTimeoutWatchdog;
    if (!watchdog) {
      return;
    }

    if (this.nowMs() < watchdog.deadlineMs) {
      return;
    }

    const elapsedMs = Math.max(
      watchdog.timeoutMs,
      this.nowMs() - watchdog.startedAtMs,
    );
    const startedAt = new Date(watchdog.startedAtMs).toISOString();
    const deadlineAt = new Date(watchdog.deadlineMs).toISOString();
    const diagnostics =
      `Phase "${watchdog.phaseName}" timed out after ${elapsedMs}ms ` +
      `(configured limit: ${watchdog.timeoutMs}ms). ` +
      `Started at ${startedAt}; deadline was ${deadlineAt}. ` +
      `Current step: ${watchdog.currentStep}.`;

    if (!watchdog.tripped) {
      watchdog.tripped = true;
      this.loopControl.requestStop();
      await this.control.setPhaseStatus({
        phaseId: watchdog.phaseId,
        status: "TIMED_OUT",
        ciStatusContext: diagnostics,
      });
      await this.publishRuntimeEvent(
        createRuntimeEvent({
          family: "phase-resilience",
          type: "phase:timeout",
          payload: {
            timeoutMs: watchdog.timeoutMs,
            elapsedMs,
            startedAt,
            deadlineAt,
            currentStep: watchdog.currentStep,
            summary: diagnostics,
          },
          context: {
            source: "PHASE_RUNNER",
            projectName: this.config.projectName,
            phaseId: watchdog.phaseId,
            phaseName: watchdog.phaseName,
          },
        }),
      );
      await this.publishRuntimeEvent(
        createRuntimeEvent({
          family: "task-lifecycle",
          type: "task.lifecycle.phase-update",
          payload: {
            status: "TIMED_OUT",
            message: diagnostics,
          },
          context: {
            source: "PHASE_RUNNER",
            projectName: this.config.projectName,
            phaseId: watchdog.phaseId,
            phaseName: watchdog.phaseName,
          },
        }),
      );
      await this.publishRuntimeEvent(
        createRuntimeEvent({
          family: "terminal-outcome",
          type: "terminal.outcome",
          payload: {
            outcome: "failure",
            summary: diagnostics,
          },
          context: {
            source: "PHASE_RUNNER",
            projectName: this.config.projectName,
            phaseId: watchdog.phaseId,
            phaseName: watchdog.phaseName,
          },
        }),
      );
    }

    throw new PhaseTimedOutError(diagnostics);
  }

  private getMaxTaskRetries(): number {
    return Math.max(0, this.config.maxTaskRetries ?? 3);
  }

  private async waitForDeferredTask(delayMs: number): Promise<boolean> {
    await this.assertPhaseNotTimedOut();
    if (delayMs <= 0) {
      return !this.loopControl.isStopRequested();
    }

    console.info(
      `Execution loop: waiting ${Math.ceil(delayMs / 1000)}s for rate-limit backoff to expire.`,
    );

    let remainingMs = delayMs;
    while (remainingMs > 0) {
      if (this.loopControl.isStopRequested()) {
        return false;
      }

      const remainingTimeoutMs = this.getRemainingPhaseTimeoutMs();
      const sleepMs = Math.min(
        remainingMs,
        1_000,
        remainingTimeoutMs === null ? 1_000 : Math.max(0, remainingTimeoutMs),
      );
      await this.sleep(sleepMs);
      await this.assertPhaseNotTimedOut();
      remainingMs -= sleepMs;
    }

    return !this.loopControl.isStopRequested();
  }

  async run(): Promise<void> {
    const rl = createInterface({
      input: stdin,
      output: stdout,
    });
    let activePhaseId: string | null = null;
    let shouldTeardownOnSuccess = false;
    this.executionCwd = this.config.projectRootDir;

    console.info(
      `Starting phase execution loop in ${this.config.mode} mode (countdown: ${this.config.countdownSeconds}s, assignee: ${this.config.activeAssignee}, recovery max attempts: ${this.config.maxRecoveryAttempts}).`,
    );

    try {
      // Reconcile any IN_PROGRESS tasks left over from a prior process crash
      // before the execution loop starts to avoid status drift and ensure the
      // loop picks them up cleanly as TODO items.
      const reconciledTasks = await this.control.reconcileInProgressTasks();
      if (reconciledTasks > 0) {
        console.info(
          `Startup: reconciled ${reconciledTasks} IN_PROGRESS task(s) to TODO after process restart.`,
        );
      }

      const state = await this.control.getState();
      const phase = this.resolveActivePhase(state);
      activePhaseId = phase.id;
      this.startPhaseTimeoutWatchdog(phase);
      await this.assertPhaseNotTimedOut();

      // Preflight: validate phase metadata and status before any git work.
      // Identical gate in both AUTO and MANUAL modes — deterministic execution
      // gate semantics that cannot be bypassed by exception recovery.
      this.runPreflightChecks(phase);
      await this.checkBranchBasePreconditions(phase);

      await this.prepareBranch(phase);
      await this.assertPhaseNotTimedOut();
      const completedPhase = await this.executionLoop(phase, rl);
      await this.assertPhaseNotTimedOut();

      if (completedPhase && this.config.vcsProvider !== "null") {
        this.setPhaseTimeoutStep("CI integration");
        await this.handleCiIntegration(completedPhase);
        shouldTeardownOnSuccess = true;
      } else if (completedPhase) {
        this.setPhaseTimeoutStep("final phase completion");
        await this.assertPhaseNotTimedOut();
        await this.control.setPhaseStatus({
          phaseId: completedPhase.id,
          status: "DONE",
        });
        await this.publishRuntimeEvent(
          createRuntimeEvent({
            family: "terminal-outcome",
            type: "terminal.outcome",
            payload: {
              outcome: "success",
              summary: `Phase ${completedPhase.name} completed successfully.`,
            },
            context: {
              source: "PHASE_RUNNER",
              projectName: this.config.projectName,
              phaseId: completedPhase.id,
              phaseName: completedPhase.name,
            },
          }),
        );
        shouldTeardownOnSuccess = true;
      }
    } catch (error) {
      if (activePhaseId) {
        await this.teardownPhaseWorktreeOnFailure(activePhaseId);
      }
      throw error;
    } finally {
      rl.close();
      if (shouldTeardownOnSuccess && activePhaseId) {
        await this.teardownPhaseWorktree(activePhaseId);
      }
    }
  }

  private resolveActivePhase(state: any): Phase {
    const configuredPhaseId = this.config.phaseId?.trim();
    if (configuredPhaseId) {
      const isActive = Array.isArray(state.activePhaseIds)
        ? state.activePhaseIds.some(
            (candidate: string) => candidate.trim() === configuredPhaseId,
          )
        : false;
      if (!isActive) {
        throw new PhasePreflightError(
          `Phase "${configuredPhaseId}" is not active. ` +
            "Use 'ixado phase active <phaseNumber|phaseId>' before running with --phase.",
        );
      }

      try {
        return resolveActivePhaseStrict(state, configuredPhaseId);
      } catch (error) {
        if (!(error instanceof ActivePhaseResolutionError)) {
          throw error;
        }

        switch (error.code) {
          case "NO_PHASES":
            throw new PhasePreflightError(
              "No phases found in project state. Run 'ixado phase create' to add a phase before running.",
            );
          case "ACTIVE_PHASE_ID_MISSING":
            throw new PhasePreflightError(
              "Active phase ID is missing from project state. " +
                "Set one explicitly with 'ixado phase active <phaseNumber|phaseId>' before running.",
            );
          case "ACTIVE_PHASE_ID_NOT_FOUND":
            throw new PhasePreflightError(
              `Active phase ID "${error.activePhaseId}" not found in project state. ` +
                "Run 'ixado phase list' to verify phase IDs, or 'ixado phase active <phaseNumber|phaseId>' to update.",
            );
          default:
            throw error;
        }
      }
    }

    try {
      return resolveActivePhaseStrict(state);
    } catch (error) {
      if (!(error instanceof ActivePhaseResolutionError)) {
        throw error;
      }

      switch (error.code) {
        case "NO_PHASES":
          throw new PhasePreflightError(
            "No phases found in project state. Run 'ixado phase create' to add a phase before running.",
          );
        case "ACTIVE_PHASE_ID_MISSING":
          throw new PhasePreflightError(
            "Active phase ID is missing from project state. " +
              "Set one explicitly with 'ixado phase active <phaseNumber|phaseId>' before running.",
          );
        case "ACTIVE_PHASE_ID_NOT_FOUND":
          throw new PhasePreflightError(
            `Active phase ID "${error.activePhaseId}" not found in project state. ` +
              "Run 'ixado phase list' to verify phase IDs, or 'ixado phase active <phaseNumber|phaseId>' to update.",
          );
        default:
          throw error;
      }
    }
  }

  private async teardownPhaseWorktree(phaseId: string): Promise<void> {
    if (!this.worktreeManager) {
      return;
    }

    const state = await this.control.getState();
    const phase = state.phases.find(
      (candidate: any) => candidate.id === phaseId,
    );
    if (!phase) {
      return;
    }

    const worktreePath = phase.worktreePath?.trim();
    if (!worktreePath) {
      return;
    }

    await this.worktreeManager.teardown(phase.id);
    await this.control.setPhaseStatus({
      phaseId: phase.id,
      status: phase.status,
      worktreePath: null,
    });
    this.executionCwd = this.config.projectRootDir;
    console.info(`Execution loop: removed worktree ${worktreePath}.`);
  }

  private async teardownPhaseWorktreeOnFailure(phaseId: string): Promise<void> {
    try {
      await this.teardownPhaseWorktree(phaseId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to teardown worktree after failure: ${message}`);
    }
  }

  /**
   * Validates phase metadata and status before any git or task work begins.
   * Throws PhasePreflightError (non-recoverable) when the phase cannot be run,
   * producing an actionable user-facing message and preventing AI recovery from
   * being invoked for conditions the user must resolve manually.
   *
   * Checks performed (identical for AUTO and MANUAL modes):
   *   1. Terminal status gate:
   *      - terminal + no actionable TODO/CI_FIX tasks => CLOSED (fail fast)
   *      - terminal + actionable TODO/CI_FIX tasks => RESUMABLE (allow run)
   *      - non-terminal statuses => OPEN
   *   2. branchName is non-empty — an empty branch name would produce a
   *      confusing git error rather than a clear failure.
   */
  private runPreflightChecks(phase: Phase): void {
    const gate = resolvePhaseExecutionGate(phase);
    if (gate === "CLOSED") {
      throw new PhasePreflightError(
        `Phase "${phase.name}" is in terminal status "${phase.status}" with no actionable TODO/CI_FIX tasks ` +
          `and cannot be re-executed. ` +
          `Run 'ixado phase list' to check the current status, or create a new phase with 'ixado phase create'.`,
      );
    }
    if (gate === "RESUMABLE") {
      console.info(
        `Preflight: phase "${phase.name}" is terminal (${phase.status}) but has pending TODO/CI_FIX tasks; resuming execution.`,
      );
    }

    if (!phase.branchName || !phase.branchName.trim()) {
      throw new PhasePreflightError(
        `Phase "${phase.name}" has an empty or missing branchName. ` +
          `Update the phase with a valid git branch name before running.`,
      );
    }
  }

  /**
   * Validates that the working copy is on the configured base branch before
   * creating a new phase branch.  If the phase branch already exists locally,
   * the check is skipped entirely — checkout will succeed regardless of HEAD.
   *
   * Throws PhasePreflightError (non-recoverable) with an actionable message
   * when the branch does not yet exist and HEAD is on a branch other than
   * `ciBaseBranch`, preventing accidental branch-from-branch drift in
   * multi-phase workflows.
   */
  private async checkBranchBasePreconditions(phase: Phase): Promise<void> {
    const branchExists = await this.git.localBranchExists(
      phase.branchName,
      this.config.projectRootDir,
    );
    if (branchExists) {
      return; // Branch already exists; no base-branch constraint needed.
    }

    const currentBranch = await this.git.getCurrentBranch(
      this.config.projectRootDir,
    );
    const allowedBase = this.config.ciBaseBranch;
    if (currentBranch !== allowedBase) {
      throw new PhasePreflightError(
        `Cannot create phase branch "${phase.branchName}" from "${currentBranch}". ` +
          `HEAD must be on the base branch "${allowedBase}" before creating a new phase branch. ` +
          `Run: git checkout ${allowedBase}`,
      );
    }

    // Update base branch to latest remote before branching so the new
    // phase branch starts from an up-to-date base, avoiding merge conflicts.
    try {
      console.info(
        `Execution loop: fetching and fast-forwarding ${allowedBase} before branching.`,
      );
      await this.git.fetchBranch({
        branchName: allowedBase,
        cwd: this.config.projectRootDir,
      });
      await this.git.pullFastForwardOnly(this.config.projectRootDir);
      console.info(`Execution loop: ${allowedBase} is up to date with remote.`);
    } catch (error) {
      // Non-fatal: if fetch/pull fails (e.g. offline, diverged history),
      // proceed with the local state and log a warning.
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(
        `Execution loop: failed to update ${allowedBase} from remote (proceeding with local state): ${msg}`,
      );
    }
  }

  private async prepareBranch(phase: Phase): Promise<void> {
    this.setPhaseTimeoutStep("branch preparation");
    await this.assertPhaseNotTimedOut();
    await this.control.setPhaseStatus({
      phaseId: phase.id,
      status: "BRANCHING",
    });
    await this.publishRuntimeEvent(
      createRuntimeEvent({
        family: "task-lifecycle",
        type: "task.lifecycle.phase-update",
        payload: {
          status: "BRANCHING",
          message: "Preparing phase branch.",
        },
        context: {
          source: "PHASE_RUNNER",
          projectName: this.config.projectName,
          phaseId: phase.id,
          phaseName: phase.name,
        },
      }),
    );
    console.info(`Execution loop: preparing branch ${phase.branchName}.`);
    let branchCwd = this.config.projectRootDir;
    let worktreePath = phase.worktreePath?.trim() || undefined;

    // Clear stale worktreePath if the directory no longer exists on disk
    // (e.g. after `worktree prune` removed it without updating state).
    if (worktreePath && !existsSync(worktreePath)) {
      console.info(
        `Execution loop: stored worktree path ${worktreePath} no longer exists, reprovisioning.`,
      );
      await this.control.setPhaseStatus({
        phaseId: phase.id,
        status: phase.status,
        worktreePath: null,
      });
      worktreePath = undefined;
    }

    while (true) {
      try {
        await this.assertPhaseNotTimedOut();
        if (this.worktreeManager) {
          if (!worktreePath) {
            worktreePath = await this.worktreeManager.provision({
              phaseId: phase.id,
              branchName: phase.branchName,
              fromRef: "HEAD",
            });
            await this.control.setPhaseStatus({
              phaseId: phase.id,
              status: "BRANCHING",
              worktreePath,
            });
            console.info(
              `Execution loop: provisioned worktree ${worktreePath}.`,
            );
          }
          branchCwd = worktreePath;
        }

        this.executionCwd = branchCwd;
        await this.git.ensureCleanWorkingTree(branchCwd);
        const currentBranch = await this.git.getCurrentBranch(branchCwd);
        if (currentBranch === phase.branchName) {
          console.info(
            `Execution loop: already on branch ${phase.branchName}.`,
          );
        } else {
          try {
            await this.git.checkout(phase.branchName, branchCwd);
            console.info(
              `Execution loop: checked out existing branch ${phase.branchName}.`,
            );
          } catch {
            await this.privilegedGit.createBranch({
              branchName: phase.branchName,
              cwd: branchCwd,
              fromRef: "HEAD",
            });
            console.info(
              `Execution loop: created and checked out branch ${phase.branchName}.`,
            );
          }
        }
        break;
      } catch (error) {
        if (error instanceof PhaseTimedOutError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        const category = (error as any).category;
        try {
          await this.attemptExceptionRecovery({
            phaseId: phase.id,
            phaseName: phase.name,
            errorMessage: message,
            category,
          });
          if (category === "DIRTY_WORKTREE") {
            await this.git.ensureCleanWorkingTree(branchCwd);
          }
          console.info(
            "Execution loop: recovery succeeded for branching preconditions, retrying.",
          );
          continue;
        } catch (recoveryError) {
          const recoveryMessage =
            recoveryError instanceof Error
              ? recoveryError.message
              : String(recoveryError);
          await this.control.setPhaseStatus({
            phaseId: phase.id,
            status: "CI_FAILED",
            failureKind: "AGENT_FAILURE" as PhaseFailureKind,
            ciStatusContext: `Branching failed: ${message}
Recovery: ${recoveryMessage}`,
          });
          throw recoveryError;
        }
      }
    }

    this.setPhaseTimeoutStep("coding");
    await this.assertPhaseNotTimedOut();
    await this.control.setPhaseStatus({
      phaseId: phase.id,
      status: "CODING",
    });
    await this.publishRuntimeEvent(
      createRuntimeEvent({
        family: "task-lifecycle",
        type: "task.lifecycle.phase-update",
        payload: {
          status: "CODING",
          message: "Phase entered coding status.",
        },
        context: {
          source: "PHASE_RUNNER",
          projectName: this.config.projectName,
          phaseId: phase.id,
          phaseName: phase.name,
        },
      }),
    );
  }

  private async executionLoop(
    phase: Phase,
    rl: ReturnType<typeof createInterface>,
  ): Promise<Phase | undefined> {
    let iteration = 0;
    let resumeSession = false;

    while (true) {
      this.setPhaseTimeoutStep("execution loop");
      await this.assertPhaseNotTimedOut();
      if (this.loopControl.isStopRequested()) {
        console.info("Execution loop stopped.");
        return undefined;
      }

      const state = await this.control.getState();
      const currentPhase = this.resolveActivePhase(state);
      const nowMs = this.nowMs();
      const nextTaskIndex = pickNextTask(currentPhase.tasks, nowMs);

      if (nextTaskIndex < 0) {
        const nextDelayMs = getNextTaskAvailabilityDelayMs(
          currentPhase.tasks,
          nowMs,
        );
        if (nextDelayMs !== null) {
          this.setPhaseTimeoutStep(
            `waiting ${Math.ceil(nextDelayMs / 1000)}s for deferred task availability`,
          );
          const shouldContinue = await this.waitForDeferredTask(nextDelayMs);
          if (!shouldContinue) {
            console.info(
              "Execution loop stopped while waiting for retry backoff.",
            );
            return undefined;
          }
          continue;
        }

        console.info(
          `Execution loop finished. No TODO or CI_FIX tasks in active phase ${currentPhase.name}.`,
        );
        return currentPhase;
      }

      const nextTaskNumber = nextTaskIndex + 1;
      const nextTask = currentPhase.tasks[nextTaskIndex];
      const nextTaskLabel = `task #${nextTaskNumber} ${nextTask.title}`;

      if (iteration > 0) {
        this.setPhaseTimeoutStep(`advance gate before ${nextTaskLabel}`);
        await this.assertPhaseNotTimedOut();
        const abortController = new AbortController();
        const advancePromise =
          this.config.mode === "AUTO"
            ? waitForAutoAdvanceGate({
                loopControl: this.loopControl,
                countdownSeconds: this.config.countdownSeconds,
                nextTaskLabel,
                onInfo: (line) => console.info(line),
                sleep: async (ms) => this.sleep(ms),
              })
            : waitForManualAdvanceGate({
                loopControl: this.loopControl,
                nextTaskLabel,
                askLocal: async () =>
                  rl
                    .question("> ", { signal: abortController.signal })
                    .then((answer) =>
                      answer.trim().toLowerCase() === "stop" ? "STOP" : "NEXT",
                    )
                    .catch((error) => {
                      if ((error as { name?: string }).name === "AbortError") {
                        return new Promise<"NEXT" | "STOP">(() => {});
                      }
                      throw error;
                    }),
                cancelLocal: () => abortController.abort(),
                onInfo: (line) => console.info(line),
              });
        const remainingMs = this.getRemainingPhaseTimeoutMs();
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise =
          remainingMs === null
            ? new Promise<never>(() => {})
            : new Promise<never>((_resolve, reject) => {
                timeoutHandle = setTimeout(
                  () => {
                    this.loopControl.requestStop();
                    abortController.abort();
                    void this.assertPhaseNotTimedOut().catch(reject);
                  },
                  Math.max(0, remainingMs),
                );
              });
        let decision: "NEXT" | "STOP";
        try {
          decision = await Promise.race([advancePromise, timeoutPromise]);
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }

        if (decision === "STOP") {
          this.loopControl.requestStop();
          console.info("Execution loop stopped before starting the next task.");
          return undefined;
        }
      }

      iteration += 1;
      this.setPhaseTimeoutStep(`running ${nextTaskLabel}`);
      await this.runTaskStep(
        currentPhase,
        nextTask,
        nextTaskNumber,
        resumeSession,
      );
      await this.assertPhaseNotTimedOut();

      const updatedState = await this.control.getState();
      const updatedPhase = this.resolveActivePhase(updatedState);
      const resultTask = updatedPhase.tasks[nextTaskNumber - 1];

      if (!resultTask) {
        throw new Error(`Task #${nextTaskNumber} not found after execution.`);
      }

      if (resultTask.status === "TODO") {
        resumeSession = true;
        continue;
      }

      this.setPhaseTimeoutStep(`tester after ${nextTaskLabel}`);
      await this.runTesterStep(updatedPhase, resultTask, nextTaskNumber);
      await this.assertPhaseNotTimedOut();

      resumeSession = true;
    }
  }

  private async runTaskStep(
    phase: Phase,
    task: Task,
    taskNumber: number,
    resumeSession: boolean,
  ): Promise<void> {
    const { assignee: preferredAssignee, routingReason } =
      this.resolveTaskRouting(task, taskNumber);
    let effectiveAssignee = await this.resolveDispatchAssignee({
      phase,
      task,
      taskNumber,
      preferredAssignee,
    });
    let taskDescriptionOverride: string | undefined;
    let resultContextPrefix: string | undefined;
    let deliberationSummary: DeliberationSummary | undefined;
    if (task.deliberate === true) {
      const deliberation = await this.runDeliberationForTask({
        phase,
        task,
        taskNumber,
        implementerAssignee: effectiveAssignee,
      });
      taskDescriptionOverride = deliberation.refinedPrompt;
      deliberationSummary = deliberation.summary;
      resultContextPrefix = formatDeliberationSummaryForResultContext(
        deliberation.summary,
      );
    }
    const nextTaskLabel = `task #${taskNumber} ${task.title}`;
    console.info(
      `Execution loop: starting ${nextTaskLabel} with ${effectiveAssignee}.`,
    );
    await this.publishRuntimeEvent(
      createRuntimeEvent({
        family: "task-lifecycle",
        type: "task.lifecycle.start",
        payload: {
          assignee: effectiveAssignee,
          resume: resumeSession,
          message: `Starting ${nextTaskLabel} with ${effectiveAssignee}.`,
        },
        context: {
          source: "PHASE_RUNNER",
          projectName: this.config.projectName,
          phaseId: phase.id,
          phaseName: phase.name,
          taskId: task.id,
          taskTitle: task.title,
          taskNumber,
          adapterId: effectiveAssignee,
        },
      }),
    );

    let taskRunCount = 0;
    const maxTaskRunCount = Math.max(1, this.config.maxRecoveryAttempts + 1);

    while (taskRunCount < maxTaskRunCount) {
      this.setPhaseTimeoutStep(
        `running task #${taskNumber} ${task.title} with ${effectiveAssignee}`,
      );
      await this.assertPhaseNotTimedOut();
      taskRunCount += 1;
      if (taskRunCount > 1) {
        effectiveAssignee = await this.resolveDispatchAssignee({
          phase,
          task,
          taskNumber,
          preferredAssignee,
        });
      }
      const updatedState = await this.executeTaskAttemptAndWait({
        phase,
        task,
        taskNumber,
        assignee: effectiveAssignee,
        routingReason,
        resume: resumeSession,
        taskDescriptionOverride,
        resultContextPrefix,
      });
      await this.assertPhaseNotTimedOut();
      const updatedPhase = this.resolveActivePhase(updatedState);
      const resultTask = updatedPhase.tasks[taskNumber - 1];

      if (!resultTask) {
        throw new Error(`Task #${taskNumber} not found after loop execution.`);
      }

      await this.recordAdapterTaskOutcome({
        phase: updatedPhase,
        task: resultTask,
        taskNumber,
        assignee: effectiveAssignee,
      });
      console.info(
        `Execution loop: ${nextTaskLabel} finished with status ${resultTask.status}.`,
      );
      await this.publishRuntimeEvent(
        createRuntimeEvent({
          family: "task-lifecycle",
          type: "task.lifecycle.finish",
          payload: {
            status: resultTask.status,
            message: `${nextTaskLabel} finished with status ${resultTask.status}.`,
            deliberation: deliberationSummary
              ? {
                  finalVerdict: deliberationSummary.finalVerdict,
                  rounds: deliberationSummary.rounds.length,
                  refinePassesUsed: deliberationSummary.refinePassesUsed,
                  pendingComments: deliberationSummary.pendingComments.length,
                }
              : undefined,
          },
          context: {
            source: "PHASE_RUNNER",
            projectName: this.config.projectName,
            phaseId: updatedPhase.id,
            phaseName: updatedPhase.name,
            taskId: resultTask.id,
            taskTitle: resultTask.title,
            taskNumber,
            adapterId: effectiveAssignee,
          },
        }),
      );
      if (resultTask.status !== "FAILED") {
        this.lastExecutedTaskContext = {
          taskId: resultTask.id,
          assignee: effectiveAssignee,
        };
        return;
      }

      resumeSession = true;
      const failureMessage =
        resultTask.errorLogs ??
        `Execution failed for task #${taskNumber} ${resultTask.title}.`;
      if (resultTask.errorLogs) {
        console.info(`Failure details: ${resultTask.errorLogs}`);
      }

      if (resultTask.adapterFailureKind === "rate_limited") {
        const nextRetryCount = (resultTask.rateLimitRetryCount ?? 0) + 1;
        const maxTaskRetries = this.getMaxTaskRetries();

        if (nextRetryCount > maxTaskRetries) {
          const deadLetterHint =
            maxTaskRetries === 0
              ? `Task moved to DEAD_LETTER after rate-limit retry budget 0 prevented automatic retry. Remediate manually, then reset with 'ixado task reset ${taskNumber}'.`
              : `Task moved to DEAD_LETTER after ${maxTaskRetries} rate-limit retries were exhausted. Remediate manually, then reset with 'ixado task reset ${taskNumber}'.`;
          await this.control.markTaskDeadLetter({
            phaseId: updatedPhase.id,
            taskId: resultTask.id,
            reason: deadLetterHint,
          });
          await this.publishRuntimeEvent(
            createRuntimeEvent({
              family: "task-lifecycle",
              type: "task.lifecycle.finish",
              payload: {
                status: "DEAD_LETTER",
                message: `${nextTaskLabel} moved to DEAD_LETTER after rate-limit retries were exhausted.`,
              },
              context: {
                source: "PHASE_RUNNER",
                projectName: this.config.projectName,
                phaseId: updatedPhase.id,
                phaseName: updatedPhase.name,
                taskId: resultTask.id,
                taskTitle: resultTask.title,
                taskNumber,
                adapterId: effectiveAssignee,
              },
            }),
          );
          await this.control.setPhaseStatus({
            phaseId: updatedPhase.id,
            status: "CI_FAILED",
            failureKind: "AGENT_FAILURE" as PhaseFailureKind,
            ciStatusContext: `${failureMessage}\n${deadLetterHint}`,
          });
          throw new Error(
            `Rate-limit retries exhausted for task #${taskNumber} after ${maxTaskRetries} retries.`,
          );
        }

        const retryDelayMs = computeRateLimitBackoffMs(nextRetryCount);
        const retryAt = new Date(this.nowMs() + retryDelayMs).toISOString();
        const retrySummary =
          `${nextTaskLabel} hit a rate limit; re-queued for retry ${nextRetryCount}/${maxTaskRetries} ` +
          `in ${Math.ceil(retryDelayMs / 1000)}s.`;
        await this.control.requeueRateLimitedTask({
          phaseId: updatedPhase.id,
          taskId: resultTask.id,
          retryCount: nextRetryCount,
          retryAt,
        });
        console.info(
          `Execution loop: re-queued ${nextTaskLabel} after rate limit; retry ${nextRetryCount}/${maxTaskRetries} scheduled in ${Math.ceil(retryDelayMs / 1000)}s.`,
        );
        await this.publishRuntimeEvent(
          createRuntimeEvent({
            family: "task-resilience",
            type: "task:rate_limit_retry",
            payload: {
              retryCount: nextRetryCount,
              maxRetries: maxTaskRetries,
              retryDelayMs,
              retryAt,
              summary: retrySummary,
            },
            context: {
              source: "PHASE_RUNNER",
              projectName: this.config.projectName,
              phaseId: updatedPhase.id,
              phaseName: updatedPhase.name,
              taskId: resultTask.id,
              taskTitle: resultTask.title,
              taskNumber,
              adapterId: effectiveAssignee,
            },
          }),
        );
        await this.publishRuntimeEvent(
          createRuntimeEvent({
            family: "task-lifecycle",
            type: "task.lifecycle.progress",
            payload: {
              message: retrySummary,
            },
            context: {
              source: "PHASE_RUNNER",
              projectName: this.config.projectName,
              phaseId: updatedPhase.id,
              phaseName: updatedPhase.name,
              taskId: resultTask.id,
              taskTitle: resultTask.title,
              taskNumber,
              adapterId: effectiveAssignee,
            },
          }),
        );
        return;
      }

      try {
        await this.attemptExceptionRecovery({
          phaseId: updatedPhase.id,
          phaseName: updatedPhase.name,
          taskId: resultTask.id,
          taskTitle: resultTask.title,
          errorMessage: failureMessage,
          category: resultTask.errorCategory,
          adapterFailureKind: (resultTask as any).adapterFailureKind,
        });
        console.info(
          `Execution loop: recovery fixed ${nextTaskLabel}, retrying task.`,
        );
        continue;
      } catch (recoveryError) {
        const recoveryMessage =
          recoveryError instanceof Error
            ? recoveryError.message
            : String(recoveryError);
        const deadLetterHint =
          recoveryError instanceof RecoveryAttemptsExhaustedError &&
          recoveryError.reason === "unfixable"
            ? `Task moved to DEAD_LETTER after recovery marked it unfixable. Remediate manually, then reset with 'ixado task reset ${taskNumber}'.`
            : undefined;

        if (deadLetterHint) {
          await this.control.markTaskDeadLetter?.({
            phaseId: updatedPhase.id,
            taskId: resultTask.id,
            reason: deadLetterHint,
          });
          await this.publishRuntimeEvent(
            createRuntimeEvent({
              family: "task-lifecycle",
              type: "task.lifecycle.finish",
              payload: {
                status: "DEAD_LETTER",
                message: `${nextTaskLabel} moved to DEAD_LETTER.`,
              },
              context: {
                source: "PHASE_RUNNER",
                projectName: this.config.projectName,
                phaseId: updatedPhase.id,
                phaseName: updatedPhase.name,
                taskId: resultTask.id,
                taskTitle: resultTask.title,
                taskNumber,
                adapterId: effectiveAssignee,
              },
            }),
          );
        }

        await this.control.setPhaseStatus({
          phaseId: updatedPhase.id,
          status: "CI_FAILED",
          failureKind: "AGENT_FAILURE" as PhaseFailureKind,
          ciStatusContext: `${failureMessage}
Recovery: ${recoveryMessage}${deadLetterHint ? `\n${deadLetterHint}` : ""}`,
        });
        throw recoveryError;
      }
    }

    await this.control.setPhaseStatus({
      phaseId: phase.id,
      status: "CI_FAILED",
      failureKind: "AGENT_FAILURE" as PhaseFailureKind,
      ciStatusContext: `Execution failed after ${maxTaskRunCount} run attempts for task #${taskNumber}.`,
    });
    throw new Error(
      `Execution loop stopped after FAILED task #${taskNumber}. Recovery retries were exhausted.`,
    );
  }

  private async executeTaskAttemptAndWait(input: {
    phase: Phase;
    task: Task;
    taskNumber: number;
    assignee: CLIAdapterId;
    routingReason: TaskRoutingReason;
    resume: boolean;
    taskDescriptionOverride?: string;
    resultContextPrefix?: string;
  }): Promise<any> {
    const raceCount = this.resolveTaskRaceCount(input.task);
    if (raceCount <= 1) {
      return this.control.startActiveTaskAndWait({
        taskNumber: input.taskNumber,
        assignee: input.assignee,
        resolvedAssignee: input.assignee,
        routingReason: input.routingReason,
        resume: input.resume,
        taskDescriptionOverride: input.taskDescriptionOverride,
        resultContextPrefix: input.resultContextPrefix,
      });
    }

    return this.runRaceTaskAttemptAndWait({
      ...input,
      raceCount,
    });
  }

  private resolveTaskRaceCount(task: Task): number {
    const raceCount = task.race ?? this.config.defaultRace ?? 1;
    if (!Number.isInteger(raceCount) || raceCount <= 0) {
      throw new Error("task.race must be a positive integer.");
    }

    return raceCount;
  }

  private async runRaceTaskAttemptAndWait(input: {
    phase: Phase;
    task: Task;
    taskNumber: number;
    assignee: CLIAdapterId;
    routingReason: TaskRoutingReason;
    resume: boolean;
    taskDescriptionOverride?: string;
    resultContextPrefix?: string;
    raceCount: number;
  }): Promise<any> {
    if (!this.worktreeManager) {
      throw new Error(
        `Race execution for task #${input.taskNumber} requires worktrees.enabled=true.`,
      );
    }

    const taskLabel = `task #${input.taskNumber} ${input.task.title}`;
    const prepared = await this.control.prepareTaskExecution({
      phaseId: input.phase.id,
      taskId: input.task.id,
      assignee: input.assignee,
      resolvedAssignee: input.assignee,
      routingReason: input.routingReason,
      resume: input.resume,
      taskDescriptionOverride: input.taskDescriptionOverride,
      resultContextPrefix: input.resultContextPrefix,
      cwd: this.executionCwd,
    });

    const orchestrator = new RaceOrchestrator(this.worktreeManager);
    let provisionedBranches: RaceBranch[] = [];
    let branchResults: RaceBranchResult<RaceBranchExecutionOutput>[] = [];
    let raceState: TaskRaceState | undefined;
    let raceStateUpdateQueue = Promise.resolve();
    const persistRaceState = async (
      nextState: TaskRaceState | undefined,
    ): Promise<void> => {
      raceState = nextState;
      await this.control.updateTaskRaceState({
        phaseId: input.phase.id,
        taskId: input.task.id,
        raceState: nextState,
      });
    };
    const queueRaceStateUpdate = (
      transform: (current: TaskRaceState | undefined) => TaskRaceState,
    ): Promise<void> => {
      raceStateUpdateQueue = raceStateUpdateQueue.then(() =>
        persistRaceState(transform(raceState)),
      );
      return raceStateUpdateQueue;
    };

    try {
      console.info(
        `Execution loop: running ${taskLabel} in race mode with ${input.raceCount} branches.`,
      );
      await this.publishRuntimeEvent(
        createRuntimeEvent({
          family: "race-lifecycle",
          type: "race:start",
          payload: {
            raceCount: input.raceCount,
            baseBranchName: input.phase.branchName,
            summary: `Starting race mode for task #${input.taskNumber} ${input.task.title} with ${input.raceCount} branch(es).`,
          },
          context: {
            source: "PHASE_RUNNER",
            projectName: this.config.projectName,
            phaseId: input.phase.id,
            phaseName: input.phase.name,
            taskId: input.task.id,
            taskTitle: input.task.title,
            taskNumber: input.taskNumber,
            adapterId: input.assignee,
          },
        }),
      );
      const branches = await orchestrator.provisionBranches({
        phaseId: input.phase.id,
        taskId: input.task.id,
        raceCount: input.raceCount,
        baseBranchName: input.phase.branchName,
        fromRef: input.phase.branchName,
      });
      provisionedBranches = branches;
      await persistRaceState({
        status: "running",
        raceCount: input.raceCount,
        branches: branches.map((branch) => ({
          index: branch.index,
          branchName: branch.branchName,
          status: "pending",
        })),
        updatedAt: new Date().toISOString(),
      });
      branchResults = await Promise.all(
        branches.map(
          async (
            branch,
          ): Promise<RaceBranchResult<RaceBranchExecutionOutput>> => {
            try {
              const result = await this.runRaceBranch({
                phase: input.phase,
                task: prepared.taskForPrompt,
                assignee: input.assignee,
                branch,
                resume: false,
              });
              await queueRaceStateUpdate((current) =>
                this.updateRaceStateBranch(current, {
                  branchIndex: branch.index,
                  branchName: branch.branchName,
                  status: "fulfilled",
                }),
              );
              await this.publishRaceBranchEvent({
                phase: input.phase,
                task: input.task,
                taskNumber: input.taskNumber,
                assignee: input.assignee,
                branch,
                status: "fulfilled",
              });
              return {
                ...branch,
                status: "fulfilled",
                result,
              };
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              await queueRaceStateUpdate((current) =>
                this.updateRaceStateBranch(current, {
                  branchIndex: branch.index,
                  branchName: branch.branchName,
                  status: "rejected",
                  error: message,
                }),
              );
              await this.publishRaceBranchEvent({
                phase: input.phase,
                task: input.task,
                taskNumber: input.taskNumber,
                assignee: input.assignee,
                branch,
                status: "rejected",
                error: message,
              });
              return {
                ...branch,
                status: "rejected",
                error: error instanceof Error ? error : new Error(message),
              };
            }
          },
        ),
      );

      const judgedWinner = await this.judgeRaceBranches({
        phase: input.phase,
        task: prepared.taskForPrompt,
        taskNumber: input.taskNumber,
        implementerAssignee: input.assignee,
        branches: branchResults,
      });
      await queueRaceStateUpdate((current) =>
        this.markRaceStateJudged(current, {
          judgeAdapter: judgedWinner.judgeAssignee,
          pickedBranchIndex: judgedWinner.winner.index,
          branchName: judgedWinner.winner.branchName,
          reasoning: judgedWinner.reasoning,
        }),
      );
      await this.publishRaceJudgeEvent({
        phase: input.phase,
        task: input.task,
        taskNumber: input.taskNumber,
        judgeAssignee: judgedWinner.judgeAssignee,
        winner: judgedWinner.winner,
        reasoning: judgedWinner.reasoning,
      });
      const commitCount = await this.applyRaceWinner(judgedWinner.winner);
      await queueRaceStateUpdate((current) =>
        this.markRaceStateApplied(current, {
          pickedBranchIndex: judgedWinner.winner.index,
          branchName: judgedWinner.winner.branchName,
          commitCount,
        }),
      );
      await this.publishRacePickEvent({
        phase: input.phase,
        task: input.task,
        taskNumber: input.taskNumber,
        winner: judgedWinner.winner,
        commitCount,
      });
      await orchestrator.teardownBranches(branchResults);
      branchResults = [];
      provisionedBranches = [];

      await this.control.completeTaskExecution({
        phaseId: input.phase.id,
        taskId: input.task.id,
        status: "DONE",
        resultContext: this.buildRaceResultContext({
          resultContextPrefix: input.resultContextPrefix,
          winner: judgedWinner.winner,
          reasoning: judgedWinner.reasoning,
        }),
        startedFromStatus: prepared.startedFromStatus,
      });
    } catch (error) {
      const failure = this.summarizeRaceFailure(error, branchResults);
      let failureLogs = failure.message;

      try {
        const teardownTargets =
          branchResults.length > 0 ? branchResults : provisionedBranches;
        if (teardownTargets.length > 0) {
          await orchestrator.teardownBranches(teardownTargets);
        }
      } catch (teardownError) {
        const teardownMessage =
          teardownError instanceof Error
            ? teardownError.message
            : String(teardownError);
        failureLogs = `${failureLogs}\nRace teardown failed: ${teardownMessage}`;
      }

      await this.control.completeTaskExecution({
        phaseId: input.phase.id,
        taskId: input.task.id,
        status: "FAILED",
        errorLogs: failureLogs,
        errorCategory: failure.errorCategory,
        adapterFailureKind: failure.adapterFailureKind,
        startedFromStatus: prepared.startedFromStatus,
      });
    }

    return this.control.getState();
  }

  private async runRaceBranch(input: {
    phase: Phase;
    task: Task;
    assignee: CLIAdapterId;
    branch: RaceBranch;
    resume: boolean;
  }): Promise<RaceBranchExecutionOutput> {
    const phaseForBranch: Phase = {
      ...input.phase,
      branchName: input.branch.branchName,
      worktreePath: input.branch.worktreePath,
    };
    const prompt = buildWorkerPrompt({
      archetype: "CODER",
      projectName: this.config.projectName,
      rootDir: input.branch.worktreePath,
      phase: phaseForBranch,
      task: input.task,
    });
    const result = await this.control.runInternalWork({
      assignee: input.assignee,
      prompt,
      phaseId: input.phase.id,
      taskId: input.task.id,
      resume: input.resume,
      cwd: input.branch.worktreePath,
    });
    const diffResult = await this.testerRunner.run({
      command: "git",
      args: [
        "diff",
        "--no-color",
        "--binary",
        "--full-index",
        input.branch.fromRef,
      ],
      cwd: input.branch.worktreePath,
    });

    return {
      diff: diffResult.stdout,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  private async judgeRaceBranches(input: {
    phase: Phase;
    task: Task;
    taskNumber: number;
    implementerAssignee: CLIAdapterId;
    branches: RaceBranchResult<RaceBranchExecutionOutput>[];
  }): Promise<{
    winner: RaceBranchResult<RaceBranchExecutionOutput> & {
      status: "fulfilled";
    };
    judgeAssignee: CLIAdapterId;
    reasoning: string;
  }> {
    const fulfilledCount = input.branches.filter(
      (branch) => branch.status === "fulfilled",
    ).length;
    if (fulfilledCount === 0) {
      throw new Error("Race execution produced no successful candidates.");
    }

    const judgeAssignee = await this.resolveJudgeAssignee({
      phase: input.phase,
      task: input.task,
      taskNumber: input.taskNumber,
      implementerAssignee: input.implementerAssignee,
    });
    const judgePrompt = buildRaceJudgePrompt({
      projectName: this.config.projectName,
      rootDir: this.executionCwd,
      phaseName: input.phase.name,
      taskTitle: input.task.title,
      taskDescription: input.task.description,
      branches: input.branches.map((branch) => ({
        index: branch.index,
        branchName: branch.branchName,
        status: branch.status,
        diff: branch.status === "fulfilled" ? branch.result.diff : "",
        stdout: branch.status === "fulfilled" ? branch.result.stdout : "",
        stderr: branch.status === "fulfilled" ? branch.result.stderr : "",
        error: branch.status === "rejected" ? branch.error.message : undefined,
      })),
    });
    const judgeResult = await this.control.runInternalWork({
      assignee: judgeAssignee,
      prompt: judgePrompt,
      phaseId: input.phase.id,
      taskId: input.task.id,
      cwd: this.executionCwd,
    });
    const verdict = parseRaceJudgeVerdict(
      judgeResult.stdout,
      input.branches.length,
    );
    const winner = input.branches.find(
      (branch) => branch.index === verdict.pickedBranchIndex,
    );
    if (!winner) {
      throw new Error(
        `Judge selected unknown candidate ${verdict.pickedBranchIndex}.`,
      );
    }
    if (winner.status !== "fulfilled") {
      throw new Error(
        `Judge selected candidate ${winner.index}, but that branch failed: ${winner.error.message}`,
      );
    }

    return {
      winner,
      judgeAssignee,
      reasoning: verdict.reasoning,
    };
  }

  private async resolveJudgeAssignee(input: {
    phase: Phase;
    task: Task;
    taskNumber: number;
    implementerAssignee: CLIAdapterId;
  }): Promise<CLIAdapterId> {
    const preferredJudge =
      this.config.judgeAdapter ?? this.config.activeAssignee;
    const enabledAdapters = new Set(this.enabledAdapters);
    const candidates: CLIAdapterId[] = [];

    for (const candidate of [
      preferredJudge,
      input.implementerAssignee,
      ...this.enabledAdapters,
    ]) {
      if (!candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }

    const openCandidates: CLIAdapterId[] = [];
    for (const candidate of candidates) {
      if (!enabledAdapters.has(candidate)) {
        continue;
      }

      const decision = this.getAdapterBreaker(candidate).check(candidate);
      await this.maybeEmitCircuitTransition({
        phase: input.phase,
        task: input.task,
        taskNumber: input.taskNumber,
        decision,
      });

      if (!decision.canExecute) {
        openCandidates.push(candidate);
        continue;
      }

      return candidate;
    }

    throw new Error(
      `No race judge available for task #${input.taskNumber} ${input.task.title}. Open circuits: ${openCandidates.join(", ")}.`,
    );
  }

  private async applyRaceWinner(
    winner: RaceBranchResult<RaceBranchExecutionOutput> & {
      status: "fulfilled";
    },
  ): Promise<number> {
    const commitRange = `${winner.fromRef}..${winner.branchName}`;
    const commits = await this.listCommitsInRange(
      commitRange,
      this.executionCwd,
    );
    await this.git.ensureCleanWorkingTree(this.executionCwd);
    if (!winner.result.diff.trim()) {
      return commits.length;
    }
    await this.testerRunner.run({
      command: "git",
      args: ["apply", "--index", "--binary", "-"],
      cwd: this.executionCwd,
      stdin: winner.result.diff,
    });
    return commits.length;
  }

  private async publishRaceBranchEvent(input: {
    phase: Phase;
    task: Task;
    taskNumber: number;
    assignee: CLIAdapterId;
    branch: RaceBranch;
    status: "fulfilled" | "rejected";
    error?: string;
  }): Promise<void> {
    const summary =
      input.status === "fulfilled"
        ? `Race branch ${input.branch.index}/${input.branch.branchName} finished successfully.`
        : `Race branch ${input.branch.index}/${input.branch.branchName} failed: ${input.error ?? "unknown error"}`;

    await this.publishRuntimeEvent(
      createRuntimeEvent({
        family: "race-lifecycle",
        type: "race:branch",
        payload: {
          branchIndex: input.branch.index,
          branchName: input.branch.branchName,
          status: input.status,
          summary,
          error: input.error,
        },
        context: {
          source: "PHASE_RUNNER",
          projectName: this.config.projectName,
          phaseId: input.phase.id,
          phaseName: input.phase.name,
          taskId: input.task.id,
          taskTitle: input.task.title,
          taskNumber: input.taskNumber,
          adapterId: input.assignee,
        },
      }),
    );
  }

  private async publishRaceJudgeEvent(input: {
    phase: Phase;
    task: Task;
    taskNumber: number;
    judgeAssignee: CLIAdapterId;
    winner: RaceBranchResult<RaceBranchExecutionOutput> & {
      status: "fulfilled";
    };
    reasoning: string;
  }): Promise<void> {
    await this.publishRuntimeEvent(
      createRuntimeEvent({
        family: "race-lifecycle",
        type: "race:judge",
        payload: {
          judgeAdapter: input.judgeAssignee,
          pickedBranchIndex: input.winner.index,
          branchName: input.winner.branchName,
          summary: `Race judge ${input.judgeAssignee} selected candidate ${input.winner.index} (${input.winner.branchName}).`,
          reasoning: input.reasoning,
        },
        context: {
          source: "PHASE_RUNNER",
          projectName: this.config.projectName,
          phaseId: input.phase.id,
          phaseName: input.phase.name,
          taskId: input.task.id,
          taskTitle: input.task.title,
          taskNumber: input.taskNumber,
          adapterId: input.judgeAssignee,
        },
      }),
    );
  }

  private async publishRacePickEvent(input: {
    phase: Phase;
    task: Task;
    taskNumber: number;
    winner: RaceBranchResult<RaceBranchExecutionOutput> & {
      status: "fulfilled";
    };
    commitCount: number;
  }): Promise<void> {
    const commitSummary =
      input.commitCount === 1 ? "1 commit" : `${input.commitCount} commits`;

    await this.publishRuntimeEvent(
      createRuntimeEvent({
        family: "race-lifecycle",
        type: "race:pick",
        payload: {
          branchIndex: input.winner.index,
          branchName: input.winner.branchName,
          commitCount: input.commitCount,
          summary: `Applied race winner candidate ${input.winner.index} (${input.winner.branchName}) with ${commitSummary}.`,
        },
        context: {
          source: "PHASE_RUNNER",
          projectName: this.config.projectName,
          phaseId: input.phase.id,
          phaseName: input.phase.name,
          taskId: input.task.id,
          taskTitle: input.task.title,
          taskNumber: input.taskNumber,
        },
      }),
    );
  }

  private async listCommitsInRange(
    range: string,
    cwd: string,
  ): Promise<string[]> {
    const result = await this.testerRunner.run({
      command: "git",
      args: ["rev-list", "--reverse", range],
      cwd,
    });

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private buildRaceResultContext(input: {
    resultContextPrefix?: string;
    winner: RaceBranchResult<RaceBranchExecutionOutput> & {
      status: "fulfilled";
    };
    reasoning: string;
  }): string {
    const winnerOutput = [
      input.winner.result.stdout.trim(),
      input.winner.result.stderr.trim(),
    ]
      .filter((value) => value.length > 0)
      .join("\n\n");
    const resultBody = [
      `Race mode selected candidate ${input.winner.index} (${input.winner.branchName}).`,
      "",
      "Judge reasoning:",
      input.reasoning,
      "",
      winnerOutput || "Task finished without textual output.",
    ].join("\n");

    return input.resultContextPrefix &&
      input.resultContextPrefix.trim().length > 0
      ? `${input.resultContextPrefix.trimEnd()}\n\n${resultBody}`
      : resultBody;
  }

  private updateRaceStateBranch(
    current: TaskRaceState | undefined,
    input: {
      branchIndex: number;
      branchName: string;
      status: "fulfilled" | "rejected";
      error?: string;
    },
  ): TaskRaceState {
    const existingBranches = current?.branches ?? [];
    const nextBranches = existingBranches.some(
      (branch) => branch.index === input.branchIndex,
    )
      ? existingBranches.map((branch) =>
          branch.index === input.branchIndex
            ? {
                ...branch,
                branchName: input.branchName,
                status: input.status,
                error: input.error,
              }
            : branch,
        )
      : [
          ...existingBranches,
          {
            index: input.branchIndex,
            branchName: input.branchName,
            status: input.status,
            error: input.error,
          },
        ];

    return {
      status: current?.status ?? "running",
      raceCount: current?.raceCount ?? nextBranches.length,
      branches: nextBranches.sort((a, b) => a.index - b.index),
      judgeAdapter: current?.judgeAdapter,
      pickedBranchIndex: current?.pickedBranchIndex,
      reasoning: current?.reasoning,
      commitCount: current?.commitCount,
      updatedAt: new Date().toISOString(),
    };
  }

  private markRaceStateJudged(
    current: TaskRaceState | undefined,
    input: {
      judgeAdapter: CLIAdapterId;
      pickedBranchIndex: number;
      branchName: string;
      reasoning: string;
    },
  ): TaskRaceState {
    const branches = this.ensureRaceStateBranch(
      current?.branches ?? [],
      input.pickedBranchIndex,
      input.branchName,
    ).map((branch) =>
      branch.index === input.pickedBranchIndex
        ? { ...branch, status: "picked" as const }
        : branch,
    );

    return {
      status: "judged",
      raceCount: current?.raceCount ?? branches.length,
      branches,
      judgeAdapter: input.judgeAdapter,
      pickedBranchIndex: input.pickedBranchIndex,
      reasoning: input.reasoning,
      commitCount: current?.commitCount,
      updatedAt: new Date().toISOString(),
    };
  }

  private markRaceStateApplied(
    current: TaskRaceState | undefined,
    input: {
      pickedBranchIndex: number;
      branchName: string;
      commitCount: number;
    },
  ): TaskRaceState {
    const branches = this.ensureRaceStateBranch(
      current?.branches ?? [],
      input.pickedBranchIndex,
      input.branchName,
    ).map((branch) =>
      branch.index === input.pickedBranchIndex
        ? { ...branch, status: "picked" as const }
        : branch,
    );

    return {
      status: "applied",
      raceCount: current?.raceCount ?? branches.length,
      branches,
      judgeAdapter: current?.judgeAdapter,
      pickedBranchIndex: input.pickedBranchIndex,
      reasoning: current?.reasoning,
      commitCount: input.commitCount,
      updatedAt: new Date().toISOString(),
    };
  }

  private ensureRaceStateBranch(
    branches: readonly TaskRaceBranch[],
    branchIndex: number,
    branchName: string,
  ): TaskRaceBranch[] {
    if (branches.some((branch) => branch.index === branchIndex)) {
      return [...branches].sort((a, b) => a.index - b.index);
    }

    return [
      ...branches,
      {
        index: branchIndex,
        branchName,
        status: "pending" as const,
      },
    ].sort((a, b) => a.index - b.index);
  }

  private summarizeRaceFailure(
    error: unknown,
    branchResults: readonly RaceBranchResult<RaceBranchExecutionOutput>[],
  ): {
    message: string;
    errorCategory?: any;
    adapterFailureKind?: any;
  } {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    if (
      branchResults.length > 0 &&
      branchResults.every((branch) => branch.status === "rejected")
    ) {
      const details = branchResults.map(
        (branch) =>
          `Candidate ${branch.index} (${branch.branchName}) failed: ${branch.error.message}`,
      );
      const adapterFailureKinds = [
        ...new Set(
          branchResults
            .map((branch) => (branch.error as any).adapterFailureKind)
            .filter((value) => value !== undefined),
        ),
      ];
      const errorCategories = [
        ...new Set(
          branchResults
            .map((branch) => (branch.error as any).category)
            .filter((value) => value !== undefined),
        ),
      ];

      return {
        message: [
          `Race execution failed: all ${branchResults.length} candidate branches failed.`,
          ...details,
        ].join("\n"),
        errorCategory:
          errorCategories.length === 1 ? errorCategories[0] : undefined,
        adapterFailureKind:
          adapterFailureKinds.length === 1 ? adapterFailureKinds[0] : undefined,
      };
    }

    return {
      message: normalizedError.message,
      errorCategory: (normalizedError as any).category,
      adapterFailureKind: (normalizedError as any).adapterFailureKind,
    };
  }

  private resolveEnabledAdapters(): CLIAdapterId[] {
    const configured =
      this.config.enabledAdapters && this.config.enabledAdapters.length > 0
        ? this.config.enabledAdapters
        : CLI_ADAPTER_IDS;
    const unique: CLIAdapterId[] = [];
    const seen = new Set<CLIAdapterId>();
    for (const adapterId of configured) {
      if (seen.has(adapterId)) {
        continue;
      }
      seen.add(adapterId);
      unique.push(adapterId);
    }
    if (!seen.has(this.config.activeAssignee)) {
      unique.unshift(this.config.activeAssignee);
    }
    if (unique.length === 0) {
      throw new Error("PhaseRunner requires at least one enabled adapter.");
    }
    return unique;
  }

  private buildAdapterFallbackChain(
    preferredAssignee: CLIAdapterId,
  ): CLIAdapterId[] {
    const preferredIndex = this.enabledAdapters.indexOf(preferredAssignee);
    if (preferredIndex < 0) {
      return [
        preferredAssignee,
        ...this.enabledAdapters.filter(
          (adapterId) => adapterId !== preferredAssignee,
        ),
      ];
    }
    return [
      ...this.enabledAdapters.slice(preferredIndex),
      ...this.enabledAdapters.slice(0, preferredIndex),
    ];
  }

  private getAdapterBreakerConfig(
    adapterId: CLIAdapterId,
  ): AdapterCircuitBreakerConfig {
    return (
      this.config.adapterCircuitBreakers?.[adapterId] ??
      DEFAULT_ADAPTER_BREAKER_CONFIG
    );
  }

  private getAdapterBreaker(adapterId: CLIAdapterId): AdapterCircuitBreaker {
    const existing = this.adapterBreakers.get(adapterId);
    if (existing) {
      return existing;
    }
    const breaker = new AdapterCircuitBreaker(
      this.getAdapterBreakerConfig(adapterId),
    );
    this.adapterBreakers.set(adapterId, breaker);
    return breaker;
  }

  private async resolveDispatchAssignee(input: {
    phase: Phase;
    task: Task;
    taskNumber: number;
    preferredAssignee: CLIAdapterId;
  }): Promise<CLIAdapterId> {
    const chain = this.buildAdapterFallbackChain(input.preferredAssignee);
    const openCandidates: CLIAdapterId[] = [];

    for (const adapterId of chain) {
      const decision = this.getAdapterBreaker(adapterId).check(adapterId);
      await this.maybeEmitCircuitTransition({
        phase: input.phase,
        task: input.task,
        taskNumber: input.taskNumber,
        decision,
      });
      if (decision.canExecute) {
        if (openCandidates.length > 0) {
          const message = `Routing fallback for task #${input.taskNumber} (${input.task.title}): circuit open for ${openCandidates.join(", ")}; using ${adapterId}.`;
          console.info(message);
          await this.publishRuntimeEvent(
            createRuntimeEvent({
              family: "task-lifecycle",
              type: "task.lifecycle.progress",
              payload: { message },
              context: {
                source: "PHASE_RUNNER",
                projectName: this.config.projectName,
                phaseId: input.phase.id,
                phaseName: input.phase.name,
                taskId: input.task.id,
                taskTitle: input.task.title,
                taskNumber: input.taskNumber,
                adapterId,
              },
            }),
          );
        }
        return adapterId;
      }
      openCandidates.push(adapterId);
    }

    throw new Error(
      `No adapter available for task #${input.taskNumber} ${input.task.title}. Open circuits: ${openCandidates.join(", ")}.`,
    );
  }

  private async recordAdapterTaskOutcome(input: {
    phase: Phase;
    task: Task;
    taskNumber: number;
    assignee: CLIAdapterId;
  }): Promise<void> {
    const breaker = this.getAdapterBreaker(input.assignee);
    const decision =
      input.task.status === "FAILED"
        ? breaker.recordFailure(input.assignee)
        : breaker.recordSuccess(input.assignee);

    await this.maybeEmitCircuitTransition({
      phase: input.phase,
      task: input.task,
      taskNumber: input.taskNumber,
      decision,
    });
  }

  private async maybeEmitCircuitTransition(input: {
    phase: Phase;
    task: Task;
    taskNumber: number;
    decision: AdapterCircuitDecision;
  }): Promise<void> {
    if (input.decision.transition === "none") {
      return;
    }

    const stage = input.decision.transition === "opened" ? "opened" : "closed";
    const summary =
      stage === "opened"
        ? `Circuit breaker opened for ${input.decision.snapshot.adapterId} after ${input.decision.snapshot.consecutiveFailures} consecutive failure(s).`
        : `Circuit breaker closed for ${input.decision.snapshot.adapterId}; adapter is eligible again.`;

    await this.publishRuntimeEvent(
      createRuntimeEvent({
        family: "adapter-circuit",
        type: "adapter.circuit",
        payload: {
          stage,
          summary,
          consecutiveFailures: input.decision.snapshot.consecutiveFailures,
          failureThreshold: input.decision.snapshot.failureThreshold,
          cooldownMs: input.decision.snapshot.cooldownMs,
          remainingCooldownMs: input.decision.snapshot.remainingCooldownMs,
          openedAt: input.decision.snapshot.openedAt,
        },
        context: {
          source: "PHASE_RUNNER",
          projectName: this.config.projectName,
          phaseId: input.phase.id,
          phaseName: input.phase.name,
          taskId: input.task.id,
          taskTitle: input.task.title,
          taskNumber: input.taskNumber,
          adapterId: input.decision.snapshot.adapterId,
        },
      }),
    );
  }

  private resolveTaskRouting(
    task: Task,
    taskNumber: number,
  ): { assignee: CLIAdapterId; routingReason: TaskRoutingReason } {
    // Explicit task assignment remains authoritative and bypasses semantic routing.
    if (task.assignee !== "UNASSIGNED") {
      return {
        assignee: task.assignee as CLIAdapterId,
        routingReason: TaskRoutingReasonSchema.enum.fallback,
      };
    }

    if (!task.taskType) {
      console.info(
        `Routing fallback for task #${taskNumber} (${task.title}): taskType is missing; using ${this.config.activeAssignee}.`,
      );
      return {
        assignee: this.config.activeAssignee,
        routingReason: TaskRoutingReasonSchema.enum.fallback,
      };
    }

    const affinityAssignee = this.config.adapterAffinities?.[task.taskType];
    if (!affinityAssignee) {
      console.info(
        `Routing fallback for task #${taskNumber} (${task.title}): no adapter affinity configured for taskType '${task.taskType}'; using ${this.config.activeAssignee}.`,
      );
      return {
        assignee: this.config.activeAssignee,
        routingReason: TaskRoutingReasonSchema.enum.fallback,
      };
    }

    return {
      assignee: affinityAssignee,
      routingReason: TaskRoutingReasonSchema.enum.affinity,
    };
  }

  private async runDeliberationForTask(input: {
    phase: Phase;
    task: Task;
    taskNumber: number;
    implementerAssignee: CLIAdapterId;
  }): Promise<{
    refinedPrompt: string;
    summary: DeliberationSummary;
  }> {
    const reviewerAssignee = await this.resolveDeliberationReviewerAssignee({
      phase: input.phase,
      task: input.task,
      taskNumber: input.taskNumber,
      implementerAssignee: input.implementerAssignee,
    });
    const maxRefinePasses = this.config.deliberation?.maxRefinePasses ?? 1;
    console.info(
      `Execution loop: running deliberation for task #${input.taskNumber} ${input.task.title} with implementer=${input.implementerAssignee} reviewer=${reviewerAssignee}.`,
    );

    const result = await runDeliberationPass({
      projectName: this.config.projectName,
      rootDir: this.executionCwd,
      phase: input.phase,
      task: input.task,
      implementerAssignee: input.implementerAssignee,
      reviewerAssignee,
      maxRefinePasses,
      runInternalWork: async (internalInput) => {
        const executionResult = await this.control.runInternalWork({
          assignee: internalInput.assignee,
          prompt: internalInput.prompt,
          phaseId: internalInput.phaseId,
          taskId: internalInput.taskId,
          resume: internalInput.resume,
        });
        return {
          stdout: executionResult.stdout,
          stderr: executionResult.stderr,
        };
      },
    });

    if (result.status === "MAX_REFINE_PASSES_EXCEEDED") {
      console.warn(
        `Deliberation reached max refine passes (${maxRefinePasses}) for task #${input.taskNumber}. Continuing with latest refined prompt.`,
      );
    } else {
      console.info(
        `Deliberation approved for task #${input.taskNumber} after ${result.summary.rounds.length} round(s).`,
      );
    }

    return {
      refinedPrompt: result.refinedPrompt,
      summary: result.summary,
    };
  }

  private async resolveDeliberationReviewerAssignee(input: {
    phase: Phase;
    task: Task;
    taskNumber: number;
    implementerAssignee: CLIAdapterId;
  }): Promise<CLIAdapterId> {
    const preferredReviewer =
      this.config.deliberation?.reviewerAdapter ?? this.config.activeAssignee;
    const enabledAdapters = new Set(this.enabledAdapters);
    const candidates: CLIAdapterId[] = [];

    for (const candidate of [
      preferredReviewer,
      input.implementerAssignee,
      ...this.enabledAdapters,
    ]) {
      if (!candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }

    const openCandidates: CLIAdapterId[] = [];
    for (const candidate of candidates) {
      if (!enabledAdapters.has(candidate)) {
        continue;
      }

      const decision = this.getAdapterBreaker(candidate).check(candidate);
      await this.maybeEmitCircuitTransition({
        phase: input.phase,
        task: input.task,
        taskNumber: input.taskNumber,
        decision,
      });

      if (!decision.canExecute) {
        openCandidates.push(candidate);
        continue;
      }

      if (candidate !== preferredReviewer) {
        const reason = enabledAdapters.has(preferredReviewer)
          ? `circuit open for ${preferredReviewer}`
          : `${preferredReviewer} is unavailable`;
        const message = `Deliberation reviewer fallback for task #${input.taskNumber} (${input.task.title}): ${reason}; using ${candidate}.`;
        console.info(message);
        await this.publishRuntimeEvent(
          createRuntimeEvent({
            family: "task-lifecycle",
            type: "task.lifecycle.progress",
            payload: { message },
            context: {
              source: "PHASE_RUNNER",
              projectName: this.config.projectName,
              phaseId: input.phase.id,
              phaseName: input.phase.name,
              taskId: input.task.id,
              taskTitle: input.task.title,
              taskNumber: input.taskNumber,
              adapterId: candidate,
            },
          }),
        );
      }

      return candidate;
    }

    throw new Error(
      `No deliberation reviewer available for task #${input.taskNumber} ${input.task.title}. Open circuits: ${openCandidates.join(", ")}.`,
    );
  }

  private async runTesterStep(
    phase: Phase,
    task: Task,
    taskNumber: number,
  ): Promise<void> {
    this.setPhaseTimeoutStep(
      `running tester after task #${taskNumber} ${task.title}`,
    );
    await this.assertPhaseNotTimedOut();
    await this.publishRuntimeEvent(
      createRuntimeEvent({
        family: "tester-recovery",
        type: "tester.activity",
        payload: {
          stage: "started",
          summary: `Tester started after task #${taskNumber} ${task.title}.`,
        },
        context: {
          source: "PHASE_RUNNER",
          projectName: this.config.projectName,
          phaseId: phase.id,
          phaseName: phase.name,
          taskId: task.id,
          taskTitle: task.title,
          taskNumber,
        },
      }),
    );

    const testerResult = await runTesterWorkflow({
      phaseId: phase.id,
      phaseName: phase.name,
      completedTask: {
        id: task.id,
        title: task.title,
      },
      cwd: this.executionCwd,
      testerCommand: this.config.testerCommand,
      testerArgs: this.config.testerArgs,
      testerTimeoutMs: this.config.testerTimeoutMs,
      runner: this.testerRunner,
      createFixTask: async (input) => {
        // Dedup: skip if a CI_FIX task already exists in the phase that covers
        // this failure (either by exact title match or by depending on the
        // same triggering task). Repeated tester failures for the same
        // underlying issue must not generate duplicate CI_FIX tasks.
        const latestState = await this.control.getState();
        const latestPhase = latestState.phases.find(
          (p: any) => p.id === input.phaseId,
        );

        // Guardrail: enforce depth cap for the fix-task chain.
        if (!latestPhase) {
          throw new Error(
            `Phase not found while creating CI_FIX task: ${input.phaseId}`,
          );
        }
        const depth = this.calculateTaskDepth(latestPhase, task);
        if (depth >= this.config.ciFixMaxDepth) {
          throw new Error(
            `CI_FIX cascade depth cap exceeded (${this.config.ciFixMaxDepth}). ` +
              `The fix task chain for "${task.title}" has reached the maximum allowed depth. ` +
              `Manual intervention is required to break the failure cycle.`,
          );
        }

        const alreadyExists = latestPhase?.tasks.some(
          (t: any) =>
            t.status === "CI_FIX" &&
            (t.title === input.title ||
              t.dependencies.includes(task.id) ||
              input.dependencies.some((depId) =>
                t.dependencies.includes(depId),
              )),
        );
        if (alreadyExists) {
          console.info(
            `Tester: CI_FIX task for "${task.title}" already exists (title match or shared dependency) — skipping duplicate creation.`,
          );
          return;
        }
        await this.control.createTask({
          phaseId: input.phaseId,
          title: input.title,
          description: input.description,
          assignee: this.config.activeAssignee,
          dependencies: input.dependencies,
          status: input.status,
        });
      },
    });
    await this.assertPhaseNotTimedOut();

    if (testerResult.status === "SKIPPED") {
      console.warn(testerResult.reason);
      await this.publishRuntimeEvent(
        createRuntimeEvent({
          family: "tester-recovery",
          type: "tester.activity",
          payload: {
            stage: "skipped",
            summary: testerResult.reason,
          },
          context: {
            source: "PHASE_RUNNER",
            projectName: this.config.projectName,
            phaseId: phase.id,
            phaseName: phase.name,
            taskId: task.id,
            taskTitle: task.title,
            taskNumber,
          },
        }),
      );
      return;
    }

    if (testerResult.status === "FAILED") {
      console.info(
        `Tester workflow failed after task #${taskNumber}. Created fix task: ${testerResult.fixTaskTitle}.`,
      );
      await this.publishRuntimeEvent(
        createRuntimeEvent({
          family: "tester-recovery",
          type: "tester.activity",
          payload: {
            stage: "failed",
            summary: `Tester failed after ${task.title}. Created fix task: ${testerResult.fixTaskTitle}.`,
          },
          context: {
            source: "PHASE_RUNNER",
            projectName: this.config.projectName,
            phaseId: phase.id,
            phaseName: phase.name,
            taskId: task.id,
            taskTitle: task.title,
            taskNumber,
          },
        }),
      );
      await this.control.setPhaseStatus({
        phaseId: phase.id,
        status: "CI_FAILED",
        failureKind: "LOCAL_TESTER" as PhaseFailureKind,
        ciStatusContext: `${testerResult.errorMessage}

${testerResult.fixTaskDescription}`.trim(),
      });
      throw new Error(
        "Execution loop stopped after tester failure. Fix task has been created.",
      );
    }

    console.info(`Tester workflow passed after task #${taskNumber}.`);
    await this.publishRuntimeEvent(
      createRuntimeEvent({
        family: "tester-recovery",
        type: "tester.activity",
        payload: {
          stage: "passed",
          summary: `Tester passed after task #${taskNumber}.`,
        },
        context: {
          source: "PHASE_RUNNER",
          projectName: this.config.projectName,
          phaseId: phase.id,
          phaseName: phase.name,
          taskId: task.id,
          taskTitle: task.title,
          taskNumber,
        },
      }),
    );
  }

  private calculateTaskDepth(phase: Phase, task: Task): number {
    const isFixTask =
      task.status === "CI_FIX" ||
      task.title.startsWith("CI_FIX: ") ||
      task.title.startsWith("Fix tests after ");

    if (!isFixTask) {
      return 0;
    }

    let depth = 1;
    let currentTask = task;
    const visited = new Set<string>();

    while (currentTask.dependencies.length > 0) {
      if (visited.has(currentTask.id)) {
        break; // Cycle protection
      }
      visited.add(currentTask.id);

      const parentId = currentTask.dependencies[0];
      const parentTask = phase.tasks.find((t) => t.id === parentId);
      if (!parentTask) {
        break;
      }

      const isParentFixTask =
        parentTask.status === "CI_FIX" ||
        parentTask.title.startsWith("CI_FIX: ") ||
        parentTask.title.startsWith("Fix tests after ");

      if (!isParentFixTask) {
        break;
      }

      depth += 1;
      currentTask = parentTask;
    }
    return depth;
  }

  private resolveCommitTrailersForPhase(phase: Phase): {
    originatedBy: string;
    executedBy: CLIAdapterId;
  } {
    if (this.lastExecutedTaskContext) {
      return {
        originatedBy: `${phase.id}/${this.lastExecutedTaskContext.taskId}`,
        executedBy: this.lastExecutedTaskContext.assignee,
      };
    }

    for (let index = phase.tasks.length - 1; index >= 0; index -= 1) {
      const task = phase.tasks[index];
      if (!task || task.status !== "DONE") {
        continue;
      }

      const executedBy =
        task.resolvedAssignee ??
        (task.assignee !== "UNASSIGNED"
          ? (task.assignee as CLIAdapterId)
          : undefined);
      if (!executedBy) {
        continue;
      }

      return {
        originatedBy: `${phase.id}/${task.id}`,
        executedBy,
      };
    }

    throw new Error(
      `CI integration requires at least one DONE task with a resolved assignee to derive commit trailers for phase "${phase.name}".`,
    );
  }

  private async handleCiIntegration(phase: Phase): Promise<void> {
    this.setPhaseTimeoutStep("CI integration");
    await this.assertPhaseNotTimedOut();
    const isGitHub = this.config.vcsProvider === "github";
    await this.control.setPhaseStatus({
      phaseId: phase.id,
      status: "CREATING_PR",
    });
    const ciMessage = isGitHub
      ? "Creating PR and running CI integration."
      : `Pushing branch via ${this.config.vcsProvider} provider.`;
    await this.publishRuntimeEvent(
      createRuntimeEvent({
        family: "task-lifecycle",
        type: "task.lifecycle.phase-update",
        payload: {
          status: "CREATING_PR",
          message: ciMessage,
        },
        context: {
          source: "PHASE_RUNNER",
          projectName: this.config.projectName,
          phaseId: phase.id,
          phaseName: phase.name,
        },
      }),
    );
    console.info(
      isGitHub
        ? "CI integration enabled. Pushing branch and creating PR."
        : `CI integration enabled (${this.config.vcsProvider} provider). Pushing branch.`,
    );
    const commitTrailers = this.resolveCommitTrailersForPhase(phase);

    let ciResult: any;
    for (
      let ciAttempt = 1;
      ciAttempt <= Math.max(1, this.config.maxRecoveryAttempts + 1);
      ciAttempt += 1
    ) {
      try {
        this.setPhaseTimeoutStep(`CI integration attempt ${ciAttempt}`);
        const vcsProvider = createVcsProvider(
          this.config.vcsProvider,
          this.testerRunner,
        );
        ciResult = await runCiIntegration({
          phaseId: phase.id,
          phaseName: phase.name,
          tasks: phase.tasks,
          cwd: this.executionCwd,
          baseBranch: this.config.ciBaseBranch,
          pullRequest: this.config.ciPullRequest,
          commitTrailers,
          runner: this.testerRunner,
          vcsProvider,
          vcsProviderType: this.config.vcsProvider,
          role: this.config.role,
          policy: this.config.policy,
          setPhasePrUrl: async (input) => {
            await this.control.setPhasePrUrl(input);
          },
        });
        await this.assertPhaseNotTimedOut();
        break;
      } catch (error) {
        if (error instanceof PhaseTimedOutError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        const category = (error as any).category;
        if (ciAttempt > this.config.maxRecoveryAttempts) {
          throw error;
        }
        await this.attemptExceptionRecovery({
          phaseId: phase.id,
          phaseName: phase.name,
          errorMessage: message,
          category,
        });
        console.info(
          `Execution loop: recovery fixed CI integration precondition, retrying CI integration (attempt ${ciAttempt + 1}).`,
        );
      }
    }

    if (!ciResult) {
      throw new Error("CI integration did not produce a result.");
    }

    // For providers without PR support (local), run gates if configured, then mark DONE
    if (!ciResult.prUrl) {
      if (this.config.gates.length > 0) {
        await this.runPostIntegrationGateChain(phase, ciResult);
        return;
      }
      console.info(
        `CI integration completed (provider: ${this.config.vcsProvider}). Branch pushed: ${ciResult.headBranch}. No PR created.`,
      );
      await this.control.setPhaseStatus({
        phaseId: phase.id,
        status: "DONE",
      });
      await this.publishRuntimeEvent(
        createRuntimeEvent({
          family: "terminal-outcome",
          type: "terminal.outcome",
          payload: {
            outcome: "success",
            summary: `Phase ${phase.name} completed (${this.config.vcsProvider} provider, branch: ${ciResult.headBranch}).`,
          },
          context: {
            source: "PHASE_RUNNER",
            projectName: this.config.projectName,
            phaseId: phase.id,
            phaseName: phase.name,
          },
        }),
      );
      return;
    }

    await this.control.setPhaseStatus({
      phaseId: phase.id,
      status: "AWAITING_CI",
    });
    console.info(
      `CI integration completed. PR: ${ciResult.prUrl} (head: ${ciResult.headBranch}, base: ${ciResult.baseBranch}).`,
    );
    await this.publishRuntimeEvent(
      createRuntimeEvent({
        family: "ci-pr-lifecycle",
        type: "pr.activity",
        payload: {
          stage: "created",
          summary: `Created PR #${parsePullRequestNumberFromUrl(ciResult.prUrl)}: ${ciResult.prUrl}`,
          prUrl: ciResult.prUrl,
          prNumber: parsePullRequestNumberFromUrl(ciResult.prUrl),
          baseBranch: ciResult.baseBranch,
          headBranch: ciResult.headBranch,
          draft: this.config.ciPullRequest.createAsDraft,
        },
        context: {
          source: "PHASE_RUNNER",
          projectName: this.config.projectName,
          phaseId: phase.id,
          phaseName: phase.name,
        },
      }),
    );

    // Run post-integration gate chain if configured
    if (this.config.gates.length > 0) {
      await this.runPostIntegrationGateChain(phase, ciResult);
    } else {
      // Legacy path: direct CI validation
      await this.runCiValidationStep(phase);
    }
  }

  private async runPostIntegrationGateChain(
    phase: Phase,
    ciResult: { prUrl?: string; headBranch: string; baseBranch: string },
  ): Promise<void> {
    const vcsProvider = createVcsProvider(
      this.config.vcsProvider,
      this.testerRunner,
    );
    const gates = createGatesFromConfig(
      this.config.gates,
      this.testerRunner,
      vcsProvider,
      this.config.vcsProvider,
    );

    const prNumber = ciResult.prUrl
      ? parsePullRequestNumberFromUrl(ciResult.prUrl)
      : undefined;

    const gateContext: GateContext = {
      phaseId: phase.id,
      phaseName: phase.name,
      phase,
      cwd: this.executionCwd,
      baseBranch: ciResult.baseBranch,
      headBranch: ciResult.headBranch,
      vcsProviderType: this.config.vcsProvider,
      prUrl: ciResult.prUrl,
      prNumber,
    };

    const totalGates = gates.length;
    const eventContext = {
      source: "PHASE_RUNNER" as const,
      projectName: this.config.projectName,
      phaseId: phase.id,
      phaseName: phase.name,
    };

    const chainResult = await runGateChain(gates, gateContext, {
      onGateStart: async (gate, index) => {
        console.info(`Gate chain: starting gate "${gate.name}".`);
        await this.publishRuntimeEvent(
          createRuntimeEvent({
            family: "gate-lifecycle",
            type: "gate.activity",
            payload: {
              stage: "start",
              gateName: gate.name,
              gateIndex: index,
              totalGates,
              summary: `Starting gate "${gate.name}" (${index + 1}/${totalGates}).`,
            },
            context: eventContext,
          }),
        );
      },
      onGateResult: async (gate, result, index) => {
        const stage = result.passed ? "pass" : "fail";
        console.info(
          `Gate chain: gate "${gate.name}" ${result.passed ? "PASSED" : "FAILED"}.`,
        );
        if (!result.passed) {
          console.info(`Gate diagnostics: ${result.diagnostics}`);
        }
        await this.publishRuntimeEvent(
          createRuntimeEvent({
            family: "gate-lifecycle",
            type: "gate.activity",
            payload: {
              stage,
              gateName: gate.name,
              gateIndex: index,
              totalGates,
              summary: result.passed
                ? `Gate "${gate.name}" passed (${index + 1}/${totalGates}).`
                : `Gate "${gate.name}" failed (${index + 1}/${totalGates}): ${result.diagnostics}`,
              diagnostics: result.passed ? undefined : result.diagnostics,
              retryable: result.passed ? undefined : result.retryable,
            },
            context: eventContext,
          }),
        );
      },
    });

    if (chainResult.passed) {
      // Promote draft PR to ready if configured (mirrors legacy runCiValidationStep)
      if (this.config.ciPullRequest.markReadyOnApproval && ciResult.prUrl) {
        const prNumber = parsePullRequestNumberFromUrl(ciResult.prUrl);
        await this.privilegedGit.markPullRequestReady({
          prNumber,
          cwd: this.executionCwd,
        });
        console.info(`Marked draft PR #${prNumber} as ready for review.`);
        await this.publishRuntimeEvent(
          createRuntimeEvent({
            family: "ci-pr-lifecycle",
            type: "pr.activity",
            payload: {
              stage: "ready-for-review",
              summary: `Marked PR #${prNumber} as ready for review.`,
              prNumber,
              prUrl: ciResult.prUrl,
            },
            context: {
              source: "PHASE_RUNNER",
              projectName: this.config.projectName,
              phaseId: phase.id,
              phaseName: phase.name,
            },
          }),
        );
      }

      // For non-PR providers, terminal state is DONE not READY_FOR_REVIEW
      const terminalStatus = ciResult.prUrl ? "READY_FOR_REVIEW" : "DONE";
      await this.control.setPhaseStatus({
        phaseId: phase.id,
        status: terminalStatus,
      });
      await this.publishRuntimeEvent(
        createRuntimeEvent({
          family: "terminal-outcome",
          type: "terminal.outcome",
          payload: {
            outcome: "success",
            summary: ciResult.prUrl
              ? `Phase ${phase.name} passed all gates and is ready for review.`
              : `Phase ${phase.name} passed all gates (${this.config.vcsProvider} provider, branch: ${ciResult.headBranch}).`,
          },
          context: {
            source: "PHASE_RUNNER",
            projectName: this.config.projectName,
            phaseId: phase.id,
            phaseName: phase.name,
          },
        }),
      );
    } else {
      const failedGate = chainResult.results.find((r) => !r.passed);
      const diagnostics = failedGate?.diagnostics ?? "Unknown gate failure.";
      const failureKind: PhaseFailureKind =
        failedGate?.gate === "pr_ci" ? "REMOTE_CI" : "LOCAL_TESTER";
      await this.control.setPhaseStatus({
        phaseId: phase.id,
        status: "CI_FAILED",
        failureKind,
        ciStatusContext: `Gate "${failedGate?.gate}" failed: ${diagnostics}`,
      });
      throw new Error(
        `Gate chain failed at "${failedGate?.gate}": ${diagnostics}`,
      );
    }
  }

  private async runCiValidationStep(phase: Phase): Promise<void> {
    const latestState = await this.control.getState();
    const validationPhase = latestState.phases.find(
      (p: any) => p.id === phase.id,
    );
    if (!validationPhase) {
      throw new Error(
        `Completed phase not found for CI validation: ${phase.id}`,
      );
    }

    const prUrl = validationPhase.prUrl?.trim();
    if (!prUrl) {
      throw new Error("CI validation requires a phase PR URL.");
    }
    const prNumber = parsePullRequestNumberFromUrl(prUrl);
    console.info(`Polling GitHub CI checks for PR #${prNumber}.`);
    const ciSummary = await this.github.pollCiStatus({
      prNumber,
      cwd: this.executionCwd,
      intervalMs: 1_000,
      terminalConfirmations: 2,
      onTransition: async (transition) => {
        const transitionMessage = this.formatCiTransitionMessage({
          prNumber,
          transition,
        });
        console.info(transitionMessage);
        await this.publishRuntimeEvent(
          createRuntimeEvent({
            family: "ci-pr-lifecycle",
            type: "ci.activity",
            payload: {
              stage: "poll-transition",
              summary: transitionMessage,
              prNumber,
              previousOverall: transition.previousOverall ?? undefined,
              overall: transition.overall,
              pollCount: transition.pollCount,
              rerun: transition.isRerun,
              terminal: transition.isTerminal,
              terminalObservationCount: transition.terminalObservationCount,
              requiredTerminalObservations:
                transition.requiredTerminalObservations,
            },
            context: {
              source: "PHASE_RUNNER",
              projectName: this.config.projectName,
              phaseId: phase.id,
              phaseName: phase.name,
            },
          }),
        );
      },
    });
    const ciDiagnostics = formatCiDiagnostics({
      prNumber,
      prUrl,
      summary: ciSummary,
    });
    console.info(ciDiagnostics);

    if (ciSummary.overall !== "SUCCESS") {
      const currentState = await this.control.getState();
      const currentPhase = currentState.phases.find(
        (p: any) => p.id === phase.id,
      );
      if (!currentPhase) {
        throw new Error(
          `Active phase not found during CI failure mapping: ${phase.id}`,
        );
      }

      const mapping = deriveTargetedCiFixTasks({
        summary: ciSummary,
        prUrl,
        existingTasks: currentPhase.tasks,
      });

      // Guardrail: enforce fan-out count cap (fail fast if too many new tasks are required)
      if (mapping.tasksToCreate.length > this.config.ciFixMaxFanOut) {
        const fanOutError =
          `CI_FIX fan-out count cap exceeded (${this.config.ciFixMaxFanOut}). ` +
          `Detected ${mapping.tasksToCreate.length} new failing CI checks, which exceeds the allowed fan-out limit. ` +
          `Manual intervention is required to address the large number of failures.`;

        await this.control.setPhaseStatus({
          phaseId: phase.id,
          status: "CI_FAILED",
          failureKind: "REMOTE_CI" as PhaseFailureKind,
          ciStatusContext: [ciDiagnostics, fanOutError].join("\n\n"),
        });

        await this.publishRuntimeEvent(
          createRuntimeEvent({
            family: "ci-pr-lifecycle",
            type: "ci.activity",
            payload: {
              stage: "failed",
              summary: fanOutError,
              prNumber,
              overall: "FAILURE",
              createdFixTaskCount: 0,
            },
            context: {
              source: "PHASE_RUNNER",
              projectName: this.config.projectName,
              phaseId: phase.id,
              phaseName: phase.name,
            },
          }),
        );

        await this.publishRuntimeEvent(
          createRuntimeEvent({
            family: "terminal-outcome",
            type: "terminal.outcome",
            payload: {
              outcome: "failure",
              summary: fanOutError,
            },
            context: {
              source: "PHASE_RUNNER",
              projectName: this.config.projectName,
              phaseId: phase.id,
              phaseName: phase.name,
            },
          }),
        );

        throw new Error(fanOutError);
      }

      for (const taskInput of mapping.tasksToCreate) {
        await this.control.createTask({
          phaseId: phase.id,
          title: taskInput.title,
          description: taskInput.description,
          assignee: this.config.activeAssignee,
          dependencies: taskInput.dependencies,
          status: taskInput.status,
        });
      }

      const nextAction =
        mapping.tasksToCreate.length > 0
          ? "Next action: complete the new CI_FIX task(s) and rerun phase execution."
          : "Next action: complete the existing CI_FIX task(s) and rerun phase execution.";
      const ciFailureContext = [
        ciDiagnostics,
        `CI_FIX mapping: created=${mapping.tasksToCreate.length}, skipped_existing=${mapping.skippedTaskTitles.length}`,
        nextAction,
      ].join("\n");

      await this.control.setPhaseStatus({
        phaseId: phase.id,
        status: "CI_FAILED",
        failureKind: "REMOTE_CI" as PhaseFailureKind,
        ciStatusContext: ciFailureContext,
      });

      await this.publishRuntimeEvent(
        createRuntimeEvent({
          family: "ci-pr-lifecycle",
          type: "ci.activity",
          payload: {
            stage: "failed",
            summary: `CI checks failed for PR #${prNumber}; created ${mapping.tasksToCreate.length} CI_FIX task(s).`,
            prNumber,
            overall: "FAILURE",
            createdFixTaskCount: mapping.tasksToCreate.length,
          },
          context: {
            source: "PHASE_RUNNER",
            projectName: this.config.projectName,
            phaseId: phase.id,
            phaseName: phase.name,
          },
        }),
      );

      await this.publishRuntimeEvent(
        createRuntimeEvent({
          family: "terminal-outcome",
          type: "terminal.outcome",
          payload: {
            outcome: "failure",
            summary: `CI checks failed for PR #${prNumber}; created ${mapping.tasksToCreate.length} CI_FIX task(s).`,
          },
          context: {
            source: "PHASE_RUNNER",
            projectName: this.config.projectName,
            phaseId: phase.id,
            phaseName: phase.name,
          },
        }),
      );
      throw new Error(
        "Execution loop stopped after CI checks failed. Targeted CI_FIX tasks are pending.",
      );
    }

    console.info(
      `Starting CI validation loop (max retries: ${this.config.validationMaxRetries}).`,
    );
    const validationResult = await runCiValidationLoop({
      projectName: latestState.projectName,
      rootDir: latestState.rootDir,
      phase: validationPhase,
      assignee: this.config.activeAssignee,
      maxRetries: this.config.validationMaxRetries,
      readGitDiff: async () => {
        const diff = await this.testerRunner.run({
          command: "git",
          args: ["diff", "--no-color"],
          cwd: this.executionCwd,
        });
        return diff.stdout;
      },
      runInternalWork: async (input) => {
        const result = await this.control.runInternalWork({
          assignee: input.assignee,
          prompt: input.prompt,
          phaseId: input.phaseId,
          resume: input.resume,
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
    });

    if (validationResult.status === "MAX_RETRIES_EXCEEDED") {
      await this.control.setPhaseStatus({
        phaseId: phase.id,
        status: "CI_FAILED",
        failureKind: "REMOTE_CI" as PhaseFailureKind,
        ciStatusContext: validationResult.pendingComments.join("\n"),
      });
      console.info(
        `CI validation loop reached max retries (${validationResult.maxRetries}). Pending comments: ${validationResult.pendingComments.join(" | ")}`,
      );
      await this.publishRuntimeEvent(
        createRuntimeEvent({
          family: "ci-pr-lifecycle",
          type: "ci.activity",
          payload: {
            stage: "validation-max-retries",
            summary: `Review requires fixes after ${validationResult.fixAttempts} attempts.`,
            prNumber,
            overall: "FAILURE",
          },
          context: {
            source: "PHASE_RUNNER",
            projectName: this.config.projectName,
            phaseId: phase.id,
            phaseName: phase.name,
          },
        }),
      );
      await this.publishRuntimeEvent(
        createRuntimeEvent({
          family: "terminal-outcome",
          type: "terminal.outcome",
          payload: {
            outcome: "failure",
            summary: `Review requires fixes after ${validationResult.fixAttempts} attempts.`,
          },
          context: {
            source: "PHASE_RUNNER",
            projectName: this.config.projectName,
            phaseId: phase.id,
            phaseName: phase.name,
          },
        }),
      );
      throw new Error(
        "Execution loop stopped after CI validation max retries.",
      );
    }

    if (this.config.ciPullRequest.markReadyOnApproval) {
      const prUrl = validationPhase.prUrl?.trim();
      if (!prUrl) {
        throw new Error(
          "PR ready transition is enabled but phase PR URL is missing.",
        );
      }

      const prNumber = parsePullRequestNumberFromUrl(prUrl);
      await this.privilegedGit.markPullRequestReady({
        prNumber,
        cwd: this.executionCwd,
      });
      console.info(`Marked draft PR #${prNumber} as ready for review.`);
      await this.publishRuntimeEvent(
        createRuntimeEvent({
          family: "ci-pr-lifecycle",
          type: "pr.activity",
          payload: {
            stage: "ready-for-review",
            summary: `Marked PR #${prNumber} as ready for review.`,
            prNumber,
            prUrl,
          },
          context: {
            source: "PHASE_RUNNER",
            projectName: this.config.projectName,
            phaseId: phase.id,
            phaseName: phase.name,
          },
        }),
      );
    }

    await this.control.setPhaseStatus({
      phaseId: phase.id,
      status: "READY_FOR_REVIEW",
    });

    console.info(
      `CI validation loop approved after ${validationResult.reviews.length} review round(s) and ${validationResult.fixAttempts} fix attempt(s).`,
    );
    await this.publishRuntimeEvent(
      createRuntimeEvent({
        family: "ci-pr-lifecycle",
        type: "ci.activity",
        payload: {
          stage: "succeeded",
          summary: `CI checks and review approved for PR #${prNumber}.`,
          prNumber,
          overall: "SUCCESS",
        },
        context: {
          source: "PHASE_RUNNER",
          projectName: this.config.projectName,
          phaseId: phase.id,
          phaseName: phase.name,
        },
      }),
    );
    await this.publishRuntimeEvent(
      createRuntimeEvent({
        family: "terminal-outcome",
        type: "terminal.outcome",
        payload: {
          outcome: "success",
          summary: `Review approved after ${validationResult.reviews.length} round(s).`,
        },
        context: {
          source: "PHASE_RUNNER",
          projectName: this.config.projectName,
          phaseId: phase.id,
          phaseName: phase.name,
        },
      }),
    );
  }

  private async attemptExceptionRecovery(input: {
    phaseId: string;
    phaseName: string;
    taskId?: string;
    taskTitle?: string;
    errorMessage: string;
    category?: any;
    adapterFailureKind?: any;
  }): Promise<void> {
    const exception = classifyRecoveryException({
      message: input.errorMessage,
      category: input.category,
      phaseId: input.phaseId,
      adapterFailureKind: input.adapterFailureKind,
      taskId: input.taskId,
    });
    if (!isRecoverableException(exception)) {
      throw new Error(
        `Exception is not recoverable by policy: ${input.errorMessage}`,
      );
    }
    if (this.config.maxRecoveryAttempts <= 0) {
      throw new Error(
        `Exception recovery disabled (exceptionRecovery.maxAttempts=${this.config.maxRecoveryAttempts}).`,
      );
    }

    let lastError: Error | undefined;
    let lastExhaustionReason: RecoveryExhaustionReason = "failed";
    for (
      let attemptNumber = 1;
      attemptNumber <= this.config.maxRecoveryAttempts;
      attemptNumber += 1
    ) {
      console.info(
        `Recovery attempt ${attemptNumber}/${this.config.maxRecoveryAttempts} for ${input.taskTitle ?? input.phaseName}: ${exception.category}.`,
      );
      await this.publishRuntimeEvent(
        createRuntimeEvent({
          family: "tester-recovery",
          type: "recovery.activity",
          payload: {
            stage: "attempt-started",
            summary: `Recovery attempt ${attemptNumber}/${this.config.maxRecoveryAttempts} for ${input.taskTitle ?? input.phaseName}.`,
            attemptNumber,
            category: exception.category,
          },
          context: {
            source: "PHASE_RUNNER",
            projectName: this.config.projectName,
            phaseId: input.phaseId,
            phaseName: input.phaseName,
            taskId: input.taskId,
            taskTitle: input.taskTitle,
          },
        }),
      );
      let markedUnfixable = false;
      try {
        const recovery = await runExceptionRecovery({
          cwd: this.executionCwd,
          assignee: this.config.activeAssignee,
          exception,
          attemptNumber,
          role: this.config.role,
          policy: this.config.policy,
          phaseName: input.phaseName,
          taskTitle: input.taskTitle,
          runInternalWork: async (work) => {
            const result = await this.control.runInternalWork({
              assignee: work.assignee,
              prompt: work.prompt,
              cwd: work.cwd,
              phaseId: work.phaseId,
              taskId: work.taskId,
              resume: work.resume,
            });
            return {
              stdout: result.stdout,
              stderr: result.stderr,
            };
          },
        });

        await this.control.recordRecoveryAttempt({
          phaseId: input.phaseId,
          taskId: input.taskId,
          attemptNumber,
          exception: recovery.exception,
          result: recovery.result,
        });

        if (recovery.result.status === "fixed") {
          await verifyRecoveryPostcondition({
            exception: recovery.exception,
            verifiers: {
              verifyDirtyWorktree: async () =>
                this.git.ensureCleanWorkingTree(this.executionCwd),
            },
          });
          console.info(`Recovery fixed: ${recovery.result.reasoning}`);
          await this.publishRuntimeEvent(
            createRuntimeEvent({
              family: "tester-recovery",
              type: "recovery.activity",
              payload: {
                stage: "attempt-fixed",
                summary: recovery.result.reasoning,
                attemptNumber,
                category: exception.category,
              },
              context: {
                source: "PHASE_RUNNER",
                projectName: this.config.projectName,
                phaseId: input.phaseId,
                phaseName: input.phaseName,
                taskId: input.taskId,
                taskTitle: input.taskTitle,
              },
            }),
          );
          return;
        }

        await this.publishRuntimeEvent(
          createRuntimeEvent({
            family: "tester-recovery",
            type: "recovery.activity",
            payload: {
              stage: "attempt-unfixable",
              summary: recovery.result.reasoning,
              attemptNumber,
              category: exception.category,
            },
            context: {
              source: "PHASE_RUNNER",
              projectName: this.config.projectName,
              phaseId: input.phaseId,
              phaseName: input.phaseName,
              taskId: input.taskId,
              taskTitle: input.taskTitle,
            },
          }),
        );

        markedUnfixable = true;
        throw new Error(
          `Recovery marked unfixable: ${recovery.result.reasoning}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = new Error(message);
        lastExhaustionReason = markedUnfixable ? "unfixable" : "failed";
        console.info(`Recovery attempt ${attemptNumber} failed: ${message}`);
        await this.publishRuntimeEvent(
          createRuntimeEvent({
            family: "tester-recovery",
            type: "recovery.activity",
            payload: {
              stage: "attempt-failed",
              summary: message,
              attemptNumber,
              category: exception.category,
            },
            context: {
              source: "PHASE_RUNNER",
              projectName: this.config.projectName,
              phaseId: input.phaseId,
              phaseName: input.phaseName,
              taskId: input.taskId,
              taskTitle: input.taskTitle,
            },
          }),
        );
      }
    }

    throw new RecoveryAttemptsExhaustedError(
      `Recovery attempts exhausted (${this.config.maxRecoveryAttempts}): ${lastError?.message ?? input.errorMessage}`,
      lastExhaustionReason,
    );
  }

  private formatCiTransitionMessage(input: {
    prNumber: number;
    transition: CiPollTransition;
  }): string {
    const previousOverall = input.transition.previousOverall ?? "INIT";
    const rerunSuffix = input.transition.isRerun ? " | rerun-detected" : "";
    const terminalSuffix = input.transition.isTerminal
      ? ` | terminal-confirmation=${input.transition.terminalObservationCount}/${input.transition.requiredTerminalObservations}`
      : "";
    return `CI transition PR #${input.prNumber}: ${previousOverall} -> ${input.transition.overall} (poll=${input.transition.pollCount})${rerunSuffix}${terminalSuffix}`;
  }

  private async publishRuntimeEvent(event: RuntimeEvent): Promise<void> {
    if (!this.notifyLoopEvent) {
      return;
    }
    await this.notifyLoopEvent(event);
  }
}
