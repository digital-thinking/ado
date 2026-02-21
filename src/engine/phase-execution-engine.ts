import { createAdapter, type CodexUsageSnapshot, type TaskAdapter } from "../adapters";
import type { ProcessRunner } from "../process";
import type {
  CLIAdapterId,
  Phase,
  PhaseStatus,
  ProjectState,
  Task,
} from "../types";
import type { CiStatusSummary } from "../vcs";

export interface StateStore {
  readProjectState(): Promise<ProjectState>;
  writeProjectState(state: ProjectState): Promise<ProjectState>;
}

export interface GitOps {
  ensureCleanWorkingTree(cwd: string): Promise<void>;
  createBranch(input: { branchName: string; cwd: string; fromRef?: string }): Promise<void>;
  pushBranch(input: { branchName: string; cwd: string; remote?: string; setUpstream?: boolean }): Promise<void>;
}

export interface GitHubOps {
  createPullRequest(input: {
    base: string;
    head: string;
    title: string;
    body: string;
    cwd: string;
  }): Promise<string>;
  pollCiStatus(input: {
    prNumber: number;
    cwd: string;
    intervalMs?: number;
    timeoutMs?: number;
  }): Promise<CiStatusSummary>;
  addReviewComment?(prNumber: number, body: string, cwd: string): Promise<void>;
}

export interface UsageTrackerLike {
  collect(cwd: string): Promise<CodexUsageSnapshot>;
}

export interface NotificationPublisherLike {
  notify(message: string): Promise<void>;
}

export type AdapterFactory = (adapterId: CLIAdapterId, runner: ProcessRunner) => TaskAdapter;

export type RunPhaseOptions = {
  cwd: string;
  baseBranch?: string;
  prTitle?: string;
  prBody?: string;
  ciPollIntervalMs?: number;
  ciPollTimeoutMs?: number;
  maxFixAttempts?: number;
  availableAssignees?: CLIAdapterId[];
};

export type RunPhaseResult = {
  phaseId: string;
  prUrl: string;
  ciStatus: CiStatusSummary;
};

const DEFAULT_ASSIGNEE_ORDER: CLIAdapterId[] = [
  "CODEX_CLI",
  "GEMINI_CLI",
  "CLAUDE_CLI",
  "MOCK_CLI",
];

function parsePullRequestNumber(prUrl: string): number {
  const match = /\/pull\/(\d+)/.exec(prUrl);
  if (!match) {
    throw new Error(`Unable to parse PR number from URL: ${prUrl}`);
  }

  return Number(match[1]);
}

function dependencySatisfied(task: Task, doneTaskIds: Set<string>): boolean {
  return task.dependencies.every((dependencyId) => doneTaskIds.has(dependencyId));
}

function readCodexUsage(payload: unknown): { used: number; quota: number } | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const providers = (payload as Record<string, unknown>).providers;
  if (!providers || typeof providers !== "object") {
    return null;
  }

  const codex = (providers as Record<string, unknown>).codex;
  if (!codex || typeof codex !== "object") {
    return null;
  }

  const used = Number((codex as Record<string, unknown>).used);
  const quota = Number((codex as Record<string, unknown>).quota);
  if (!Number.isFinite(used) || !Number.isFinite(quota) || quota <= 0) {
    return null;
  }

  return { used, quota };
}

function isCodexNearQuota(snapshot: CodexUsageSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }

  const usage = readCodexUsage(snapshot.payload);
  if (!usage) {
    return false;
  }

  return usage.used / usage.quota >= 0.9;
}

function buildTaskPrompt(task: Task, ciContext?: string): string {
  if (ciContext) {
    return `${task.title}\n\n${task.description}\n\nCI context:\n${ciContext}`;
  }

  return `${task.title}\n\n${task.description}`;
}

function summarizeCiStatus(ciStatus: CiStatusSummary): string {
  if (ciStatus.checks.length === 0) {
    return `CI status: ${ciStatus.overall}`;
  }

  const checks = ciStatus.checks.map((check) => `${check.name}: ${check.state}`).join(", ");
  return `CI status: ${ciStatus.overall}. Checks: ${checks}`;
}

export class PhaseExecutionEngine {
  private readonly store: StateStore;
  private readonly git: GitOps;
  private readonly github: GitHubOps;
  private readonly runner: ProcessRunner;
  private readonly adapterFactory: AdapterFactory;
  private readonly usageTracker?: UsageTrackerLike;
  private readonly notifier?: NotificationPublisherLike;

  constructor(input: {
    store: StateStore;
    git: GitOps;
    github: GitHubOps;
    runner: ProcessRunner;
    adapterFactory?: AdapterFactory;
    usageTracker?: UsageTrackerLike;
    notifier?: NotificationPublisherLike;
  }) {
    this.store = input.store;
    this.git = input.git;
    this.github = input.github;
    this.runner = input.runner;
    this.adapterFactory = input.adapterFactory ?? createAdapter;
    this.usageTracker = input.usageTracker;
    this.notifier = input.notifier;
  }

  async runPhase(phaseId: string, options: RunPhaseOptions): Promise<RunPhaseResult> {
    if (!options.cwd.trim()) {
      throw new Error("cwd must not be empty.");
    }

    const phase = await this.getPhase(phaseId);
    const prTitle = options.prTitle ?? `Phase ${phase.name}`;
    const prBody = options.prBody ?? `Automated Phase execution for ${phase.name}.`;
    const availableAssignees = options.availableAssignees ?? DEFAULT_ASSIGNEE_ORDER;
    const maxFixAttempts = options.maxFixAttempts ?? 3;

    await this.git.ensureCleanWorkingTree(options.cwd);

    await this.setPhaseStatus(phaseId, "BRANCHING");
    await this.git.createBranch({
      branchName: phase.branchName,
      cwd: options.cwd,
      fromRef: options.baseBranch ?? "HEAD",
    });

    await this.setPhaseStatus(phaseId, "CODING");
    await this.runTaskLoop(phaseId, options.cwd, ["TODO", "FAILED"], availableAssignees);

    await this.setPhaseStatus(phaseId, "CREATING_PR");
    await this.git.pushBranch({
      branchName: phase.branchName,
      cwd: options.cwd,
      setUpstream: true,
    });

    const prUrl = await this.github.createPullRequest({
      base: options.baseBranch ?? "main",
      head: phase.branchName,
      title: prTitle,
      body: prBody,
      cwd: options.cwd,
    });
    const prNumber = parsePullRequestNumber(prUrl);

    if (this.github.addReviewComment) {
      await this.github.addReviewComment(
        prNumber,
        "Automated IxADO review: execution completed, waiting for CI.",
        options.cwd
      );
    }

    await this.updatePhase(phaseId, (target) => ({
      ...target,
      prUrl,
      status: "AWAITING_CI",
    }));

    let ciStatus = await this.github.pollCiStatus({
      prNumber,
      cwd: options.cwd,
      intervalMs: options.ciPollIntervalMs,
      timeoutMs: options.ciPollTimeoutMs,
    });

    if (ciStatus.overall === "SUCCESS") {
      await this.setPhaseStatus(phaseId, "READY_FOR_REVIEW");
      await this.notify(`Phase ready for review: ${prUrl}`);

      return { phaseId, prUrl, ciStatus };
    }

    await this.updatePhase(phaseId, (target) => ({
      ...target,
      status: "CI_FAILED",
      ciStatusContext: summarizeCiStatus(ciStatus),
    }));
    await this.notify(`CI failed for ${prUrl}. Starting automated fix loop.`);

    for (let attempt = 1; attempt <= maxFixAttempts; attempt += 1) {
      const ciContext = `Attempt ${attempt}: ${summarizeCiStatus(ciStatus)}`;
      await this.markTasksForCiFix(phaseId, ciContext);
      await this.runTaskLoop(phaseId, options.cwd, ["CI_FIX", "FAILED"], availableAssignees, ciContext);

      await this.git.pushBranch({
        branchName: phase.branchName,
        cwd: options.cwd,
        setUpstream: false,
      });

      await this.setPhaseStatus(phaseId, "AWAITING_CI");
      ciStatus = await this.github.pollCiStatus({
        prNumber,
        cwd: options.cwd,
        intervalMs: options.ciPollIntervalMs,
        timeoutMs: options.ciPollTimeoutMs,
      });

      if (ciStatus.overall === "SUCCESS") {
        await this.setPhaseStatus(phaseId, "READY_FOR_REVIEW");
        await this.notify(`CI recovered and phase is ready for review: ${prUrl}`);
        return { phaseId, prUrl, ciStatus };
      }

      await this.updatePhase(phaseId, (target) => ({
        ...target,
        status: "CI_FAILED",
        ciStatusContext: summarizeCiStatus(ciStatus),
      }));
    }

    throw new Error(`CI fix loop exhausted ${maxFixAttempts} attempts without success.`);
  }

  private async runTaskLoop(
    phaseId: string,
    cwd: string,
    runnableStatuses: Array<Task["status"]>,
    availableAssignees: CLIAdapterId[],
    ciContext?: string
  ): Promise<void> {
    while (true) {
      const phase = await this.getPhase(phaseId);
      const doneTaskIds = new Set(
        phase.tasks.filter((task) => task.status === "DONE").map((task) => task.id)
      );

      const pending = phase.tasks.filter((task) => runnableStatuses.includes(task.status));
      if (pending.length === 0) {
        return;
      }

      const runnable = pending.find((task) => dependencySatisfied(task, doneTaskIds));
      if (!runnable) {
        throw new Error(`No runnable task found for phase ${phase.name}. Check task dependencies.`);
      }

      await this.executeTask(phaseId, runnable.id, cwd, availableAssignees, ciContext);
    }
  }

  private async executeTask(
    phaseId: string,
    taskId: string,
    cwd: string,
    availableAssignees: CLIAdapterId[],
    ciContext?: string
  ): Promise<void> {
    const selectedAssignee = await this.resolveAssignee(phaseId, taskId, cwd, availableAssignees);

    await this.updateTask(phaseId, taskId, (task) => ({
      ...task,
      assignee: selectedAssignee,
      status: "IN_PROGRESS",
    }));

    const adapter = this.adapterFactory(selectedAssignee, this.runner);
    const task = (await this.getPhase(phaseId)).tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    try {
      const result = await adapter.run({
        prompt: buildTaskPrompt(task, ciContext),
        cwd,
      });

      await this.updateTask(phaseId, taskId, (target) => ({
        ...target,
        assignee: selectedAssignee,
        status: "DONE",
        resultContext: result.stdout.trim(),
        errorLogs: undefined,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.updateTask(phaseId, taskId, (target) => ({
        ...target,
        assignee: selectedAssignee,
        status: "FAILED",
        errorLogs: message,
      }));
      throw error;
    }
  }

  private async resolveAssignee(
    phaseId: string,
    taskId: string,
    cwd: string,
    availableAssignees: CLIAdapterId[]
  ): Promise<CLIAdapterId> {
    const phase = await this.getPhase(phaseId);
    const task = phase.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.assignee !== "UNASSIGNED") {
      return task.assignee as CLIAdapterId;
    }

    let usageSnapshot: CodexUsageSnapshot | null = null;
    if (this.usageTracker) {
      try {
        usageSnapshot = await this.usageTracker.collect(cwd);
      } catch {
        usageSnapshot = null;
      }
    }

    const codexNearQuota = isCodexNearQuota(usageSnapshot);
    const preferred = codexNearQuota
      ? availableAssignees.filter((assignee) => assignee !== "CODEX_CLI")
      : availableAssignees;

    const fallbackOrder = [...preferred, ...DEFAULT_ASSIGNEE_ORDER].filter(
      (value, idx, arr) => arr.indexOf(value) === idx
    );

    return fallbackOrder[0] ?? "MOCK_CLI";
  }

  private async markTasksForCiFix(phaseId: string, ciContext: string): Promise<void> {
    await this.updatePhase(phaseId, (phase) => ({
      ...phase,
      tasks: phase.tasks.map((task) => {
        if (task.status === "DONE" || task.status === "FAILED" || task.status === "CI_FIX") {
          return {
            ...task,
            status: "CI_FIX",
            errorLogs: ciContext,
          };
        }

        return task;
      }),
    }));
  }

  private async notify(message: string): Promise<void> {
    if (!this.notifier) {
      return;
    }

    await this.notifier.notify(message);
  }

  private async getState(): Promise<ProjectState> {
    return this.store.readProjectState();
  }

  private async getPhase(phaseId: string): Promise<Phase> {
    const state = await this.getState();
    const phase = state.phases.find((candidate) => candidate.id === phaseId);
    if (!phase) {
      throw new Error(`Phase not found: ${phaseId}`);
    }

    return phase;
  }

  private async setPhaseStatus(phaseId: string, status: PhaseStatus): Promise<void> {
    await this.updatePhase(phaseId, (phase) => ({
      ...phase,
      status,
    }));
  }

  private async updateTask(
    phaseId: string,
    taskId: string,
    updater: (task: Task) => Task
  ): Promise<void> {
    await this.updatePhase(phaseId, (phase) => {
      const nextTasks = [...phase.tasks];
      const taskIndex = nextTasks.findIndex((task) => task.id === taskId);
      if (taskIndex < 0) {
        throw new Error(`Task not found: ${taskId}`);
      }

      nextTasks[taskIndex] = updater(nextTasks[taskIndex]);

      return {
        ...phase,
        tasks: nextTasks,
      };
    });
  }

  private async updatePhase(phaseId: string, updater: (phase: Phase) => Phase): Promise<void> {
    const state = await this.getState();
    const phaseIndex = state.phases.findIndex((candidate) => candidate.id === phaseId);
    if (phaseIndex < 0) {
      throw new Error(`Phase not found: ${phaseId}`);
    }

    const nextPhases = [...state.phases];
    nextPhases[phaseIndex] = updater(nextPhases[phaseIndex]);

    await this.store.writeProjectState({
      ...state,
      activePhaseId: phaseId,
      phases: nextPhases,
    });
  }
}
