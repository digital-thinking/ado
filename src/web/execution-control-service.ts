import { ExecutionRunLock } from "../engine/execution-run-lock";
import { PhaseLoopControl } from "../engine/phase-loop-control";
import { PhaseRunner, type PhaseRunnerConfig } from "../engine/phase-runner";
import { resolveActivePhaseStrict } from "../state/active-phase";
import { loadAuthPolicy } from "../security/policy-loader";
import { loadCliSettings, getAvailableAgents } from "../cli/settings";
import type { AgentView } from "./agent-supervisor";
import type { ControlCenterService } from "./control-center-service";
import type { CLIAdapterId, CliAgentSettings } from "../types";
import type { RuntimeEvent } from "../types/runtime-events";

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
  settingsFilePath: string;
  agentSettings: CliAgentSettings;
  resolveDefaultAssignee: ResolveDefaultAssignee;
  onRuntimeEvent?: (event: RuntimeEvent) => Promise<void> | void;
  sleep?: (ms: number) => Promise<void>;
};

function nowIso(): string {
  return new Date().toISOString();
}

export class ExecutionControlService {
  private readonly control: ControlCenterService;
  private readonly agents: {
    list: () => AgentView[];
    kill: (id: string) => AgentView;
  };
  private readonly projectRootDir: string;
  private readonly settingsFilePath: string;
  private readonly agentSettings: CliAgentSettings;
  private readonly resolveDefaultAssignee: ResolveDefaultAssignee;
  private readonly onRuntimeEvent: (
    event: RuntimeEvent,
  ) => Promise<void> | void;
  private readonly sleep: (ms: number) => Promise<void>;
  private status: AutoExecutionStatus;
  private runLock: ExecutionRunLock | null = null;
  private loopControl: PhaseLoopControl | null = null;

  constructor(input: ExecutionControlServiceInput) {
    if (!input.projectRootDir.trim()) {
      throw new Error("projectRootDir must not be empty.");
    }
    this.control = input.control;
    this.agents = input.agents;
    this.projectRootDir = input.projectRootDir;
    this.settingsFilePath = input.settingsFilePath;
    this.agentSettings = input.agentSettings;
    this.resolveDefaultAssignee = input.resolveDefaultAssignee;
    this.onRuntimeEvent = input.onRuntimeEvent ?? (() => {});
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

    const lockState = await this.control.getState(projectName);
    const lockPhaseId =
      lockState.activePhaseIds[0]?.trim() || "no-active-phase";
    const runLock = new ExecutionRunLock({
      projectRootDir: this.projectRootDir,
      projectName,
      phaseId: lockPhaseId,
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

    void this.runPhaseRunner(projectName).catch(async (error) => {
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
      message: "Stop requested. Stopping at a clean boundary.",
    });

    if (this.loopControl) {
      this.loopControl.requestStop();
    }

    await this.stopActiveTaskAndReset();
    return this.getStatus(projectName);
  }

  private setStatus(next: Omit<AutoExecutionStatus, "updatedAt">): void {
    this.status = {
      ...next,
      updatedAt: nowIso(),
    };
  }

  private async runPhaseRunner(projectName: string): Promise<void> {
    const loopControl = new PhaseLoopControl();
    this.loopControl = loopControl;

    try {
      const settings = await loadCliSettings(this.settingsFilePath);
      const policy = await loadAuthPolicy(this.settingsFilePath);

      const project = settings.projects.find((p) => p.name === projectName);
      const projectExec = {
        autoMode:
          project?.executionSettings?.autoMode ??
          settings.executionLoop.autoMode,
        defaultAssignee:
          project?.executionSettings?.defaultAssignee ??
          settings.internalWork.assignee,
        defaultRace:
          project?.executionSettings?.defaultRace ??
          settings.executionLoop.defaultRace,
        maxTaskRetries:
          project?.executionSettings?.maxTaskRetries ??
          settings.executionLoop.maxTaskRetries,
        phaseTimeoutMs:
          project?.executionSettings?.phaseTimeoutMs ??
          settings.executionLoop.phaseTimeoutMs,
      };

      const enabledAdapters = getAvailableAgents(settings);
      const state = await this.control.getState(projectName);
      const activePhase = resolveActivePhaseStrict(state);

      const projectRootDir = project?.rootDir ?? this.projectRootDir;

      const config: PhaseRunnerConfig = {
        mode: "AUTO",
        countdownSeconds: settings.executionLoop.countdownSeconds,
        activeAssignee: projectExec.defaultAssignee,
        enabledAdapters,
        adapterAffinities: settings.agents.adapterAffinities,
        adapterCircuitBreakers: {
          CODEX_CLI: settings.agents.CODEX_CLI.circuitBreaker,
          CLAUDE_CLI: settings.agents.CLAUDE_CLI.circuitBreaker,
          GEMINI_CLI: settings.agents.GEMINI_CLI.circuitBreaker,
          MOCK_CLI: settings.agents.MOCK_CLI.circuitBreaker,
        },
        maxRecoveryAttempts: settings.exceptionRecovery.maxAttempts,
        testerCommand: settings.executionLoop.testerCommand,
        testerArgs: settings.executionLoop.testerArgs,
        testerTimeoutMs: settings.executionLoop.testerTimeoutMs,
        defaultRace: projectExec.defaultRace,
        maxTaskRetries: projectExec.maxTaskRetries,
        judgeAdapter: settings.executionLoop.judgeAdapter,
        phaseTimeoutMs: projectExec.phaseTimeoutMs,
        ciEnabled: settings.executionLoop.ciEnabled,
        vcsProvider: settings.executionLoop.vcsProvider,
        gates: settings.executionLoop.gates,
        ciBaseBranch: settings.executionLoop.ciBaseBranch,
        ciPullRequest: settings.executionLoop.pullRequest,
        validationMaxRetries: settings.executionLoop.validationMaxRetries,
        ciFixMaxFanOut: settings.executionLoop.ciFixMaxFanOut,
        ciFixMaxDepth: settings.executionLoop.ciFixMaxDepth,
        deliberation: {
          reviewerAdapter: settings.executionLoop.deliberation.reviewerAdapter,
          maxRefinePasses: settings.executionLoop.deliberation.maxRefinePasses,
        },
        projectRootDir,
        worktrees: settings.worktrees,
        phaseId: activePhase.id,
        projectName,
        policy,
        role: "admin",
      };

      const runner = new PhaseRunner(
        this.control,
        config,
        loopControl,
        async (event) => {
          // Update status from runtime events for UI visibility
          if (
            event.type === "task.lifecycle.phase-update" &&
            "status" in event.payload
          ) {
            this.setStatus({
              ...this.status,
              phaseId: event.phaseId,
              message: String(
                (event.payload as { message?: string }).message ?? event.type,
              ),
            });
          }
          // Forward to external listeners (Telegram, logging, etc.)
          await this.onRuntimeEvent(event);
        },
      );

      await runner.run();

      this.setStatus({
        running: false,
        stopRequested: false,
        projectName,
        phaseId: undefined,
        taskId: undefined,
        taskTitle: undefined,
        message: "Auto mode finished. Phase execution completed.",
      });
    } finally {
      this.loopControl = null;
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

    for (let attempt = 0; attempt < STOP_SETTLE_MAX_ATTEMPTS; attempt += 1) {
      const state = await this.control.getState(projectName);
      const phase = state.phases.find((p) => p.id === phaseId);
      const task = phase?.tasks.find((t) => t.id === taskId);
      if (task && task.status !== "IN_PROGRESS") {
        if (task.status === "FAILED") {
          await this.control.resetTaskToTodo({
            projectName,
            phaseId,
            taskId,
          });
        }
        break;
      }
      await this.sleep(STOP_SETTLE_POLL_MS);
    }
  }
}
