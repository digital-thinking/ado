import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveCliLogFilePath } from "./logging";

describe("cli logging", () => {
  let sandboxDir: string;
  const originalGlobalConfigPath = process.env.IXADO_GLOBAL_CONFIG_FILE;
  const originalCliLogPath = process.env.IXADO_CLI_LOG_FILE;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-cli-logging-"));
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
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("defaults CLI log path to global .ixado folder", () => {
    process.env.IXADO_GLOBAL_CONFIG_FILE = join(
      sandboxDir,
      ".ixado",
      "config.json",
    );

    expect(resolveCliLogFilePath(join(sandboxDir, "project"))).toBe(
      join(sandboxDir, ".ixado", "cli.log"),
    );
  });

  test("uses IXADO_CLI_LOG_FILE when configured", () => {
    const customLogFilePath = join(sandboxDir, "custom", "cli.log");
    process.env.IXADO_CLI_LOG_FILE = customLogFilePath;

    expect(resolveCliLogFilePath(join(sandboxDir, "project"))).toBe(
      customLogFilePath,
    );
  });
});
