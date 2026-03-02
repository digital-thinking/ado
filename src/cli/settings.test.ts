import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TestSandbox } from "./test-helpers";

import {
  DEFAULT_CLI_SETTINGS,
  loadCliSettings,
  resolveOnboardSettingsFilePath,
  resolveOnboardSoulFilePath,
  resolveSettingsFilePath,
  saveSoulFile,
  runOnboard,
  saveCliSettings,
} from "./settings";

const DEFAULT_AGENT_SETTINGS = {
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
};

const DEFAULT_LOOP_SETTINGS = {
  autoMode: false,
  countdownSeconds: 10,
  testerCommand: null,
  testerArgs: null,
  testerTimeoutMs: 600000,
  ciEnabled: false,
  ciBaseBranch: "main",
  validationMaxRetries: 3,
  ciFixMaxFanOut: 10,
  ciFixMaxDepth: 3,
  pullRequest: {
    defaultTemplatePath: null,
    templateMappings: [],
    labels: [],
    assignees: [],
    createAsDraft: false,
    markReadyOnApproval: false,
  },
};
const DEFAULT_EXCEPTION_RECOVERY_SETTINGS = {
  maxAttempts: 1,
};
const DEFAULT_USAGE_SETTINGS = {
  codexbarEnabled: true,
};
const DEFAULT_TELEGRAM_NOTIFICATIONS = {
  level: "all" as const,
  suppressDuplicates: true,
};

describe("cli settings", () => {
  let sandbox: TestSandbox;
  let settingsFilePath: string;
  let soulFilePath: string;
  const originalHome = process.env.HOME;
  const originalGlobalConfigPath = process.env.IXADO_GLOBAL_CONFIG_FILE;
  const originalSettingsPath = process.env.IXADO_SETTINGS_FILE;
  const originalSoulPath = process.env.IXADO_SOUL_FILE;

  beforeEach(async () => {
    sandbox = await TestSandbox.create("ixado-cli-settings-");
    settingsFilePath = join(sandbox.projectDir, "settings.json");
    soulFilePath = join(sandbox.projectDir, "SOUL.md");
    process.env.HOME = sandbox.projectDir;
    process.env.IXADO_GLOBAL_CONFIG_FILE = sandbox.globalConfigFile;
    delete process.env.IXADO_SETTINGS_FILE;
    delete process.env.IXADO_SOUL_FILE;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalGlobalConfigPath === undefined) {
      delete process.env.IXADO_GLOBAL_CONFIG_FILE;
    } else {
      process.env.IXADO_GLOBAL_CONFIG_FILE = originalGlobalConfigPath;
    }
    if (originalSettingsPath === undefined) {
      delete process.env.IXADO_SETTINGS_FILE;
    } else {
      process.env.IXADO_SETTINGS_FILE = originalSettingsPath;
    }
    if (originalSoulPath === undefined) {
      delete process.env.IXADO_SOUL_FILE;
    } else {
      process.env.IXADO_SOUL_FILE = originalSoulPath;
    }
    await sandbox.cleanup();
  });

  test("onboard defaults to global settings path", () => {
    expect(resolveOnboardSettingsFilePath()).toBe(sandbox.globalConfigFile);
  });

  test("default settings path resolves to global config path", () => {
    expect(resolveSettingsFilePath()).toBe(sandbox.globalConfigFile);
  });

  test("onboard defaults SOUL path next to settings file", () => {
    expect(resolveOnboardSoulFilePath()).toBe(
      join(sandbox.projectDir, ".ixado", "SOUL.md"),
    );
  });

  test("onboard settings and SOUL paths honor environment overrides", () => {
    const customSettingsPath = join(
      sandbox.projectDir,
      "custom",
      "settings.json",
    );
    const customSoulPath = join(sandbox.projectDir, "custom", "profile.md");

    process.env.IXADO_SETTINGS_FILE = customSettingsPath;
    expect(resolveOnboardSettingsFilePath()).toBe(customSettingsPath);
    expect(resolveOnboardSoulFilePath()).toBe(
      join(sandbox.projectDir, "custom", "SOUL.md"),
    );

    process.env.IXADO_SOUL_FILE = customSoulPath;
    expect(resolveOnboardSoulFilePath()).toBe(customSoulPath);
  });

  test("returns defaults when settings file is missing", async () => {
    const settings = await loadCliSettings(settingsFilePath);
    expect(settings).toEqual(DEFAULT_CLI_SETTINGS);
  });

  test("saves and loads settings", async () => {
    await saveCliSettings(settingsFilePath, {
      projects: [],
      telegram: {
        enabled: true,
        botToken: "abc",
        ownerId: 123,
        notifications: DEFAULT_TELEGRAM_NOTIFICATIONS,
      },
      internalWork: {
        assignee: "CLAUDE_CLI",
      },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      exceptionRecovery: DEFAULT_EXCEPTION_RECOVERY_SETTINGS,
      usage: DEFAULT_USAGE_SETTINGS,
      agents: DEFAULT_AGENT_SETTINGS,
    });

    const settings = await loadCliSettings(settingsFilePath);
    expect(settings).toEqual({
      projects: [],
      telegram: {
        enabled: true,
        botToken: "abc",
        ownerId: 123,
        notifications: DEFAULT_TELEGRAM_NOTIFICATIONS,
      },
      internalWork: {
        assignee: "CLAUDE_CLI",
      },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      exceptionRecovery: DEFAULT_EXCEPTION_RECOVERY_SETTINGS,
      usage: DEFAULT_USAGE_SETTINGS,
      agents: DEFAULT_AGENT_SETTINGS,
    });
  });

  test("loads defaults when requested settings file is missing", async () => {
    await Bun.write(
      sandbox.globalConfigFile,
      JSON.stringify({
        executionLoop: {
          autoMode: true,
          countdownSeconds: 42,
        },
        internalWork: {
          assignee: "CLAUDE_CLI",
        },
      }),
    );

    const settings = await loadCliSettings(settingsFilePath);
    expect(settings).toEqual(DEFAULT_CLI_SETTINGS);
  });

  test("loads settings from the provided file only", async () => {
    await Bun.write(
      sandbox.globalConfigFile,
      JSON.stringify({
        executionLoop: {
          testerCommand: "bun",
          testerArgs: ["test"],
          countdownSeconds: 99,
        },
        exceptionRecovery: {
          maxAttempts: 2,
        },
        agents: {
          CODEX_CLI: {
            timeoutMs: 5000,
          },
        },
      }),
    );
    await Bun.write(
      settingsFilePath,
      JSON.stringify({
        executionLoop: {
          countdownSeconds: 3,
        },
        exceptionRecovery: {
          maxAttempts: 4,
        },
        agents: {
          CODEX_CLI: {
            timeoutMs: 7000,
          },
        },
      }),
    );

    const settings = await loadCliSettings(settingsFilePath);
    expect(settings.executionLoop.testerCommand).toBeNull();
    expect(settings.executionLoop.testerArgs).toBeNull();
    expect(settings.executionLoop.countdownSeconds).toBe(3);
    expect(settings.exceptionRecovery.maxAttempts).toBe(4);
    expect(settings.agents.CODEX_CLI.timeoutMs).toBe(7000);
  });

  test("reads codexbar usage telemetry from the provided file only", async () => {
    await Bun.write(
      sandbox.globalConfigFile,
      JSON.stringify({
        usage: {
          codexbarEnabled: false,
        },
      }),
    );
    await Bun.write(
      settingsFilePath,
      JSON.stringify({
        usage: {
          codexbarEnabled: true,
        },
      }),
    );

    const settings = await loadCliSettings(settingsFilePath);
    expect(settings.usage.codexbarEnabled).toBe(true);
  });

  test("deep-merges executionLoop.pullRequest overrides in a single config file", async () => {
    await Bun.write(
      settingsFilePath,
      JSON.stringify({
        executionLoop: {
          pullRequest: {
            createAsDraft: true,
            labels: ["ixado"],
            templateMappings: [
              {
                branchPrefix: "phase-23-",
                templatePath: ".github/pr_phase23.md",
              },
            ],
            assignees: ["octocat"],
            markReadyOnApproval: true,
          },
        },
      }),
    );

    const settings = await loadCliSettings(settingsFilePath);
    expect(settings.executionLoop.pullRequest).toEqual({
      defaultTemplatePath: null,
      templateMappings: [
        {
          branchPrefix: "phase-23-",
          templatePath: ".github/pr_phase23.md",
        },
      ],
      labels: ["ixado"],
      assignees: ["octocat"],
      createAsDraft: true,
      markReadyOnApproval: true,
    });
  });

  test("fails for invalid settings json", async () => {
    await Bun.write(settingsFilePath, "{invalid");
    await expect(loadCliSettings(settingsFilePath)).rejects.toThrow(
      `Settings file contains invalid JSON: ${settingsFilePath}`,
    );
  });

  test("writes SOUL file from personality", async () => {
    await saveSoulFile(soulFilePath, "Direct and pragmatic.");

    const soul = await Bun.file(soulFilePath).text();
    expect(soul).toContain("# SOUL");
    expect(soul).toContain("Personality: Direct and pragmatic.");
  });

  test("onboard accepts yes and persists telegram bot settings", async () => {
    const answers = [
      "y",
      "600000",
      "y",
      "600000",
      "y",
      "600000",
      "y",
      "600000",
      "2",
      "Concise and pragmatic",
      "y",
      "my-token",
      "123456",
    ];
    let idx = 0;
    const output: string[] = [];

    const settings = await runOnboard(
      settingsFilePath,
      soulFilePath,
      async () => answers[idx++] ?? "",
      async (line) => {
        output.push(line);
      },
    );

    expect(settings).toEqual({
      projects: [],
      telegram: {
        enabled: true,
        botToken: "my-token",
        ownerId: 123456,
        notifications: DEFAULT_TELEGRAM_NOTIFICATIONS,
      },
      internalWork: {
        assignee: "CLAUDE_CLI",
      },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      exceptionRecovery: DEFAULT_EXCEPTION_RECOVERY_SETTINGS,
      usage: DEFAULT_USAGE_SETTINGS,
      agents: {
        CODEX_CLI: {
          enabled: true,
          timeoutMs: 600000,
          startupSilenceTimeoutMs: 60_000,
          bypassApprovalsAndSandbox: false,
        },
        CLAUDE_CLI: {
          enabled: true,
          timeoutMs: 600000,
          startupSilenceTimeoutMs: 60_000,
          bypassApprovalsAndSandbox: false,
        },
        GEMINI_CLI: {
          enabled: true,
          timeoutMs: 600000,
          startupSilenceTimeoutMs: 60_000,
          bypassApprovalsAndSandbox: false,
        },
        MOCK_CLI: {
          enabled: true,
          timeoutMs: 600000,
          startupSilenceTimeoutMs: 60_000,
          bypassApprovalsAndSandbox: false,
        },
      },
    });
    expect(output[0]).toContain("Setup: Telegram mode enables remote");
    expect(output[1]).toContain("Setup: SOUL.md stores IxADO");
    expect(
      output.some((line) => line.includes("Setup: Internal work adapter")),
    ).toBe(true);
    expect(
      output.some((line) => line.includes("installed and available in PATH")),
    ).toBe(true);
    expect(output.some((line) => line.includes("press Enter to keep"))).toBe(
      true,
    );
    await expect(loadCliSettings(settingsFilePath)).resolves.toEqual(settings);
    const soul = await Bun.file(soulFilePath).text();
    expect(soul).toContain("Personality: Concise and pragmatic");
  });

  test("onboard retries invalid answer and stores no as disabled", async () => {
    const answers = [
      "",
      "700000",
      "",
      "700000",
      "",
      "700000",
      "",
      "700000",
      "invalid",
      "3",
      "Reliable and precise",
      "maybe",
      "no",
    ];
    let idx = 0;

    const settings = await runOnboard(
      settingsFilePath,
      soulFilePath,
      async () => answers[idx++] ?? "",
      async () => {},
    );

    expect(settings).toEqual({
      projects: [],
      telegram: {
        enabled: false,
        notifications: DEFAULT_TELEGRAM_NOTIFICATIONS,
      },
      internalWork: { assignee: "GEMINI_CLI" },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      exceptionRecovery: DEFAULT_EXCEPTION_RECOVERY_SETTINGS,
      usage: DEFAULT_USAGE_SETTINGS,
      agents: {
        CODEX_CLI: {
          enabled: true,
          timeoutMs: 700000,
          startupSilenceTimeoutMs: 60_000,
          bypassApprovalsAndSandbox: false,
        },
        CLAUDE_CLI: {
          enabled: true,
          timeoutMs: 700000,
          startupSilenceTimeoutMs: 60_000,
          bypassApprovalsAndSandbox: false,
        },
        GEMINI_CLI: {
          enabled: true,
          timeoutMs: 700000,
          startupSilenceTimeoutMs: 60_000,
          bypassApprovalsAndSandbox: false,
        },
        MOCK_CLI: {
          enabled: true,
          timeoutMs: 700000,
          startupSilenceTimeoutMs: 60_000,
          bypassApprovalsAndSandbox: false,
        },
      },
    });
  });

  test("onboard retries invalid bot token and owner ID", async () => {
    const answers = [
      "y",
      "800000",
      "y",
      "800000",
      "y",
      "800000",
      "y",
      "800000",
      "4",
      "Pragmatic helper",
      "y",
      "",
      "token",
      "abc",
      "0",
      "42",
    ];
    let idx = 0;

    const settings = await runOnboard(
      settingsFilePath,
      soulFilePath,
      async () => answers[idx++] ?? "",
      async () => {},
    );

    expect(settings).toEqual({
      projects: [],
      telegram: {
        enabled: true,
        botToken: "token",
        ownerId: 42,
        notifications: DEFAULT_TELEGRAM_NOTIFICATIONS,
      },
      internalWork: {
        assignee: "MOCK_CLI",
      },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      exceptionRecovery: DEFAULT_EXCEPTION_RECOVERY_SETTINGS,
      usage: DEFAULT_USAGE_SETTINGS,
      agents: {
        CODEX_CLI: {
          enabled: true,
          timeoutMs: 800000,
          startupSilenceTimeoutMs: 60_000,
          bypassApprovalsAndSandbox: false,
        },
        CLAUDE_CLI: {
          enabled: true,
          timeoutMs: 800000,
          startupSilenceTimeoutMs: 60_000,
          bypassApprovalsAndSandbox: false,
        },
        GEMINI_CLI: {
          enabled: true,
          timeoutMs: 800000,
          startupSilenceTimeoutMs: 60_000,
          bypassApprovalsAndSandbox: false,
        },
        MOCK_CLI: {
          enabled: true,
          timeoutMs: 800000,
          startupSilenceTimeoutMs: 60_000,
          bypassApprovalsAndSandbox: false,
        },
      },
    });
  });

  test("onboard supports pressing enter to keep existing values", async () => {
    await saveCliSettings(settingsFilePath, {
      projects: [],
      telegram: {
        enabled: true,
        botToken: "existing-token",
        ownerId: 999,
        notifications: DEFAULT_TELEGRAM_NOTIFICATIONS,
      },
      internalWork: {
        assignee: "GEMINI_CLI",
      },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      exceptionRecovery: DEFAULT_EXCEPTION_RECOVERY_SETTINGS,
      usage: DEFAULT_USAGE_SETTINGS,
      agents: DEFAULT_AGENT_SETTINGS,
    });
    await saveSoulFile(soulFilePath, "Existing soul");

    const answers = ["", "", "", "", "", "", "", "", "", "", ""];
    let idx = 0;

    const settings = await runOnboard(
      settingsFilePath,
      soulFilePath,
      async () => answers[idx++] ?? "",
      async () => {},
    );

    expect(settings).toEqual({
      projects: [],
      telegram: {
        enabled: true,
        botToken: "existing-token",
        ownerId: 999,
        notifications: DEFAULT_TELEGRAM_NOTIFICATIONS,
      },
      internalWork: {
        assignee: "GEMINI_CLI",
      },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      exceptionRecovery: DEFAULT_EXCEPTION_RECOVERY_SETTINGS,
      usage: DEFAULT_USAGE_SETTINGS,
      agents: DEFAULT_AGENT_SETTINGS,
    });

    const soul = await Bun.file(soulFilePath).text();
    expect(soul).toContain("Personality: Existing soul");
  });

  test("onboard pressing enter on missing existing value asks again", async () => {
    const answers = [
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "New personality",
      "y",
      "",
      "token",
      "",
      "123",
    ];
    let idx = 0;
    const output: string[] = [];

    const settings = await runOnboard(
      settingsFilePath,
      soulFilePath,
      async () => answers[idx++] ?? "",
      async (line) => {
        output.push(line);
      },
    );

    expect(settings).toEqual({
      projects: [],
      telegram: {
        enabled: true,
        botToken: "token",
        ownerId: 123,
        notifications: DEFAULT_TELEGRAM_NOTIFICATIONS,
      },
      internalWork: {
        assignee: "CODEX_CLI",
      },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      exceptionRecovery: DEFAULT_EXCEPTION_RECOVERY_SETTINGS,
      usage: DEFAULT_USAGE_SETTINGS,
      agents: DEFAULT_AGENT_SETTINGS,
    });
    expect(
      output.some((line) => line.includes("No existing SOUL profile found")),
    ).toBe(true);
    expect(
      output.some((line) =>
        line.includes("No existing Telegram bot token found"),
      ),
    ).toBe(true);
    expect(
      output.some((line) =>
        line.includes("No existing Telegram owner ID found"),
      ),
    ).toBe(true);
  });
});
