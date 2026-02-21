import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";

import { StateEngine } from "../state";

const REQUIRED_ENV_VARS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_ID"] as const;
const DEFAULT_STATE_FILE = ".ixado/state.json";

function getRequiredEnv(name: (typeof REQUIRED_ENV_VARS)[number]): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

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

async function bootstrap(): Promise<void> {
  const token = getRequiredEnv("TELEGRAM_BOT_TOKEN");
  const ownerId = parseOwnerId(getRequiredEnv("TELEGRAM_OWNER_ID"));
  const stateFilePath = resolveStateFilePath();
  const stateEngine = new StateEngine(stateFilePath);
  const stateSummary = await loadOrInitializeState(stateEngine, stateFilePath);

  console.info("IxADO bootstrap checks passed.");
  console.info(
    `Telegram security preconditions verified (owner: ${ownerId}, token length: ${token.length}).`
  );
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
