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
      telegram: { enabled: true },
    });

    const settings = await loadCliSettings(settingsFilePath);
    expect(settings).toEqual({
      telegram: { enabled: true },
    });
  });

  test("fails for invalid settings json", async () => {
    await Bun.write(settingsFilePath, "{invalid");
    await expect(loadCliSettings(settingsFilePath)).rejects.toThrow(
      `Settings file contains invalid JSON: ${settingsFilePath}`
    );
  });

  test("onboard accepts yes and persists telegram enabled", async () => {
    const settings = await runOnboard(settingsFilePath, async () => "y");

    expect(settings).toEqual({
      telegram: { enabled: true },
    });
    await expect(loadCliSettings(settingsFilePath)).resolves.toEqual(settings);
  });

  test("onboard retries invalid answer and stores no as disabled", async () => {
    const answers = ["maybe", "no"];
    let idx = 0;

    const settings = await runOnboard(settingsFilePath, async () => answers[idx++] ?? "");

    expect(settings).toEqual({
      telegram: { enabled: false },
    });
  });
});
