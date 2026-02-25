import { ExecutionRunLock } from "../engine/execution-run-lock";
import type { AgentView } from "./agent-supervisor";
import type { ControlCenterService } from "./control-center-service";
import type { CLIAdapterId, ProjectState, Task } from "../types";

const STOP_SETTLE_POLL_MS = 1_000;
const STOP_SETTLE_MAX_ATTEMPTS = 15;

export type AutoExecutionStatus = {
  running: boolean;
  stopRequested: boolean;
  projectName: string;
  phaseId?: string;
  taskId?: string;
  taskTitle?: string;
  message: string;
  updatedAt: string;
};

type ResolveDefaultAssignee = (projectName: string) => Promise<CLIAdapterId>;

export type ExecutionControlServiceInput = {
  control: ControlCenterService;
  agents: {
    list: () => AgentView[];
    kill: (id: string) => AgentView;
  };
  projectRootDir: string;
  projectName: string;
  resolveDefaultAssignee: ResolveDefaultAssignee;
  sleep?: (ms: number) => Promise<void>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function pickNextAutoTask(tasks: Task[]): Task | undefined {
  const ciFix = tasks.find((task) => task.status === "CI_FIX");
  if (ciFix) {
    return ciFix;
  }
  return tasks.find((task) => task.status === "TODO");
}

function resolveActivePhase(state: ProjectState) {
  const explicit = state.activePhaseId
    ? state.phases.find((phase) => phase.id === state.activePhaseId)
    : undefined;
  return explicit ?? state.phases[0];
}

function resolveTask(
  state: ProjectState,
  phaseId: string,
  taskId: string,
): Task | undefined {
  const phase = state.phases.find((candidate) => candidate.id === phaseId);
  return phase?.tasks.find((candidate) => candidate.id === taskId);
}

export class ExecutionControlService {
  private readonly control: ControlCenterService;
  private readonly agents: {
    list: () => AgentView[];
    kill: (id: string) => AgentView;
  };
  private readonly projectRootDir: string;
  private readonly resolveDefaultAssignee: ResolveDefaultAssignee;
  private readonly sleep: (ms: number) => Promise<void>;
  private status: AutoExecutionStatus;
  private runLock: ExecutionRunLock | null = null;

  constructor(input: ExecutionControlServiceInput) {
    if (!input.projectRootDir.trim()) {
      throw new Error("projectRootDir must not be empty.");
    }
    this.control = input.control;
    this.agents = input.agents;
    this.projectRootDir = input.projectRootDir;
    this.resolveDefaultAssignee = input.resolveDefaultAssignee;
    this.sleep =
      input.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.status = {
      running: false,
      stopRequested: false,
      projectName: input.projectName,
      message: "Auto mode is idle.",
      updatedAt: nowIso(),
    };
  }

  getStatus(projectName?: string): AutoExecutionStatus {
    if (!projectName || projectName === this.status.projectName) {
      return { ...this.status };
    }

    return {
      running: false,
      stopRequested: false,
      projectName,
      message: "Auto mode is idle.",
      updatedAt: nowIso(),
    };
  }

  async startAuto(input?: {
    projectName?: string;
  }): Promise<AutoExecutionStatus> {
    if (this.status.running) {
      throw new Error(
        `Auto mode is already running for project ${this.status.projectName}.`,
      );
    }

    const projectName = (input?.projectName || this.status.projectName).trim();
    if (!projectName) {
      throw new Error("projectName must not be empty.");
    }

    const runLock = new ExecutionRunLock({
      projectRootDir: this.projectRootDir,
      projectName,
      owner: "WEB_AUTO_MODE",
    });
    await runLock.acquire();
    this.runLock = runLock;

    this.setStatus({
      running: true,
      stopRequested: false,
      projectName,
      phaseId: undefined,
      taskId: undefined,
      taskTitle: undefined,
      message: `Auto mode running for project ${projectName}.`,
    });

    void this.runAutoLoop(projectName).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({
        running: false,
        stopRequested: false,
        projectName,
        phaseId: undefined,
        taskId: undefined,
        taskTitle: undefined,
        message: `Auto mode failed: ${message}`,
      });
      await this.releaseRunLock();
    });

    return this.getStatus(projectName);
  }

  async stop(input?: { projectName?: string }): Promise<AutoExecutionStatus> {
    const projectName = (input?.projectName || this.status.projectName).trim();
    if (!projectName) {
      throw new Error("projectName must not be empty.");
    }

    if (!this.status.running) {
      return {
        running: false,
        stopRequested: false,
        projectName,
        message: "Auto mode is not running.",
        updatedAt: nowIso(),
      };
    }

    if (this.status.projectName !== projectName) {
      throw new Error(
        `Auto mode is running for project ${this.status.projectName}, not ${projectName}.`,
      );
    }

    this.setStatus({
      ...this.status,
      stopRequested: true,
      message:
        "Stop requested. Stopping at a clean boundary and resetting active task.",
    });

    await this.stopActiveTaskAndReset();
    return this.getStatus(projectName);
  }

  private setStatus(next: Omit<AutoExecutionStatus, "updatedAt">): void {
    this.status = {
      ...next,
      updatedAt: nowIso(),
    };
  }

  private async runAutoLoop(projectName: string): Promise<void> {
    try {
      while (true) {
        if (this.status.stopRequested) {
          this.setStatus({
            running: false,
            stopRequested: false,
            projectName,
            phaseId: undefined,
            taskId: undefined,
            taskTitle: undefined,
            message: "Auto mode stopped.",
          });
          return;
        }

        const state = await this.control.getState(projectName);
        const phase = resolveActivePhase(state);
        if (!phase) {
          this.setStatus({
            running: false,
            stopRequested: false,
            projectName,
            phaseId: undefined,
            taskId: undefined,
            taskTitle: undefined,
            message: "No phase available to execute.",
          });
          return;
        }

        const nextTask = pickNextAutoTask(phase.tasks);
        if (!nextTask) {
          this.setStatus({
            running: false,
            stopRequested: false,
            projectName,
            phaseId: undefined,
            taskId: undefined,
            taskTitle: undefined,
            message: "Auto mode finished. No TODO or CI_FIX tasks remain.",
          });
          return;
        }

        const defaultAssignee = await this.resolveDefaultAssignee(projectName);
        const assignee: CLIAdapterId =
          nextTask.assignee !== "UNASSIGNED"
            ? (nextTask.assignee as CLIAdapterId)
            : defaultAssignee;

        this.setStatus({
          running: true,
          stopRequested: this.status.stopRequested,
          projectName,
          phaseId: phase.id,
          taskId: nextTask.id,
          taskTitle: nextTask.title,
          message: `Running task '${nextTask.title}' with ${assignee}.`,
        });

        const updatedState = await this.control.startTaskAndWait({
          projectName,
          phaseId: phase.id,
          taskId: nextTask.id,
          assignee,
        });
        const resultTask = resolveTask(updatedState, phase.id, nextTask.id);
        if (!resultTask) {
          throw new Error(
            "Active task disappeared while auto mode was running.",
          );
        }

        if (this.status.stopRequested) {
          this.setStatus({
            running: false,
            stopRequested: false,
            projectName,
            phaseId: undefined,
            taskId: undefined,
            taskTitle: undefined,
            message: "Auto mode stopped. Reset to the last completed task.",
          });
          return;
        }

        if (resultTask.status === "DONE") {
          this.setStatus({
            running: true,
            stopRequested: false,
            projectName,
            phaseId: undefined,
            taskId: undefined,
            taskTitle: undefined,
            message: `Completed task '${resultTask.title}'. Continuing...`,
          });
          continue;
        }

        if (resultTask.status === "FAILED") {
          this.setStatus({
            running: false,
            stopRequested: false,
            projectName,
            phaseId: undefined,
            taskId: undefined,
            taskTitle: undefined,
            message: `Auto mode stopped because task '${resultTask.title}' failed.`,
          });
          return;
        }
      }
    } finally {
      if (this.status.running && this.status.projectName === projectName) {
        this.setStatus({
          ...this.status,
          running: false,
          stopRequested: false,
          phaseId: undefined,
          taskId: undefined,
          taskTitle: undefined,
        });
      }
      await this.releaseRunLock();
    }
  }

  private async releaseRunLock(): Promise<void> {
    if (!this.runLock) {
      return;
    }
    const lock = this.runLock;
    this.runLock = null;
    await lock.release();
  }

  private async stopActiveTaskAndReset(): Promise<void> {
    if (!this.status.phaseId || !this.status.taskId) {
      return;
    }

    const projectName = this.status.projectName;
    const phaseId = this.status.phaseId;
    const taskId = this.status.taskId;

    const runningAgent = this.agents
      .list()
      .find(
        (agent) =>
          agent.projectName === projectName &&
          agent.phaseId === phaseId &&
          agent.taskId === taskId &&
          agent.status === "RUNNING",
      );
    if (runningAgent) {
      this.agents.kill(runningAgent.id);
    }

    let settledTask: Task | undefined;
    for (let attempt = 0; attempt < STOP_SETTLE_MAX_ATTEMPTS; attempt += 1) {
      const state = await this.control.getState(projectName);
      const task = resolveTask(state, phaseId, taskId);
      if (task && task.status !== "IN_PROGRESS") {
        settledTask = task;
        break;
      }
      await this.sleep(STOP_SETTLE_POLL_MS);
    }

    if (!settledTask) {
      throw new Error("Failed to stop active task cleanly within timeout.");
    }

    if (settledTask.status === "FAILED") {
      await this.control.resetTaskToTodo({
        projectName,
        phaseId,
        taskId,
      });
    }
  }
}
