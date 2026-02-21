import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";

import { StateEngine } from "../state";

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

function resolveTelegramConfig(): TelegramBootstrapConfig {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const rawOwnerId = process.env.TELEGRAM_OWNER_ID?.trim();

  if (!token && !rawOwnerId) {
    return { enabled: false };
  }

  if (!token || !rawOwnerId) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID must both be set when Telegram mode is enabled."
    );
  }

  return {
    enabled: true,
    token,
    ownerId: parseOwnerId(rawOwnerId),
  };
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

async function bootstrap(): Promise<void> {
  const telegram = resolveTelegramConfig();
  const stateFilePath = resolveStateFilePath();
  const stateEngine = new StateEngine(stateFilePath);
  const stateSummary = await loadOrInitializeState(stateEngine, stateFilePath);

  console.info("IxADO bootstrap checks passed.");
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
  console.info("Core engine and Telegram adapter wiring are pending in ROADMAP phases.");
}

await bootstrap().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Startup failed: ${message}`);
  process.exitCode = 1;
});
