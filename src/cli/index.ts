import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";

import { createPromptLogArtifacts, writeOutputLog } from "../agent-logs";
import { resolveAgentRegistryFilePath } from "../agent-registry";
import { buildAdapterExecutionPlan, createAdapter } from "../adapters";
import { createTelegramRuntime } from "../bot";
import { runCiIntegration } from "../engine/ci-integration";
import { runCiValidationLoop } from "../engine/ci-validation-loop";
import { PhaseLoopControl } from "../engine/phase-loop-control";
import {
  waitForAutoAdvance as waitForAutoAdvanceGate,
  waitForManualAdvance as waitForManualAdvanceGate,
} from "../engine/phase-loop-wait";
import { runTesterWorkflow } from "../engine/tester-workflow";
import { ProcessManager } from "../process";
import { StateEngine } from "../state";
import { CLIAdapterIdSchema } from "../types";
import { GitManager } from "../vcs";
import { AgentSupervisor, ControlCenterService, type AgentView } from "../web";
import { initializeCliLogging } from "./logging";
import {
  getAvailableAgents,
  loadCliSettings,
  resolveSettingsFilePath,
  resolveSoulFilePath,
  runOnboard,
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

async function loadOrInitializeState(engine: StateEngine, stateFilePath: string): Promise<{
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
    projectName: "IxADO",
    rootDir: process.cwd(),
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

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || settings.botToken?.trim();
  const rawOwnerId = process.env.TELEGRAM_OWNER_ID?.trim();
  const ownerIdFromSettings = settings.ownerId;

  if (!token || (!rawOwnerId && ownerIdFromSettings === undefined)) {
    throw new Error(
      "Telegram is enabled in settings, but bot token and owner ID are required (in settings or env)."
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
  settings: Awaited<ReturnType<typeof loadCliSettings>>
): ControlCenterService {
  return createServices(stateFilePath, settings).control;
}

function createControlCenterServiceWithAgentTracking(
  stateFilePath: string,
  processManager: ProcessManager,
  agents: AgentSupervisor,
  settings: Awaited<ReturnType<typeof loadCliSettings>>
): ControlCenterService {
  return new ControlCenterService(
    new StateEngine(stateFilePath),
    resolve(process.cwd(), "TASKS.md"),
    async (workInput) => {
      const availableAgents = getAvailableAgents(settings);
      if (!availableAgents.includes(workInput.assignee)) {
        throw new Error(
          `Agent '${workInput.assignee}' is disabled. Available agents: ${availableAgents.join(", ")}.`
        );
      }

      const assigneeSettings = settings.agents[workInput.assignee];
      const adapter = createAdapter(workInput.assignee, processManager);
      const artifacts = await createPromptLogArtifacts({
        cwd: process.cwd(),
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
          cwd: process.cwd(),
          timeoutMs: assigneeSettings.timeoutMs,
          stdin,
          phaseId: workInput.phaseId,
          taskId: workInput.taskId,
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
            `Adapter '${workInput.assignee}' requires '${adapter.contract.command}' but it is not installed or not on PATH. Install it or select another adapter with 'ixado onboard'.`
          );
        }

        throw new Error(`${message}\nLogs: ${artifacts.outputFilePath}`);
      }
    },
    async () => {
      await processManager.run({
        command: "git",
        args: ["reset", "--hard"],
        cwd: process.cwd(),
      });
    }
  );
}

function createServices(
  stateFilePath: string,
  settings: Awaited<ReturnType<typeof loadCliSettings>>
): {
  control: ControlCenterService;
  agents: AgentSupervisor;
} {
  const processManager = new ProcessManager();
  const agents = new AgentSupervisor({
    registryFilePath: resolveAgentRegistryFilePath(process.cwd()),
  });
  const control = createControlCenterServiceWithAgentTracking(
    stateFilePath,
    processManager,
    agents,
    settings
  );
  return { control, agents };
}

async function runDefaultCommand(): Promise<void> {
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const telegram = resolveTelegramConfig(settings.telegram);
  const stateFilePath = resolveStateFilePath();
  const stateEngine = new StateEngine(stateFilePath);
  const { control, agents } = createServices(stateFilePath, settings);
  const stateSummary = await loadOrInitializeState(stateEngine, stateFilePath);
  const availableAgents = getAvailableAgents(settings);

  console.info("IxADO bootstrap checks passed.");
  console.info(`CLI logs: ${CLI_LOG_FILE_PATH}.`);
  console.info(`Settings loaded from ${settingsFilePath}.`);

  if (telegram.enabled) {
    console.info(
      `Telegram mode enabled (owner: ${telegram.ownerId}, token length: ${telegram.token.length}).`
    );
  } else {
    console.info("Telegram mode disabled. Running in local CLI mode.");
  }

  console.info(
    `State engine ready (${stateSummary.initialized ? "initialized" : "loaded"} at ${stateFilePath}, phases: ${stateSummary.phaseCount}).`
  );
  console.info(`Available agents: ${availableAgents.join(", ")}.`);

  if (telegram.enabled) {
    console.info("Starting Telegram command center.");
    console.info(
      "Bot polling is active. Send /status, /tasks, /starttask <taskNumber> [assignee], /setactivephase <phaseNumber|phaseId>, /next, or /stop. Press Ctrl+C to stop."
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

function printHelp(): void {
  console.info("IxADO CLI");
  console.info("");
  console.info("Usage:");
  console.info("  ixado           Run IxADO with stored settings");
  console.info("  ixado status    Show project status and running agents");
  console.info("  ixado onboard   Configure local CLI settings");
  console.info(
    "  ixado task list  List tasks in active phase with numbers"
  );
  console.info("  ixado task start <taskNumber> [assignee]  Start active-phase task");
  console.info("  ixado task retry <taskNumber>  Retry FAILED task with same assignee/session");
  console.info("  ixado task logs <taskNumber>   Show logs/result for task in active phase");
  console.info("  ixado task reset <taskNumber>  Reset FAILED task to TODO and hard-reset repo");
  console.info("  ixado phase active <phaseNumber|phaseId>  Set active phase");
  console.info(
    "  ixado phase run [auto|manual] [countdownSeconds]  Run TODO tasks in active phase sequentially"
  );
  console.info("  ixado web start [port]   Start local web control center in background");
  console.info("  ixado web stop           Stop local web control center");
  console.info("  ixado help      Show this help");
}

async function runOnboardCommand(): Promise<void> {
  const settingsFilePath = resolveSettingsFilePath();
  const soulFilePath = resolveSoulFilePath();
  const rl = createInterface({
    input: stdin,
    output: stdout,
  });

  try {
    const settings = await runOnboard(
      settingsFilePath,
      soulFilePath,
      (question) => rl.question(question)
    );
    console.info(`CLI logs: ${CLI_LOG_FILE_PATH}.`);
    console.info(`Settings saved to ${settingsFilePath}.`);
    console.info(`SOUL file saved to ${soulFilePath}.`);
    console.info(`Telegram mode ${settings.telegram.enabled ? "enabled" : "disabled"}.`);
    console.info(`Internal work adapter: ${settings.internalWork.assignee}.`);
    console.info(`Available agents: ${getAvailableAgents(settings).join(", ")}.`);
    for (const agentId of getAvailableAgents(settings)) {
      console.info(`  ${agentId} timeout: ${settings.agents[agentId].timeoutMs}ms`);
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

async function runWebStartCommand(args: string[]): Promise<void> {
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const stateFilePath = resolveStateFilePath();
  const portFromArgs = parseWebPort(args[2]);
  const portFromEnv = parseWebPort(process.env.IXADO_WEB_PORT?.trim());
  const port = portFromArgs ?? portFromEnv;

  const runtime = await startWebDaemon({
    cwd: process.cwd(),
    stateFilePath,
    projectName: "IxADO",
    entryScriptPath: resolveCliEntryScriptPath(),
    port,
  });

  console.info(`Web control center started at ${runtime.url} (pid: ${runtime.pid}).`);
  console.info(`Web logs: ${runtime.logFilePath}`);
  console.info(`CLI logs: ${CLI_LOG_FILE_PATH}`);
  console.info(`Internal work default adapter: ${settings.internalWork.assignee}.`);
  console.info("Use `ixado web stop` to stop it.");
}

async function runWebStopCommand(): Promise<void> {
  const result = await stopWebDaemon(process.cwd());
  if (result.status === "stopped") {
    console.info(`Web control center stopped (pid: ${result.record.pid}).`);
    console.info(`Web logs: ${result.record.logFilePath}`);
    console.info(`CLI logs: ${CLI_LOG_FILE_PATH}`);
    return;
  }

  if (result.reason === "stale_runtime_file") {
    console.info("Web control center was not running. Removed stale runtime metadata.");
    return;
  }

  console.info("Web control center is not running.");
}

async function runWebServeCommand(args: string[]): Promise<void> {
  const stateFilePath = resolveStateFilePath();
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const portFromArgs = parseWebPort(args[2]);
  const portFromEnv = parseWebPort(process.env.IXADO_WEB_PORT?.trim());
  const port = portFromArgs ?? portFromEnv;

  const runtime = await serveWebControlCenter({
    cwd: process.cwd(),
    stateFilePath,
    projectName: "IxADO",
    defaultInternalWorkAssignee: settings.internalWork.assignee,
    agentSettings: settings.agents,
    port,
  });

  console.info(`Web control center started at ${runtime.url} (pid: ${runtime.pid}).`);
  console.info(`Web logs: ${runtime.logFilePath}`);
  console.info(`CLI logs: ${CLI_LOG_FILE_PATH}`);
}

async function runWebCommand(args: string[]): Promise<void> {
  const subcommand = args[1];

  if (subcommand === "start") {
    await runWebStartCommand(args);
    return;
  }

  if (subcommand === "stop") {
    await runWebStopCommand();
    return;
  }

  if (subcommand === "serve") {
    await runWebServeCommand(args);
    return;
  }

  throw new Error("Unknown web command. Use `ixado web start [port]` or `ixado web stop`.");
}

type PhaseRunMode = "AUTO" | "MANUAL";

function resolveActivePhaseFromState(
  state: Awaited<ReturnType<ControlCenterService["getState"]>>
): Awaited<ReturnType<ControlCenterService["getState"]>>["phases"][number] {
  const phase = state.phases.find((candidate) => candidate.id === state.activePhaseId) ?? state.phases[0];
  if (!phase) {
    throw new Error("No active phase found.");
  }

  return phase;
}

function resolvePhaseRunMode(rawMode: string | undefined, autoModeDefault: boolean): PhaseRunMode {
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

  throw new Error("Usage: ixado phase run [auto|manual] [countdownSeconds]");
}

function resolveCountdownSeconds(rawCountdown: string | undefined, fallback: number): number {
  const normalized = rawCountdown?.trim();
  if (!normalized) {
    return fallback;
  }

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Usage: ixado phase run [auto|manual] [countdownSeconds]");
  }

  return parsed;
}

async function waitForManualAdvance(
  rl: ReturnType<typeof createInterface>,
  loopControl: PhaseLoopControl,
  nextTaskLabel: string
): Promise<"NEXT" | "STOP"> {
  const abortController = new AbortController();
  return waitForManualAdvanceGate({
    loopControl,
    nextTaskLabel,
    askLocal: async () =>
      rl
        .question("> ", { signal: abortController.signal })
        .then((answer) => (answer.trim().toLowerCase() === "stop" ? "STOP" : "NEXT"))
        .catch((error) => {
          if ((error as { name?: string }).name === "AbortError") {
            return new Promise<"NEXT" | "STOP">(() => {});
          }

          throw error;
        }),
    cancelLocal: () => {
      abortController.abort();
    },
    onInfo: (line) => {
      console.info(line);
    },
  });
}

async function waitForAutoAdvance(
  loopControl: PhaseLoopControl,
  countdownSeconds: number,
  nextTaskLabel: string
): Promise<"NEXT" | "STOP"> {
  return waitForAutoAdvanceGate({
    loopControl,
    countdownSeconds,
    nextTaskLabel,
    onInfo: (line) => {
      console.info(line);
    },
  });
}

async function resolveActivePhaseTaskForNumber(
  control: ControlCenterService,
  taskNumber: number
): Promise<{
  phase: Awaited<ReturnType<ControlCenterService["getState"]>>["phases"][number];
  task: Awaited<ReturnType<ControlCenterService["getState"]>>["phases"][number]["tasks"][number];
}> {
  const state = await control.getState();
  const phase = state.phases.find((candidate) => candidate.id === state.activePhaseId) ?? state.phases[0];
  if (!phase) {
    throw new Error("No active phase found.");
  }

  const task = phase.tasks[taskNumber - 1];
  if (!task) {
    throw new Error(`Task #${taskNumber} not found in active phase ${phase.name}.`);
  }

  return { phase, task };
}

async function runTaskStartCommand(args: string[]): Promise<void> {
  const rawTaskNumber = args[2]?.trim() ?? "";
  const taskNumber = Number(rawTaskNumber);
  if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
    throw new Error("Usage: ixado task start <taskNumber> [assignee]");
  }

  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const stateFilePath = resolveStateFilePath();
  const control = createControlCenterService(stateFilePath, settings);
  await control.ensureInitialized("IxADO", process.cwd());

  const explicitAssignee = args[3]?.trim();
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
    throw new Error(`Agent '${assignee}' is disabled. Available agents: ${availableAgents.join(", ")}.`);
  }
  console.info(`Starting active-phase task #${taskNumber} with ${assignee}.`);

  const state = await control.startActiveTaskAndWait({
    taskNumber,
    assignee,
  });

  const phase = state.phases.find((candidate) => candidate.id === state.activePhaseId) ?? state.phases[0];
  if (!phase) {
    throw new Error("No phase available after task run.");
  }
  const task = phase.tasks[taskNumber - 1];
  if (!task) {
    throw new Error(`Task #${taskNumber} not found after task run.`);
  }

  console.info(`Task #${taskNumber} ${task.title} finished with status ${task.status}.`);
  if (task.status === "FAILED" && task.errorLogs) {
    console.info(`Failure details: ${task.errorLogs}`);
  }
}

async function runTaskListCommand(): Promise<void> {
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const stateFilePath = resolveStateFilePath();
  const control = createControlCenterService(stateFilePath, settings);
  await control.ensureInitialized("IxADO", process.cwd());
  const tasksView = await control.listActivePhaseTasks();
  console.info(`Active phase: ${tasksView.phaseName}`);
  if (tasksView.items.length === 0) {
    console.info("No tasks in active phase.");
    return;
  }

  for (const item of tasksView.items) {
    console.info(`${item.number}. [${item.status}] ${item.title} (${item.assignee})`);
  }
}

async function runTaskRetryCommand(args: string[]): Promise<void> {
  const rawTaskNumber = args[2]?.trim() ?? "";
  const taskNumber = Number(rawTaskNumber);
  if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
    throw new Error("Usage: ixado task retry <taskNumber>");
  }

  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const stateFilePath = resolveStateFilePath();
  const control = createControlCenterService(stateFilePath, settings);
  await control.ensureInitialized("IxADO", process.cwd());

  const { task } = await resolveActivePhaseTaskForNumber(control, taskNumber);
  if (task.status !== "FAILED") {
    throw new Error(`Task #${taskNumber} must be FAILED before retry. Current status: ${task.status}.`);
  }
  if (task.assignee === "UNASSIGNED") {
    throw new Error(
      `Task #${taskNumber} has no retry assignee. Reset to TODO, assign an agent, and start it again.`
    );
  }

  const assignee = CLIAdapterIdSchema.parse(task.assignee);
  const availableAgents = getAvailableAgents(settings);
  if (!availableAgents.includes(assignee)) {
    throw new Error(`Agent '${assignee}' is disabled. Available agents: ${availableAgents.join(", ")}.`);
  }

  console.info(`Retrying active-phase task #${taskNumber} with ${assignee}.`);
  const state = await control.startActiveTaskAndWait({
    taskNumber,
    assignee,
  });

  const phase = state.phases.find((candidate) => candidate.id === state.activePhaseId) ?? state.phases[0];
  if (!phase) {
    throw new Error("No phase available after task retry.");
  }
  const retriedTask = phase.tasks[taskNumber - 1];
  if (!retriedTask) {
    throw new Error(`Task #${taskNumber} not found after retry.`);
  }

  console.info(`Task #${taskNumber} ${retriedTask.title} finished with status ${retriedTask.status}.`);
  if (retriedTask.status === "FAILED" && retriedTask.errorLogs) {
    console.info(`Failure details: ${retriedTask.errorLogs}`);
  }
}

async function runTaskLogsCommand(args: string[]): Promise<void> {
  const rawTaskNumber = args[2]?.trim() ?? "";
  const taskNumber = Number(rawTaskNumber);
  if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
    throw new Error("Usage: ixado task logs <taskNumber>");
  }

  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const stateFilePath = resolveStateFilePath();
  const control = createControlCenterService(stateFilePath, settings);
  await control.ensureInitialized("IxADO", process.cwd());
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

async function runTaskResetCommand(args: string[]): Promise<void> {
  const rawTaskNumber = args[2]?.trim() ?? "";
  const taskNumber = Number(rawTaskNumber);
  if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
    throw new Error("Usage: ixado task reset <taskNumber>");
  }

  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const stateFilePath = resolveStateFilePath();
  const control = createControlCenterService(stateFilePath, settings);
  await control.ensureInitialized("IxADO", process.cwd());
  const { phase, task } = await resolveActivePhaseTaskForNumber(control, taskNumber);

  if (task.status !== "FAILED") {
    throw new Error(`Task #${taskNumber} must be FAILED before reset. Current status: ${task.status}.`);
  }

  await control.resetTaskToTodo({
    phaseId: phase.id,
    taskId: task.id,
  });
  console.info(`Task #${taskNumber} reset to TODO and repository hard-reset to last commit.`);
}

async function runTaskCommand(args: string[]): Promise<void> {
  const subcommand = args[1];
  if (subcommand === "list") {
    await runTaskListCommand();
    return;
  }

  if (subcommand === "start") {
    await runTaskStartCommand(args);
    return;
  }

  if (subcommand === "retry") {
    await runTaskRetryCommand(args);
    return;
  }

  if (subcommand === "logs") {
    await runTaskLogsCommand(args);
    return;
  }

  if (subcommand === "reset") {
    await runTaskResetCommand(args);
    return;
  }

  throw new Error(
    "Unknown task command. Use `ixado task list`, `ixado task start <taskNumber> [assignee]`, `ixado task retry <taskNumber>`, `ixado task logs <taskNumber>`, or `ixado task reset <taskNumber>`."
  );
}

async function runPhaseRunCommand(args: string[]): Promise<void> {
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const stateFilePath = resolveStateFilePath();
  const control = createControlCenterService(stateFilePath, settings);
  await control.ensureInitialized("IxADO", process.cwd());

  const mode = resolvePhaseRunMode(args[2], settings.executionLoop.autoMode);
  const countdownSeconds = resolveCountdownSeconds(args[3], settings.executionLoop.countdownSeconds);
  const loopControl = new PhaseLoopControl();
  const activeAssignee = settings.internalWork.assignee;
  const testerRunner = new ProcessManager();
  const git = new GitManager(testerRunner);
  const cwd = process.cwd();
  const telegram = resolveTelegramConfig(settings.telegram);

  let runtime: ReturnType<typeof createTelegramRuntime> | undefined;
  if (telegram.enabled) {
    runtime = createTelegramRuntime({
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
    await runtime.start();
    console.info("Telegram loop controls enabled: /next and /stop.");
  }

  const notifyLoopEvent = async (message: string): Promise<void> => {
    if (!runtime) {
      return;
    }

    await runtime.notifyOwner(message);
  };

  const rl = createInterface({
    input: stdin,
    output: stdout,
  });

  console.info(
    `Starting phase execution loop in ${mode} mode (countdown: ${countdownSeconds}s, assignee: ${activeAssignee}).`
  );

  try {
    const startingState = await control.getState();
    const startingPhase = resolveActivePhaseFromState(startingState);
    await control.setPhaseStatus({
      phaseId: startingPhase.id,
      status: "BRANCHING",
    });
    console.info(`Execution loop: preparing branch ${startingPhase.branchName}.`);
    try {
      await git.ensureCleanWorkingTree(cwd);
      const currentBranch = await git.getCurrentBranch(cwd);
      if (currentBranch === startingPhase.branchName) {
        console.info(`Execution loop: already on branch ${startingPhase.branchName}.`);
      } else {
        try {
          await git.checkout(startingPhase.branchName, cwd);
          console.info(`Execution loop: checked out existing branch ${startingPhase.branchName}.`);
        } catch {
          await git.createBranch({
            branchName: startingPhase.branchName,
            cwd,
            fromRef: "HEAD",
          });
          console.info(`Execution loop: created and checked out branch ${startingPhase.branchName}.`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await control.setPhaseStatus({
        phaseId: startingPhase.id,
        status: "CI_FAILED",
        ciStatusContext: `Branching failed: ${message}`,
      });
      throw error;
    }

    await control.setPhaseStatus({
      phaseId: startingPhase.id,
      status: "CODING",
    });

    let iteration = 0;
    let resumeSession = false;
    let completedPhase:
      | Awaited<ReturnType<ControlCenterService["getState"]>>["phases"][number]
      | undefined;
    while (true) {
      if (loopControl.isStopRequested()) {
        console.info("Execution loop stopped.");
        break;
      }

      const state = await control.getState();
      const phase = resolveActivePhaseFromState(state);
      const nextTaskIndex = phase.tasks.findIndex((task) => task.status === "TODO");
      if (nextTaskIndex < 0) {
        console.info(`Execution loop finished. No TODO tasks in active phase ${phase.name}.`);
        completedPhase = phase;
        break;
      }

      const nextTaskNumber = nextTaskIndex + 1;
      const nextTask = phase.tasks[nextTaskIndex];
      const nextTaskLabel = `task #${nextTaskNumber} ${nextTask.title}`;

      if (iteration > 0) {
        const decision =
          mode === "AUTO"
            ? await waitForAutoAdvance(loopControl, countdownSeconds, nextTaskLabel)
            : await waitForManualAdvance(rl, loopControl, nextTaskLabel);
        if (decision === "STOP") {
          loopControl.requestStop();
          console.info("Execution loop stopped before starting the next task.");
          break;
        }
      }

      iteration += 1;
      console.info(`Execution loop: starting ${nextTaskLabel} with ${activeAssignee}.`);
      const updatedState = await control.startActiveTaskAndWait({
        taskNumber: nextTaskNumber,
        assignee: activeAssignee,
        resume: resumeSession,
      });
      const updatedPhase = resolveActivePhaseFromState(updatedState);
      const resultTask = updatedPhase.tasks[nextTaskNumber - 1];
      if (!resultTask) {
        throw new Error(`Task #${nextTaskNumber} not found after loop execution.`);
      }

      console.info(`Execution loop: ${nextTaskLabel} finished with status ${resultTask.status}.`);
      if (resultTask.status === "FAILED") {
        resumeSession = false;
        if (resultTask.errorLogs) {
          console.info(`Failure details: ${resultTask.errorLogs}`);
        }
        await control.setPhaseStatus({
          phaseId: updatedPhase.id,
          status: "CI_FAILED",
          ciStatusContext:
            resultTask.errorLogs ??
            `Execution failed for task #${nextTaskNumber} ${resultTask.title}.`,
        });
        throw new Error(
          `Execution loop stopped after FAILED task #${nextTaskNumber}. Resolve it or reset the task before continuing.`
        );
      }

      await notifyLoopEvent(
        `Task Done: ${updatedPhase.name} #${nextTaskNumber} ${resultTask.title} (${resultTask.status}).`
      );

      const testerResult = await runTesterWorkflow({
        phaseId: updatedPhase.id,
        phaseName: updatedPhase.name,
        completedTask: {
          id: resultTask.id,
          title: resultTask.title,
        },
        cwd: process.cwd(),
        testerCommand: settings.executionLoop.testerCommand,
        testerArgs: settings.executionLoop.testerArgs,
        testerTimeoutMs: settings.executionLoop.testerTimeoutMs,
        runner: testerRunner,
        createFixTask: async (input) => {
          await control.createTask({
            phaseId: input.phaseId,
            title: input.title,
            description: input.description,
            assignee: activeAssignee,
            dependencies: input.dependencies,
          });
        },
      });
      if (testerResult.status === "FAILED") {
        resumeSession = false;
        console.info(
          `Tester workflow failed after ${nextTaskLabel}. Created fix task: ${testerResult.fixTaskTitle}.`
        );
        await notifyLoopEvent(
          `Test Fail: ${updatedPhase.name} after ${resultTask.title}. Created fix task: ${testerResult.fixTaskTitle}.`
        );
        await control.setPhaseStatus({
          phaseId: updatedPhase.id,
          status: "CI_FAILED",
          ciStatusContext:
            `${testerResult.errorMessage}\n\n${testerResult.fixTaskDescription}`.trim(),
        });
        throw new Error("Execution loop stopped after tester failure. Fix task has been created.");
      }

      console.info(`Tester workflow passed after ${nextTaskLabel}.`);
      resumeSession = true;
    }

    if (completedPhase && settings.executionLoop.ciEnabled) {
      await control.setPhaseStatus({
        phaseId: completedPhase.id,
        status: "CREATING_PR",
      });
      console.info("Optional CI integration enabled. Pushing branch and creating PR via gh.");
      const ciResult = await runCiIntegration({
        phaseId: completedPhase.id,
        phaseName: completedPhase.name,
        cwd,
        baseBranch: settings.executionLoop.ciBaseBranch,
        runner: testerRunner,
        setPhasePrUrl: async (input) => {
          await control.setPhasePrUrl(input);
        },
      });
      await control.setPhaseStatus({
        phaseId: completedPhase.id,
        status: "AWAITING_CI",
      });
      console.info(
        `Optional CI integration completed. PR: ${ciResult.prUrl} (head: ${ciResult.headBranch}, base: ${ciResult.baseBranch}).`
      );
      await notifyLoopEvent(
        `PR Created: ${completedPhase.name} -> ${ciResult.prUrl}`
      );

      const latestState = await control.getState();
      const validationPhase = latestState.phases.find((phase) => phase.id === completedPhase.id);
      if (!validationPhase) {
        throw new Error(`Completed phase not found for CI validation: ${completedPhase.id}`);
      }

      console.info(
        `Starting CI validation loop (max retries: ${settings.executionLoop.validationMaxRetries}).`
      );
      const validationResult = await runCiValidationLoop({
        projectName: latestState.projectName,
        rootDir: latestState.rootDir,
        phase: validationPhase,
        assignee: activeAssignee,
        maxRetries: settings.executionLoop.validationMaxRetries,
        readGitDiff: async () => {
          const diff = await testerRunner.run({
            command: "git",
            args: ["diff", "--no-color"],
            cwd,
          });

          return diff.stdout;
        },
        runInternalWork: async (input) => {
          const result = await control.runInternalWork({
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
        await control.setPhaseStatus({
          phaseId: completedPhase.id,
          status: "CI_FAILED",
          ciStatusContext: validationResult.pendingComments.join("\n"),
        });
        console.info(
          `CI validation loop reached max retries (${validationResult.maxRetries}). Pending comments: ${validationResult.pendingComments.join(" | ")}`
        );
        await notifyLoopEvent(
          `Review: ${completedPhase.name} needs fixes after ${validationResult.fixAttempts} attempts. Pending: ${validationResult.pendingComments.join(" | ")}`
        );
        throw new Error("Execution loop stopped after CI validation max retries.");
      }

      await control.setPhaseStatus({
        phaseId: completedPhase.id,
        status: "READY_FOR_REVIEW",
      });

      console.info(
        `CI validation loop approved after ${validationResult.reviews.length} review round(s) and ${validationResult.fixAttempts} fix attempt(s).`
      );
      await notifyLoopEvent(
        `Review: ${completedPhase.name} approved after ${validationResult.reviews.length} round(s).`
      );
    } else if (completedPhase) {
      await control.setPhaseStatus({
        phaseId: completedPhase.id,
        status: "DONE",
      });
    }
  } finally {
    rl.close();
    runtime?.stop();
  }
}

async function runPhaseActiveCommand(args: string[]): Promise<void> {
  const phaseId = args[2]?.trim() ?? "";
  if (!phaseId) {
    throw new Error("Usage: ixado phase active <phaseNumber|phaseId>");
  }

  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const stateFilePath = resolveStateFilePath();
  const control = createControlCenterService(stateFilePath, settings);
  await control.ensureInitialized("IxADO", process.cwd());
  const state = await control.setActivePhase({ phaseId });
  const active = state.phases.find((phase) => phase.id === state.activePhaseId);
  if (!active) {
    throw new Error(`Active phase not found after update: ${phaseId}`);
  }

  console.info(`Active phase set to ${active.name} (${active.id}).`);
}

async function runPhaseCommand(args: string[]): Promise<void> {
  const subcommand = args[1];
  if (subcommand === "run") {
    await runPhaseRunCommand(args);
    return;
  }

  if (subcommand === "active") {
    await runPhaseActiveCommand(args);
    return;
  }

  throw new Error(
    "Unknown phase command. Use `ixado phase active <phaseNumber|phaseId>` or `ixado phase run [auto|manual] [countdownSeconds]`."
  );
}

function resolveAssignedTaskLabel(agent: AgentView, state: Awaited<ReturnType<ControlCenterService["getState"]>>): string {
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
  const stateFilePath = resolveStateFilePath();
  const { control, agents } = createServices(stateFilePath, settings);
  await control.ensureInitialized("IxADO", process.cwd());
  const state = await control.getState();
  const activePhase = state.phases.find((phase) => phase.id === state.activePhaseId);
  const runningAgents = agents.list().filter((agent) => agent.status === "RUNNING");
  const availableAgents = getAvailableAgents(settings);

  console.info(`Project: ${state.projectName}`);
  console.info(`Root: ${state.rootDir}`);
  console.info(`Phases: ${state.phases.length}`);
  console.info(
    `Active: ${activePhase ? `${activePhase.name} (${activePhase.status})` : "none"}`
  );
  console.info(`Available agents: ${availableAgents.join(", ")}`);
  console.info(`Running Agents (${runningAgents.length}):`);
  if (runningAgents.length === 0) {
    console.info("none");
    return;
  }

  for (const [index, agent] of runningAgents.entries()) {
    console.info(`${index + 1}. ${agent.name} -> ${resolveAssignedTaskLabel(agent, state)}`);
  }
}

async function runCli(args: string[]): Promise<void> {
  const command = args[0];

  if (!command) {
    await runDefaultCommand();
    return;
  }

  if (command === "onboard") {
    await runOnboardCommand();
    return;
  }

  if (command === "status") {
    await runStatusCommand();
    return;
  }

  if (command === "web") {
    await runWebCommand(args);
    return;
  }

  if (command === "task") {
    await runTaskCommand(args);
    return;
  }

  if (command === "phase") {
    await runPhaseCommand(args);
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

await runCli(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Startup failed: ${message}`);
  process.exitCode = 1;
});
