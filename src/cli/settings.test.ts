import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TestSandbox } from "./test-helpers";

import {
  DEFAULT_CLI_SETTINGS,
  loadCliSettings,
  resolveOnboardSettingsFilePath,
  resolveOnboardSoulFilePath,
  saveSoulFile,
  runOnboard,
  saveCliSettings,
} from "./settings";

const DEFAULT_AGENT_SETTINGS = {
  CODEX_CLI: { enabled: true, timeoutMs: 3_600_000 },
  CLAUDE_CLI: { enabled: true, timeoutMs: 3_600_000 },
  GEMINI_CLI: { enabled: true, timeoutMs: 3_600_000 },
  MOCK_CLI: { enabled: true, timeoutMs: 3_600_000 },
};

const DEFAULT_LOOP_SETTINGS = {
  autoMode: false,
  countdownSeconds: 10,
  testerCommand: "npm",
  testerArgs: ["run", "test"],
  testerTimeoutMs: 600000,
  ciEnabled: false,
  ciBaseBranch: "main",
  validationMaxRetries: 3,
};
const DEFAULT_EXCEPTION_RECOVERY_SETTINGS = {
  maxAttempts: 1,
};
const DEFAULT_USAGE_SETTINGS = {
  codexbarEnabled: true,
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

  test("loads settings from global config when local file is missing", async () => {
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
    expect(settings).toEqual({
      ...DEFAULT_CLI_SETTINGS,
      internalWork: {
        assignee: "CLAUDE_CLI",
      },
      executionLoop: {
        ...DEFAULT_CLI_SETTINGS.executionLoop,
        autoMode: true,
        countdownSeconds: 42,
      },
    });
  });

  test("local settings override global config values", async () => {
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
    expect(settings.executionLoop.testerCommand).toBe("bun");
    expect(settings.executionLoop.testerArgs).toEqual(["test"]);
    expect(settings.executionLoop.countdownSeconds).toBe(3);
    expect(settings.exceptionRecovery.maxAttempts).toBe(4);
    expect(settings.agents.CODEX_CLI.timeoutMs).toBe(7000);
  });

  test("supports overriding codexbar usage telemetry from global and local config", async () => {
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
      },
      internalWork: {
        assignee: "CLAUDE_CLI",
      },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      exceptionRecovery: DEFAULT_EXCEPTION_RECOVERY_SETTINGS,
      usage: DEFAULT_USAGE_SETTINGS,
      agents: {
        CODEX_CLI: { enabled: true, timeoutMs: 600000 },
        CLAUDE_CLI: { enabled: true, timeoutMs: 600000 },
        GEMINI_CLI: { enabled: true, timeoutMs: 600000 },
        MOCK_CLI: { enabled: true, timeoutMs: 600000 },
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
      telegram: { enabled: false },
      internalWork: { assignee: "GEMINI_CLI" },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      exceptionRecovery: DEFAULT_EXCEPTION_RECOVERY_SETTINGS,
      usage: DEFAULT_USAGE_SETTINGS,
      agents: {
        CODEX_CLI: { enabled: true, timeoutMs: 700000 },
        CLAUDE_CLI: { enabled: true, timeoutMs: 700000 },
        GEMINI_CLI: { enabled: true, timeoutMs: 700000 },
        MOCK_CLI: { enabled: true, timeoutMs: 700000 },
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
      },
      internalWork: {
        assignee: "MOCK_CLI",
      },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      exceptionRecovery: DEFAULT_EXCEPTION_RECOVERY_SETTINGS,
      usage: DEFAULT_USAGE_SETTINGS,
      agents: {
        CODEX_CLI: { enabled: true, timeoutMs: 800000 },
        CLAUDE_CLI: { enabled: true, timeoutMs: 800000 },
        GEMINI_CLI: { enabled: true, timeoutMs: 800000 },
        MOCK_CLI: { enabled: true, timeoutMs: 800000 },
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
