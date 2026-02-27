import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { resolve, basename } from "node:path";

import { createPromptLogArtifacts, writeOutputLog } from "../agent-logs";
import { resolveAgentRegistryFilePath } from "../agent-registry";
import {
  resolveLatestAgentRuntimeDiagnostic,
  summarizeAgentRuntimeDiagnostic,
} from "../agent-runtime-diagnostics";
import {
  buildAdapterExecutionPlan,
  buildAdapterInitializationDiagnostic,
  createAdapter,
  formatAdapterStartupDiagnostic,
} from "../adapters";
import { createTelegramRuntime } from "../bot";
import { ExecutionRunLock } from "../engine/execution-run-lock";
import { PhaseLoopControl } from "../engine/phase-loop-control";
import { PhaseRunner } from "../engine/phase-runner";
import { ProcessManager } from "../process";
import { StateEngine } from "../state";
import {
  ActivePhaseResolutionError,
  resolveActivePhaseStrict,
} from "../state/active-phase";
import {
  buildRecoveryTraceLinks,
  formatPhaseTaskContext,
  summarizeFailure,
} from "../log-readability";
import {
  CLIAdapterIdSchema,
  WorkerAssigneeSchema,
  type CLIAdapterId,
  type PhaseFailureKind,
} from "../types";
import {
  createTelegramNotificationEvaluator,
  formatRuntimeEventForCli,
  formatRuntimeEventForTelegram,
} from "../types/runtime-events";
import { AgentSupervisor, ControlCenterService, type AgentView } from "../web";
import { loadAuthPolicy } from "../security/policy-loader";
import { initializeCliLogging } from "./logging";
import { CommandRegistry, type CommandActionContext } from "./command-registry";
import { ValidationError } from "./validation";
import {
  getAvailableAgents,
  loadCliSettings,
  resolveGlobalSettingsFilePath,
  resolveOnboardSettingsFilePath,
  resolveOnboardSoulFilePath,
  resolveSettingsFilePath,
  runOnboard,
  saveCliSettings,
} from "./settings";
import {
  parseWebPort,
  serveWebControlCenter,
  startWebDaemon,
  stopWebDaemon,
} from "./web-control";

const DEFAULT_STATE_FILE = ".ixado/state.json";
const CLI_LOG_FILE_PATH = initializeCliLogging(process.cwd());

type TelegramBootstrapConfig =
  | { enabled: false }
  | { enabled: true; token: string; ownerId: number };

function parseOwnerId(rawOwnerId: string): number {
  const ownerId = Number(rawOwnerId);

  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    throw new Error("TELEGRAM_OWNER_ID must be a positive integer.");
  }

  return ownerId;
}

function resolveStateFilePath(): string {
  const configuredStatePath = process.env.IXADO_STATE_FILE?.trim();

  if (configuredStatePath) {
    return resolve(configuredStatePath);
  }

  return resolve(process.cwd(), DEFAULT_STATE_FILE);
}

function resolveStateFilePathForProject(projectRootDir: string): string {
  return resolve(projectRootDir, DEFAULT_STATE_FILE);
}

async function resolveActiveProjectRootDir(): Promise<string | undefined> {
  const globalSettingsFilePath = resolveGlobalSettingsFilePath();
  const settings = await loadCliSettings(globalSettingsFilePath);

  if (!settings.activeProject) {
    return undefined;
  }

  const project = settings.projects.find(
    (p) => p.name === settings.activeProject,
  );
  return project?.rootDir;
}

async function resolveProjectAwareStateFilePath(): Promise<string> {
  const configuredStatePath = process.env.IXADO_STATE_FILE?.trim();
  if (configuredStatePath) {
    return resolve(configuredStatePath);
  }

  const activeRootDir = await resolveActiveProjectRootDir();
  if (activeRootDir) {
    return resolveStateFilePathForProject(activeRootDir);
  }

  return resolve(process.cwd(), DEFAULT_STATE_FILE);
}

async function resolveProjectName(): Promise<string> {
  const globalSettingsFilePath = resolveGlobalSettingsFilePath();
  const settings = await loadCliSettings(globalSettingsFilePath);

  if (settings.activeProject) {
    return settings.activeProject;
  }

  const currentDir = process.cwd();
  const project = settings.projects.find((p) => p.rootDir === currentDir);
  if (project) {
    return project.name;
  }

  return basename(currentDir) || "IxADO";
}

async function resolveProjectRootDir(): Promise<string> {
  const activeRootDir = await resolveActiveProjectRootDir();
  return activeRootDir ?? process.cwd();
}

function resolveProjectExecutionSettings(
  settings: Awaited<ReturnType<typeof loadCliSettings>>,
  projectName: string,
): { autoMode: boolean; defaultAssignee: CLIAdapterId } {
  const project = settings.projects.find((p) => p.name === projectName);
  return {
    autoMode:
      project?.executionSettings?.autoMode ?? settings.executionLoop.autoMode,
    defaultAssignee:
      project?.executionSettings?.defaultAssignee ??
      settings.internalWork.assignee,
  };
}

function resolveConfigTargetProjectIndex(
  settings: Awaited<ReturnType<typeof loadCliSettings>>,
): number | undefined {
  if (settings.activeProject) {
    const activeIndex = settings.projects.findIndex(
      (project) => project.name === settings.activeProject,
    );
    if (activeIndex >= 0) {
      return activeIndex;
    }
  }

  const cwd = process.cwd();
  const cwdIndex = settings.projects.findIndex(
    (project) => project.rootDir === cwd,
  );
  if (cwdIndex >= 0) {
    return cwdIndex;
  }
  return undefined;
}

async function loadOrInitializeState(
  engine: StateEngine,
  stateFilePath: string,
  projectRootDir: string,
  projectName: string,
): Promise<{
  phaseCount: number;
  initialized: boolean;
}> {
  try {
    await access(stateFilePath, fsConstants.F_OK);
    const state = await engine.readProjectState();

    return {
      phaseCount: state.phases.length,
      initialized: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const state = await engine.initialize({
    projectName,
    rootDir: projectRootDir,
  });

  return {
    phaseCount: state.phases.length,
    initialized: true,
  };
}

function resolveTelegramConfig(settings: {
  enabled: boolean;
  botToken?: string;
  ownerId?: number;
}): TelegramBootstrapConfig {
  if (!settings.enabled) {
    return { enabled: false };
  }

  const token =
    process.env.TELEGRAM_BOT_TOKEN?.trim() || settings.botToken?.trim();
  const rawOwnerId = process.env.TELEGRAM_OWNER_ID?.trim();
  const ownerIdFromSettings = settings.ownerId;

  if (!token || (!rawOwnerId && ownerIdFromSettings === undefined)) {
    throw new Error(
      "Telegram is enabled in settings, but bot token and owner ID are required (in settings or env).",
    );
  }

  return {
    enabled: true,
    token,
    ownerId: rawOwnerId ? parseOwnerId(rawOwnerId) : ownerIdFromSettings!,
  };
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

function createControlCenterService(
  stateFilePath: string,
  projectRootDir: string,
  settings: Awaited<ReturnType<typeof loadCliSettings>>,
  projectName: string,
): ControlCenterService {
  return createServices(stateFilePath, projectRootDir, settings, projectName)
    .control;
}

function createControlCenterServiceWithAgentTracking(
  stateFilePath: string,
  projectRootDir: string,
  processManager: ProcessManager,
  agents: AgentSupervisor,
  settings: Awaited<ReturnType<typeof loadCliSettings>>,
  projectName: string,
): ControlCenterService {
  return new ControlCenterService({
    stateEngine: new StateEngine(stateFilePath),
    tasksMarkdownFilePath: resolve(projectRootDir, "TASKS.md"),
    internalWorkRunner: async (workInput) => {
      const availableAgents = getAvailableAgents(settings);
      if (!availableAgents.includes(workInput.assignee)) {
        throw new Error(
          `Agent '${workInput.assignee}' is disabled. Available agents: ${availableAgents.join(", ")}.`,
        );
      }

      const assigneeSettings = settings.agents[workInput.assignee];
      const adapter = createAdapter(workInput.assignee, processManager, {
        bypassApprovalsAndSandbox: assigneeSettings.bypassApprovalsAndSandbox,
      });
      const startupDiagnostic = buildAdapterInitializationDiagnostic({
        adapterId: workInput.assignee,
        command: adapter.contract.command,
        baseArgs: adapter.contract.baseArgs,
        cwd: projectRootDir,
        timeoutMs: assigneeSettings.timeoutMs,
        startupSilenceTimeoutMs: assigneeSettings.startupSilenceTimeoutMs,
      });
      if (startupDiagnostic) {
        console.info(formatAdapterStartupDiagnostic(startupDiagnostic));
      }
      const artifacts = await createPromptLogArtifacts({
        cwd: projectRootDir,
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
      try {
        const result = await agents.runToCompletion({
          name: agentName,
          command: adapter.contract.command,
          args,
          cwd: projectRootDir,
          timeoutMs: assigneeSettings.timeoutMs,
          startupSilenceTimeoutMs: assigneeSettings.startupSilenceTimeoutMs,
          stdin,
          adapterId: workInput.assignee,
          approvedAdapterSpawn: true,
          phaseId: workInput.phaseId,
          taskId: workInput.taskId,
          projectName,
        });
        await writeOutputLog({
          outputFilePath: artifacts.outputFilePath,
          command: result.command,
          args: result.args,
          durationMs: result.durationMs,
          stdout: result.stdout,
          stderr: result.stderr,
        });
        return {
          command: result.command,
          args: result.args,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await writeOutputLog({
          outputFilePath: artifacts.outputFilePath,
          command: adapter.contract.command,
          args,
          errorMessage: message,
        });
        if (isMissingCommandError(error)) {
          throw new Error(
            `Adapter '${workInput.assignee}' requires '${adapter.contract.command}' but it is not installed or not on PATH. Install it or select another adapter with 'ixado onboard'.`,
          );
        }

        throw new Error(`${message}\nLogs: ${artifacts.outputFilePath}`);
      }
    },
    repositoryResetRunner: async () => {
      await processManager.run({
        command: "git",
        args: ["reset", "--hard"],
        cwd: projectRootDir,
      });
    },
  });
}

function createServices(
  stateFilePath: string,
  projectRootDir: string,
  settings: Awaited<ReturnType<typeof loadCliSettings>>,
  projectName: string,
): {
  control: ControlCenterService;
  agents: AgentSupervisor;
} {
  const processManager = new ProcessManager();
  const agents = new AgentSupervisor({
    registryFilePath: resolveAgentRegistryFilePath(projectRootDir),
  });
  const control = createControlCenterServiceWithAgentTracking(
    stateFilePath,
    projectRootDir,
    processManager,
    agents,
    settings,
    projectName,
  );
  return { control, agents };
}

async function runDefaultCommand(): Promise<void> {
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const policy = await loadAuthPolicy(settingsFilePath);
  const telegram = resolveTelegramConfig(settings.telegram);
  const projectRootDir = await resolveProjectRootDir();
  const projectName = await resolveProjectName();
  const stateFilePath = await resolveProjectAwareStateFilePath();
  const stateEngine = new StateEngine(stateFilePath);
  const { control, agents } = createServices(
    stateFilePath,
    projectRootDir,
    settings,
    projectName,
  );
  const stateSummary = await loadOrInitializeState(
    stateEngine,
    stateFilePath,
    projectRootDir,
    projectName,
  );
  const availableAgents = getAvailableAgents(settings);
  const projectExecutionSettings = resolveProjectExecutionSettings(
    settings,
    projectName,
  );

  console.info("IxADO bootstrap checks passed.");
  console.info(`CLI logs: ${CLI_LOG_FILE_PATH}.`);
  console.info(`Settings loaded from ${settingsFilePath}.`);
  console.info(`Authorization policy loaded (version: ${policy.version}).`);

  if (telegram.enabled) {
    console.info(
      `Telegram mode enabled (owner: ${telegram.ownerId}, token length: ${telegram.token.length}).`,
    );
  } else {
    console.info("Telegram mode disabled. Running in local CLI mode.");
  }

  console.info(
    `State engine ready (${stateSummary.initialized ? "initialized" : "loaded"} at ${stateFilePath}, phases: ${stateSummary.phaseCount}).`,
  );
  console.info(`Available agents: ${availableAgents.join(", ")}.`);

  if (telegram.enabled) {
    console.info("Starting Telegram command center.");
    console.info(
      "Bot polling is active. Send /status, /tasks, /starttask <taskNumber> [assignee], /setactivephase <phaseNumber|phaseId>, /next, or /stop. Press Ctrl+C to stop.",
    );
    const runtime = createTelegramRuntime({
      token: telegram.token,
      ownerId: telegram.ownerId,
      readState: () => control.getState(),
      listAgents: () => agents.list(),
      availableAssignees: availableAgents,
      defaultAssignee: projectExecutionSettings.defaultAssignee,
      startTask: async (input) =>
        control.startActiveTaskAndWait({
          taskNumber: input.taskNumber,
          assignee: input.assignee,
        }),
      setActivePhase: async (input) =>
        control.setActivePhase({
          phaseId: input.phaseId,
        }),
      requestNextLoop: () => "No active execution loop.",
      requestStopLoop: () => "No active execution loop.",
    });

    await runtime.start();
    return;
  }

  console.info("Telegram command center not started.");
}

async function runInitCommand(_ctx: CommandActionContext): Promise<void> {
  const globalSettingsFilePath = resolveGlobalSettingsFilePath();
  const settings = await loadCliSettings(globalSettingsFilePath);
  const currentDir = process.cwd();
  const projectName = basename(currentDir);

  const existingProject = settings.projects.find(
    (p) => p.rootDir === currentDir,
  );
  if (existingProject) {
    console.info(
      `Project '${existingProject.name}' is already registered at ${currentDir}.`,
    );
    console.info(
      `Next:    Run 'ixado switch ${existingProject.name}' to activate it, or 'ixado list' to see all projects.`,
    );
    return;
  }

  settings.projects.push({
    name: projectName,
    rootDir: currentDir,
  });

  await saveCliSettings(globalSettingsFilePath, settings);
  console.info(
    `Registered project '${projectName}' at ${currentDir} in global config.`,
  );
  console.info(
    `Next:    Run 'ixado switch ${projectName}' to set it active, then 'ixado phase create <name> <branch>'.`,
  );
}

async function runListCommand(_ctx: CommandActionContext): Promise<void> {
  const globalSettingsFilePath = resolveGlobalSettingsFilePath();
  const settings = await loadCliSettings(globalSettingsFilePath);
  const currentDir = process.cwd();

  if (settings.projects.length === 0) {
    console.info(
      "No projects registered. Use `ixado init` to register the current directory.",
    );
    return;
  }

  console.info("Registered projects:");
  for (const project of settings.projects) {
    const isActive = settings.activeProject === project.name;
    const isCwd = project.rootDir === currentDir;
    const markers = [isActive ? "active" : "", isCwd ? "cwd" : ""]
      .filter(Boolean)
      .join(", ");
    const suffix = markers ? ` (${markers})` : "";
    console.info(`  ${project.name} -> ${project.rootDir}${suffix}`);
  }
}

async function runSwitchCommand({ args }: CommandActionContext): Promise<void> {
  const projectName = args[0]?.trim() ?? "";
  if (!projectName) {
    throw new ValidationError("Missing required argument: <project-name>.", {
      usage: "ixado switch <project-name>",
      hint: "Run 'ixado list' to see registered projects.",
    });
  }

  const globalSettingsFilePath = resolveGlobalSettingsFilePath();
  const settings = await loadCliSettings(globalSettingsFilePath);
  const project = settings.projects.find((p) => p.name === projectName);
  if (!project) {
    const available = settings.projects.map((p) => p.name).join(", ");
    throw new ValidationError(`Project '${projectName}' not found.`, {
      usage: "ixado switch <project-name>",
      hint: `Registered projects: ${available || "none"}. Run 'ixado list' for details.`,
    });
  }

  settings.activeProject = project.name;
  await saveCliSettings(globalSettingsFilePath, settings);
  console.info(
    `Switched active project to '${project.name}' at ${project.rootDir}.`,
  );
  console.info(`Next:    Run 'ixado status' to see phase and task state.`);
}

async function runOnboardCommand(): Promise<void> {
  const settingsFilePath = resolveOnboardSettingsFilePath();
  const soulFilePath = resolveOnboardSoulFilePath();
  const rl = createInterface({
    input: stdin,
    output: stdout,
  });

  try {
    const settings = await runOnboard(
      settingsFilePath,
      soulFilePath,
      (question) => rl.question(question),
    );
    console.info(`CLI logs: ${CLI_LOG_FILE_PATH}.`);
    console.info(`Settings saved to ${settingsFilePath}.`);
    console.info(`SOUL file saved to ${soulFilePath}.`);
    console.info(
      `Telegram mode ${settings.telegram.enabled ? "enabled" : "disabled"}.`,
    );
    console.info(`Internal work adapter: ${settings.internalWork.assignee}.`);
    console.info(
      `Available agents: ${getAvailableAgents(settings).join(", ")}.`,
    );
    for (const agentId of getAvailableAgents(settings)) {
      console.info(
        `  ${agentId} timeout: ${settings.agents[agentId].timeoutMs}ms`,
      );
    }
    if (settings.telegram.enabled) {
      console.info("Telegram bot credentials stored in settings file.");
    }
    console.info(
      `Next:    Run 'ixado init' to register this directory as a project, then 'ixado phase create <name> <branch>'.`,
    );
  } finally {
    rl.close();
  }
}

function resolveCliEntryScriptPath(): string {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error("Unable to resolve CLI entry script path.");
  }

  return resolve(scriptPath);
}

async function runWebStartCommand({
  args,
}: CommandActionContext): Promise<void> {
  const settingsFilePath = resolveGlobalSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const projectRootDir = await resolveProjectRootDir();
  const projectName = await resolveProjectName();
  const projectExecutionSettings = resolveProjectExecutionSettings(
    settings,
    projectName,
  );
  const stateFilePath = await resolveProjectAwareStateFilePath();
  const portFromArgs = parseWebPort(args[0]);
  const portFromEnv = parseWebPort(process.env.IXADO_WEB_PORT?.trim());
  const port = portFromArgs ?? portFromEnv;

  const runtime = await startWebDaemon({
    cwd: projectRootDir,
    stateFilePath,
    settingsFilePath,
    projectName,
    entryScriptPath: resolveCliEntryScriptPath(),
    port,
  });

  console.info(
    `Web control center started at ${runtime.url} (pid: ${runtime.pid}).`,
  );
  console.info(`Web logs: ${runtime.logFilePath}`);
  console.info(`CLI logs: ${CLI_LOG_FILE_PATH}`);
  console.info(
    `Internal work default adapter: ${projectExecutionSettings.defaultAssignee}.`,
  );
  console.info("Use `ixado web stop` to stop it.");
}

async function runWebStopCommand(_ctx: CommandActionContext): Promise<void> {
  const projectRootDir = await resolveProjectRootDir();
  const result = await stopWebDaemon(projectRootDir);
  if (result.status === "stopped") {
    console.info(`Web control center stopped (pid: ${result.record.pid}).`);
    console.info(`Web logs: ${result.record.logFilePath}`);
    console.info(`CLI logs: ${CLI_LOG_FILE_PATH}`);
    console.info(`Next:    Run 'ixado web start' to restart it.`);
    return;
  }

  if (result.status === "permission_denied") {
    console.info(
      `Web control center is running at ${result.record.url} (pid: ${result.record.pid}), but this user cannot stop it (permission denied).`,
    );
    console.info(
      `Next:    Run as the user who started the process to stop it.`,
    );
    return;
  }

  if (result.reason === "stale_runtime_file") {
    console.info(
      "Web control center was not running. Removed stale runtime metadata.",
    );
    console.info(`Next:    Run 'ixado web start [port]' to start it.`);
    return;
  }

  console.info("Web control center is not running.");
  console.info(`Next:    Run 'ixado web start [port]' to start it.`);
}

async function runWebServeCommand({
  args,
}: CommandActionContext): Promise<void> {
  const projectRootDir = await resolveProjectRootDir();
  const projectName = await resolveProjectName();
  const stateFilePath = await resolveProjectAwareStateFilePath();
  const settingsFilePath = resolveGlobalSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const projectExecutionSettings = resolveProjectExecutionSettings(
    settings,
    projectName,
  );
  const portFromArgs = parseWebPort(args[0]);
  const portFromEnv = parseWebPort(process.env.IXADO_WEB_PORT?.trim());
  const port = portFromArgs ?? portFromEnv;

  const runtime = await serveWebControlCenter({
    cwd: projectRootDir,
    stateFilePath,
    settingsFilePath,
    projectName,
    defaultInternalWorkAssignee: projectExecutionSettings.defaultAssignee,
    defaultAutoMode: projectExecutionSettings.autoMode,
    agentSettings: settings.agents,
    port,
  });

  console.info(
    `Web control center started at ${runtime.url} (pid: ${runtime.pid}).`,
  );
  console.info(`Web logs: ${runtime.logFilePath}`);
  console.info(`CLI logs: ${CLI_LOG_FILE_PATH}`);
}

function resolvePhaseFailureKindLabel(
  failureKind: PhaseFailureKind | undefined,
): string {
  switch (failureKind) {
    case "LOCAL_TESTER":
      return "local tester failure";
    case "REMOTE_CI":
      return "remote CI failure";
    case "AGENT_FAILURE":
      return "agent execution failure";
    default:
      return "failure";
  }
}

function resolvePhaseFailureGuidance(
  failureKind: PhaseFailureKind | undefined,
): string {
  switch (failureKind) {
    case "LOCAL_TESTER":
      return "Local test suite failed. Complete the CI_FIX task(s) to fix failing tests, then rerun 'ixado phase run'.";
    case "REMOTE_CI":
      return "Remote CI checks failed on the PR. Complete the CI_FIX task(s) to address CI errors, then rerun 'ixado phase run'.";
    case "AGENT_FAILURE":
      return "Task agent execution failed. Retry the failed task with 'ixado task retry <n>' or reset it with 'ixado task reset <n>'.";
    default:
      return "Phase execution stopped. Run 'ixado task list' to review tasks and 'ixado phase run' to resume.";
  }
}

type PhaseRunMode = "AUTO" | "MANUAL";

function resolveActivePhaseFromState(
  state: Awaited<ReturnType<ControlCenterService["getState"]>>,
): Awaited<ReturnType<ControlCenterService["getState"]>>["phases"][number] {
  try {
    return resolveActivePhaseStrict(state);
  } catch (error) {
    if (error instanceof ActivePhaseResolutionError) {
      switch (error.code) {
        case "ACTIVE_PHASE_ID_MISSING":
        case "ACTIVE_PHASE_ID_NOT_FOUND":
          throw new Error(
            `${error.message} Run 'ixado phase active <phaseNumber|phaseId>'.`,
          );
        default:
          throw error;
      }
    }

    throw error;
  }
}

function resolvePhaseRunMode(
  rawMode: string | undefined,
  autoModeDefault: boolean,
): PhaseRunMode {
  const normalized = rawMode?.trim().toLowerCase();
  if (!normalized) {
    return autoModeDefault ? "AUTO" : "MANUAL";
  }
  if (normalized === "auto") {
    return "AUTO";
  }
  if (normalized === "manual") {
    return "MANUAL";
  }

  throw new ValidationError(`Invalid phase run mode: '${rawMode}'.`, {
    usage: "ixado phase run [auto|manual] [countdownSeconds>=0]",
    hint: "Use 'auto' for fully automatic execution or 'manual' for step-by-step confirmation.",
  });
}

function resolveCountdownSeconds(
  rawCountdown: string | undefined,
  fallback: number,
): number {
  const normalized = rawCountdown?.trim();
  if (!normalized) {
    return fallback;
  }

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ValidationError(
      `Invalid countdown seconds: '${rawCountdown}'. Expected a non-negative integer.`,
      {
        usage: "ixado phase run [auto|manual] [countdownSeconds>=0]",
        hint: "Use 0 to skip the countdown, or a positive number for a timed delay.",
      },
    );
  }

  return parsed;
}

async function resolveActivePhaseTaskForNumber(
  control: ControlCenterService,
  taskNumber: number,
): Promise<{
  phase: Awaited<
    ReturnType<ControlCenterService["getState"]>
  >["phases"][number];
  task: Awaited<
    ReturnType<ControlCenterService["getState"]>
  >["phases"][number]["tasks"][number];
}> {
  const state = await control.getState();
  const phase =
    state.phases.find((candidate) => candidate.id === state.activePhaseId) ??
    state.phases[0];
  if (!phase) {
    throw new ValidationError("No active phase found.", {
      hint: "Run 'ixado phase create <name> <branchName>' to create a phase first.",
    });
  }

  const task = phase.tasks[taskNumber - 1];
  if (!task) {
    throw new ValidationError(
      `Task #${taskNumber} not found in active phase '${phase.name}'.`,
      {
        hint: "Run 'ixado task list' to see available task numbers.",
      },
    );
  }

  return { phase, task };
}

async function runTaskStartCommand({
  args,
}: CommandActionContext): Promise<void> {
  const rawTaskNumber = args[0]?.trim() ?? "";
  const taskNumber = Number(rawTaskNumber);
  if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
    throw new ValidationError(
      `Invalid task number${rawTaskNumber ? `: '${rawTaskNumber}'` : ""}. Expected a positive integer.`,
      {
        usage: "ixado task start <taskNumber> [assignee]",
        hint: "Run 'ixado task list' to see available task numbers.",
      },
    );
  }

  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const projectRootDir = await resolveProjectRootDir();
  const projectName = await resolveProjectName();
  const stateFilePath = await resolveProjectAwareStateFilePath();
  const control = createControlCenterService(
    stateFilePath,
    projectRootDir,
    settings,
    projectName,
  );
  await control.ensureInitialized(projectName, projectRootDir);

  const explicitAssignee = args[1]?.trim();
  const projectExecutionSettings = resolveProjectExecutionSettings(
    settings,
    projectName,
  );
  let assigneeCandidate =
    explicitAssignee || projectExecutionSettings.defaultAssignee;
  if (!explicitAssignee) {
    const { task } = await resolveActivePhaseTaskForNumber(control, taskNumber);
    if (task.status === "FAILED" && task.assignee !== "UNASSIGNED") {
      assigneeCandidate = task.assignee;
    }
  }

  const assignee = CLIAdapterIdSchema.parse(assigneeCandidate);
  const availableAgents = getAvailableAgents(settings);
  if (!availableAgents.includes(assignee)) {
    throw new ValidationError(`Agent '${assignee}' is disabled.`, {
      hint: `Available agents: ${availableAgents.join(", ")}. Enable the agent with 'ixado onboard'.`,
    });
  }
  console.info(`Starting active-phase task #${taskNumber} with ${assignee}.`);

  const state = await control.startActiveTaskAndWait({
    taskNumber,
    assignee,
  });

  const phase =
    state.phases.find((candidate) => candidate.id === state.activePhaseId) ??
    state.phases[0];
  if (!phase) {
    throw new Error("No phase available after task run.");
  }
  const task = phase.tasks[taskNumber - 1];
  if (!task) {
    throw new Error(`Task #${taskNumber} not found after task run.`);
  }

  console.info(
    `Task #${taskNumber} ${task.title} finished with status ${task.status}.`,
  );
  if (task.status === "FAILED") {
    if (task.errorLogs) {
      console.info(`Failure details: ${task.errorLogs}`);
    }
    console.info(
      `Next:    Retry with 'ixado task retry ${taskNumber}' or reset with 'ixado task reset ${taskNumber}'.`,
    );
  } else {
    console.info(
      `Next:    Run 'ixado task list' to see all tasks or 'ixado phase run' to continue.`,
    );
  }
}

async function runTaskCreateCommand({
  args,
}: CommandActionContext): Promise<void> {
  const title = args[0]?.trim() ?? "";
  const description = args[1]?.trim() ?? "";
  if (!title || !description) {
    throw new ValidationError(
      "Missing required arguments: <title> and <description>.",
      {
        usage: "ixado task create <title> <description> [assignee]",
        hint: "Enclose multi-word values in quotes.",
      },
    );
  }

  const rawAssignee = args[2]?.trim();
  const parsedAssignee = rawAssignee
    ? WorkerAssigneeSchema.safeParse(rawAssignee)
    : { success: true as const, data: "UNASSIGNED" as const };
  if (!parsedAssignee.success) {
    throw new ValidationError(`Invalid assignee: '${rawAssignee}'.`, {
      usage: "ixado task create <title> <description> [assignee]",
      hint: "assignee must be one of: MOCK_CLI, CLAUDE_CLI, GEMINI_CLI, CODEX_CLI, UNASSIGNED",
    });
  }
  const assignee = parsedAssignee.data;
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const projectRootDir = await resolveProjectRootDir();
  const projectName = await resolveProjectName();
  const stateFilePath = await resolveProjectAwareStateFilePath();
  const control = createControlCenterService(
    stateFilePath,
    projectRootDir,
    settings,
    projectName,
  );
  await control.ensureInitialized(projectName, projectRootDir);
  const state = await control.getState();
  const activePhase = resolveActivePhaseFromState(state);
  const updated = await control.createTask({
    phaseId: activePhase.id,
    title,
    description,
    assignee,
  });
  const refreshedPhase =
    updated.phases.find((phase) => phase.id === activePhase.id) ?? activePhase;
  const taskNumber = refreshedPhase.tasks.length;
  console.info(
    `Created task #${taskNumber} in ${refreshedPhase.name}: ${title}.`,
  );
  console.info(`Status:  TODO — assignee: ${assignee}`);
  console.info(
    `Next:    Run 'ixado task start ${taskNumber}' to start it, or 'ixado phase run' to run all TODO tasks.`,
  );
}

async function runTaskListCommand(_ctx: CommandActionContext): Promise<void> {
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const projectRootDir = await resolveProjectRootDir();
  const projectName = await resolveProjectName();
  const stateFilePath = await resolveProjectAwareStateFilePath();
  const control = createControlCenterService(
    stateFilePath,
    projectRootDir,
    settings,
    projectName,
  );
  await control.ensureInitialized(projectName, projectRootDir);
  const tasksView = await control.listActivePhaseTasks();
  console.info(`Active phase: ${tasksView.phaseName}`);
  if (tasksView.items.length === 0) {
    console.info("No tasks in active phase.");
    return;
  }

  for (const item of tasksView.items) {
    console.info(
      `${item.number}. [${item.status}] ${item.title} (${item.assignee})`,
    );
  }
}

async function runTaskRetryCommand({
  args,
}: CommandActionContext): Promise<void> {
  const rawTaskNumber = args[0]?.trim() ?? "";
  const taskNumber = Number(rawTaskNumber);
  if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
    throw new ValidationError(
      `Invalid task number${rawTaskNumber ? `: '${rawTaskNumber}'` : ""}. Expected a positive integer.`,
      {
        usage: "ixado task retry <taskNumber>",
        hint: "Run 'ixado task list' to see available task numbers.",
      },
    );
  }

  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const projectRootDir = await resolveProjectRootDir();
  const projectName = await resolveProjectName();
  const stateFilePath = await resolveProjectAwareStateFilePath();
  const control = createControlCenterService(
    stateFilePath,
    projectRootDir,
    settings,
    projectName,
  );
  await control.ensureInitialized(projectName, projectRootDir);

  const { task } = await resolveActivePhaseTaskForNumber(control, taskNumber);
  if (task.status !== "FAILED") {
    throw new ValidationError(
      `Task #${taskNumber} is not in FAILED status (current: ${task.status}).`,
      {
        hint: "Only failed tasks can be retried.",
      },
    );
  }
  if (task.assignee === "UNASSIGNED") {
    throw new ValidationError(`Task #${taskNumber} has no assignee.`, {
      hint: `Reset to TODO with 'ixado task reset ${taskNumber}', assign an agent, then start it again.`,
    });
  }

  const assignee = CLIAdapterIdSchema.parse(task.assignee);
  const availableAgents = getAvailableAgents(settings);
  if (!availableAgents.includes(assignee)) {
    throw new ValidationError(`Agent '${assignee}' is disabled.`, {
      hint: `Available agents: ${availableAgents.join(", ")}. Enable the agent with 'ixado onboard'.`,
    });
  }

  console.info(`Retrying active-phase task #${taskNumber} with ${assignee}.`);
  const state = await control.startActiveTaskAndWait({
    taskNumber,
    assignee,
  });

  const phase =
    state.phases.find((candidate) => candidate.id === state.activePhaseId) ??
    state.phases[0];
  if (!phase) {
    throw new Error("No phase available after task retry.");
  }
  const retriedTask = phase.tasks[taskNumber - 1];
  if (!retriedTask) {
    throw new Error(`Task #${taskNumber} not found after retry.`);
  }

  console.info(
    `Task #${taskNumber} ${retriedTask.title} finished with status ${retriedTask.status}.`,
  );
  if (retriedTask.status === "FAILED") {
    if (retriedTask.errorLogs) {
      console.info(`Failure details: ${retriedTask.errorLogs}`);
    }
    console.info(
      `Next:    Retry again with 'ixado task retry ${taskNumber}' or reset with 'ixado task reset ${taskNumber}'.`,
    );
  } else {
    console.info(
      `Next:    Run 'ixado task list' to see all tasks or 'ixado phase run' to continue.`,
    );
  }
}

async function runTaskLogsCommand({
  args,
}: CommandActionContext): Promise<void> {
  const rawTaskNumber = args[0]?.trim() ?? "";
  const taskNumber = Number(rawTaskNumber);
  if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
    throw new ValidationError(
      `Invalid task number${rawTaskNumber ? `: '${rawTaskNumber}'` : ""}. Expected a positive integer.`,
      {
        usage: "ixado task logs <taskNumber>",
        hint: "Run 'ixado task list' to see available task numbers.",
      },
    );
  }

  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const projectRootDir = await resolveProjectRootDir();
  const projectName = await resolveProjectName();
  const stateFilePath = await resolveProjectAwareStateFilePath();
  const control = createControlCenterService(
    stateFilePath,
    projectRootDir,
    settings,
    projectName,
  );
  await control.ensureInitialized(projectName, projectRootDir);
  const { phase, task } = await resolveActivePhaseTaskForNumber(
    control,
    taskNumber,
  );

  console.info(`Task #${taskNumber}: ${task.title} [${task.status}]`);
  const contextLabel = formatPhaseTaskContext({
    phaseId: phase.id,
    phaseName: phase.name,
    taskId: task.id,
    taskTitle: task.title,
    taskNumber,
  });
  if (contextLabel) {
    console.info(`Context: ${contextLabel}`);
  }

  if (task.status === "FAILED") {
    console.info(`Failure summary: ${summarizeFailure(task.errorLogs)}`);
    const recoveryLinks = buildRecoveryTraceLinks({
      context: {
        phaseId: phase.id,
        taskId: task.id,
      },
      attempts: task.recoveryAttempts,
    });
    if (recoveryLinks.length > 0) {
      console.info(
        `Recovery traces: ${recoveryLinks.map((link) => `${link.label}=${link.href}`).join(" | ")}`,
      );
    }
    console.info(task.errorLogs ?? "No failure logs recorded.");
    return;
  }
  if (task.status === "DONE") {
    console.info(task.resultContext ?? "No result context recorded.");
    return;
  }

  console.info("Task has no terminal logs yet.");
}

async function runTaskResetCommand({
  args,
}: CommandActionContext): Promise<void> {
  const rawTaskNumber = args[0]?.trim() ?? "";
  const taskNumber = Number(rawTaskNumber);
  if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
    throw new ValidationError(
      `Invalid task number${rawTaskNumber ? `: '${rawTaskNumber}'` : ""}. Expected a positive integer.`,
      {
        usage: "ixado task reset <taskNumber>",
        hint: "Run 'ixado task list' to see available task numbers.",
      },
    );
  }

  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const projectRootDir = await resolveProjectRootDir();
  const projectName = await resolveProjectName();
  const stateFilePath = await resolveProjectAwareStateFilePath();
  const control = createControlCenterService(
    stateFilePath,
    projectRootDir,
    settings,
    projectName,
  );
  await control.ensureInitialized(projectName, projectRootDir);
  const { phase, task } = await resolveActivePhaseTaskForNumber(
    control,
    taskNumber,
  );

  if (task.status !== "FAILED") {
    throw new ValidationError(
      `Task #${taskNumber} is not in FAILED status (current: ${task.status}).`,
      {
        hint: "Only failed tasks can be reset.",
      },
    );
  }

  await control.resetTaskToTodo({
    phaseId: phase.id,
    taskId: task.id,
  });
  console.info(
    `Task #${taskNumber} reset to TODO and repository hard-reset to last commit.`,
  );
  console.info(
    `Next:    Run 'ixado task start ${taskNumber}' to start it, or 'ixado phase run' to run all TODO tasks.`,
  );
}

async function runPhaseRunCommand({
  args,
}: CommandActionContext): Promise<void> {
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const policy = await loadAuthPolicy(settingsFilePath);
  const projectRootDir = await resolveProjectRootDir();
  const projectName = await resolveProjectName();
  const stateFilePath = await resolveProjectAwareStateFilePath();
  const { control, agents } = createServices(
    stateFilePath,
    projectRootDir,
    settings,
    projectName,
  );
  await control.ensureInitialized(projectName, projectRootDir);
  const projectExecutionSettings = resolveProjectExecutionSettings(
    settings,
    projectName,
  );

  // Reconcile stale RUNNING agents left over from a prior process crash so that
  // the agent registry does not show phantom RUNNING entries.
  const reconciledAgents = agents.reconcileStaleRunningAgents();
  if (reconciledAgents > 0) {
    console.info(
      `Startup: reconciled ${reconciledAgents} stale RUNNING agent(s) to STOPPED after process restart.`,
    );
  }

  const mode = resolvePhaseRunMode(args[0], projectExecutionSettings.autoMode);
  const countdownSeconds = resolveCountdownSeconds(
    args[1],
    settings.executionLoop.countdownSeconds,
  );
  const loopControl = new PhaseLoopControl();
  const activeAssignee = projectExecutionSettings.defaultAssignee;
  const telegram = resolveTelegramConfig(settings.telegram);

  let telegramRuntime: ReturnType<typeof createTelegramRuntime> | undefined;
  const notifyTelegramEvent = createTelegramNotificationEvaluator({
    level: settings.telegram.notifications.level,
    suppressDuplicates: settings.telegram.notifications.suppressDuplicates,
  });
  if (telegram.enabled) {
    telegramRuntime = createTelegramRuntime({
      token: telegram.token,
      ownerId: telegram.ownerId,
      readState: () => control.getState(),
      listAgents: () => [],
      availableAssignees: getAvailableAgents(settings),
      defaultAssignee: activeAssignee,
      startTask: async (input) =>
        control.startActiveTaskAndWait({
          taskNumber: input.taskNumber,
          assignee: input.assignee,
        }),
      setActivePhase: async (input) =>
        control.setActivePhase({
          phaseId: input.phaseId,
        }),
      requestNextLoop: () =>
        loopControl.requestNext()
          ? "Execution loop advance requested."
          : "Execution loop is already stopped.",
      requestStopLoop: () => {
        loopControl.requestStop();
        return "Execution loop stop requested.";
      },
    });
    await telegramRuntime.start();
    console.info("Telegram loop controls enabled: /next and /stop.");
  }

  const runner = new PhaseRunner(
    control,
    {
      mode,
      countdownSeconds,
      activeAssignee,
      maxRecoveryAttempts: settings.exceptionRecovery.maxAttempts,
      testerCommand: settings.executionLoop.testerCommand,
      testerArgs: settings.executionLoop.testerArgs,
      testerTimeoutMs: settings.executionLoop.testerTimeoutMs,
      ciEnabled: settings.executionLoop.ciEnabled,
      ciBaseBranch: settings.executionLoop.ciBaseBranch,
      ciPullRequest: settings.executionLoop.pullRequest,
      validationMaxRetries: settings.executionLoop.validationMaxRetries,
      ciFixMaxFanOut: settings.executionLoop.ciFixMaxFanOut,
      ciFixMaxDepth: settings.executionLoop.ciFixMaxDepth,
      projectRootDir,
      projectName,
      policy,
      role: "admin",
    },
    loopControl,
    async (event) => {
      console.info(`[runtime] ${formatRuntimeEventForCli(event)}`);
      if (telegramRuntime && notifyTelegramEvent(event)) {
        await telegramRuntime.notifyOwner(formatRuntimeEventForTelegram(event));
      }
    },
  );

  const runLock = new ExecutionRunLock({
    projectRootDir,
    projectName,
    owner: "CLI_PHASE_RUN",
  });
  await runLock.acquire();

  try {
    await runner.run();
  } finally {
    await runLock.release();
    telegramRuntime?.stop();
  }
}

async function runPhaseActiveCommand({
  args,
}: CommandActionContext): Promise<void> {
  const phaseId = args[0]?.trim() ?? "";
  if (!phaseId) {
    throw new ValidationError(
      "Missing required argument: <phaseNumber|phaseId>.",
      {
        usage: "ixado phase active <phaseNumber|phaseId>",
        hint: "Run 'ixado phase list' to see available phases.",
      },
    );
  }

  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const projectRootDir = await resolveProjectRootDir();
  const projectName = await resolveProjectName();
  const stateFilePath = await resolveProjectAwareStateFilePath();
  const control = createControlCenterService(
    stateFilePath,
    projectRootDir,
    settings,
    projectName,
  );
  await control.ensureInitialized(projectName, projectRootDir);
  const state = await control.setActivePhase({ phaseId });
  const active = state.phases.find((phase) => phase.id === state.activePhaseId);
  if (!active) {
    throw new Error(`Active phase not found after update: ${phaseId}`);
  }

  console.info(`Active phase set to ${active.name} (${active.id}).`);
  console.info(`Status:  ${active.status} — ${active.tasks.length} task(s)`);
  console.info(
    `Next:    Run 'ixado task list' to review tasks or 'ixado phase run' to start execution.`,
  );
}

async function runPhaseCreateCommand({
  args,
}: CommandActionContext): Promise<void> {
  const name = args[0]?.trim() ?? "";
  const branchName = args[1]?.trim() ?? "";
  if (!name || !branchName) {
    throw new ValidationError(
      "Missing required arguments: <name> and <branchName>.",
      {
        usage: "ixado phase create <name> <branchName>",
        hint: "Provide a human-readable name and a valid git branch name.",
      },
    );
  }

  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const projectRootDir = await resolveProjectRootDir();
  const projectName = await resolveProjectName();
  const stateFilePath = await resolveProjectAwareStateFilePath();
  const control = createControlCenterService(
    stateFilePath,
    projectRootDir,
    settings,
    projectName,
  );
  await control.ensureInitialized(projectName, projectRootDir);
  const nextState = await control.createPhase({
    name,
    branchName,
  });
  const createdPhase = nextState.phases[nextState.phases.length - 1];
  if (!createdPhase) {
    throw new Error("Phase creation failed.");
  }

  console.info(`Created phase ${createdPhase.name} (${createdPhase.id}).`);
  console.info(
    `Status:  ${createdPhase.status} — branch: ${branchName}, ${createdPhase.tasks.length} task(s)`,
  );
  console.info(
    `Next:    Add tasks with 'ixado task create <title> <description>', then run 'ixado phase run'.`,
  );
}

function resolveAssignedTaskLabel(
  agent: AgentView,
  state: Awaited<ReturnType<ControlCenterService["getState"]>>,
): string {
  const taskId = agent.taskId?.trim();
  if (!taskId) {
    return "unassigned";
  }

  for (const phase of state.phases) {
    const task = phase.tasks.find((candidate) => candidate.id === taskId);
    if (task) {
      return `${phase.name}: ${task.title}`;
    }
  }

  return taskId;
}

function resolveAgentRuntimeSummary(agent: AgentView): string | undefined {
  const diagnostic = resolveLatestAgentRuntimeDiagnostic(agent.outputTail);
  if (!diagnostic) {
    return undefined;
  }

  return summarizeAgentRuntimeDiagnostic(diagnostic);
}

async function runStatusCommand(): Promise<void> {
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const projectRootDir = await resolveProjectRootDir();
  const projectName = await resolveProjectName();
  const stateFilePath = await resolveProjectAwareStateFilePath();
  const { control, agents } = createServices(
    stateFilePath,
    projectRootDir,
    settings,
    projectName,
  );
  await control.ensureInitialized(projectName, projectRootDir);
  const state = await control.getState();
  const activePhase = state.phases.find(
    (phase) => phase.id === state.activePhaseId,
  );
  const runningAgents = agents
    .list()
    .filter((agent) => agent.status === "RUNNING");
  const availableAgents = getAvailableAgents(settings);

  console.info(`Project: ${state.projectName}`);
  console.info(`Root: ${state.rootDir}`);
  console.info(`Phases: ${state.phases.length}`);
  if (activePhase?.status === "CI_FAILED") {
    const kindLabel = resolvePhaseFailureKindLabel(activePhase.failureKind);
    console.info(
      `Active: ${activePhase.name} (${activePhase.status} — ${kindLabel})`,
    );
    console.info(
      `Guidance: ${resolvePhaseFailureGuidance(activePhase.failureKind)}`,
    );
  } else {
    console.info(
      `Active: ${activePhase ? `${activePhase.name} (${activePhase.status})` : "none"}`,
    );
  }
  console.info(`Available agents: ${availableAgents.join(", ")}`);
  console.info(`Running Agents (${runningAgents.length}):`);
  if (runningAgents.length === 0) {
    console.info("none");
    return;
  }

  for (const [index, agent] of runningAgents.entries()) {
    const runtimeSummary = resolveAgentRuntimeSummary(agent);
    console.info(
      `${index + 1}. ${agent.name} -> ${resolveAssignedTaskLabel(agent, state)}${runtimeSummary ? ` | ${runtimeSummary}` : ""}`,
    );
  }
}

function parseConfigMode(rawMode: string): boolean {
  const normalized = rawMode.trim().toLowerCase();
  if (normalized === "auto") {
    return true;
  }
  if (normalized === "manual") {
    return false;
  }

  throw new ValidationError(
    `Invalid mode: '${rawMode}'. Expected 'auto' or 'manual'.`,
    {
      usage: "ixado config mode <auto|manual>",
      hint: "Use 'auto' for automatic execution or 'manual' for step-by-step.",
    },
  );
}

function parseConfigToggle(
  rawValue: string,
  usage: string,
  hint: string,
): boolean {
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "on") {
    return true;
  }
  if (normalized === "off") {
    return false;
  }

  throw new ValidationError(
    `Invalid toggle value: '${rawValue}'. Expected 'on' or 'off'.`,
    { usage, hint },
  );
}

function parseConfigRecoveryMaxAttempts(rawValue: string): number {
  const maxAttempts = Number(rawValue.trim());
  if (!Number.isInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > 10) {
    throw new ValidationError(
      `Invalid recovery max attempts: '${rawValue}'. Expected an integer from 0 to 10.`,
      {
        usage: "ixado config recovery <maxAttempts:0-10>",
        hint: "Use 0 to disable recovery, or a value from 1-10 for the attempt limit.",
      },
    );
  }

  return maxAttempts;
}

function getSettingsPrecedenceMessage(settingsFilePath: string): string {
  return `Scope: global defaults (${settingsFilePath}).`;
}

async function runConfigShowCommand(_ctx: CommandActionContext): Promise<void> {
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const projectName = await resolveProjectName();
  const projectExecutionSettings = resolveProjectExecutionSettings(
    settings,
    projectName,
  );
  console.info(`Settings file: ${settingsFilePath}`);
  console.info(getSettingsPrecedenceMessage(settingsFilePath));
  console.info(
    `Execution loop mode: ${projectExecutionSettings.autoMode ? "AUTO" : "MANUAL"}`,
  );
  console.info(
    `Default coding CLI: ${projectExecutionSettings.defaultAssignee}`,
  );
  console.info(
    `Exception recovery max attempts: ${settings.exceptionRecovery.maxAttempts}`,
  );
  console.info(
    `Codexbar usage telemetry: ${settings.usage.codexbarEnabled ? "ON" : "OFF"}`,
  );
}

async function runConfigModeCommand({
  args,
}: CommandActionContext): Promise<void> {
  const rawMode = args[0]?.trim() ?? "";
  if (!rawMode) {
    throw new ValidationError("Missing required argument: <auto|manual>.", {
      usage: "ixado config mode <auto|manual>",
      hint: "Use 'auto' for automatic execution or 'manual' for step-by-step.",
    });
  }

  const autoMode = parseConfigMode(rawMode);
  const settingsFilePath = resolveGlobalSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const targetProjectIndex = resolveConfigTargetProjectIndex(settings);
  const projects = settings.projects.map((project, index) =>
    index !== targetProjectIndex
      ? project
      : {
          ...project,
          executionSettings: {
            autoMode,
            defaultAssignee:
              project.executionSettings?.defaultAssignee ??
              settings.internalWork.assignee,
          },
        },
  );
  const saved = await saveCliSettings(settingsFilePath, {
    ...settings,
    executionLoop: {
      ...settings.executionLoop,
      autoMode,
    },
    projects,
  });
  const resolvedMode =
    targetProjectIndex === undefined
      ? saved.executionLoop.autoMode
      : (saved.projects[targetProjectIndex]?.executionSettings?.autoMode ??
        saved.executionLoop.autoMode);
  console.info(
    `Execution loop mode set to ${resolvedMode ? "AUTO" : "MANUAL"}.`,
  );
  console.info(`Settings saved to ${settingsFilePath}.`);
  console.info(getSettingsPrecedenceMessage(settingsFilePath));
  console.info(`Next:    Run 'ixado phase run' to apply the new mode.`);
}

async function runConfigAssigneeCommand({
  args,
}: CommandActionContext): Promise<void> {
  const rawAssignee = args[0]?.trim() ?? "";
  if (!rawAssignee) {
    throw new ValidationError(
      "Missing required argument: <CODEX_CLI|CLAUDE_CLI|GEMINI_CLI|MOCK_CLI>.",
      {
        usage:
          "ixado config assignee <CODEX_CLI|CLAUDE_CLI|GEMINI_CLI|MOCK_CLI>",
        hint: "Run 'ixado config' to see available adapters.",
      },
    );
  }

  const parsedAssignee = CLIAdapterIdSchema.safeParse(rawAssignee);
  if (!parsedAssignee.success) {
    throw new ValidationError(`Invalid assignee: '${rawAssignee}'.`, {
      usage: "ixado config assignee <CODEX_CLI|CLAUDE_CLI|GEMINI_CLI|MOCK_CLI>",
      hint: "Valid values: CODEX_CLI, CLAUDE_CLI, GEMINI_CLI, MOCK_CLI.",
    });
  }
  const assignee = parsedAssignee.data;
  const settingsFilePath = resolveGlobalSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  if (!settings.agents[assignee].enabled) {
    throw new ValidationError(`Agent '${assignee}' is disabled.`, {
      hint: "Enable the agent in settings before setting it as default.",
    });
  }

  const targetProjectIndex = resolveConfigTargetProjectIndex(settings);
  const projects = settings.projects.map((project, index) =>
    index !== targetProjectIndex
      ? project
      : {
          ...project,
          executionSettings: {
            autoMode:
              project.executionSettings?.autoMode ??
              settings.executionLoop.autoMode,
            defaultAssignee: assignee,
          },
        },
  );
  const saved = await saveCliSettings(settingsFilePath, {
    ...settings,
    internalWork: {
      ...settings.internalWork,
      assignee,
    },
    projects,
  });
  console.info(`Default coding CLI set to ${assignee}.`);
  console.info(`Settings saved to ${settingsFilePath}.`);
  console.info(getSettingsPrecedenceMessage(settingsFilePath));
  console.info(
    `Next:    Run 'ixado phase run' or 'ixado task start <n>' to use the new default.`,
  );
}

async function runConfigUsageCommand({
  args,
}: CommandActionContext): Promise<void> {
  const rawValue = args[0]?.trim() ?? "";
  if (!rawValue) {
    throw new ValidationError("Missing required argument: <on|off>.", {
      usage: "ixado config usage <on|off>",
      hint: "Use 'on' to enable usage tracking or 'off' to disable it.",
    });
  }

  const codexbarEnabled = parseConfigToggle(
    rawValue,
    "ixado config usage <on|off>",
    "Use 'on' to enable usage tracking or 'off' to disable it.",
  );
  const settingsFilePath = resolveGlobalSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const saved = await saveCliSettings(settingsFilePath, {
    ...settings,
    usage: {
      ...settings.usage,
      codexbarEnabled,
    },
  });

  console.info(
    `Codexbar usage telemetry set to ${saved.usage.codexbarEnabled ? "ON" : "OFF"}.`,
  );
  console.info(`Settings saved to ${settingsFilePath}.`);
  console.info(getSettingsPrecedenceMessage(settingsFilePath));
  console.info(
    `Next:    Usage data will ${saved.usage.codexbarEnabled ? "be collected" : "not be collected"} on next run.`,
  );
}

async function runConfigRecoveryCommand({
  args,
}: CommandActionContext): Promise<void> {
  const rawValue = args[0]?.trim() ?? "";
  if (!rawValue) {
    throw new ValidationError(
      "Missing required argument: <maxAttempts:0-10>.",
      {
        usage: "ixado config recovery <maxAttempts:0-10>",
        hint: "Use 0 to disable recovery, or a value from 1-10 for the attempt limit.",
      },
    );
  }

  const maxAttempts = parseConfigRecoveryMaxAttempts(rawValue);
  const settingsFilePath = resolveGlobalSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const saved = await saveCliSettings(settingsFilePath, {
    ...settings,
    exceptionRecovery: {
      ...settings.exceptionRecovery,
      maxAttempts,
    },
  });

  console.info(
    `Exception recovery max attempts set to ${saved.exceptionRecovery.maxAttempts}.`,
  );
  console.info(`Settings saved to ${settingsFilePath}.`);
  console.info(getSettingsPrecedenceMessage(settingsFilePath));
  console.info(
    `Next:    Run 'ixado phase run' to apply the updated recovery limit.`,
  );
}

async function runCli(args: string[]): Promise<void> {
  if (process.env.IXADO_WEB_DAEMON_MODE?.trim() === "1") {
    await runWebServeCommand({ args: [], fullArgs: [] });
    return;
  }

  const registry = new CommandRegistry([
    {
      name: "",
      description: "Run IxADO with stored settings",
      action: async () => runDefaultCommand(),
    },
    {
      name: "status",
      description: "Show project status and running agents",
      action: runStatusCommand,
    },
    {
      name: "init",
      description: "Register current directory as project in global config",
      action: runInitCommand,
    },
    {
      name: "list",
      description: "Show all registered projects",
      action: runListCommand,
    },
    {
      name: "switch",
      description: "Switch active project context",
      usage: "switch <project-name>",
      action: runSwitchCommand,
    },
    {
      name: "onboard",
      description: "Configure global CLI settings",
      action: runOnboardCommand,
    },
    {
      name: "task",
      description: "Manage tasks",
      subcommands: [
        {
          name: "list",
          description: "List tasks in active phase with numbers",
          action: runTaskListCommand,
        },
        {
          name: "create",
          description: "Create task in active phase",
          usage: "create <title> <description> [assignee]",
          action: runTaskCreateCommand,
        },
        {
          name: "start",
          description: "Start active-phase task",
          usage: "start <taskNumber> [assignee]",
          action: runTaskStartCommand,
        },
        {
          name: "retry",
          description: "Retry FAILED task with same assignee/session",
          usage: "retry <taskNumber>",
          action: runTaskRetryCommand,
        },
        {
          name: "logs",
          description: "Show logs/result for task in active phase",
          usage: "logs <taskNumber>",
          action: runTaskLogsCommand,
        },
        {
          name: "reset",
          description: "Reset FAILED task to TODO and hard-reset repo",
          usage: "reset <taskNumber>",
          action: runTaskResetCommand,
        },
      ],
    },
    {
      name: "phase",
      description: "Manage phases",
      subcommands: [
        {
          name: "create",
          description: "Create phase and set it active",
          usage: "create <name> <branchName>",
          action: runPhaseCreateCommand,
        },
        {
          name: "active",
          description: "Set active phase",
          usage: "active <phaseNumber|phaseId>",
          action: runPhaseActiveCommand,
        },
        {
          name: "run",
          description: "Run TODO/CI_FIX tasks in active phase sequentially",
          usage: "run [auto|manual] [countdownSeconds>=0]",
          action: runPhaseRunCommand,
        },
      ],
    },
    {
      name: "config",
      description: "Manage configuration",
      usage: "config",
      action: runConfigShowCommand,
      subcommands: [
        {
          name: "show",
          description: "Show current global config",
          action: runConfigShowCommand,
        },
        {
          name: "mode",
          description: "Set default phase-loop mode",
          usage: "mode <auto|manual>",
          action: runConfigModeCommand,
        },
        {
          name: "assignee",
          description: "Set default coding CLI",
          usage: "assignee <CLI_ADAPTER>",
          action: runConfigAssigneeCommand,
        },
        {
          name: "recovery",
          description: "Set exception recovery max attempts",
          usage: "recovery <maxAttempts:0-10>",
          action: runConfigRecoveryCommand,
        },
        {
          name: "usage",
          description: "Enable/disable codexbar usage telemetry",
          usage: "usage <on|off>",
          action: runConfigUsageCommand,
        },
      ],
    },
    {
      name: "web",
      description: "Manage web control center",
      subcommands: [
        {
          name: "start",
          description: "Start local web control center in background",
          usage: "start [port]",
          action: runWebStartCommand,
        },
        {
          name: "stop",
          description: "Stop local web control center",
          action: runWebStopCommand,
        },
      ],
    },
  ]);

  await registry.run(args);
}

await runCli(process.argv.slice(2)).catch((error) => {
  if (error instanceof ValidationError) {
    console.error(error.format());
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
  }
  process.exitCode = 1;
});
