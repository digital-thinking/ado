import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_CLI_SETTINGS,
  loadCliSettings,
  runOnboard,
  saveCliSettings,
} from "./settings";

describe("cli settings", () => {
  let sandboxDir: string;
  let settingsFilePath: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-cli-settings-"));
    settingsFilePath = join(sandboxDir, "settings.json");
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
    });

    const settings = await loadCliSettings(settingsFilePath);
    expect(settings).toEqual({
      telegram: {
        enabled: true,
        botToken: "abc",
        ownerId: 123,
      },
    });
  });

  test("fails for invalid settings json", async () => {
    await Bun.write(settingsFilePath, "{invalid");
    await expect(loadCliSettings(settingsFilePath)).rejects.toThrow(
      `Settings file contains invalid JSON: ${settingsFilePath}`
    );
  });

  test("onboard accepts yes and persists telegram bot settings", async () => {
    const answers = ["y", "my-token", "123456"];
    let idx = 0;
    const output: string[] = [];

    const settings = await runOnboard(
      settingsFilePath,
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
    });
    expect(output[0]).toContain("Setup: Telegram mode enables remote");
    await expect(loadCliSettings(settingsFilePath)).resolves.toEqual(settings);
  });

  test("onboard retries invalid answer and stores no as disabled", async () => {
    const answers = ["maybe", "no"];
    let idx = 0;

    const settings = await runOnboard(
      settingsFilePath,
      async () => answers[idx++] ?? "",
      async () => {}
    );

    expect(settings).toEqual({
      telegram: { enabled: false },
    });
  });

  test("onboard retries invalid bot token and owner ID", async () => {
    const answers = ["y", "", "token", "abc", "0", "42"];
    let idx = 0;

    const settings = await runOnboard(
      settingsFilePath,
      async () => answers[idx++] ?? "",
      async () => {}
    );

    expect(settings).toEqual({
      telegram: {
        enabled: true,
        botToken: "token",
        ownerId: 42,
      },
    });
  });
});
