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
  type CiPollTransition,
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
  type TaskRoutingReason,
  type TaskType,
} from "../types";
import { createRuntimeEvent, type RuntimeEvent } from "../types/runtime-events";

/**
 * Picks the index of the next task to execute, applying explicit priority rules
 * for deterministic, stable ordering across TODO and CI_FIX task sets.
 *
 * Selection rules (highest priority first):
 *   1. CI_FIX tasks — must be resolved before new work so the repository
 *      stays in a passing state after every tester run.
 *   2. TODO tasks   — normal forward-progress work.
 *
 * Within each priority tier the task with the lowest array index is chosen,
 * providing stable ordering across state reloads and consistent task numbering.
 *
 * Returns the index of the selected task, or -1 when no actionable task exists.
 */
export function pickNextTask(tasks: readonly { status: string }[]): number {
  // Priority 1: resolve CI_FIX tasks before advancing to new work.
  const ciFixIndex = tasks.findIndex((task) => task.status === "CI_FIX");
  if (ciFixIndex >= 0) {
    return ciFixIndex;
  }
  // Priority 2: fall back to the earliest pending TODO task.
  return tasks.findIndex((task) => task.status === "TODO");
}

const TERMINAL_PHASE_STATUSES = [
  "DONE",
  "AWAITING_CI",
  "READY_FOR_REVIEW",
  "CI_FAILED",
] as const;

const ACTIONABLE_TASK_STATUSES = ["TODO", "CI_FIX"] as const;
const DEFAULT_ADAPTER_BREAKER_CONFIG: AdapterCircuitBreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 300_000,
};

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
  ciEnabled: boolean;
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

      // Preflight: validate phase metadata and status before any git work.
      // Identical gate in both AUTO and MANUAL modes — deterministic execution
      // gate semantics that cannot be bypassed by exception recovery.
      this.runPreflightChecks(phase);
      await this.checkBranchBasePreconditions(phase);

      await this.prepareBranch(phase);
      const completedPhase = await this.executionLoop(phase, rl);

      if (completedPhase && this.config.ciEnabled) {
        await this.handleCiIntegration(completedPhase);
        shouldTeardownOnSuccess = true;
      } else if (completedPhase) {
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
        return resolveActivePhaseStrict({
          phases: state.phases,
          activePhaseIds: [configuredPhaseId],
        });
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
  }

  private async prepareBranch(phase: Phase): Promise<void> {
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

    while (true) {
      try {
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
      if (this.loopControl.isStopRequested()) {
        console.info("Execution loop stopped.");
        return undefined;
      }

      const state = await this.control.getState();
      const currentPhase = this.resolveActivePhase(state);
      const nextTaskIndex = pickNextTask(currentPhase.tasks);

      if (nextTaskIndex < 0) {
        console.info(
          `Execution loop finished. No TODO or CI_FIX tasks in active phase ${currentPhase.name}.`,
        );
        return currentPhase;
      }

      const nextTaskNumber = nextTaskIndex + 1;
      const nextTask = currentPhase.tasks[nextTaskIndex];
      const nextTaskLabel = `task #${nextTaskNumber} ${nextTask.title}`;

      if (iteration > 0) {
        const abortController = new AbortController();
        const decision =
          this.config.mode === "AUTO"
            ? await waitForAutoAdvanceGate({
                loopControl: this.loopControl,
                countdownSeconds: this.config.countdownSeconds,
                nextTaskLabel,
                onInfo: (line) => console.info(line),
              })
            : await waitForManualAdvanceGate({
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

        if (decision === "STOP") {
          this.loopControl.requestStop();
          console.info("Execution loop stopped before starting the next task.");
          return undefined;
        }
      }

      iteration += 1;
      await this.runTaskStep(
        currentPhase,
        nextTask,
        nextTaskNumber,
        resumeSession,
      );

      const updatedState = await this.control.getState();
      const updatedPhase = this.resolveActivePhase(updatedState);
      const resultTask = updatedPhase.tasks[nextTaskNumber - 1];

      await this.runTesterStep(updatedPhase, resultTask, nextTaskNumber);

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
      taskRunCount += 1;
      if (taskRunCount > 1) {
        effectiveAssignee = await this.resolveDispatchAssignee({
          phase,
          task,
          taskNumber,
          preferredAssignee,
        });
      }
      const updatedState = await this.control.startActiveTaskAndWait({
        taskNumber,
        assignee: effectiveAssignee,
        resolvedAssignee: effectiveAssignee,
        routingReason,
        resume: resumeSession,
        taskDescriptionOverride,
        resultContextPrefix,
      });
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
    await this.control.setPhaseStatus({
      phaseId: phase.id,
      status: "CREATING_PR",
    });
    await this.publishRuntimeEvent(
      createRuntimeEvent({
        family: "task-lifecycle",
        type: "task.lifecycle.phase-update",
        payload: {
          status: "CREATING_PR",
          message: "Creating PR and running CI integration.",
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
      "Optional CI integration enabled. Pushing branch and creating PR via gh.",
    );
    const commitTrailers = this.resolveCommitTrailersForPhase(phase);

    let ciResult: any;
    for (
      let ciAttempt = 1;
      ciAttempt <= Math.max(1, this.config.maxRecoveryAttempts + 1);
      ciAttempt += 1
    ) {
      try {
        ciResult = await runCiIntegration({
          phaseId: phase.id,
          phaseName: phase.name,
          tasks: phase.tasks,
          cwd: this.executionCwd,
          baseBranch: this.config.ciBaseBranch,
          pullRequest: this.config.ciPullRequest,
          commitTrailers,
          runner: this.testerRunner,
          role: this.config.role,
          policy: this.config.policy,
          setPhasePrUrl: async (input) => {
            await this.control.setPhasePrUrl(input);
          },
        });
        break;
      } catch (error) {
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

    await this.control.setPhaseStatus({
      phaseId: phase.id,
      status: "AWAITING_CI",
    });
    console.info(
      `Optional CI integration completed. PR: ${ciResult.prUrl} (head: ${ciResult.headBranch}, base: ${ciResult.baseBranch}).`,
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

    await this.runCiValidationStep(phase);
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
