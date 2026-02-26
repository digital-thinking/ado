import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import {
  classifyAdapterFailure,
  type AdapterFailureKind,
} from "../adapters/failure-taxonomy";
import { buildWorkerPrompt } from "../engine/worker-prompts";
import { parseJsonFromModelOutput } from "../engine/json-parser";
import {
  ProcessExecutionError,
  ProcessManager,
  type ProcessRunner,
} from "../process";
import type { StateEngine } from "../state";
import {
  CLIAdapterIdSchema,
  ExceptionMetadataSchema,
  ExceptionRecoveryResultSchema,
  PhaseFailureKindSchema,
  PhaseSchema,
  PhaseStatusSchema,
  RecoveryAttemptRecordSchema,
  TaskCompletionVerificationSchema,
  TaskSchema,
  WorkerAssigneeSchema,
  type CLIAdapterId,
  type ExceptionMetadata,
  type ExceptionRecoveryResult,
  type Phase,
  type PhaseFailureKind,
  type PhaseStatus,
  type ProjectState,
  type RecoveryAttemptRecord,
  type SideEffectContract,
  type Task,
  type TaskCompletionVerification,
  type WorkerAssignee,
} from "../types";
import { parsePullRequestNumberFromUrl } from "../vcs";

const DEFAULT_TASKS_MARKDOWN_PATH = "TASKS.md";
const TASKS_IMPORT_TIMEOUT_MS = 180_000;
const TASK_EXECUTION_TIMEOUT_MS = 3_600_000;
const MAX_STORED_CONTEXT_LENGTH = 4_000;

const ImportedTaskPlanSchema = z.object({
  code: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  status: z.enum(["TODO", "DONE"]).default("TODO"),
  assignee: WorkerAssigneeSchema.default("UNASSIGNED"),
  dependencies: z.array(z.string().min(1)).default([]),
});

const ImportedPhasePlanSchema = z.object({
  name: z.string().min(1),
  branchName: z.string().min(1),
  tasks: z.array(ImportedTaskPlanSchema),
});

const ImportedTasksPlanSchema = z.object({
  phases: z.array(ImportedPhasePlanSchema).min(1),
});

type ImportedTaskPlan = z.infer<typeof ImportedTaskPlanSchema>;
type ImportedPhasePlan = z.infer<typeof ImportedPhasePlanSchema>;
type ImportedTasksPlan = z.infer<typeof ImportedTasksPlanSchema>;

export type CreatePhaseInput = {
  name: string;
  branchName: string;
};

export type CreateTaskInput = {
  phaseId: string;
  title: string;
  description: string;
  assignee?: WorkerAssignee;
  dependencies?: string[];
  status?: Task["status"];
};

export type UpdateTaskInput = {
  phaseId: string;
  taskId: string;
  title: string;
  description: string;
  dependencies: string[];
};

export type RunInternalWorkInput = {
  assignee: CLIAdapterId;
  prompt: string;
  timeoutMs?: number;
  phaseId?: string;
  taskId?: string;
  resume?: boolean;
};

export type RunInternalWorkResult = {
  assignee: CLIAdapterId;
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type ImportTasksMarkdownResult = {
  state: ProjectState;
  importedPhaseCount: number;
  importedTaskCount: number;
  sourceFilePath: string;
  assignee: CLIAdapterId;
};

export type StartTaskInput = {
  phaseId: string;
  taskId: string;
  assignee: CLIAdapterId;
  resume?: boolean;
};

export type SetActivePhaseInput = {
  phaseId: string;
};

export type SetPhasePrUrlInput = {
  phaseId: string;
  prUrl: string;
};

export type SetPhaseStatusInput = {
  phaseId: string;
  status: PhaseStatus;
  ciStatusContext?: string;
  failureKind?: PhaseFailureKind;
};

export type RecordRecoveryAttemptInput = {
  phaseId: string;
  taskId?: string;
  attemptNumber: number;
  exception: ExceptionMetadata;
  result: ExceptionRecoveryResult;
};

export type StartActiveTaskInput = {
  taskNumber: number;
  assignee: CLIAdapterId;
  resume?: boolean;
};

export type ResetTaskInput = {
  phaseId: string;
  taskId: string;
};

export type ActivePhaseTaskItem = {
  number: number;
  title: string;
  status: Task["status"];
  assignee: WorkerAssignee;
};

export type ActivePhaseTasksView = {
  phaseId: string;
  phaseName: string;
  items: ActivePhaseTaskItem[];
};

type InternalWorkRunner = (
  input: RunInternalWorkInput,
) => Promise<Omit<RunInternalWorkResult, "assignee">>;

type RepositoryResetRunner = () => Promise<void>;

export type StateEngineFactory = (
  projectName: string,
) => StateEngine | Promise<StateEngine>;

type ImportedTaskDraft = ImportedTaskPlan & {
  id: string;
};

type ImportedPhaseDraft = Omit<ImportedPhasePlan, "tasks"> & {
  id: string;
  tasks: ImportedTaskDraft[];
};

function buildTasksMarkdownImportPrompt(markdown: string): string {
  return [
    "Transform the TASKS.md content into IxADO import JSON.",
    "Return only valid JSON (no markdown, no commentary).",
    "Schema:",
    '{"phases":[{"name":"Phase X: Name","branchName":"phase-x-name","tasks":[{"code":"P1-001","title":"P1-001 Task title","description":"Task description","status":"TODO|DONE","assignee":"UNASSIGNED|MOCK_CLI|CODEX_CLI|GEMINI_CLI|CLAUDE_CLI","dependencies":["P1-000"]}]}]}',
    "Rules:",
    "- Include every phase and every task from TASKS.md.",
    "- Preserve checkbox status: [x] -> DONE, [ ] -> TODO.",
    "- Dependencies must be task codes, not prose.",
    "- Do not invent phases or tasks that are not in TASKS.md.",
    "- Keep titles concise and description meaningful.",
    "TASKS.md:",
    markdown,
  ].join("\n\n");
}

function createDraftsFromPlan(plan: ImportedTasksPlan): ImportedPhaseDraft[] {
  const taskCodeSet = new Set<string>();
  const taskCodeToId = new Map<string, string>();

  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      if (taskCodeSet.has(task.code)) {
        throw new Error(`Duplicate task code in import plan: ${task.code}`);
      }

      taskCodeSet.add(task.code);
      taskCodeToId.set(task.code, randomUUID());
    }
  }

  return plan.phases.map((phase) => ({
    id: randomUUID(),
    name: phase.name,
    branchName: phase.branchName,
    tasks: phase.tasks.map((task) => ({
      ...task,
      id: taskCodeToId.get(task.code)!,
    })),
  }));
}

function taskExecutionKey(phaseId: string, taskId: string): string {
  return `${phaseId}:${taskId}`;
}

function isRecoveringFixTaskStatus(status: Task["status"]): boolean {
  return status === "CI_FIX";
}

function truncateForState(value: string): string {
  if (value.length <= MAX_STORED_CONTEXT_LENGTH) {
    return value;
  }

  return value.slice(0, MAX_STORED_CONTEXT_LENGTH);
}

function resolveActivePhaseOrThrow(state: ProjectState): Phase {
  const explicitActive = state.activePhaseId
    ? state.phases.find((phase) => phase.id === state.activePhaseId)
    : undefined;
  if (explicitActive) {
    return explicitActive;
  }

  const firstPhase = state.phases[0];
  if (!firstPhase) {
    throw new Error("No phases found.");
  }

  return firstPhase;
}

function resolvePhaseIdForReference(
  state: ProjectState,
  phaseReference: string,
): string {
  const exactMatch = state.phases.find((phase) => phase.id === phaseReference);
  if (exactMatch) {
    return exactMatch.id;
  }

  const phaseNumber = Number(phaseReference);
  if (Number.isInteger(phaseNumber) && phaseNumber > 0) {
    const phaseByNumber = state.phases[phaseNumber - 1];
    if (phaseByNumber) {
      return phaseByNumber.id;
    }
  }

  throw new Error(`Phase not found: ${phaseReference}`);
}

const SIDE_EFFECT_CONTRACT_PATTERNS: ReadonlyArray<{
  contract: SideEffectContract;
  patterns: ReadonlyArray<RegExp>;
}> = [
  {
    contract: "PR_CREATION",
    patterns: [
      /\bcreate pr task\b/i,
      /\bcreate pull request\b/i,
      /\bopen pr\b/i,
      /\bpull request\b/i,
    ],
  },
  {
    contract: "REMOTE_PUSH",
    patterns: [
      /\bremote push\b/i,
      /\bpush branch\b/i,
      /\bpush to origin\b/i,
      /\bpush changes\b/i,
    ],
  },
  {
    contract: "CI_TRIGGERED_UPDATE",
    patterns: [
      /\bci-triggered updates?\b/i,
      /\bci triggered updates?\b/i,
      /\btrigger ci\b/i,
      /\bci status updates?\b/i,
    ],
  },
];

const GITHUB_BOUND_SIDE_EFFECT_CONTRACTS: readonly SideEffectContract[] = [
  "PR_CREATION",
  "REMOTE_PUSH",
  "CI_TRIGGERED_UPDATE",
];

type SideEffectProbeResult = TaskCompletionVerification["probes"][number];

type SideEffectProbeRunResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  details: string;
  failureKind?: AdapterFailureKind;
};

type GitHubCapabilityPreflightFailure = {
  completionVerification: TaskCompletionVerification;
  adapterFailureKind: AdapterFailureKind;
};

export function resolveTaskCompletionSideEffectContracts(
  task: Pick<Task, "title" | "description">,
): SideEffectContract[] {
  const text = `${task.title}\n${task.description}`;

  return SIDE_EFFECT_CONTRACT_PATTERNS.flatMap((entry) => {
    const matches = entry.patterns.some((pattern) => pattern.test(text));
    return matches ? [entry.contract] : [];
  });
}

function resolveGitHubBoundContracts(
  contracts: SideEffectContract[],
): SideEffectContract[] {
  return contracts.filter((contract) =>
    GITHUB_BOUND_SIDE_EFFECT_CONTRACTS.includes(contract),
  );
}

function hasCiTriggeredUpdateSignal(phase: Phase): boolean {
  if (
    phase.status === "AWAITING_CI" ||
    phase.status === "CI_FAILED" ||
    phase.status === "READY_FOR_REVIEW"
  ) {
    return true;
  }

  if (Boolean(phase.ciStatusContext?.trim())) {
    return true;
  }

  return phase.tasks.some((task) => task.status === "CI_FIX");
}

function summarizeVerificationFailure(
  verification: TaskCompletionVerification,
): string {
  const details =
    verification.missingSideEffects.length > 0
      ? verification.missingSideEffects.join(" | ")
      : "Missing side effects were detected.";
  return `Completion side-effect verification failed: ${details}`;
}

function summarizeCapabilityPreflightFailure(
  verification: TaskCompletionVerification,
): string {
  const details =
    verification.missingSideEffects.length > 0
      ? verification.missingSideEffects.join(" | ")
      : "GitHub runtime capability mismatch detected.";
  return `Runtime capability preflight failed for GitHub-bound task: ${details}`;
}

export class ControlCenterService {
  private readonly stateEngineFactory: StateEngineFactory;
  private readonly projectStateEngines = new Map<string, StateEngine>();
  private readonly tasksMarkdownFilePath: string;
  private readonly internalWorkRunner?: InternalWorkRunner;
  private readonly repositoryResetRunner?: RepositoryResetRunner;
  private readonly runningTaskExecutions = new Map<string, Promise<void>>();
  private readonly onStateChange?: (
    projectName: string,
    state: ProjectState,
  ) => void;
  private readonly sideEffectProbeRunner: ProcessRunner;
  private defaultProjectName?: string;

  constructor(
    stateOrFactory: StateEngine | StateEngineFactory,
    tasksMarkdownFilePath = resolve(process.cwd(), DEFAULT_TASKS_MARKDOWN_PATH),
    internalWorkRunner?: InternalWorkRunner,
    repositoryResetRunner?: RepositoryResetRunner,
    onStateChange?: (projectName: string, state: ProjectState) => void,
    sideEffectProbeRunner: ProcessRunner = new ProcessManager(),
  ) {
    if (typeof stateOrFactory === "function") {
      this.stateEngineFactory = stateOrFactory;
    } else {
      this.stateEngineFactory = () => stateOrFactory;
    }
    this.tasksMarkdownFilePath = tasksMarkdownFilePath;
    this.internalWorkRunner = internalWorkRunner;
    this.repositoryResetRunner = repositoryResetRunner;
    this.onStateChange = onStateChange;
    this.sideEffectProbeRunner = sideEffectProbeRunner;
  }

  private async getEngine(projectName?: string): Promise<StateEngine> {
    const name = projectName || this.defaultProjectName;
    if (!name) {
      throw new Error(
        "No project name specified and no default project initialized.",
      );
    }

    let engine = this.projectStateEngines.get(name);
    if (!engine) {
      engine = await this.stateEngineFactory(name);
      this.projectStateEngines.set(name, engine);
    }
    return engine;
  }

  async ensureInitialized(
    projectName: string,
    rootDir: string,
  ): Promise<ProjectState> {
    if (!this.defaultProjectName) {
      this.defaultProjectName = projectName;
    }

    const engine = await this.getEngine(projectName);
    try {
      return await engine.readProjectState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("State file not found")) {
        throw error;
      }
    }

    return engine.initialize({ projectName, rootDir });
  }

  async getState(projectName?: string): Promise<ProjectState> {
    return (await this.getEngine(projectName)).readProjectState();
  }

  async createPhase(
    input: CreatePhaseInput & { projectName?: string },
  ): Promise<ProjectState> {
    if (!input.name.trim()) {
      throw new Error("phase name must not be empty.");
    }
    if (!input.branchName.trim()) {
      throw new Error("branch name must not be empty.");
    }

    const engine = await this.getEngine(input.projectName);
    const state = await engine.readProjectState();
    const phase = PhaseSchema.parse({
      id: randomUUID(),
      name: input.name.trim(),
      branchName: input.branchName.trim(),
      status: "PLANNING",
      tasks: [],
    });

    const nextState = await engine.writeProjectState({
      ...state,
      activePhaseId: phase.id,
      phases: [...state.phases, phase],
    });
    this.onStateChange?.(nextState.projectName, nextState);
    return nextState;
  }

  async createTask(
    input: CreateTaskInput & { projectName?: string },
  ): Promise<ProjectState> {
    if (!input.phaseId.trim()) {
      throw new Error("phaseId must not be empty.");
    }
    if (!input.title.trim()) {
      throw new Error("task title must not be empty.");
    }
    if (!input.description.trim()) {
      throw new Error("task description must not be empty.");
    }

    const engine = await this.getEngine(input.projectName);
    const state = await engine.readProjectState();
    const phaseIndex = state.phases.findIndex(
      (phase) => phase.id === input.phaseId,
    );
    if (phaseIndex < 0) {
      throw new Error(`Phase not found: ${input.phaseId}`);
    }

    const task = TaskSchema.parse({
      id: randomUUID(),
      title: input.title.trim(),
      description: input.description.trim(),
      assignee: input.assignee ?? "UNASSIGNED",
      dependencies: input.dependencies ?? [],
      status: input.status ?? "TODO",
    });

    const nextPhases = [...state.phases];
    nextPhases[phaseIndex] = {
      ...nextPhases[phaseIndex],
      tasks: [...nextPhases[phaseIndex].tasks, task],
    };

    const nextState = await engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
    this.onStateChange?.(nextState.projectName, nextState);
    return nextState;
  }

  async updateTask(
    input: UpdateTaskInput & { projectName?: string },
  ): Promise<ProjectState> {
    const phaseId = input.phaseId.trim();
    const taskId = input.taskId.trim();
    const title = input.title.trim();
    const description = input.description.trim();
    const dependencies = input.dependencies
      .map((dependencyId) => dependencyId.trim())
      .filter(
        (dependencyId, index, values) =>
          dependencyId.length > 0 && values.indexOf(dependencyId) === index,
      );

    if (!phaseId) {
      throw new Error("phaseId must not be empty.");
    }
    if (!taskId) {
      throw new Error("taskId must not be empty.");
    }
    if (!title) {
      throw new Error("task title must not be empty.");
    }
    if (!description) {
      throw new Error("task description must not be empty.");
    }
    if (dependencies.includes(taskId)) {
      throw new Error("Task cannot depend on itself.");
    }

    const runKey = taskExecutionKey(phaseId, taskId);
    if (this.runningTaskExecutions.has(runKey)) {
      throw new Error("Cannot edit a running task.");
    }

    const engine = await this.getEngine(input.projectName);
    const state = await engine.readProjectState();
    const phaseIndex = state.phases.findIndex((phase) => phase.id === phaseId);
    if (phaseIndex < 0) {
      throw new Error(`Phase not found: ${phaseId}`);
    }

    const phase = state.phases[phaseIndex];
    const taskIndex = phase.tasks.findIndex((task) => task.id === taskId);
    if (taskIndex < 0) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const task = phase.tasks[taskIndex];
    if (task.status === "IN_PROGRESS") {
      throw new Error("Cannot edit task while it is IN_PROGRESS.");
    }

    const knownTaskIds = new Set(
      state.phases.flatMap((candidatePhase) =>
        candidatePhase.tasks.map((candidateTask) => candidateTask.id),
      ),
    );
    const missingDependency = dependencies.find(
      (dependencyId) => !knownTaskIds.has(dependencyId),
    );
    if (missingDependency) {
      throw new Error(
        `Task has invalid dependency reference: ${missingDependency}`,
      );
    }

    const updatedTask = TaskSchema.parse({
      ...task,
      title,
      description,
      dependencies,
    });

    const nextPhases = [...state.phases];
    const nextTasks = [...phase.tasks];
    nextTasks[taskIndex] = updatedTask;
    nextPhases[phaseIndex] = {
      ...phase,
      tasks: nextTasks,
    };

    const nextState = await engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
    this.onStateChange?.(nextState.projectName, nextState);
    return nextState;
  }

  async setActivePhase(
    input: SetActivePhaseInput & { projectName?: string },
  ): Promise<ProjectState> {
    const phaseReference = input.phaseId.trim();
    if (!phaseReference) {
      throw new Error("phaseId must not be empty.");
    }

    const engine = await this.getEngine(input.projectName);
    const state = await engine.readProjectState();
    const phaseId = resolvePhaseIdForReference(state, phaseReference);

    const nextState = await engine.writeProjectState({
      ...state,
      activePhaseId: phaseId,
    });
    this.onStateChange?.(nextState.projectName, nextState);
    return nextState;
  }

  async setPhasePrUrl(
    input: SetPhasePrUrlInput & { projectName?: string },
  ): Promise<ProjectState> {
    const phaseId = input.phaseId.trim();
    const prUrl = input.prUrl.trim();
    if (!phaseId) {
      throw new Error("phaseId must not be empty.");
    }
    if (!prUrl) {
      throw new Error("prUrl must not be empty.");
    }

    const engine = await this.getEngine(input.projectName);
    const state = await engine.readProjectState();
    const phaseIndex = state.phases.findIndex((phase) => phase.id === phaseId);
    if (phaseIndex < 0) {
      throw new Error(`Phase not found: ${phaseId}`);
    }

    const phase = state.phases[phaseIndex];
    const nextPhases = [...state.phases];
    nextPhases[phaseIndex] = PhaseSchema.parse({
      ...phase,
      prUrl,
    });

    const nextState = await engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
    this.onStateChange?.(nextState.projectName, nextState);
    return nextState;
  }

  async setPhaseStatus(
    input: SetPhaseStatusInput & { projectName?: string },
  ): Promise<ProjectState> {
    const phaseId = input.phaseId.trim();
    const status = PhaseStatusSchema.parse(input.status);
    if (!phaseId) {
      throw new Error("phaseId must not be empty.");
    }

    const engine = await this.getEngine(input.projectName);
    const state = await engine.readProjectState();
    const phaseIndex = state.phases.findIndex((phase) => phase.id === phaseId);
    if (phaseIndex < 0) {
      throw new Error(`Phase not found: ${phaseId}`);
    }

    const phase = state.phases[phaseIndex];
    const normalizedContext = input.ciStatusContext?.trim();
    const ciStatusContext =
      status === "CI_FAILED"
        ? normalizedContext || phase.ciStatusContext
        : undefined;
    const rawFailureKind = input.failureKind
      ? PhaseFailureKindSchema.parse(input.failureKind)
      : undefined;
    const failureKind =
      status === "CI_FAILED"
        ? (rawFailureKind ?? phase.failureKind)
        : undefined;
    const nextPhases = [...state.phases];
    nextPhases[phaseIndex] = PhaseSchema.parse({
      ...phase,
      status,
      ciStatusContext,
      failureKind,
    });

    const nextState = await engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
    this.onStateChange?.(nextState.projectName, nextState);
    return nextState;
  }

  async listActivePhaseTasks(
    projectName?: string,
  ): Promise<ActivePhaseTasksView> {
    const engine = await this.getEngine(projectName);
    const state = await engine.readProjectState();
    const activePhase = resolveActivePhaseOrThrow(state);

    return {
      phaseId: activePhase.id,
      phaseName: activePhase.name,
      items: activePhase.tasks.map((task, index) => ({
        number: index + 1,
        title: task.title,
        status: task.status,
        assignee: task.assignee,
      })),
    };
  }

  async recordRecoveryAttempt(
    input: RecordRecoveryAttemptInput & { projectName?: string },
  ): Promise<ProjectState> {
    const phaseId = input.phaseId.trim();
    const taskId = input.taskId?.trim();
    if (!phaseId) {
      throw new Error("phaseId must not be empty.");
    }

    const attemptNumber = Number(input.attemptNumber);
    if (!Number.isInteger(attemptNumber) || attemptNumber <= 0) {
      throw new Error("attemptNumber must be a positive integer.");
    }

    const exception = ExceptionMetadataSchema.parse(input.exception);
    const result = ExceptionRecoveryResultSchema.parse(input.result);

    const engine = await this.getEngine(input.projectName);
    const state = await engine.readProjectState();
    const phaseIndex = state.phases.findIndex((phase) => phase.id === phaseId);
    if (phaseIndex < 0) {
      throw new Error(`Phase not found: ${phaseId}`);
    }

    const phase = state.phases[phaseIndex];
    const record = RecoveryAttemptRecordSchema.parse({
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      attemptNumber,
      exception,
      result,
    });

    const nextPhases = [...state.phases];
    if (taskId) {
      const taskIndex = phase.tasks.findIndex((task) => task.id === taskId);
      if (taskIndex < 0) {
        throw new Error(`Task not found: ${taskId}`);
      }
      const nextTasks = [...phase.tasks];
      nextTasks[taskIndex] = TaskSchema.parse({
        ...nextTasks[taskIndex],
        recoveryAttempts: [
          ...(nextTasks[taskIndex].recoveryAttempts ?? []),
          record,
        ],
      });
      nextPhases[phaseIndex] = PhaseSchema.parse({
        ...phase,
        tasks: nextTasks,
      });
    } else {
      nextPhases[phaseIndex] = PhaseSchema.parse({
        ...phase,
        recoveryAttempts: [...(phase.recoveryAttempts ?? []), record],
      });
    }

    const nextState = await engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
    this.onStateChange?.(nextState.projectName, nextState);
    return nextState;
  }

  async startActiveTask(
    input: StartActiveTaskInput & { projectName?: string },
  ): Promise<ProjectState> {
    const taskNumber = Number(input.taskNumber);
    if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
      throw new Error("taskNumber must be a positive integer.");
    }

    const engine = await this.getEngine(input.projectName);
    const state = await engine.readProjectState();
    const activePhase = resolveActivePhaseOrThrow(state);
    const task = activePhase.tasks[taskNumber - 1];
    if (!task) {
      throw new Error(
        `Task number ${taskNumber} not found in active phase ${activePhase.name}.`,
      );
    }

    return this.startTask({
      phaseId: activePhase.id,
      taskId: task.id,
      assignee: input.assignee,
      resume: input.resume,
      projectName: input.projectName,
    });
  }

  async startActiveTaskAndWait(
    input: StartActiveTaskInput & { projectName?: string },
  ): Promise<ProjectState> {
    const taskNumber = Number(input.taskNumber);
    if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
      throw new Error("taskNumber must be a positive integer.");
    }

    const engine = await this.getEngine(input.projectName);
    const state = await engine.readProjectState();
    const activePhase = resolveActivePhaseOrThrow(state);
    const task = activePhase.tasks[taskNumber - 1];
    if (!task) {
      throw new Error(
        `Task number ${taskNumber} not found in active phase ${activePhase.name}.`,
      );
    }

    return this.startTaskAndWait({
      phaseId: activePhase.id,
      taskId: task.id,
      assignee: input.assignee,
      resume: input.resume,
      projectName: input.projectName,
    });
  }

  async startTask(
    input: StartTaskInput & { projectName?: string },
  ): Promise<ProjectState> {
    const phaseId = input.phaseId.trim();
    const taskId = input.taskId.trim();
    const assignee = CLIAdapterIdSchema.parse(input.assignee);
    if (!phaseId) {
      throw new Error("phaseId must not be empty.");
    }
    if (!taskId) {
      throw new Error("taskId must not be empty.");
    }
    if (!this.internalWorkRunner) {
      throw new Error("Internal work runner is not configured.");
    }

    const runKey = taskExecutionKey(phaseId, taskId);
    if (this.runningTaskExecutions.has(runKey)) {
      throw new Error(`Task is already running: ${taskId}`);
    }

    const engine = await this.getEngine(input.projectName);
    const state = await engine.readProjectState();
    const phaseIndex = state.phases.findIndex((phase) => phase.id === phaseId);
    if (phaseIndex < 0) {
      throw new Error(`Phase not found: ${phaseId}`);
    }

    const phase = state.phases[phaseIndex];
    const taskIndex = phase.tasks.findIndex((task) => task.id === taskId);
    if (taskIndex < 0) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const task = phase.tasks[taskIndex];
    if (
      task.status !== "TODO" &&
      task.status !== "FAILED" &&
      task.status !== "CI_FIX"
    ) {
      throw new Error(
        `Task must be TODO, FAILED, or CI_FIX before start. Current status: ${task.status}`,
      );
    }
    if (task.status === "FAILED" && task.assignee !== assignee) {
      throw new Error(
        `FAILED task must be retried with the same assignee (${task.assignee}). Reset the task to TODO before assigning a different agent.`,
      );
    }

    const dependencyMap = new Map(
      state.phases.flatMap((candidatePhase) =>
        candidatePhase.tasks.map((candidateTask) => [
          candidateTask.id,
          {
            phaseName: candidatePhase.name,
            taskTitle: candidateTask.title,
            status: candidateTask.status,
          },
        ]),
      ),
    );
    const blockingDependency = task.dependencies.find((dependencyId) => {
      const dependency = dependencyMap.get(dependencyId);
      return !dependency || dependency.status !== "DONE";
    });
    if (blockingDependency) {
      const dependency = dependencyMap.get(blockingDependency);
      if (!dependency) {
        throw new Error(
          "Task has an invalid dependency reference. Dependency task is missing in project state.",
        );
      }

      throw new Error(
        `Task has incomplete dependency: ${dependency.taskTitle} (${dependency.phaseName}, status: ${dependency.status}). Dependencies must be DONE before starting.`,
      );
    }

    const prompt = buildWorkerPrompt({
      archetype: "CODER",
      projectName: state.projectName,
      rootDir: state.rootDir,
      phase,
      task,
    });

    const updatedTask = TaskSchema.parse({
      ...task,
      assignee,
      status: "IN_PROGRESS",
      resultContext: undefined,
      errorLogs: undefined,
      completionVerification: undefined,
    });

    const nextPhases = [...state.phases];
    const nextTasks = [...phase.tasks];
    nextTasks[taskIndex] = updatedTask;
    nextPhases[phaseIndex] = {
      ...phase,
      tasks: nextTasks,
    };

    const nextState = await engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
    this.onStateChange?.(nextState.projectName, nextState);

    const shouldResume =
      Boolean(input.resume) ||
      (task.status === "FAILED" && task.assignee === assignee);

    const executionPromise = this.executeTaskRun({
      phaseId,
      taskId,
      assignee,
      prompt,
      resume: shouldResume,
      startedFromStatus: task.status,
      projectName: input.projectName,
    }).finally(() => {
      this.runningTaskExecutions.delete(runKey);
    });

    this.runningTaskExecutions.set(runKey, executionPromise);
    return nextState;
  }

  async startTaskAndWait(
    input: StartTaskInput & { projectName?: string },
  ): Promise<ProjectState> {
    await this.startTask(input);
    const runKey = taskExecutionKey(input.phaseId.trim(), input.taskId.trim());
    const running = this.runningTaskExecutions.get(runKey);
    if (running) {
      await running;
    }

    return (await this.getEngine(input.projectName)).readProjectState();
  }

  async runInternalWork(
    input: RunInternalWorkInput,
  ): Promise<RunInternalWorkResult> {
    const assignee = CLIAdapterIdSchema.parse(input.assignee);
    const prompt = input.prompt.trim();

    if (!prompt) {
      throw new Error("internal work prompt must not be empty.");
    }
    if (!this.internalWorkRunner) {
      throw new Error("Internal work runner is not configured.");
    }

    const result = await this.internalWorkRunner({
      assignee,
      prompt,
      timeoutMs: input.timeoutMs,
      phaseId: input.phaseId,
      taskId: input.taskId,
      resume: input.resume,
    });

    return {
      assignee,
      command: result.command,
      args: result.args,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
    };
  }

  async importFromTasksMarkdown(
    assignee: CLIAdapterId,
    projectName?: string,
  ): Promise<ImportTasksMarkdownResult> {
    const validAssignee = CLIAdapterIdSchema.parse(assignee);
    const markdown = await readFile(this.tasksMarkdownFilePath, "utf8");
    const prompt = buildTasksMarkdownImportPrompt(markdown);
    const internalResult = await this.runInternalWork({
      assignee: validAssignee,
      prompt,
      timeoutMs: TASKS_IMPORT_TIMEOUT_MS,
    });

    const parsed = parseJsonFromModelOutput(
      internalResult.stdout,
      "Internal work did not return valid JSON.",
    );
    const plan = ImportedTasksPlanSchema.parse(parsed);
    const draftPhases = createDraftsFromPlan(plan);

    const taskCodeToId = new Map<string, string>();
    for (const draftPhase of draftPhases) {
      for (const draftTask of draftPhase.tasks) {
        taskCodeToId.set(draftTask.code, draftTask.id);
      }
    }

    const engine = await this.getEngine(projectName);
    const state = await engine.readProjectState();
    let importedPhaseCount = 0;
    let importedTaskCount = 0;
    let lastImportedPhaseId: string | undefined;
    const nextPhases = [...state.phases];

    for (const draftPhase of draftPhases) {
      const mappedTasks = draftPhase.tasks.map((draftTask) =>
        TaskSchema.parse({
          id: draftTask.id,
          title: draftTask.title,
          description: draftTask.description,
          status: draftTask.status,
          assignee: draftTask.assignee,
          dependencies: draftTask.dependencies
            .map((taskCode) => taskCodeToId.get(taskCode))
            .filter((taskId): taskId is string => typeof taskId === "string"),
        }),
      );

      const existingPhaseIndex = nextPhases.findIndex(
        (phase) => phase.name === draftPhase.name,
      );
      if (existingPhaseIndex < 0) {
        const createdPhase = PhaseSchema.parse({
          id: draftPhase.id,
          name: draftPhase.name,
          branchName: draftPhase.branchName,
          status: "PLANNING",
          tasks: mappedTasks,
        });

        nextPhases.push(createdPhase);
        importedPhaseCount += 1;
        importedTaskCount += mappedTasks.length;
        lastImportedPhaseId = createdPhase.id;
        continue;
      }

      const existingPhase = nextPhases[existingPhaseIndex];
      const existingTaskTitles = new Set(
        existingPhase.tasks.map((task) => task.title),
      );
      const tasksToAppend = mappedTasks.filter(
        (task) => !existingTaskTitles.has(task.title),
      );
      if (tasksToAppend.length === 0) {
        continue;
      }

      nextPhases[existingPhaseIndex] = {
        ...existingPhase,
        tasks: [...existingPhase.tasks, ...tasksToAppend],
      };
      importedTaskCount += tasksToAppend.length;
      lastImportedPhaseId = existingPhase.id;
    }

    const nextState = await engine.writeProjectState({
      ...state,
      phases: nextPhases,
      activePhaseId: state.activePhaseId ?? lastImportedPhaseId,
    });
    this.onStateChange?.(nextState.projectName, nextState);

    return {
      state: nextState,
      importedPhaseCount,
      importedTaskCount,
      sourceFilePath: this.tasksMarkdownFilePath,
      assignee: validAssignee,
    };
  }

  private async runSideEffectProbe(
    cwd: string,
    args: string[],
  ): Promise<SideEffectProbeRunResult> {
    return this.runCommandProbe(cwd, "git", args);
  }

  private async runCommandProbe(
    cwd: string,
    command: string,
    args: string[],
  ): Promise<SideEffectProbeRunResult> {
    try {
      const result = await this.sideEffectProbeRunner.run({
        command,
        args,
        cwd,
      });
      return {
        success: true,
        stdout: result.stdout,
        stderr: result.stderr,
        details: "ok",
      };
    } catch (error) {
      const failureKind = classifyAdapterFailure(error);
      if (error instanceof ProcessExecutionError) {
        const stderr = error.result.stderr.trim();
        const details = stderr
          ? `${command} ${args.join(" ")} failed: ${stderr}`
          : `${command} ${args.join(" ")} failed with exit code ${error.result.exitCode}.`;
        return {
          success: false,
          stdout: error.result.stdout,
          stderr: error.result.stderr,
          details,
          failureKind,
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        stdout: "",
        stderr: "",
        details: `${command} ${args.join(" ")} failed: ${message}`,
        failureKind,
      };
    }
  }

  private async runGitHubRuntimeCapabilityPreflight(input: {
    phaseId: string;
    taskId: string;
    projectName?: string;
  }): Promise<GitHubCapabilityPreflightFailure | undefined> {
    const engine = await this.getEngine(input.projectName);
    const state = await engine.readProjectState();
    const phase = state.phases.find(
      (candidate) => candidate.id === input.phaseId,
    );
    if (!phase) {
      throw new Error(
        `Phase not found while running GitHub capability preflight: ${input.phaseId}`,
      );
    }

    const task = phase.tasks.find((candidate) => candidate.id === input.taskId);
    if (!task) {
      throw new Error(
        `Task not found while running GitHub capability preflight: ${input.taskId}`,
      );
    }

    const contracts = resolveTaskCompletionSideEffectContracts(task);
    const githubContracts = resolveGitHubBoundContracts(contracts);
    if (githubContracts.length === 0) {
      return undefined;
    }

    const probes: SideEffectProbeResult[] = [];
    const missingSideEffects: string[] = [];
    let adapterFailureKind: AdapterFailureKind = "unknown";
    const setFailureKind = (kind?: AdapterFailureKind) => {
      if (!kind || kind === "unknown" || adapterFailureKind !== "unknown") {
        return;
      }
      adapterFailureKind = kind;
    };

    const ghToolingProbe = await this.runCommandProbe(state.rootDir, "gh", [
      "--version",
    ]);
    if (ghToolingProbe.success) {
      const versionLine =
        ghToolingProbe.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.length > 0) ?? "gh is available.";
      probes.push({
        name: "gh --version",
        success: true,
        details: `Tooling available: ${versionLine}`,
      });
    } else {
      setFailureKind(ghToolingProbe.failureKind);
      probes.push({
        name: "gh --version",
        success: false,
        details: ghToolingProbe.details,
      });
      missingSideEffects.push(
        `Tooling preflight failed: ${ghToolingProbe.details} Install GitHub CLI and ensure 'gh' is available on PATH.`,
      );
    }

    if (!ghToolingProbe.success) {
      probes.push({
        name: "gh auth status --hostname github.com",
        success: false,
        details:
          "Skipped because GitHub CLI tooling check failed (gh is unavailable).",
      });
      missingSideEffects.push(
        "Auth preflight was skipped because GitHub CLI is unavailable. Install GitHub CLI, then run 'gh auth login --hostname github.com'.",
      );
    } else {
      const ghAuthProbe = await this.runCommandProbe(state.rootDir, "gh", [
        "auth",
        "status",
        "--hostname",
        "github.com",
      ]);
      if (ghAuthProbe.success) {
        probes.push({
          name: "gh auth status --hostname github.com",
          success: true,
          details: "GitHub CLI authentication is valid for github.com.",
        });
      } else {
        setFailureKind(ghAuthProbe.failureKind);
        probes.push({
          name: "gh auth status --hostname github.com",
          success: false,
          details: ghAuthProbe.details,
        });
        missingSideEffects.push(
          `Auth preflight failed: ${ghAuthProbe.details} Run 'gh auth login --hostname github.com' and verify access to this repository.`,
        );
      }
    }

    const networkProbe = await this.runCommandProbe(state.rootDir, "git", [
      "ls-remote",
      "https://github.com/github/gitignore.git",
      "HEAD",
    ]);
    const hasGitHubResponse = networkProbe.stdout.trim().length > 0;
    if (networkProbe.success && hasGitHubResponse) {
      probes.push({
        name: "git ls-remote github.com",
        success: true,
        details: "Network reachability to github.com verified.",
      });
    } else {
      setFailureKind(networkProbe.failureKind);
      probes.push({
        name: "git ls-remote github.com",
        success: false,
        details: networkProbe.success
          ? "git ls-remote github.com returned no output."
          : networkProbe.details,
      });
      missingSideEffects.push(
        `Network preflight failed: ${
          networkProbe.success
            ? "git ls-remote github.com returned no output."
            : networkProbe.details
        } Verify outbound connectivity to github.com (VPN/proxy/firewall) and retry.`,
      );
    }

    if (missingSideEffects.length === 0) {
      return undefined;
    }

    return {
      completionVerification: TaskCompletionVerificationSchema.parse({
        checkedAt: new Date().toISOString(),
        contracts: githubContracts,
        status: "FAILED",
        probes,
        missingSideEffects,
      }),
      adapterFailureKind,
    };
  }

  private async verifyTaskCompletionSideEffects(input: {
    phaseId: string;
    taskId: string;
    projectName?: string;
  }): Promise<TaskCompletionVerification | undefined> {
    const engine = await this.getEngine(input.projectName);
    const state = await engine.readProjectState();
    const phase = state.phases.find(
      (candidate) => candidate.id === input.phaseId,
    );
    if (!phase) {
      throw new Error(
        `Phase not found while verifying completion side effects: ${input.phaseId}`,
      );
    }

    const task = phase.tasks.find((candidate) => candidate.id === input.taskId);
    if (!task) {
      throw new Error(
        `Task not found while verifying completion side effects: ${input.taskId}`,
      );
    }

    const contracts = resolveTaskCompletionSideEffectContracts(task);
    if (contracts.length === 0) {
      return undefined;
    }

    const probes: SideEffectProbeResult[] = [];
    const missingSideEffects: string[] = [];

    if (contracts.includes("PR_CREATION")) {
      const prUrl = phase.prUrl?.trim();
      if (!prUrl) {
        probes.push({
          name: "phase.prUrl",
          success: false,
          details: "Missing phase PR URL.",
        });
        missingSideEffects.push(
          "PR creation was not verified because phase.prUrl is missing.",
        );
      } else {
        try {
          parsePullRequestNumberFromUrl(prUrl);
          probes.push({
            name: "phase.prUrl",
            success: true,
            details: `PR URL present: ${prUrl}`,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          probes.push({
            name: "phase.prUrl",
            success: false,
            details: `Invalid PR URL: ${prUrl}`,
          });
          missingSideEffects.push(
            `PR creation was not verified because phase.prUrl is invalid (${message}).`,
          );
        }
      }
    }

    if (contracts.includes("REMOTE_PUSH")) {
      const branchProbe = await this.runSideEffectProbe(state.rootDir, [
        "branch",
        "--show-current",
      ]);
      const branchName = branchProbe.stdout.trim();
      if (!branchProbe.success || !branchName) {
        probes.push({
          name: "git branch --show-current",
          success: false,
          details: branchProbe.success
            ? "Current branch is empty."
            : branchProbe.details,
        });
        missingSideEffects.push(
          "Remote push was not verified because current branch could not be resolved.",
        );
      } else {
        probes.push({
          name: "git branch --show-current",
          success: true,
          details: `Current branch: ${branchName}`,
        });

        const upstreamProbe = await this.runSideEffectProbe(state.rootDir, [
          "for-each-ref",
          "--format=%(upstream:short)",
          `refs/heads/${branchName}`,
        ]);
        const upstream = upstreamProbe.stdout.trim();
        if (!upstreamProbe.success || !upstream) {
          probes.push({
            name: "git upstream",
            success: false,
            details: upstreamProbe.success
              ? "No upstream configured."
              : upstreamProbe.details,
          });
          missingSideEffects.push(
            `Remote push was not verified because branch "${branchName}" has no upstream tracking ref.`,
          );
        } else {
          probes.push({
            name: "git upstream",
            success: true,
            details: `Upstream: ${upstream}`,
          });
        }

        const remoteHeadProbe = await this.runSideEffectProbe(state.rootDir, [
          "ls-remote",
          "--heads",
          "origin",
          branchName,
        ]);
        const hasRemoteHead = remoteHeadProbe.stdout.trim().length > 0;
        if (!remoteHeadProbe.success || !hasRemoteHead) {
          probes.push({
            name: "git ls-remote",
            success: false,
            details: remoteHeadProbe.success
              ? `Remote branch origin/${branchName} not found.`
              : remoteHeadProbe.details,
          });
          missingSideEffects.push(
            `Remote push was not verified because origin/${branchName} is missing.`,
          );
        } else {
          probes.push({
            name: "git ls-remote",
            success: true,
            details: `Remote branch origin/${branchName} exists.`,
          });
        }
      }
    }

    if (contracts.includes("CI_TRIGGERED_UPDATE")) {
      const hasSignal = hasCiTriggeredUpdateSignal(phase);
      probes.push({
        name: "phase CI signal",
        success: hasSignal,
        details: hasSignal
          ? `Detected CI signal from phase status ${phase.status}.`
          : "No CI signal detected (status/context/CI_FIX task).",
      });
      if (!hasSignal) {
        missingSideEffects.push(
          "CI-triggered update was not verified because phase has no CI signal.",
        );
      }
    }

    const verification = TaskCompletionVerificationSchema.parse({
      checkedAt: new Date().toISOString(),
      contracts,
      status: missingSideEffects.length === 0 ? "PASSED" : "FAILED",
      probes,
      missingSideEffects,
    });
    return verification;
  }

  private async executeTaskRun(input: {
    phaseId: string;
    taskId: string;
    assignee: CLIAdapterId;
    prompt: string;
    resume: boolean;
    startedFromStatus: Task["status"];
    projectName?: string;
  }): Promise<void> {
    try {
      const capabilityPreflight =
        await this.runGitHubRuntimeCapabilityPreflight({
          phaseId: input.phaseId,
          taskId: input.taskId,
          projectName: input.projectName,
        });
      if (capabilityPreflight) {
        try {
          await this.updateTaskResult(
            input.phaseId,
            input.taskId,
            "FAILED",
            undefined,
            summarizeCapabilityPreflightFailure(
              capabilityPreflight.completionVerification,
            ),
            "AGENT_FAILURE",
            capabilityPreflight.adapterFailureKind,
            input.startedFromStatus,
            capabilityPreflight.completionVerification,
            input.projectName,
          );
        } catch (updateError) {
          const message =
            updateError instanceof Error
              ? updateError.message
              : String(updateError);
          console.error(
            `Failed to persist FAILED preflight state for task ${input.taskId}: ${message}`,
          );
        }
        return;
      }

      const result = await this.runInternalWork({
        assignee: input.assignee,
        prompt: input.prompt,
        timeoutMs: TASK_EXECUTION_TIMEOUT_MS,
        phaseId: input.phaseId,
        taskId: input.taskId,
        resume: input.resume,
      });

      const combinedResult = [result.stdout.trim(), result.stderr.trim()]
        .filter((value) => value.length > 0)
        .join("\n\n");
      const completionVerification = await this.verifyTaskCompletionSideEffects(
        {
          phaseId: input.phaseId,
          taskId: input.taskId,
          projectName: input.projectName,
        },
      );

      try {
        if (completionVerification?.status === "FAILED") {
          await this.updateTaskResult(
            input.phaseId,
            input.taskId,
            "FAILED",
            undefined,
            summarizeVerificationFailure(completionVerification),
            "UNKNOWN",
            undefined,
            input.startedFromStatus,
            completionVerification,
            input.projectName,
          );
          return;
        }

        await this.updateTaskResult(
          input.phaseId,
          input.taskId,
          "DONE",
          combinedResult || "Task finished without textual output.",
          undefined,
          undefined,
          undefined,
          input.startedFromStatus,
          completionVerification,
          input.projectName,
        );
      } catch (updateError) {
        const message =
          updateError instanceof Error
            ? updateError.message
            : String(updateError);
        console.error(
          `Failed to persist DONE state for task ${input.taskId}: ${message}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const category = (error as any).category;
      const adapterFailureKind = (error as any).adapterFailureKind;
      try {
        await this.updateTaskResult(
          input.phaseId,
          input.taskId,
          "FAILED",
          undefined,
          message,
          category,
          adapterFailureKind,
          input.startedFromStatus,
          undefined,
          input.projectName,
        );
      } catch (updateError) {
        const updateMessage =
          updateError instanceof Error
            ? updateError.message
            : String(updateError);
        console.error(
          `Failed to persist FAILED state for task ${input.taskId}: ${updateMessage}`,
        );
      }
    }
  }

  private async updateTaskResult(
    phaseId: string,
    taskId: string,
    status: "DONE" | "FAILED",
    resultContext: string | undefined,
    errorLogs: string | undefined,
    errorCategory: any, // Use any for now or import ExceptionCategory
    adapterFailureKind: any,
    startedFromStatus: Task["status"],
    completionVerification: TaskCompletionVerification | undefined,
    projectName?: string,
  ): Promise<void> {
    const engine = await this.getEngine(projectName);
    const state = await engine.readProjectState();
    const phaseIndex = state.phases.findIndex((phase) => phase.id === phaseId);
    if (phaseIndex < 0) {
      throw new Error(`Phase not found while updating task result: ${phaseId}`);
    }

    const phase = state.phases[phaseIndex];
    const taskIndex = phase.tasks.findIndex((task) => task.id === taskId);
    if (taskIndex < 0) {
      throw new Error(`Task not found while updating task result: ${taskId}`);
    }

    const currentTask = phase.tasks[taskIndex];
    const normalizedResultContext = resultContext
      ? truncateForState(resultContext)
      : undefined;
    const normalizedErrorLogs = errorLogs
      ? truncateForState(errorLogs)
      : undefined;
    const normalizedCompletionVerification = completionVerification
      ? TaskCompletionVerificationSchema.parse(completionVerification)
      : undefined;
    const currentVerificationJson = currentTask.completionVerification
      ? JSON.stringify(currentTask.completionVerification)
      : undefined;
    const nextVerificationJson = normalizedCompletionVerification
      ? JSON.stringify(normalizedCompletionVerification)
      : undefined;

    if (currentTask.status === status) {
      if (status === "DONE") {
        if (
          (!normalizedResultContext ||
            currentTask.resultContext === normalizedResultContext) &&
          currentVerificationJson === nextVerificationJson
        ) {
          return;
        }
      } else if (
        (!normalizedErrorLogs ||
          currentTask.errorLogs === normalizedErrorLogs) &&
        currentTask.errorCategory === errorCategory &&
        (currentTask as any).adapterFailureKind === adapterFailureKind &&
        currentVerificationJson === nextVerificationJson
      ) {
        return;
      }
    }
    if (currentTask.status !== status && currentTask.status !== "IN_PROGRESS") {
      throw new Error(
        `Task must be IN_PROGRESS before completion update. Current status: ${currentTask.status}`,
      );
    }

    const updatedTask = TaskSchema.parse({
      ...currentTask,
      status,
      resultContext:
        status === "DONE"
          ? (normalizedResultContext ?? currentTask.resultContext)
          : undefined,
      errorLogs:
        status === "FAILED"
          ? (normalizedErrorLogs ?? currentTask.errorLogs)
          : undefined,
      errorCategory:
        status === "FAILED"
          ? (errorCategory ?? currentTask.errorCategory)
          : undefined,
      adapterFailureKind:
        status === "FAILED"
          ? (adapterFailureKind ?? (currentTask as any).adapterFailureKind)
          : undefined,
      completionVerification: normalizedCompletionVerification,
    });

    const nextPhases = [...state.phases];
    const nextTasks = [...phase.tasks];
    nextTasks[taskIndex] = updatedTask;
    const shouldRecoverFromCiFailed =
      status === "DONE" &&
      phase.status === "CI_FAILED" &&
      isRecoveringFixTaskStatus(startedFromStatus);
    nextPhases[phaseIndex] = PhaseSchema.parse({
      ...phase,
      status: shouldRecoverFromCiFailed ? "CODING" : phase.status,
      ciStatusContext: shouldRecoverFromCiFailed
        ? undefined
        : phase.ciStatusContext,
      tasks: nextTasks,
    });

    const nextState = await engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
    this.onStateChange?.(nextState.projectName, nextState);
  }

  /**
   * Reconciles any IN_PROGRESS tasks across all phases back to TODO.
   *
   * Called at startup (before the phase execution loop begins) to recover from
   * a prior process crash that left tasks stuck in IN_PROGRESS. Returns the
   * number of tasks that were reset.
   */
  async reconcileInProgressTasks(projectName?: string): Promise<number> {
    const engine = await this.getEngine(projectName);
    const state = await engine.readProjectState();

    let reconcileCount = 0;
    const nextPhases = state.phases.map((phase) => {
      let phaseChanged = false;
      const nextTasks = phase.tasks.map((task) => {
        if (task.status !== "IN_PROGRESS") {
          return task;
        }
        reconcileCount += 1;
        phaseChanged = true;
        return TaskSchema.parse({
          ...task,
          status: "TODO",
          resultContext: undefined,
          errorLogs: undefined,
          errorCategory: undefined,
          adapterFailureKind: undefined,
          completionVerification: undefined,
        });
      });

      if (!phaseChanged) {
        return phase;
      }

      return { ...phase, tasks: nextTasks };
    });

    if (reconcileCount === 0) {
      return 0;
    }

    const nextState = await engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
    this.onStateChange?.(nextState.projectName, nextState);
    return reconcileCount;
  }

  /**
   * Resets a single IN_PROGRESS task back to TODO by task ID.
   *
   * Called when a UI-initiated agent restart abandons the previous run so the
   * task is not left permanently stuck in IN_PROGRESS. Idempotent: if the task
   * is not found or is not IN_PROGRESS, the call is a no-op.
   */
  async reconcileInProgressTaskToTodo(input: {
    taskId: string;
    projectName?: string;
  }): Promise<void> {
    const taskId = input.taskId.trim();
    if (!taskId) {
      return;
    }

    const engine = await this.getEngine(input.projectName);
    const state = await engine.readProjectState();

    let phaseIndex = -1;
    let taskIndex = -1;
    for (let index = 0; index < state.phases.length; index += 1) {
      const foundTaskIndex = state.phases[index].tasks.findIndex(
        (task) => task.id === taskId,
      );
      if (foundTaskIndex >= 0) {
        phaseIndex = index;
        taskIndex = foundTaskIndex;
        break;
      }
    }

    if (phaseIndex < 0 || taskIndex < 0) {
      return;
    }

    const phase = state.phases[phaseIndex];
    const task = phase.tasks[taskIndex];
    if (task.status !== "IN_PROGRESS") {
      return;
    }

    const updatedTask = TaskSchema.parse({
      ...task,
      status: "TODO",
      resultContext: undefined,
      errorLogs: undefined,
      errorCategory: undefined,
      adapterFailureKind: undefined,
      completionVerification: undefined,
    });

    const nextPhases = [...state.phases];
    const nextTasks = [...phase.tasks];
    nextTasks[taskIndex] = updatedTask;
    nextPhases[phaseIndex] = { ...phase, tasks: nextTasks };

    const nextState = await engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
    this.onStateChange?.(nextState.projectName, nextState);
  }

  async failTaskIfInProgress(input: {
    taskId: string;
    reason: string;
    projectName?: string;
  }): Promise<ProjectState> {
    const taskId = input.taskId.trim();
    const reason = input.reason.trim();
    if (!taskId) {
      throw new Error("taskId must not be empty.");
    }
    if (!reason) {
      throw new Error("reason must not be empty.");
    }

    const engine = await this.getEngine(input.projectName);
    const state = await engine.readProjectState();
    let phaseIndex = -1;
    let taskIndex = -1;
    for (let index = 0; index < state.phases.length; index += 1) {
      const foundTaskIndex = state.phases[index].tasks.findIndex(
        (task) => task.id === taskId,
      );
      if (foundTaskIndex >= 0) {
        phaseIndex = index;
        taskIndex = foundTaskIndex;
        break;
      }
    }
    if (phaseIndex < 0 || taskIndex < 0) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const phase = state.phases[phaseIndex];
    const task = phase.tasks[taskIndex];
    if (task.status !== "IN_PROGRESS") {
      return state;
    }

    const updatedTask = TaskSchema.parse({
      ...task,
      status: "FAILED",
      resultContext: undefined,
      errorLogs: truncateForState(reason),
      completionVerification: undefined,
    });

    const nextPhases = [...state.phases];
    const nextTasks = [...phase.tasks];
    nextTasks[taskIndex] = updatedTask;
    nextPhases[phaseIndex] = {
      ...phase,
      tasks: nextTasks,
    };

    const nextState = await engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
    this.onStateChange?.(nextState.projectName, nextState);
    return nextState;
  }

  async resetTaskToTodo(
    input: ResetTaskInput & { projectName?: string },
  ): Promise<ProjectState> {
    const phaseId = input.phaseId.trim();
    const taskId = input.taskId.trim();
    if (!phaseId) {
      throw new Error("phaseId must not be empty.");
    }
    if (!taskId) {
      throw new Error("taskId must not be empty.");
    }
    if (!this.repositoryResetRunner) {
      throw new Error("Repository reset runner is not configured.");
    }

    const runKey = taskExecutionKey(phaseId, taskId);
    if (this.runningTaskExecutions.has(runKey)) {
      throw new Error("Cannot reset a running task.");
    }

    const engine = await this.getEngine(input.projectName);
    const state = await engine.readProjectState();
    const phaseIndex = state.phases.findIndex((phase) => phase.id === phaseId);
    if (phaseIndex < 0) {
      throw new Error(`Phase not found: ${phaseId}`);
    }
    const phase = state.phases[phaseIndex];
    const taskIndex = phase.tasks.findIndex((task) => task.id === taskId);
    if (taskIndex < 0) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const task = phase.tasks[taskIndex];
    if (task.status !== "FAILED") {
      throw new Error(
        `Task must be FAILED before reset. Current status: ${task.status}`,
      );
    }

    await this.repositoryResetRunner();

    const updatedTask = TaskSchema.parse({
      ...task,
      status: "TODO",
      assignee: "UNASSIGNED",
      resultContext: undefined,
      errorLogs: undefined,
      errorCategory: undefined,
      adapterFailureKind: undefined,
      completionVerification: undefined,
    });

    const nextPhases = [...state.phases];
    const nextTasks = [...phase.tasks];
    nextTasks[taskIndex] = updatedTask;
    nextPhases[phaseIndex] = {
      ...phase,
      tasks: nextTasks,
    };

    const nextState = await engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
    this.onStateChange?.(nextState.projectName, nextState);
    return nextState;
  }
}
