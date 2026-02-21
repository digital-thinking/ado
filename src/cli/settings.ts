import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { CliSettingsSchema, type CliSettings } from "../types";

const DEFAULT_SETTINGS_FILE = ".ixado/settings.json";

export const DEFAULT_CLI_SETTINGS: CliSettings = {
  telegram: {
    enabled: false,
  },
};

export function resolveSettingsFilePath(): string {
  const configuredSettingsPath = process.env.IXADO_SETTINGS_FILE?.trim();
  if (configuredSettingsPath) {
    return resolve(configuredSettingsPath);
  }

  return resolve(process.cwd(), DEFAULT_SETTINGS_FILE);
}

export async function loadCliSettings(settingsFilePath: string): Promise<CliSettings> {
  try {
    await access(settingsFilePath, fsConstants.F_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_CLI_SETTINGS;
    }

    throw error;
  }

  const raw = await readFile(settingsFilePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Settings file contains invalid JSON: ${settingsFilePath}`);
  }

  return CliSettingsSchema.parse(parsed);
}

export async function saveCliSettings(
  settingsFilePath: string,
  settings: CliSettings
): Promise<CliSettings> {
  const validated = CliSettingsSchema.parse(settings);

  await mkdir(dirname(settingsFilePath), { recursive: true });
  await writeFile(settingsFilePath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");

  return validated;
}

type TelegramOnboardChoice = {
  enabled: boolean;
};

function parseTelegramOnboardChoice(rawAnswer: string): TelegramOnboardChoice | null {
  const normalized = rawAnswer.trim().toLowerCase();

  if (normalized === "y" || normalized === "yes") {
    return { enabled: true };
  }

  if (normalized === "" || normalized === "n" || normalized === "no") {
    return { enabled: false };
  }

  return null;
}

export type Prompt = (question: string) => Promise<string>;
export type Output = (line: string) => void | Promise<void>;

function parseOwnerId(rawOwnerId: string): number | null {
  const ownerId = Number(rawOwnerId.trim());
  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    return null;
  }

  return ownerId;
}

export async function runOnboard(
  settingsFilePath: string,
  prompt: Prompt,
  output: Output = (line) => {
    console.info(line);
  }
): Promise<CliSettings> {
  await output("Setup: Telegram mode enables remote /status and /tasks commands through your bot.");

  while (true) {
    const answer = await prompt("Enable Telegram integration? [y/N]: ");
    const choice = parseTelegramOnboardChoice(answer);

    if (!choice) {
      continue;
    }

    if (!choice.enabled) {
      const settings: CliSettings = {
        telegram: {
          enabled: false,
        },
      };

      return saveCliSettings(settingsFilePath, settings);
    }

    await output("Enter your Telegram bot token from BotFather.");
    let botToken = "";
    while (!botToken) {
      botToken = (await prompt("Telegram bot token: ")).trim();
    }

    await output("Enter your Telegram owner user ID (only this account can use bot commands).");
    let ownerId: number | null = null;
    while (ownerId === null) {
      ownerId = parseOwnerId(await prompt("Telegram owner ID: "));
    }

    const settings: CliSettings = {
      telegram: {
        enabled: true,
        botToken,
        ownerId,
      },
    };

    return saveCliSettings(settingsFilePath, settings);
  }
}
