import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { initializeCliLogging, resolveCliLogFilePath } from "./logging";
import { TestSandbox } from "./test-helpers";

describe("cli logging", () => {
  let sandbox: TestSandbox;
  const originalGlobalConfigPath = process.env.IXADO_GLOBAL_CONFIG_FILE;
  const originalCliLogPath = process.env.IXADO_CLI_LOG_FILE;

  beforeEach(async () => {
    sandbox = await TestSandbox.create("ixado-cli-logging-");
    process.env.IXADO_GLOBAL_CONFIG_FILE = sandbox.globalConfigFile;
    delete process.env.IXADO_CLI_LOG_FILE;
  });

  afterEach(async () => {
    if (originalGlobalConfigPath === undefined) {
      delete process.env.IXADO_GLOBAL_CONFIG_FILE;
    } else {
      process.env.IXADO_GLOBAL_CONFIG_FILE = originalGlobalConfigPath;
    }
    if (originalCliLogPath === undefined) {
      delete process.env.IXADO_CLI_LOG_FILE;
    } else {
      process.env.IXADO_CLI_LOG_FILE = originalCliLogPath;
    }
    await sandbox.cleanup();
  });

  test("defaults CLI log path to global .ixado folder", () => {
    expect(resolveCliLogFilePath(join(sandbox.projectDir, "project"))).toBe(
      join(dirname(sandbox.globalConfigFile), "cli.log"),
    );
  });

  test("uses IXADO_CLI_LOG_FILE when configured", () => {
    const customLogFilePath = join(sandbox.projectDir, "custom", "cli.log");
    process.env.IXADO_CLI_LOG_FILE = customLogFilePath;

    expect(resolveCliLogFilePath(join(sandbox.projectDir, "project"))).toBe(
      customLogFilePath,
    );
  });

  test("initializes logging with default global path", () => {
    const cwd = join(sandbox.projectDir, "project-default");
    const logFilePath = initializeCliLogging(cwd);

    expect(logFilePath).toBe(
      join(dirname(sandbox.globalConfigFile), "cli.log"),
    );
    expect(existsSync(logFilePath)).toBe(true);
  });

  test("initializes logging with explicit writable override path", () => {
    const customLogFilePath = join(sandbox.projectDir, "override", "cli.log");
    process.env.IXADO_CLI_LOG_FILE = customLogFilePath;

    const initializedPath = initializeCliLogging(sandbox.projectDir);

    expect(initializedPath).toBe(customLogFilePath);
    expect(existsSync(customLogFilePath)).toBe(true);
  });
  test("fails fast with actionable error for invalid override path", () => {
    const badParent = join(sandbox.projectDir, "not-a-dir");
    writeFileSync(badParent, "x", "utf8");
    process.env.IXADO_CLI_LOG_FILE = join(badParent, "child", "cli.log");

    expect(() => initializeCliLogging(sandbox.projectDir)).toThrow(
      /Failed to initialize CLI logging.*Set IXADO_CLI_LOG_FILE to a writable file path\./,
    );
  });
});
