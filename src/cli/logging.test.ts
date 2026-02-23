import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveCliLogFilePath } from "./logging";
import { TestSandbox } from "./test-helpers";

describe("cli logging", () => {
  let sandbox: TestSandbox;
  const originalGlobalConfigPath = process.env.IXADO_GLOBAL_CONFIG_FILE;
  const originalCliLogPath = process.env.IXADO_CLI_LOG_FILE;

  beforeEach(async () => {
    sandbox = await TestSandbox.create("ixado-cli-logging-");
    delete process.env.IXADO_GLOBAL_CONFIG_FILE;
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
    process.env.IXADO_GLOBAL_CONFIG_FILE = sandbox.globalConfigFile;

    expect(resolveCliLogFilePath(join(sandbox.projectDir, "project"))).toBe(
      join(sandbox.projectDir, ".ixado", "cli.log"),
    );
  });

  test("uses IXADO_CLI_LOG_FILE when configured", () => {
    const customLogFilePath = join(sandbox.projectDir, "custom", "cli.log");
    process.env.IXADO_CLI_LOG_FILE = customLogFilePath;

    expect(resolveCliLogFilePath(join(sandbox.projectDir, "project"))).toBe(
      customLogFilePath,
    );
  });
});
