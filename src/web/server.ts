import { resolve } from "node:path";
import { createServer } from "node:net";

import { createPromptLogArtifacts, writeOutputLog } from "../agent-logs";
import { resolveAgentRegistryFilePath } from "../agent-registry";
import {
  buildAdapterExecutionPlan,
  CodexUsageTracker,
  createAdapter,
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
} from "../types";
import { AgentSupervisor } from "./agent-supervisor";
import { createWebApp } from "./app";
import { ControlCenterService } from "./control-center-service";
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
  const agents = new AgentSupervisor({
    registryFilePath: resolveAgentRegistryFilePath(input.cwd),
  });
  const control = new ControlCenterService(
    (projectName) => {
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
    resolve(input.cwd, "TASKS.md"),
    async (workInput) => {
      const assigneeSettings = input.agentSettings[workInput.assignee];
      if (!assigneeSettings.enabled) {
        const available = CLI_ADAPTER_IDS.filter(
          (adapterId) => input.agentSettings[adapterId].enabled,
        );
        throw new Error(
          `Agent '${workInput.assignee}' is disabled. Available agents: ${available.join(", ")}.`,
        );
      }

      const adapter = createAdapter(workInput.assignee, processManager);
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
            stdin,
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
    async () => {
      await processManager.run({
        command: "git",
        args: ["reset", "--hard"],
        cwd: input.cwd,
      });
    },
  );
  await control.ensureInitialized(input.projectName, input.cwd);

  const usage = new UsageService(
    new CodexUsageTracker(processManager),
    input.cwd,
    {
      codexbarEnabled: settings.usage.codexbarEnabled,
    },
  );
  const cliLogFilePath = resolveCliLogFilePath(input.cwd);
  const app = createWebApp({
    control: {
      getState: (name) => control.getState(name),
      createPhase: (input) => control.createPhase(input),
      createTask: (input) => control.createTask(input),
      setActivePhase: (input) => control.setActivePhase(input),
      startTask: (input) => control.startTask(input),
      resetTaskToTodo: (input) => control.resetTaskToTodo(input),
      failTaskIfInProgress: (input) => control.failTaskIfInProgress(input),
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
        },
        internalWork: {
          ...current.internalWork,
          ...(validatedPatch.internalWork ?? {}),
        },
        executionLoop: {
          ...current.executionLoop,
          ...(validatedPatch.executionLoop ?? {}),
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
