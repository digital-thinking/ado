import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  classifyRecoveryException,
  isRecoverableException,
  runExceptionRecovery,
  verifyRecoveryPostcondition,
} from "./exception-recovery";
import { runCiIntegration } from "./ci-integration";
import { runCiValidationLoop } from "./ci-validation-loop";
import { PhaseLoopControl } from "./phase-loop-control";
import {
  waitForAutoAdvance as waitForAutoAdvanceGate,
  waitForManualAdvance as waitForManualAdvanceGate,
} from "./phase-loop-wait";
import { runTesterWorkflow } from "./tester-workflow";
import { ProcessManager, type ProcessRunner } from "../process";
import { GitHubManager, GitManager, PrivilegedGitActions } from "../vcs";
import { type ControlCenterService } from "../web";
import { type AuthPolicy, type Role } from "../security/policy";
import { type CLIAdapterId, type Phase, type Task } from "../types";

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

export type PhaseRunnerConfig = {
  mode: "AUTO" | "MANUAL";
  countdownSeconds: number;
  activeAssignee: CLIAdapterId;
  maxRecoveryAttempts: number;
  testerCommand: string | null;
  testerArgs: string[] | null;
  testerTimeoutMs: number;
  ciEnabled: boolean;
  ciBaseBranch: string;
  validationMaxRetries: number;
  projectRootDir: string;
  projectName: string;
  policy: AuthPolicy;
  role: Role | null;
};

export class PhaseRunner {
  private git: GitManager;
  private github: GitHubManager;
  private privilegedGit: PrivilegedGitActions;

  constructor(
    private control: ControlCenterService,
    private config: PhaseRunnerConfig,
    private loopControl: PhaseLoopControl = new PhaseLoopControl(),
    private notifyLoopEvent?: (message: string) => Promise<void>,
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
  }

  async run(): Promise<void> {
    const rl = createInterface({
      input: stdin,
      output: stdout,
    });

    console.info(
      `Starting phase execution loop in ${this.config.mode} mode (countdown: ${this.config.countdownSeconds}s, assignee: ${this.config.activeAssignee}, recovery max attempts: ${this.config.maxRecoveryAttempts}).`,
    );

    try {
      const state = await this.control.getState();
      const phase = this.resolveActivePhase(state);

      await this.prepareBranch(phase);
      const completedPhase = await this.executionLoop(phase, rl);

      if (completedPhase && this.config.ciEnabled) {
        await this.handleCiIntegration(completedPhase);
      } else if (completedPhase) {
        await this.control.setPhaseStatus({
          phaseId: completedPhase.id,
          status: "DONE",
        });
      }
    } finally {
      rl.close();
    }
  }

  private resolveActivePhase(state: any): Phase {
    const phase =
      state.phases.find(
        (candidate: any) => candidate.id === state.activePhaseId,
      ) ?? state.phases[0];
    if (!phase) {
      throw new Error("No active phase found.");
    }
    return phase;
  }

  private async prepareBranch(phase: Phase): Promise<void> {
    await this.control.setPhaseStatus({
      phaseId: phase.id,
      status: "BRANCHING",
    });
    console.info(`Execution loop: preparing branch ${phase.branchName}.`);

    while (true) {
      try {
        await this.git.ensureCleanWorkingTree(this.config.projectRootDir);
        const currentBranch = await this.git.getCurrentBranch(
          this.config.projectRootDir,
        );
        if (currentBranch === phase.branchName) {
          console.info(
            `Execution loop: already on branch ${phase.branchName}.`,
          );
        } else {
          try {
            await this.git.checkout(
              phase.branchName,
              this.config.projectRootDir,
            );
            console.info(
              `Execution loop: checked out existing branch ${phase.branchName}.`,
            );
          } catch {
            await this.privilegedGit.createBranch({
              branchName: phase.branchName,
              cwd: this.config.projectRootDir,
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
            await this.git.ensureCleanWorkingTree(this.config.projectRootDir);
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
    const effectiveAssignee: CLIAdapterId =
      task.assignee !== "UNASSIGNED"
        ? (task.assignee as CLIAdapterId)
        : this.config.activeAssignee;
    const nextTaskLabel = `task #${taskNumber} ${task.title}`;
    console.info(
      `Execution loop: starting ${nextTaskLabel} with ${effectiveAssignee}.`,
    );

    let taskRunCount = 0;
    const maxTaskRunCount = Math.max(1, this.config.maxRecoveryAttempts + 1);

    while (taskRunCount < maxTaskRunCount) {
      taskRunCount += 1;
      const updatedState = await this.control.startActiveTaskAndWait({
        taskNumber,
        assignee: effectiveAssignee,
        resume: resumeSession,
      });
      const updatedPhase = this.resolveActivePhase(updatedState);
      const resultTask = updatedPhase.tasks[taskNumber - 1];

      if (!resultTask) {
        throw new Error(`Task #${taskNumber} not found after loop execution.`);
      }

      console.info(
        `Execution loop: ${nextTaskLabel} finished with status ${resultTask.status}.`,
      );
      if (resultTask.status !== "FAILED") {
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
        await this.control.setPhaseStatus({
          phaseId: updatedPhase.id,
          status: "CI_FAILED",
          ciStatusContext: `${failureMessage}
Recovery: ${recoveryMessage}`,
        });
        throw recoveryError;
      }
    }

    await this.control.setPhaseStatus({
      phaseId: phase.id,
      status: "CI_FAILED",
      ciStatusContext: `Execution failed after ${maxTaskRunCount} run attempts for task #${taskNumber}.`,
    });
    throw new Error(
      `Execution loop stopped after FAILED task #${taskNumber}. Recovery retries were exhausted.`,
    );
  }

  private async runTesterStep(
    phase: Phase,
    task: Task,
    taskNumber: number,
  ): Promise<void> {
    await this.notifyLoopEvent?.(
      `Task Done: ${phase.name} #${taskNumber} ${task.title} (${task.status}).`,
    );

    const testerResult = await runTesterWorkflow({
      phaseId: phase.id,
      phaseName: phase.name,
      completedTask: {
        id: task.id,
        title: task.title,
      },
      cwd: this.config.projectRootDir,
      testerCommand: this.config.testerCommand,
      testerArgs: this.config.testerArgs,
      testerTimeoutMs: this.config.testerTimeoutMs,
      runner: this.testerRunner,
      createFixTask: async (input) => {
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
      await this.notifyLoopEvent?.(`Tester skipped: ${testerResult.reason}`);
      return;
    }

    if (testerResult.status === "FAILED") {
      console.info(
        `Tester workflow failed after task #${taskNumber}. Created fix task: ${testerResult.fixTaskTitle}.`,
      );
      await this.notifyLoopEvent?.(
        `Test Fail: ${phase.name} after ${task.title}. Created fix task: ${testerResult.fixTaskTitle}.`,
      );
      await this.control.setPhaseStatus({
        phaseId: phase.id,
        status: "CI_FAILED",
        ciStatusContext: `${testerResult.errorMessage}

${testerResult.fixTaskDescription}`.trim(),
      });
      throw new Error(
        "Execution loop stopped after tester failure. Fix task has been created.",
      );
    }

    console.info(`Tester workflow passed after task #${taskNumber}.`);
  }

  private async handleCiIntegration(phase: Phase): Promise<void> {
    await this.control.setPhaseStatus({
      phaseId: phase.id,
      status: "CREATING_PR",
    });
    console.info(
      "Optional CI integration enabled. Pushing branch and creating PR via gh.",
    );

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
          cwd: this.config.projectRootDir,
          baseBranch: this.config.ciBaseBranch,
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
    await this.notifyLoopEvent?.(
      `PR Created: ${phase.name} -> ${ciResult.prUrl}`,
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
          cwd: this.config.projectRootDir,
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
        ciStatusContext: validationResult.pendingComments.join("\n"),
      });
      console.info(
        `CI validation loop reached max retries (${validationResult.maxRetries}). Pending comments: ${validationResult.pendingComments.join(" | ")}`,
      );
      await this.notifyLoopEvent?.(
        `Review: ${phase.name} needs fixes after ${validationResult.fixAttempts} attempts. Pending: ${validationResult.pendingComments.join(" | ")}`,
      );
      throw new Error(
        "Execution loop stopped after CI validation max retries.",
      );
    }

    await this.control.setPhaseStatus({
      phaseId: phase.id,
      status: "READY_FOR_REVIEW",
    });

    console.info(
      `CI validation loop approved after ${validationResult.reviews.length} review round(s) and ${validationResult.fixAttempts} fix attempt(s).`,
    );
    await this.notifyLoopEvent?.(
      `Review: ${phase.name} approved after ${validationResult.reviews.length} round(s).`,
    );
  }

  private async attemptExceptionRecovery(input: {
    phaseId: string;
    phaseName: string;
    taskId?: string;
    taskTitle?: string;
    errorMessage: string;
    category?: any;
  }): Promise<void> {
    const exception = classifyRecoveryException({
      message: input.errorMessage,
      category: input.category,
      phaseId: input.phaseId,
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
    for (
      let attemptNumber = 1;
      attemptNumber <= this.config.maxRecoveryAttempts;
      attemptNumber += 1
    ) {
      console.info(
        `Recovery attempt ${attemptNumber}/${this.config.maxRecoveryAttempts} for ${input.taskTitle ?? input.phaseName}: ${exception.category}.`,
      );
      try {
        const recovery = await runExceptionRecovery({
          cwd: this.config.projectRootDir,
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
                this.git.ensureCleanWorkingTree(this.config.projectRootDir),
            },
          });
          console.info(`Recovery fixed: ${recovery.result.reasoning}`);
          return;
        }

        throw new Error(
          `Recovery marked unfixable: ${recovery.result.reasoning}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = new Error(message);
        console.info(`Recovery attempt ${attemptNumber} failed: ${message}`);
      }
    }

    throw new Error(
      `Recovery attempts exhausted (${this.config.maxRecoveryAttempts}): ${lastError?.message ?? input.errorMessage}`,
    );
  }
}
