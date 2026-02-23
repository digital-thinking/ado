import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { buildWorkerPrompt } from "../engine/worker-prompts";
import type { StateEngine } from "../state";
import {
  CLIAdapterIdSchema,
  ExceptionMetadataSchema,
  ExceptionRecoveryResultSchema,
  PhaseSchema,
  PhaseStatusSchema,
  RecoveryAttemptRecordSchema,
  TaskSchema,
  WorkerAssigneeSchema,
  type CLIAdapterId,
  type ExceptionMetadata,
  type ExceptionRecoveryResult,
  type Phase,
  type PhaseStatus,
  type ProjectState,
  type RecoveryAttemptRecord,
  type Task,
  type WorkerAssignee,
} from "../types";

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

function extractFirstJsonObject(raw: string): string | null {
  const startIndex = raw.indexOf("{");
  if (startIndex < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = startIndex; index < raw.length; index += 1) {
    const char = raw[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function parseJsonFromModelOutput(rawOutput: string): unknown {
  const direct = rawOutput.trim();
  if (!direct) {
    throw new Error("Internal work returned empty output.");
  }

  try {
    return JSON.parse(direct);
  } catch {
    // Continue.
  }

  const fencedMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(rawOutput);
  if (fencedMatch) {
    try {
      return JSON.parse(fencedMatch[1].trim());
    } catch {
      // Continue.
    }
  }

  const objectPayload = extractFirstJsonObject(rawOutput);
  if (objectPayload) {
    try {
      return JSON.parse(objectPayload);
    } catch {
      // Continue.
    }
  }

  throw new Error("Internal work did not return valid JSON.");
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

export class ControlCenterService {
  private readonly stateEngineFactory: StateEngineFactory;
  private readonly projectStateEngines = new Map<string, StateEngine>();
  private readonly tasksMarkdownFilePath: string;
  private readonly internalWorkRunner?: InternalWorkRunner;
  private readonly repositoryResetRunner?: RepositoryResetRunner;
  private readonly runningTaskExecutions = new Map<string, Promise<void>>();
  private defaultProjectName?: string;

  constructor(
    stateOrFactory: StateEngine | StateEngineFactory,
    tasksMarkdownFilePath = resolve(process.cwd(), DEFAULT_TASKS_MARKDOWN_PATH),
    internalWorkRunner?: InternalWorkRunner,
    repositoryResetRunner?: RepositoryResetRunner,
  ) {
    if (typeof stateOrFactory === "function") {
      this.stateEngineFactory = stateOrFactory;
    } else {
      this.stateEngineFactory = () => stateOrFactory;
    }
    this.tasksMarkdownFilePath = tasksMarkdownFilePath;
    this.internalWorkRunner = internalWorkRunner;
    this.repositoryResetRunner = repositoryResetRunner;
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

    return engine.writeProjectState({
      ...state,
      activePhaseId: phase.id,
      phases: [...state.phases, phase],
    });
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

    return engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
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

    return engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
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

    return engine.writeProjectState({
      ...state,
      activePhaseId: phaseId,
    });
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

    return engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
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
    const nextPhases = [...state.phases];
    nextPhases[phaseIndex] = PhaseSchema.parse({
      ...phase,
      status,
      ciStatusContext,
    });

    return engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
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

    return engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
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

    const parsed = parseJsonFromModelOutput(internalResult.stdout);
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

    return {
      state: nextState,
      importedPhaseCount,
      importedTaskCount,
      sourceFilePath: this.tasksMarkdownFilePath,
      assignee: validAssignee,
    };
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

      try {
        await this.updateTaskResult(
          input.phaseId,
          input.taskId,
          "DONE",
          combinedResult || "Task finished without textual output.",
          undefined,
          undefined,
          input.startedFromStatus,
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
      try {
        await this.updateTaskResult(
          input.phaseId,
          input.taskId,
          "FAILED",
          undefined,
          message,
          category,
          input.startedFromStatus,
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
    startedFromStatus: Task["status"],
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

    if (currentTask.status === status) {
      if (status === "DONE") {
        if (
          !normalizedResultContext ||
          currentTask.resultContext === normalizedResultContext
        ) {
          return;
        }
      } else if (
        (!normalizedErrorLogs ||
          currentTask.errorLogs === normalizedErrorLogs) &&
        currentTask.errorCategory === errorCategory
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

    await engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
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
    });

    const nextPhases = [...state.phases];
    const nextTasks = [...phase.tasks];
    nextTasks[taskIndex] = updatedTask;
    nextPhases[phaseIndex] = {
      ...phase,
      tasks: nextTasks,
    };

    return engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
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
    });

    const nextPhases = [...state.phases];
    const nextTasks = [...phase.tasks];
    nextTasks[taskIndex] = updatedTask;
    nextPhases[phaseIndex] = {
      ...phase,
      tasks: nextTasks,
    };

    return engine.writeProjectState({
      ...state,
      phases: nextPhases,
    });
  }
}
