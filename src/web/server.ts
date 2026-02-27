import { resolve } from "node:path";
import { createServer } from "node:net";

import { createPromptLogArtifacts, writeOutputLog } from "../agent-logs";
import { resolveAgentRegistryFilePath } from "../agent-registry";
import {
  buildAdapterExecutionPlan,
  buildAdapterInitializationDiagnostic,
  CodexUsageTracker,
  createAdapter,
  formatAdapterStartupDiagnostic,
} from "../adapters";
import { resolveCliLogFilePath } from "../cli/logging";
import {
  loadCliSettings,
  resolveGlobalSettingsFilePath,
  saveCliSettings,
} from "../cli/settings";
import { ProcessManager } from "../process";
import { StateEngine } from "../state";
import {
  CLI_ADAPTER_IDS,
  CliSettingsOverrideSchema,
  ProjectExecutionSettingsSchema,
  type CLIAdapterId,
  type CliAgentSettings,
  type ProjectState,
} from "../types";
import { AgentSupervisor, type AgentView } from "./agent-supervisor";
import { createWebApp } from "./app";
import { ControlCenterService } from "./control-center-service";
import { ExecutionControlService } from "./execution-control-service";
import { UsageService } from "./usage-service";

export type StartWebControlCenterInput = {
  cwd: string;
  stateFilePath: string;
  settingsFilePath: string;
  projectName: string;
  port?: number;
  defaultInternalWorkAssignee: CLIAdapterId;
  defaultAutoMode: boolean;
  agentSettings: CliAgentSettings;
  webLogFilePath: string;
};

export type WebControlCenterRuntime = {
  port: number;
  url: string;
  stop: () => void;
};

const WEB_SERVER_HOST = "127.0.0.1";
const WEB_SERVER_IDLE_TIMEOUT_SECONDS = 255;
const TERMINAL_TASK_STATUSES = new Set(["DONE", "FAILED"]);

function findTaskStatusById(
  state: ProjectState,
  taskId: string,
): string | undefined {
  for (const phase of state.phases) {
    const task = phase.tasks.find((candidate) => candidate.id === taskId);
    if (task) {
      return task.status;
    }
  }

  return undefined;
}

async function resolveWebPort(
  requestedPort: number | undefined,
): Promise<number> {
  if (requestedPort !== 0) {
    return requestedPort ?? 8787;
  }

  return new Promise<number>((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", (error) => {
      rejectPort(error);
    });
    probe.listen(0, WEB_SERVER_HOST, () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => {
          rejectPort(new Error("Failed to resolve ephemeral web port."));
        });
        return;
      }

      const { port } = address;
      probe.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }

        resolvePort(port);
      });
    });
  });
}

function isMissingCommandError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as NodeJS.ErrnoException;
  if (candidate.code === "ENOENT") {
    return true;
  }

  const message = candidate.message ?? "";
  return message.includes("ENOENT") || message.includes("uv_spawn");
}

export async function startWebControlCenter(
  input: StartWebControlCenterInput,
): Promise<WebControlCenterRuntime> {
  if (!input.cwd.trim()) {
    throw new Error("cwd must not be empty.");
  }
  if (!input.stateFilePath.trim()) {
    throw new Error("stateFilePath must not be empty.");
  }
  if (!input.settingsFilePath.trim()) {
    throw new Error("settingsFilePath must not be empty.");
  }
  if (!input.projectName.trim()) {
    throw new Error("projectName must not be empty.");
  }
  if (!input.agentSettings[input.defaultInternalWorkAssignee].enabled) {
    throw new Error(
      `defaultInternalWorkAssignee '${input.defaultInternalWorkAssignee}' must be enabled in agent settings.`,
    );
  }

  const processManager = new ProcessManager();
  const settings = await loadCliSettings(input.settingsFilePath);
  let runtimeConfig = {
    defaultInternalWorkAssignee: input.defaultInternalWorkAssignee,
    autoMode: input.defaultAutoMode,
  };

  // 1. Define placeholders for cross-dependencies.
  let agents: AgentSupervisor;
  let control: ControlCenterService;

  // 2. Define the hooks.
  const onAgentFailure = async (agent: AgentView) => {
    const isTerminalFailure =
      agent.status === "FAILED" ||
      (agent.status === "STOPPED" && (agent.lastExitCode ?? -1) !== 0);
    if (isTerminalFailure && agent.taskId) {
      const { buildAgentFailureReason } = await import("./api/agents");
      try {
        await control.failTaskIfInProgress({
          taskId: agent.taskId,
          reason: buildAgentFailureReason(agent, "terminated"),
          projectName: agent.projectName,
        });
      } catch {
        // Ignore stale task references.
      }
    }
  };

  const onStateChange = async (_projectName: string, state: ProjectState) => {
    const { refreshRecoveryCache } = await import("./api/agents");
    refreshRecoveryCache(state);
  };

  // 3. Initialize services with hooks.
  agents = new AgentSupervisor({
    registryFilePath: resolveAgentRegistryFilePath(input.cwd),
    onFailure: onAgentFailure,
  });

  control = new ControlCenterService({
    stateEngine: (projectName) => {
      const settingsFilePath = input.settingsFilePath;
      return (async () => {
        const s = await loadCliSettings(settingsFilePath);
        const project = s.projects.find((p) => p.name === projectName);
        if (project) {
          const stateFilePath = resolve(project.rootDir, ".ixado/state.json");
          return new StateEngine(stateFilePath);
        }

        if (projectName === input.projectName) {
          return new StateEngine(input.stateFilePath);
        }

        throw new Error(`Project not found: ${projectName}`);
      })();
    },
    tasksMarkdownFilePath: resolve(input.cwd, "TASKS.md"),
    internalWorkRunner: async (workInput) => {
      const assigneeSettings = input.agentSettings[workInput.assignee];
      if (!assigneeSettings.enabled) {
        const available = CLI_ADAPTER_IDS.filter(
          (adapterId) => input.agentSettings[adapterId].enabled,
        );
        throw new Error(
          `Agent '${workInput.assignee}' is disabled. Available agents: ${available.join(", ")}.`,
        );
      }

      const adapter = createAdapter(workInput.assignee, processManager, {
        bypassApprovalsAndSandbox: assigneeSettings.bypassApprovalsAndSandbox,
      });
      const startupDiagnostic = buildAdapterInitializationDiagnostic({
        adapterId: workInput.assignee,
        command: adapter.contract.command,
        baseArgs: adapter.contract.baseArgs,
        cwd: input.cwd,
        timeoutMs: assigneeSettings.timeoutMs,
        startupSilenceTimeoutMs: assigneeSettings.startupSilenceTimeoutMs,
      });
      if (startupDiagnostic) {
        console.info(formatAdapterStartupDiagnostic(startupDiagnostic));
      }
      const artifacts = await createPromptLogArtifacts({
        cwd: input.cwd,
        assignee: workInput.assignee,
        prompt: workInput.prompt,
      });
      const executionPlan = buildAdapterExecutionPlan({
        assignee: workInput.assignee,
        baseArgs: adapter.contract.baseArgs,
        prompt: workInput.prompt,
        promptFilePath: artifacts.inputFilePath,
        resume: Boolean(workInput.resume),
      });
      const args = executionPlan.args;
      const stdin = executionPlan.stdin;
      const agentName = workInput.taskId
        ? `${workInput.assignee} task worker`
        : `${workInput.assignee} internal worker`;
      console.info(
        `[web][internal] starting adapter=${workInput.assignee} command=${adapter.contract.command}`,
      );
      const result = await (async () => {
        try {
          const runResult = await agents.runToCompletion({
            name: agentName,
            command: adapter.contract.command,
            args,
            cwd: input.cwd,
            timeoutMs: assigneeSettings.timeoutMs,
            startupSilenceTimeoutMs: assigneeSettings.startupSilenceTimeoutMs,
            stdin,
            adapterId: workInput.assignee,
            approvedAdapterSpawn: true,
            phaseId: workInput.phaseId,
            taskId: workInput.taskId,
            projectName: input.projectName,
          });
          await writeOutputLog({
            outputFilePath: artifacts.outputFilePath,
            command: runResult.command,
            args: runResult.args,
            durationMs: runResult.durationMs,
            stdout: runResult.stdout,
            stderr: runResult.stderr,
          });
          return runResult;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await writeOutputLog({
            outputFilePath: artifacts.outputFilePath,
            command: adapter.contract.command,
            args,
            errorMessage: message,
          });
          if (isMissingCommandError(error)) {
            throw new Error(
              `Internal work adapter '${workInput.assignee}' is configured to use '${adapter.contract.command}', but that command is not installed or not on PATH. Install it or choose another adapter in 'ixado onboard' / the web UI.`,
            );
          }

          throw new Error(`${message}\nLogs: ${artifacts.outputFilePath}`);
        }
      })();
      console.info(
        `[web][internal] completed adapter=${workInput.assignee} durationMs=${result.durationMs} stdoutLen=${result.stdout.length} stderrLen=${result.stderr.length}`,
      );

      return {
        command: result.command,
        args: result.args,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      };
    },
    repositoryResetRunner: async () => {
      await processManager.run({
        command: "git",
        args: ["reset", "--hard"],
        cwd: input.cwd,
      });
    },
    onStateChange: onStateChange,
  });

  // 4. Initial cache load for all known projects.
  const { refreshRecoveryCache } = await import("./api/agents");
  for (const project of settings.projects) {
    try {
      const state = await control.getState(project.name);
      refreshRecoveryCache(state);
    } catch {
      // Ignore projects with no state yet.
    }
  }
  try {
    const defaultState = await control.getState(input.projectName);
    refreshRecoveryCache(defaultState);
  } catch {
    // Ignore.
  }

  await control.ensureInitialized(input.projectName, input.cwd);

  const projectNames = new Set<string>([
    input.projectName,
    ...settings.projects.map((project) => project.name),
  ]);
  const statesByProject = new Map<string, ProjectState>();
  for (const projectName of projectNames) {
    try {
      const state = await control.getState(projectName);
      statesByProject.set(projectName, state);
    } catch {
      // Ignore projects with no state yet.
    }
  }

  const crossStoreReconciledAgents = agents.reconcileRunningAgentsWhere(
    (agent) => {
      if (!agent.taskId || !agent.projectName) {
        return false;
      }
      const projectState = statesByProject.get(agent.projectName);
      if (!projectState) {
        return false;
      }
      const taskStatus = findTaskStatusById(projectState, agent.taskId);
      if (!taskStatus) {
        return false;
      }
      return TERMINAL_TASK_STATUSES.has(taskStatus);
    },
  );
  if (crossStoreReconciledAgents > 0) {
    console.info(
      `Startup: reconciled ${crossStoreReconciledAgents} stale RUNNING agent(s) with terminal task state to STOPPED.`,
    );
  }

  const usage = new UsageService(
    new CodexUsageTracker(processManager),
    input.cwd,
    {
      codexbarEnabled: settings.usage.codexbarEnabled,
    },
  );
  const cliLogFilePath = resolveCliLogFilePath(input.cwd);
  const execution = new ExecutionControlService({
    control,
    agents: {
      list: () => agents.list(),
      kill: (id) => agents.kill(id),
    },
    projectRootDir: input.cwd,
    projectName: input.projectName,
    resolveDefaultAssignee: async (projectName) => {
      const currentSettings = await loadCliSettings(input.settingsFilePath);
      const project = currentSettings.projects.find(
        (candidate) => candidate.name === projectName,
      );
      return (
        project?.executionSettings?.defaultAssignee ??
        currentSettings.internalWork.assignee
      );
    },
  });
  const app = createWebApp({
    control: {
      getState: (name) => control.getState(name),
      createPhase: (input) => control.createPhase(input),
      createTask: (input) => control.createTask(input),
      updateTask: (input) => control.updateTask(input),
      setActivePhase: (input) => control.setActivePhase(input),
      startTask: (input) => control.startTask(input),
      resetTaskToTodo: (input) => control.resetTaskToTodo(input),
      reconcileInProgressTaskToTodo: (input) =>
        control.reconcileInProgressTaskToTodo(input),
      failTaskIfInProgress: (input) => control.failTaskIfInProgress(input),
      recordRecoveryAttempt: (input) => control.recordRecoveryAttempt(input),
      importFromTasksMarkdown: (assignee, name) =>
        control.importFromTasksMarkdown(assignee, name),
      runInternalWork: (input) => control.runInternalWork(input),
    },
    agents: {
      list: () => agents.list(),
      start: (input) => agents.start(input),
      assign: (id, input) => agents.assign(id, input),
      kill: (id) => agents.kill(id),
      restart: (id) => agents.restart(id),
      subscribe: (id, listener) => agents.subscribe(id, listener),
    },
    usage,
    defaultAgentCwd: input.cwd,
    defaultInternalWorkAssignee: input.defaultInternalWorkAssignee,
    defaultAutoMode: input.defaultAutoMode,
    availableWorkerAssignees: CLI_ADAPTER_IDS.filter(
      (adapterId) => input.agentSettings[adapterId].enabled,
    ),
    projectName: input.projectName,
    getRuntimeConfig: async () => runtimeConfig,
    getProjects: async () => {
      const s = await loadCliSettings(input.settingsFilePath);
      return s.projects;
    },
    getProjectState: async (name) => {
      return control.getState(name);
    },
    updateProjectSettings: async (name, patch) => {
      const globalSettingsFilePath = resolveGlobalSettingsFilePath();
      const s = await loadCliSettings(globalSettingsFilePath);
      const idx = s.projects.findIndex((p) => p.name === name);
      if (idx < 0) {
        throw new Error(`Project not found: ${name}`);
      }
      const existing = s.projects[idx];
      const merged = {
        ...existing,
        executionSettings: ProjectExecutionSettingsSchema.parse({
          ...(existing.executionSettings ?? {}),
          ...patch,
        }),
      };
      const updatedProjects = [...s.projects];
      updatedProjects[idx] = merged;
      await saveCliSettings(globalSettingsFilePath, {
        ...s,
        projects: updatedProjects,
      });
      return merged;
    },
    getGlobalSettings: async () => {
      return loadCliSettings(input.settingsFilePath);
    },
    updateGlobalSettings: async (patch) => {
      const validatedPatch = CliSettingsOverrideSchema.parse(patch);
      const current = await loadCliSettings(input.settingsFilePath);
      const merged = {
        ...current,
        ...validatedPatch,
        telegram: {
          ...current.telegram,
          ...(validatedPatch.telegram ?? {}),
          notifications: {
            ...current.telegram.notifications,
            ...(validatedPatch.telegram?.notifications ?? {}),
          },
        },
        internalWork: {
          ...current.internalWork,
          ...(validatedPatch.internalWork ?? {}),
        },
        executionLoop: {
          ...current.executionLoop,
          ...(validatedPatch.executionLoop ?? {}),
          pullRequest: {
            ...current.executionLoop.pullRequest,
            ...(validatedPatch.executionLoop?.pullRequest ?? {}),
          },
        },
        exceptionRecovery: {
          ...current.exceptionRecovery,
          ...(validatedPatch.exceptionRecovery ?? {}),
        },
        usage: {
          ...current.usage,
          ...(validatedPatch.usage ?? {}),
        },
        agents: {
          CODEX_CLI: {
            ...current.agents.CODEX_CLI,
            ...(validatedPatch.agents?.CODEX_CLI ?? {}),
          },
          CLAUDE_CLI: {
            ...current.agents.CLAUDE_CLI,
            ...(validatedPatch.agents?.CLAUDE_CLI ?? {}),
          },
          GEMINI_CLI: {
            ...current.agents.GEMINI_CLI,
            ...(validatedPatch.agents?.GEMINI_CLI ?? {}),
          },
          MOCK_CLI: {
            ...current.agents.MOCK_CLI,
            ...(validatedPatch.agents?.MOCK_CLI ?? {}),
          },
        },
      };

      return saveCliSettings(input.settingsFilePath, merged);
    },
    execution: {
      getStatus: async (projectName) => execution.getStatus(projectName),
      startAuto: async (workInput) => execution.startAuto(workInput),
      stop: async (workInput) => execution.stop(workInput),
    },
    updateRuntimeConfig: async (next) => {
      const currentSettings = await loadCliSettings(input.settingsFilePath);
      const assignee =
        next.defaultInternalWorkAssignee ??
        currentSettings.internalWork.assignee;
      if (!input.agentSettings[assignee].enabled) {
        throw new Error(
          `defaultInternalWorkAssignee '${assignee}' must be enabled in agent settings.`,
        );
      }
      const autoMode =
        typeof next.autoMode === "boolean"
          ? next.autoMode
          : currentSettings.executionLoop.autoMode;

      const saved = await saveCliSettings(input.settingsFilePath, {
        ...currentSettings,
        internalWork: {
          ...currentSettings.internalWork,
          assignee,
        },
        executionLoop: {
          ...currentSettings.executionLoop,
          autoMode,
        },
      });

      runtimeConfig = {
        defaultInternalWorkAssignee: saved.internalWork.assignee,
        autoMode: saved.executionLoop.autoMode,
      };
      return runtimeConfig;
    },
    webLogFilePath: input.webLogFilePath,
    cliLogFilePath,
  });

  const requestedPort = await resolveWebPort(input.port);
  const server = Bun.serve({
    port: requestedPort,
    hostname: WEB_SERVER_HOST,
    idleTimeout: WEB_SERVER_IDLE_TIMEOUT_SECONDS,
    fetch: app.fetch,
  });
  const resolvedPort = server.port ?? requestedPort;

  return {
    port: resolvedPort,
    url: `http://${WEB_SERVER_HOST}:${resolvedPort}`,
    stop: () => {
      server.stop(true);
    },
  };
}
