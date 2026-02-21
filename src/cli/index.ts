import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";

import { createAdapter } from "../adapters";
import { createTelegramRuntime } from "../bot";
import { ProcessManager } from "../process";
import { StateEngine } from "../state";
import { CLIAdapterIdSchema } from "../types";
import { ControlCenterService } from "../web";
import { initializeCliLogging } from "./logging";
import {
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

function createControlCenterService(stateFilePath: string): ControlCenterService {
  const processManager = new ProcessManager();
  return new ControlCenterService(
    new StateEngine(stateFilePath),
    resolve(process.cwd(), "TASKS.md"),
    async (workInput) => {
      const adapter = createAdapter(workInput.assignee, processManager);
      try {
        const result = await adapter.run({
          prompt: workInput.prompt,
          cwd: process.cwd(),
          timeoutMs: workInput.timeoutMs,
        });
        return {
          command: result.command,
          args: result.args,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
        };
      } catch (error) {
        if (isMissingCommandError(error)) {
          throw new Error(
            `Adapter '${workInput.assignee}' requires '${adapter.contract.command}' but it is not installed or not on PATH. Install it or select another adapter with 'ixado onboard'.`
          );
        }

        throw error;
      }
    }
  );
}

async function runDefaultCommand(): Promise<void> {
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const telegram = resolveTelegramConfig(settings.telegram);
  const stateFilePath = resolveStateFilePath();
  const stateEngine = new StateEngine(stateFilePath);
  const control = createControlCenterService(stateFilePath);
  const stateSummary = await loadOrInitializeState(stateEngine, stateFilePath);

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

  if (telegram.enabled) {
    console.info("Starting Telegram command center.");
    console.info(
      "Bot polling is active. Send /status, /tasks, /starttask <taskNumber> [assignee], or /setactivephase <phaseId>. Press Ctrl+C to stop."
    );
    const runtime = createTelegramRuntime({
      token: telegram.token,
      ownerId: telegram.ownerId,
      readState: () => control.getState(),
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
  console.info("  ixado onboard   Configure local CLI settings");
  console.info(
    "  ixado task list  List tasks in active phase with numbers"
  );
  console.info("  ixado task start <taskNumber> [assignee]  Start active-phase task");
  console.info("  ixado phase active <phaseId>  Set active phase");
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

async function runTaskStartCommand(args: string[]): Promise<void> {
  const rawTaskNumber = args[2]?.trim() ?? "";
  const taskNumber = Number(rawTaskNumber);
  if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
    throw new Error("Usage: ixado task start <taskNumber> [assignee]");
  }

  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const assignee = CLIAdapterIdSchema.parse(
    args[3]?.trim() ? args[3].trim() : settings.internalWork.assignee
  );
  const stateFilePath = resolveStateFilePath();
  const control = createControlCenterService(stateFilePath);
  await control.ensureInitialized("IxADO", process.cwd());
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
  const stateFilePath = resolveStateFilePath();
  const control = createControlCenterService(stateFilePath);
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

  throw new Error("Unknown task command. Use `ixado task list` or `ixado task start <taskNumber> [assignee]`.");
}

async function runPhaseActiveCommand(args: string[]): Promise<void> {
  const phaseId = args[2]?.trim() ?? "";
  if (!phaseId) {
    throw new Error("Usage: ixado phase active <phaseId>");
  }

  const stateFilePath = resolveStateFilePath();
  const control = createControlCenterService(stateFilePath);
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
  if (subcommand === "active") {
    await runPhaseActiveCommand(args);
    return;
  }

  throw new Error("Unknown phase command. Use `ixado phase active <phaseId>`.");
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
