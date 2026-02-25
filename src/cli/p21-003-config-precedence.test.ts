import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { TestSandbox, runIxado } from "./test-helpers";

describe("P21-003 config precedence messaging", () => {
  const sandboxes: TestSandbox[] = [];
  const originalSettingsPath = process.env.IXADO_SETTINGS_FILE;

  afterEach(async () => {
    if (originalSettingsPath === undefined) {
      delete process.env.IXADO_SETTINGS_FILE;
    } else {
      process.env.IXADO_SETTINGS_FILE = originalSettingsPath;
    }

    await Promise.all(sandboxes.map((s) => s.cleanup()));
    sandboxes.length = 0;
  });

  test("config show explains project-overrides-global precedence", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-003-local-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "show"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      `Settings file: ${join(sandbox.projectDir, ".ixado", "settings.json")}`,
    );
    expect(result.stdout).toContain(
      `Scope: project overrides (${join(sandbox.projectDir, ".ixado", "settings.json")}).`,
    );
    expect(result.stdout).toContain(
      `Precedence: project settings override global defaults (${sandbox.globalConfigFile}).`,
    );
  });

  test("config show explains global-default scope when settings file is global", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-003-global-");
    sandboxes.push(sandbox);

    process.env.IXADO_SETTINGS_FILE = sandbox.globalConfigFile;

    const result = runIxado(["config", "show"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      `Settings file: ${sandbox.globalConfigFile}`,
    );
    expect(result.stdout).toContain(
      `Scope: global defaults (${sandbox.globalConfigFile}).`,
    );
    expect(result.stdout).not.toContain(
      "Precedence: project settings override",
    );
  });

  test("config mutation commands include precedence message after save", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-003-save-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "mode", "auto"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Execution loop mode set to AUTO.");
    expect(result.stdout).toContain("Settings saved to");
    expect(result.stdout).toContain("Scope: project overrides");
    expect(result.stdout).toContain(
      `Precedence: project settings override global defaults (${sandbox.globalConfigFile}).`,
    );
  });
});
