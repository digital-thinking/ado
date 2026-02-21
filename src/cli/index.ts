import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";

import { createTelegramRuntime } from "../bot";
import { StateEngine } from "../state";
import { startWebControlCenter } from "../web";
import {
  loadCliSettings,
  resolveSettingsFilePath,
  resolveSoulFilePath,
  runOnboard,
} from "./settings";

const DEFAULT_STATE_FILE = ".ixado/state.json";

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

async function runDefaultCommand(): Promise<void> {
  const settingsFilePath = resolveSettingsFilePath();
  const settings = await loadCliSettings(settingsFilePath);
  const telegram = resolveTelegramConfig(settings.telegram);
  const stateFilePath = resolveStateFilePath();
  const stateEngine = new StateEngine(stateFilePath);
  const stateSummary = await loadOrInitializeState(stateEngine, stateFilePath);

  console.info("IxADO bootstrap checks passed.");
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
    console.info("Bot polling is active. Send /status or /tasks to your bot. Press Ctrl+C to stop.");
    const runtime = createTelegramRuntime({
      token: telegram.token,
      ownerId: telegram.ownerId,
      readState: () => stateEngine.readProjectState(),
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
  console.info("  ixado web [port]   Start local web control center");
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
    console.info(`Settings saved to ${settingsFilePath}.`);
    console.info(`SOUL file saved to ${soulFilePath}.`);
    console.info(`Telegram mode ${settings.telegram.enabled ? "enabled" : "disabled"}.`);
    if (settings.telegram.enabled) {
      console.info("Telegram bot credentials stored in settings file.");
    }
  } finally {
    rl.close();
  }
}

function parseWebPort(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Invalid web port. Expected integer between 0 and 65535.");
  }

  return port;
}

async function runWebCommand(args: string[]): Promise<void> {
  const stateFilePath = resolveStateFilePath();
  const portFromArgs = parseWebPort(args[1]);
  const portFromEnv = parseWebPort(process.env.IXADO_WEB_PORT?.trim());
  const port = portFromArgs ?? portFromEnv;

  const runtime = await startWebControlCenter({
    cwd: process.cwd(),
    stateFilePath,
    projectName: "IxADO",
    port,
  });

  console.info(`Web control center started at ${runtime.url}`);
  console.info("Press Ctrl+C to stop.");
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
