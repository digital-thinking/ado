import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { resolve, basename } from "node:path";

import { createPromptLogArtifacts, writeOutputLog } from "../agent-logs";
import { resolveAgentRegistryFilePath } from "../agent-registry";
import { buildAdapterExecutionPlan, createAdapter } from "../adapters";
import { createTelegramRuntime } from "../bot";
import { PhaseLoopControl } from "../engine/phase-loop-control";
import { PhaseRunner } from "../engine/phase-runner";
import { ProcessManager } from "../process";
import { StateEngine } from "../state";
import {
  CLIAdapterIdSchema,
  WorkerAssigneeSchema,
  type CLIAdapterId,
} from "../types";
import { AgentSupervisor, ControlCenterService, type AgentView } from "../web";
import { loadAuthPolicy } from "../security/policy-loader";
import { initializeCliLogging } from "./logging";
import { CommandRegistry, type CommandActionContext } from "./command-registry";
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
  return new ControlCenterService(
    new StateEngine(stateFilePath),
    resolve(projectRootDir, "TASKS.md"),
    async (workInput) => {
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
    async () => {
      await processManager.run({
        command: "git",
        args: ["reset", "--hard"],
        cwd: projectRootDir,
      });
    },
  );
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
      defaultAssignee: settings.internalWork.assignee,
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
    throw new Error("Usage: ixado switch <project-name>");
  }

  const globalSettingsFilePath = resolveGlobalSettingsFilePath();
  const settings = await loadCliSettings(globalSettingsFilePath);
  const project = settings.projects.find((p) => p.name === projectName);
  if (!project) {
    const available = settings.projects.map((p) => p.name).join(", ");
    throw new Error(
      `Project '${projectName}' not found. Registered projects: ${available || "none"}.`,
    );
  }

  settings.activeProject = project.name;
  await saveCliSettings(globalSettingsFilePath, settings);
  console.info(
    `Switched active project to '${project.name}' at ${project.rootDir}.`,
  );
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
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const projectRootDir = await resolveProjectRootDir();
  const projectName = await resolveProjectName();
  const stateFilePath = await resolveProjectAwareStateFilePath();
  const portFromArgs = parseWebPort(args[0]);
  const portFromEnv = parseWebPort(process.env.IXADO_WEB_PORT?.trim());
  const port = portFromArgs ?? portFromEnv;

  const runtime = await startWebDaemon({
    cwd: projectRootDir,
    stateFilePath,
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
    `Internal work default adapter: ${settings.internalWork.assignee}.`,
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
    return;
  }

  if (result.status === "permission_denied") {
    console.info(
      `Web control center is running at ${result.record.url} (pid: ${result.record.pid}), but this user cannot stop it (permission denied).`,
    );
    return;
  }

  if (result.reason === "stale_runtime_file") {
    console.info(
      "Web control center was not running. Removed stale runtime metadata.",
    );
    return;
  }

  console.info("Web control center is not running.");
}

async function runWebServeCommand({
  args,
}: CommandActionContext): Promise<void> {
  const projectRootDir = await resolveProjectRootDir();
  const projectName = await resolveProjectName();
  const stateFilePath = await resolveProjectAwareStateFilePath();
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const portFromArgs = parseWebPort(args[0]);
  const portFromEnv = parseWebPort(process.env.IXADO_WEB_PORT?.trim());
  const port = portFromArgs ?? portFromEnv;

  const runtime = await serveWebControlCenter({
    cwd: projectRootDir,
    stateFilePath,
    settingsFilePath,
    projectName,
    defaultInternalWorkAssignee: settings.internalWork.assignee,
    defaultAutoMode: settings.executionLoop.autoMode,
    agentSettings: settings.agents,
    port,
  });

  console.info(
    `Web control center started at ${runtime.url} (pid: ${runtime.pid}).`,
  );
  console.info(`Web logs: ${runtime.logFilePath}`);
  console.info(`CLI logs: ${CLI_LOG_FILE_PATH}`);
}

type PhaseRunMode = "AUTO" | "MANUAL";

function resolveActivePhaseFromState(
  state: Awaited<ReturnType<ControlCenterService["getState"]>>,
): Awaited<ReturnType<ControlCenterService["getState"]>>["phases"][number] {
  const phase =
    state.phases.find((candidate) => candidate.id === state.activePhaseId) ??
    state.phases[0];
  if (!phase) {
    throw new Error("No active phase found.");
  }

  return phase;
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

  throw new Error("Usage: ixado phase run [auto|manual] [countdownSeconds>=0]");
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
    throw new Error(
      "Usage: ixado phase run [auto|manual] [countdownSeconds>=0]",
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
    throw new Error("No active phase found.");
  }

  const task = phase.tasks[taskNumber - 1];
  if (!task) {
    throw new Error(
      `Task #${taskNumber} not found in active phase ${phase.name}.`,
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
    throw new Error("Usage: ixado task start <taskNumber> [assignee]");
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
  let assigneeCandidate = explicitAssignee || settings.internalWork.assignee;
  if (!explicitAssignee) {
    const { task } = await resolveActivePhaseTaskForNumber(control, taskNumber);
    if (task.status === "FAILED" && task.assignee !== "UNASSIGNED") {
      assigneeCandidate = task.assignee;
    }
  }

  const assignee = CLIAdapterIdSchema.parse(assigneeCandidate);
  const availableAgents = getAvailableAgents(settings);
  if (!availableAgents.includes(assignee)) {
    throw new Error(
      `Agent '${assignee}' is disabled. Available agents: ${availableAgents.join(", ")}.`,
    );
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
  if (task.status === "FAILED" && task.errorLogs) {
    console.info(`Failure details: ${task.errorLogs}`);
  }
}

async function runTaskCreateCommand({
  args,
}: CommandActionContext): Promise<void> {
  const title = args[0]?.trim() ?? "";
  const description = args[1]?.trim() ?? "";
  if (!title || !description) {
    throw new Error(
      "Usage: ixado task create <title> <description> [assignee]",
    );
  }

  const rawAssignee = args[2]?.trim();
  const parsedAssignee = rawAssignee
    ? WorkerAssigneeSchema.safeParse(rawAssignee)
    : { success: true as const, data: "UNASSIGNED" as const };
  if (!parsedAssignee.success) {
    throw new Error(
      "Usage: ixado task create <title> <description> [assignee]\nassignee must be one of: MOCK_CLI, CLAUDE_CLI, GEMINI_CLI, CODEX_CLI, UNASSIGNED",
    );
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
  console.info(
    `Created task #${refreshedPhase.tasks.length} in ${refreshedPhase.name}: ${title}.`,
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
    throw new Error("Usage: ixado task retry <taskNumber>");
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
    throw new Error(
      `Task #${taskNumber} must be FAILED before retry. Current status: ${task.status}.`,
    );
  }
  if (task.assignee === "UNASSIGNED") {
    throw new Error(
      `Task #${taskNumber} has no retry assignee. Reset to TODO, assign an agent, and start it again.`,
    );
  }

  const assignee = CLIAdapterIdSchema.parse(task.assignee);
  const availableAgents = getAvailableAgents(settings);
  if (!availableAgents.includes(assignee)) {
    throw new Error(
      `Agent '${assignee}' is disabled. Available agents: ${availableAgents.join(", ")}.`,
    );
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
  if (retriedTask.status === "FAILED" && retriedTask.errorLogs) {
    console.info(`Failure details: ${retriedTask.errorLogs}`);
  }
}

async function runTaskLogsCommand({
  args,
}: CommandActionContext): Promise<void> {
  const rawTaskNumber = args[0]?.trim() ?? "";
  const taskNumber = Number(rawTaskNumber);
  if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
    throw new Error("Usage: ixado task logs <taskNumber>");
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

  console.info(`Task #${taskNumber}: ${task.title} [${task.status}]`);
  if (task.status === "FAILED") {
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
    throw new Error("Usage: ixado task reset <taskNumber>");
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
    throw new Error(
      `Task #${taskNumber} must be FAILED before reset. Current status: ${task.status}.`,
    );
  }

  await control.resetTaskToTodo({
    phaseId: phase.id,
    taskId: task.id,
  });
  console.info(
    `Task #${taskNumber} reset to TODO and repository hard-reset to last commit.`,
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
  const control = createControlCenterService(
    stateFilePath,
    projectRootDir,
    settings,
    projectName,
  );
  await control.ensureInitialized(projectName, projectRootDir);

  const mode = resolvePhaseRunMode(args[0], settings.executionLoop.autoMode);
  const countdownSeconds = resolveCountdownSeconds(
    args[1],
    settings.executionLoop.countdownSeconds,
  );
  const loopControl = new PhaseLoopControl();
  const activeAssignee = settings.internalWork.assignee;
  const telegram = resolveTelegramConfig(settings.telegram);

  let telegramRuntime: ReturnType<typeof createTelegramRuntime> | undefined;
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
      validationMaxRetries: settings.executionLoop.validationMaxRetries,
      projectRootDir,
      projectName,
      policy,
      role: "admin",
    },
    loopControl,
    async (message) => {
      if (telegramRuntime) {
        await telegramRuntime.notifyOwner(message);
      }
    },
  );

  try {
    await runner.run();
  } finally {
    telegramRuntime?.stop();
  }
}

async function runPhaseActiveCommand({
  args,
}: CommandActionContext): Promise<void> {
  const phaseId = args[0]?.trim() ?? "";
  if (!phaseId) {
    throw new Error("Usage: ixado phase active <phaseNumber|phaseId>");
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
}

async function runPhaseCreateCommand({
  args,
}: CommandActionContext): Promise<void> {
  const name = args[0]?.trim() ?? "";
  const branchName = args[1]?.trim() ?? "";
  if (!name || !branchName) {
    throw new Error("Usage: ixado phase create <name> <branchName>");
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
  console.info(
    `Active: ${activePhase ? `${activePhase.name} (${activePhase.status})` : "none"}`,
  );
  console.info(`Available agents: ${availableAgents.join(", ")}`);
  console.info(`Running Agents (${runningAgents.length}):`);
  if (runningAgents.length === 0) {
    console.info("none");
    return;
  }

  for (const [index, agent] of runningAgents.entries()) {
    console.info(
      `${index + 1}. ${agent.name} -> ${resolveAssignedTaskLabel(agent, state)}`,
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

  throw new Error("Usage: ixado config mode <auto|manual>");
}

function parseConfigToggle(rawValue: string, usage: string): boolean {
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "on") {
    return true;
  }
  if (normalized === "off") {
    return false;
  }

  throw new Error(usage);
}

function parseConfigRecoveryMaxAttempts(rawValue: string): number {
  const maxAttempts = Number(rawValue.trim());
  if (!Number.isInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > 10) {
    throw new Error("Usage: ixado config recovery <maxAttempts:0-10>");
  }

  return maxAttempts;
}

async function runConfigShowCommand(_ctx: CommandActionContext): Promise<void> {
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  console.info(`Settings: ${settingsFilePath}`);
  console.info(
    `Execution loop mode: ${settings.executionLoop.autoMode ? "AUTO" : "MANUAL"}`,
  );
  console.info(`Default coding CLI: ${settings.internalWork.assignee}`);
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
    throw new Error("Usage: ixado config mode <auto|manual>");
  }

  const autoMode = parseConfigMode(rawMode);
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const saved = await saveCliSettings(settingsFilePath, {
    ...settings,
    executionLoop: {
      ...settings.executionLoop,
      autoMode,
    },
  });
  console.info(
    `Execution loop mode set to ${saved.executionLoop.autoMode ? "AUTO" : "MANUAL"}.`,
  );
  console.info(`Settings saved to ${settingsFilePath}.`);
}

async function runConfigAssigneeCommand({
  args,
}: CommandActionContext): Promise<void> {
  const rawAssignee = args[0]?.trim() ?? "";
  if (!rawAssignee) {
    throw new Error(
      "Usage: ixado config assignee <CODEX_CLI|CLAUDE_CLI|GEMINI_CLI|MOCK_CLI>",
    );
  }

  const assignee = CLIAdapterIdSchema.parse(rawAssignee);
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  if (!settings.agents[assignee].enabled) {
    throw new Error(
      `Agent '${assignee}' is disabled. Enable it before setting as default.`,
    );
  }

  const saved = await saveCliSettings(settingsFilePath, {
    ...settings,
    internalWork: {
      ...settings.internalWork,
      assignee,
    },
  });
  console.info(`Default coding CLI set to ${saved.internalWork.assignee}.`);
  console.info(`Settings saved to ${settingsFilePath}.`);
}

async function runConfigUsageCommand({
  args,
}: CommandActionContext): Promise<void> {
  const rawValue = args[0]?.trim() ?? "";
  if (!rawValue) {
    throw new Error("Usage: ixado config usage <on|off>");
  }

  const codexbarEnabled = parseConfigToggle(
    rawValue,
    "Usage: ixado config usage <on|off>",
  );
  const settingsFilePath = resolveSettingsFilePath();
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
}

async function runConfigRecoveryCommand({
  args,
}: CommandActionContext): Promise<void> {
  const rawValue = args[0]?.trim() ?? "";
  if (!rawValue) {
    throw new Error("Usage: ixado config recovery <maxAttempts:0-10>");
  }

  const maxAttempts = parseConfigRecoveryMaxAttempts(rawValue);
  const settingsFilePath = resolveSettingsFilePath();
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
}

async function runCli(args: string[]): Promise<void> {
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
          description: "Show global defaults",
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
        {
          name: "serve",
          description: "Run web control center in foreground",
          usage: "serve [port]",
          action: runWebServeCommand,
        },
      ],
    },
  ]);

  await registry.run(args);
}

await runCli(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Startup failed: ${message}`);
  process.exitCode = 1;
});
