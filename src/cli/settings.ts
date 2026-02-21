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
  summary: string;
};

function parseTelegramOnboardChoice(rawAnswer: string): TelegramOnboardChoice | null {
  const normalized = rawAnswer.trim().toLowerCase();

  if (normalized === "y" || normalized === "yes") {
    return { enabled: true, summary: "enabled" };
  }

  if (normalized === "" || normalized === "n" || normalized === "no") {
    return { enabled: false, summary: "disabled" };
  }

  return null;
}

export type Prompt = (question: string) => Promise<string>;

export async function runOnboard(
  settingsFilePath: string,
  prompt: Prompt
): Promise<CliSettings> {
  while (true) {
    const answer = await prompt("Enable Telegram integration? [y/N]: ");
    const choice = parseTelegramOnboardChoice(answer);

    if (!choice) {
      continue;
    }

    const settings: CliSettings = {
      telegram: {
        enabled: choice.enabled,
      },
    };

    return saveCliSettings(settingsFilePath, settings);
  }
}
