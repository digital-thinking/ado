import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_CLI_SETTINGS,
  loadCliSettings,
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
};

describe("cli settings", () => {
  let sandboxDir: string;
  let settingsFilePath: string;
  let soulFilePath: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-cli-settings-"));
    settingsFilePath = join(sandboxDir, "settings.json");
    soulFilePath = join(sandboxDir, "SOUL.md");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("returns defaults when settings file is missing", async () => {
    const settings = await loadCliSettings(settingsFilePath);
    expect(settings).toEqual(DEFAULT_CLI_SETTINGS);
  });

  test("saves and loads settings", async () => {
    await saveCliSettings(settingsFilePath, {
      telegram: {
        enabled: true,
        botToken: "abc",
        ownerId: 123,
      },
      internalWork: {
        assignee: "CLAUDE_CLI",
      },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      agents: DEFAULT_AGENT_SETTINGS,
    });

    const settings = await loadCliSettings(settingsFilePath);
    expect(settings).toEqual({
      telegram: {
        enabled: true,
        botToken: "abc",
        ownerId: 123,
      },
      internalWork: {
        assignee: "CLAUDE_CLI",
      },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      agents: DEFAULT_AGENT_SETTINGS,
    });
  });

  test("fails for invalid settings json", async () => {
    await Bun.write(settingsFilePath, "{invalid");
    await expect(loadCliSettings(settingsFilePath)).rejects.toThrow(
      `Settings file contains invalid JSON: ${settingsFilePath}`
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
      }
    );

    expect(settings).toEqual({
      telegram: {
        enabled: true,
        botToken: "my-token",
        ownerId: 123456,
      },
      internalWork: {
        assignee: "CLAUDE_CLI",
      },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      agents: {
        CODEX_CLI: { enabled: true, timeoutMs: 600000 },
        CLAUDE_CLI: { enabled: true, timeoutMs: 600000 },
        GEMINI_CLI: { enabled: true, timeoutMs: 600000 },
        MOCK_CLI: { enabled: true, timeoutMs: 600000 },
      },
    });
    expect(output[0]).toContain("Setup: Telegram mode enables remote");
    expect(output[1]).toContain("Setup: SOUL.md stores IxADO");
    expect(output.some((line) => line.includes("Setup: Internal work adapter"))).toBe(true);
    expect(output.some((line) => line.includes("installed and available in PATH"))).toBe(true);
    expect(output.some((line) => line.includes("press 'S' to keep"))).toBe(true);
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
      async () => {}
    );

    expect(settings).toEqual({
      telegram: { enabled: false },
      internalWork: { assignee: "GEMINI_CLI" },
      executionLoop: DEFAULT_LOOP_SETTINGS,
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
      async () => {}
    );

    expect(settings).toEqual({
      telegram: {
        enabled: true,
        botToken: "token",
        ownerId: 42,
      },
      internalWork: {
        assignee: "MOCK_CLI",
      },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      agents: {
        CODEX_CLI: { enabled: true, timeoutMs: 800000 },
        CLAUDE_CLI: { enabled: true, timeoutMs: 800000 },
        GEMINI_CLI: { enabled: true, timeoutMs: 800000 },
        MOCK_CLI: { enabled: true, timeoutMs: 800000 },
      },
    });
  });

  test("onboard supports skip key to keep existing values", async () => {
    await saveCliSettings(settingsFilePath, {
      telegram: {
        enabled: true,
        botToken: "existing-token",
        ownerId: 999,
      },
      internalWork: {
        assignee: "GEMINI_CLI",
      },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      agents: DEFAULT_AGENT_SETTINGS,
    });
    await saveSoulFile(soulFilePath, "Existing soul");

    const answers = [
      "s",
      "s",
      "s",
      "s",
      "s",
      "s",
      "s",
      "s",
      "s",
      "s",
      "s",
    ];
    let idx = 0;

    const settings = await runOnboard(
      settingsFilePath,
      soulFilePath,
      async () => answers[idx++] ?? "",
      async () => {}
    );

    expect(settings).toEqual({
      telegram: {
        enabled: true,
        botToken: "existing-token",
        ownerId: 999,
      },
      internalWork: {
        assignee: "GEMINI_CLI",
      },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      agents: DEFAULT_AGENT_SETTINGS,
    });

    const soul = await Bun.file(soulFilePath).text();
    expect(soul).toContain("Personality: Existing soul");
  });

  test("onboard skip on missing existing value asks again", async () => {
    const answers = [
      "s",
      "s",
      "s",
      "s",
      "s",
      "s",
      "s",
      "s",
      "s",
      "s",
      "New personality",
      "y",
      "s",
      "token",
      "s",
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
      }
    );

    expect(settings).toEqual({
      telegram: {
        enabled: true,
        botToken: "token",
        ownerId: 123,
      },
      internalWork: {
        assignee: "CODEX_CLI",
      },
      executionLoop: DEFAULT_LOOP_SETTINGS,
      agents: DEFAULT_AGENT_SETTINGS,
    });
    expect(output.some((line) => line.includes("No existing SOUL profile found"))).toBe(true);
    expect(output.some((line) => line.includes("No existing Telegram bot token found"))).toBe(true);
    expect(output.some((line) => line.includes("No existing Telegram owner ID found"))).toBe(true);
  });
});
