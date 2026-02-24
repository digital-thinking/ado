import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  CLI_ADAPTER_IDS,
  CliSettingsOverrideSchema,
  CliSettingsSchema,
  type CLIAdapterId,
  type CliSettings,
  type CliSettingsOverride,
} from "../types";

const DEFAULT_SETTINGS_FILE = ".ixado/settings.json";
const DEFAULT_GLOBAL_SETTINGS_FILE = ".ixado/config.json";
const DEFAULT_SOUL_FILE = ".ixado/SOUL.md";
const ONBOARD_SKIP_KEY = "s";

export const DEFAULT_CLI_SETTINGS: CliSettings = {
  projects: [],
  telegram: {
    enabled: false,
  },
  internalWork: {
    assignee: "CODEX_CLI",
  },
  executionLoop: {
    autoMode: false,
    countdownSeconds: 10,
    testerCommand: null,
    testerArgs: null,
    testerTimeoutMs: 600_000,
    ciEnabled: false,
    ciBaseBranch: "main",
    validationMaxRetries: 3,
  },
  exceptionRecovery: {
    maxAttempts: 1,
  },
  usage: {
    codexbarEnabled: true,
  },
  agents: {
    CODEX_CLI: {
      enabled: true,
      timeoutMs: 3_600_000,
      startupSilenceTimeoutMs: 60_000,
      bypassApprovalsAndSandbox: false,
    },
    CLAUDE_CLI: {
      enabled: true,
      timeoutMs: 3_600_000,
      startupSilenceTimeoutMs: 60_000,
      bypassApprovalsAndSandbox: false,
    },
    GEMINI_CLI: {
      enabled: true,
      timeoutMs: 3_600_000,
      startupSilenceTimeoutMs: 60_000,
      bypassApprovalsAndSandbox: false,
    },
    MOCK_CLI: {
      enabled: true,
      timeoutMs: 3_600_000,
      startupSilenceTimeoutMs: 60_000,
      bypassApprovalsAndSandbox: false,
    },
  },
};

export function resolveSettingsFilePath(): string {
  const configuredSettingsPath = process.env.IXADO_SETTINGS_FILE?.trim();
  if (configuredSettingsPath) {
    return resolve(configuredSettingsPath);
  }

  return resolve(process.cwd(), DEFAULT_SETTINGS_FILE);
}

export function resolveGlobalSettingsFilePath(): string {
  const configuredGlobalSettingsPath =
    process.env.IXADO_GLOBAL_CONFIG_FILE?.trim();
  if (configuredGlobalSettingsPath) {
    return resolve(configuredGlobalSettingsPath);
  }

  const homeDirectory = homedir().trim();
  if (!homeDirectory) {
    throw new Error(
      "Could not resolve home directory for global settings path.",
    );
  }

  return resolve(homeDirectory, DEFAULT_GLOBAL_SETTINGS_FILE);
}

export function resolveSoulFilePath(): string {
  const configuredSoulPath = process.env.IXADO_SOUL_FILE?.trim();
  if (configuredSoulPath) {
    return resolve(configuredSoulPath);
  }

  return resolve(process.cwd(), DEFAULT_SOUL_FILE);
}

export function resolveOnboardSettingsFilePath(): string {
  const configuredSettingsPath = process.env.IXADO_SETTINGS_FILE?.trim();
  if (configuredSettingsPath) {
    return resolve(configuredSettingsPath);
  }

  return resolveGlobalSettingsFilePath();
}

export function resolveOnboardSoulFilePath(): string {
  const configuredSoulPath = process.env.IXADO_SOUL_FILE?.trim();
  if (configuredSoulPath) {
    return resolve(configuredSoulPath);
  }

  const onboardSettingsFilePath = resolveOnboardSettingsFilePath();
  return resolve(dirname(onboardSettingsFilePath), "SOUL.md");
}

async function readSettingsOverrideFile(
  settingsFilePath: string,
): Promise<CliSettingsOverride | null> {
  try {
    await access(settingsFilePath, fsConstants.F_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
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

  return CliSettingsOverrideSchema.parse(parsed);
}

function mergeCliSettings(
  base: CliSettings,
  override: CliSettingsOverride,
): CliSettings {
  return CliSettingsSchema.parse({
    projects: override.projects ?? base.projects,
    activeProject: override.activeProject ?? base.activeProject,
    telegram: {
      ...base.telegram,
      ...override.telegram,
    },
    internalWork: {
      ...base.internalWork,
      ...override.internalWork,
    },
    executionLoop: {
      ...base.executionLoop,
      ...override.executionLoop,
    },
    exceptionRecovery: {
      ...base.exceptionRecovery,
      ...override.exceptionRecovery,
    },
    usage: {
      ...base.usage,
      ...override.usage,
    },
    agents: {
      CODEX_CLI: {
        ...base.agents.CODEX_CLI,
        ...override.agents?.CODEX_CLI,
      },
      CLAUDE_CLI: {
        ...base.agents.CLAUDE_CLI,
        ...override.agents?.CLAUDE_CLI,
      },
      GEMINI_CLI: {
        ...base.agents.GEMINI_CLI,
        ...override.agents?.GEMINI_CLI,
      },
      MOCK_CLI: {
        ...base.agents.MOCK_CLI,
        ...override.agents?.MOCK_CLI,
      },
    },
  });
}

export function migrateRuntimeConfigToActiveProject(settings: CliSettings): {
  settings: CliSettings;
  migrated: boolean;
} {
  const activeProjectName = settings.activeProject;
  if (!activeProjectName) {
    return { settings, migrated: false };
  }

  let migrated = false;
  const projects = settings.projects.map((project) => {
    if (project.name !== activeProjectName || project.executionSettings) {
      return project;
    }

    migrated = true;
    return {
      ...project,
      executionSettings: {
        autoMode: settings.executionLoop.autoMode,
        defaultAssignee: settings.internalWork.assignee,
      },
    };
  });

  if (!migrated) {
    return { settings, migrated: false };
  }

  return {
    settings: {
      ...settings,
      projects,
    },
    migrated: true,
  };
}

export async function loadCliSettings(
  settingsFilePath: string,
): Promise<CliSettings> {
  const globalSettingsFilePath = resolveGlobalSettingsFilePath();
  const globalOverride =
    settingsFilePath === globalSettingsFilePath
      ? null
      : await readSettingsOverrideFile(globalSettingsFilePath);
  const localOverride = await readSettingsOverrideFile(settingsFilePath);

  // When settingsFilePath IS the global file, localOverride holds the global content (globalOverride is null).
  // When settingsFilePath is a local file, globalOverride holds the global content.
  // Build global-only settings so migration operates on and saves only global data.
  const globalFileContent = globalOverride ?? localOverride;
  let globalSettings = DEFAULT_CLI_SETTINGS;
  if (globalFileContent) {
    globalSettings = mergeCliSettings(globalSettings, globalFileContent);
  }

  const migration = migrateRuntimeConfigToActiveProject(globalSettings);
  if (migration.migrated) {
    globalSettings = migration.settings;
    await saveCliSettings(globalSettingsFilePath, globalSettings);
  }

  // For a local path, apply the local file's overrides on top of global settings.
  // For the global path itself, globalSettings already contains the full content.
  let settings = globalSettings;
  if (globalOverride !== null && localOverride) {
    settings = mergeCliSettings(settings, localOverride);
  }

  return settings;
}

export async function saveCliSettings(
  settingsFilePath: string,
  settings: CliSettings,
): Promise<CliSettings> {
  const validated = CliSettingsSchema.parse(settings);

  await mkdir(dirname(settingsFilePath), { recursive: true });
  await writeFile(
    settingsFilePath,
    `${JSON.stringify(validated, null, 2)}\n`,
    "utf8",
  );

  return validated;
}

export async function saveSoulFile(
  soulFilePath: string,
  personality: string,
): Promise<void> {
  const trimmedPersonality = personality.trim();
  if (!trimmedPersonality) {
    throw new Error("personality must not be empty.");
  }

  await mkdir(dirname(soulFilePath), { recursive: true });
  await writeFile(
    soulFilePath,
    `# SOUL\n\nPersonality: ${trimmedPersonality}\n`,
    "utf8",
  );
}

type TelegramOnboardChoice = {
  skip: boolean;
  enabled: boolean;
};

function parseTelegramOnboardChoice(
  rawAnswer: string,
  currentEnabled: boolean,
): TelegramOnboardChoice | null {
  const normalized = rawAnswer.trim().toLowerCase();

  if (normalized === "" || normalized === ONBOARD_SKIP_KEY) {
    return { skip: true, enabled: currentEnabled };
  }

  if (normalized === "y" || normalized === "yes") {
    return { skip: false, enabled: true };
  }

  if (normalized === "n" || normalized === "no") {
    return { skip: false, enabled: false };
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

function isSkipAnswer(rawAnswer: string): boolean {
  const normalized = rawAnswer.trim().toLowerCase();
  return normalized === "" || normalized === ONBOARD_SKIP_KEY;
}

async function loadSoulPersonality(
  soulFilePath: string,
): Promise<string | null> {
  try {
    const soul = await readFile(soulFilePath, "utf8");
    const match = /Personality:\s*(.+)/i.exec(soul);
    if (!match) {
      return null;
    }

    const personality = match[1].trim();
    return personality ? personality : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function parseInternalWorkAssignee(
  rawAnswer: string,
  availableAgents: CLIAdapterId[],
): CLIAdapterId | null {
  const normalized = rawAnswer.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  const byNumber = availableAgents[Number(normalized) - 1];
  if (byNumber) {
    return byNumber;
  }

  if (normalized === "codex" || normalized === "codex_cli") {
    return "CODEX_CLI";
  }
  if (normalized === "claude" || normalized === "claude_cli") {
    return "CLAUDE_CLI";
  }
  if (normalized === "gemini" || normalized === "gemini_cli") {
    return "GEMINI_CLI";
  }
  if (normalized === "mock" || normalized === "mock_cli") {
    return "MOCK_CLI";
  }

  return null;
}

function parseEnabledChoice(
  rawAnswer: string,
  currentEnabled: boolean,
): { skip: boolean; enabled: boolean } | null {
  const normalized = rawAnswer.trim().toLowerCase();

  if (normalized === ONBOARD_SKIP_KEY) {
    return { skip: true, enabled: currentEnabled };
  }
  if (!normalized) {
    return { skip: false, enabled: currentEnabled };
  }
  if (normalized === "y" || normalized === "yes") {
    return { skip: false, enabled: true };
  }
  if (normalized === "n" || normalized === "no") {
    return { skip: false, enabled: false };
  }

  return null;
}

function parseTimeoutMs(rawAnswer: string): number | null {
  const trimmed = rawAnswer.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

export function getAvailableAgents(settings: CliSettings): CLIAdapterId[] {
  return CLI_ADAPTER_IDS.filter((agentId) => settings.agents[agentId].enabled);
}

export async function runOnboard(
  settingsFilePath: string,
  soulFilePath: string,
  prompt: Prompt,
  output: Output = (line) => {
    console.info(line);
  },
): Promise<CliSettings> {
  const existingSettings = await loadCliSettings(settingsFilePath);
  const existingSoulPersonality = await loadSoulPersonality(soulFilePath);

  await output(
    "Setup: Telegram mode enables remote /status and /tasks commands through your bot.",
  );
  await output(
    "Setup: SOUL.md stores IxADO's behavior/personality profile for future prompts.",
  );
  await output(
    "Setup: Internal work adapter is used by the web UI for AI-assisted transformations.",
  );
  await output(
    "Setup: configure which agents are available and set per-agent timeout (milliseconds).",
  );
  await output(
    "Setup: make sure the selected internal-work CLI command is installed and available in PATH.",
  );
  await output(
    "Setup: press Enter to keep the current value for a field (S also works).",
  );

  const configuredAgents = {
    CODEX_CLI: { ...existingSettings.agents.CODEX_CLI },
    CLAUDE_CLI: { ...existingSettings.agents.CLAUDE_CLI },
    GEMINI_CLI: { ...existingSettings.agents.GEMINI_CLI },
    MOCK_CLI: { ...existingSettings.agents.MOCK_CLI },
  };

  while (true) {
    for (const agentId of CLI_ADAPTER_IDS) {
      let enabledChoice: { skip: boolean; enabled: boolean } | null = null;
      while (!enabledChoice) {
        const answer = await prompt(
          `Enable ${agentId}? [y/n/Enter=keep ${configuredAgents[agentId].enabled ? "enabled" : "disabled"}]: `,
        );
        enabledChoice = parseEnabledChoice(
          answer,
          configuredAgents[agentId].enabled,
        );
      }
      configuredAgents[agentId].enabled = enabledChoice.enabled;

      if (!configuredAgents[agentId].enabled) {
        continue;
      }

      let timeoutMs: number | null = null;
      while (timeoutMs === null) {
        const answer = await prompt(
          `Timeout for ${agentId} in ms [Enter=keep ${configuredAgents[agentId].timeoutMs}]: `,
        );
        if (isSkipAnswer(answer)) {
          timeoutMs = configuredAgents[agentId].timeoutMs;
          break;
        }
        timeoutMs = parseTimeoutMs(answer);
      }
      configuredAgents[agentId].timeoutMs = timeoutMs;
    }

    const enabledCount = CLI_ADAPTER_IDS.filter(
      (agentId) => configuredAgents[agentId].enabled,
    ).length;
    if (enabledCount > 0) {
      break;
    }

    await output("At least one agent must be enabled.");
  }

  let internalWorkAssignee: CLIAdapterId | null = null;
  while (internalWorkAssignee === null) {
    const availableAgents = CLI_ADAPTER_IDS.filter(
      (agentId) => configuredAgents[agentId].enabled,
    );
    const answer = await prompt(
      `Select internal-work CLI [${availableAgents.map((agentId, index) => `${index + 1}=${agentId}`).join(", ")}, Enter=keep ${existingSettings.internalWork.assignee}]: `,
    );
    if (isSkipAnswer(answer)) {
      if (!configuredAgents[existingSettings.internalWork.assignee].enabled) {
        await output(
          `Cannot keep ${existingSettings.internalWork.assignee}: this agent is disabled.`,
        );
        continue;
      }
      internalWorkAssignee = existingSettings.internalWork.assignee;
      break;
    }
    const parsedAssignee = parseInternalWorkAssignee(answer, availableAgents);
    if (parsedAssignee && configuredAgents[parsedAssignee].enabled) {
      internalWorkAssignee = parsedAssignee;
    }
  }

  let personality: string | null = null;
  while (!personality) {
    const answer = await prompt(
      "Short personality description for IxADO [Enter=keep current]: ",
    );
    if (isSkipAnswer(answer)) {
      if (!existingSoulPersonality) {
        await output(
          "No existing SOUL profile found. Enter a new personality description.",
        );
        continue;
      }

      personality = existingSoulPersonality;
      break;
    }

    const trimmed = answer.trim();
    if (!trimmed) {
      continue;
    }

    personality = trimmed;
  }
  await saveSoulFile(soulFilePath, personality);
  await output(`SOUL profile saved to ${soulFilePath}.`);

  while (true) {
    const answer = await prompt(
      `Enable Telegram integration? [y/n/Enter=keep ${existingSettings.telegram.enabled ? "enabled" : "disabled"}]: `,
    );
    const choice = parseTelegramOnboardChoice(
      answer,
      existingSettings.telegram.enabled,
    );

    if (!choice) {
      continue;
    }

    if (choice.skip) {
      const settings: CliSettings = {
        projects: existingSettings.projects,
        telegram: {
          enabled: existingSettings.telegram.enabled,
          botToken: existingSettings.telegram.botToken,
          ownerId: existingSettings.telegram.ownerId,
        },
        internalWork: {
          assignee: internalWorkAssignee,
        },
        executionLoop: existingSettings.executionLoop,
        exceptionRecovery: existingSettings.exceptionRecovery,
        usage: existingSettings.usage,
        agents: configuredAgents,
      };

      return saveCliSettings(settingsFilePath, settings);
    }

    if (!choice.enabled) {
      const settings: CliSettings = {
        projects: existingSettings.projects,
        telegram: {
          enabled: false,
        },
        internalWork: {
          assignee: internalWorkAssignee,
        },
        executionLoop: existingSettings.executionLoop,
        exceptionRecovery: existingSettings.exceptionRecovery,
        usage: existingSettings.usage,
        agents: configuredAgents,
      };

      return saveCliSettings(settingsFilePath, settings);
    }

    await output("Enter your Telegram bot token from BotFather.");
    let botToken = "";
    while (!botToken) {
      const tokenAnswer = await prompt(
        "Telegram bot token [Enter=keep current]: ",
      );
      if (isSkipAnswer(tokenAnswer)) {
        if (existingSettings.telegram.botToken?.trim()) {
          botToken = existingSettings.telegram.botToken.trim();
          break;
        }

        await output("No existing Telegram bot token found. Enter a token.");
        continue;
      }

      botToken = tokenAnswer.trim();
    }

    await output(
      "Enter your Telegram owner user ID (only this account can use bot commands).",
    );
    let ownerId: number | null = null;
    while (ownerId === null) {
      const ownerAnswer = await prompt(
        "Telegram owner ID [Enter=keep current]: ",
      );
      if (isSkipAnswer(ownerAnswer)) {
        if (existingSettings.telegram.ownerId !== undefined) {
          ownerId = existingSettings.telegram.ownerId;
          break;
        }

        await output(
          "No existing Telegram owner ID found. Enter a valid owner ID.",
        );
        continue;
      }

      ownerId = parseOwnerId(ownerAnswer);
    }

    const settings: CliSettings = {
      projects: existingSettings.projects,
      telegram: {
        enabled: true,
        botToken,
        ownerId,
      },
      internalWork: {
        assignee: internalWorkAssignee,
      },
      executionLoop: existingSettings.executionLoop,
      exceptionRecovery: existingSettings.exceptionRecovery,
      usage: existingSettings.usage,
      agents: configuredAgents,
    };

    return saveCliSettings(settingsFilePath, settings);
  }
}
