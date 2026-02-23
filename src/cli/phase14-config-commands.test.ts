import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function runCli(args: string[], cwd: string, globalConfigFile: string) {
  return Bun.spawnSync({
    cmd: [process.execPath, "run", resolve("src/cli/index.ts"), ...args],
    cwd,
    env: {
      ...process.env,
      IXADO_GLOBAL_CONFIG_FILE: globalConfigFile,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("phase14 CLI config commands", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  test("config help includes recovery command", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "ixado-p14-config-help-"));
    tempDirs.push(projectDir);
    const globalConfigFile = join(projectDir, ".ixado", "global-config.json");

    const result = runCli(["config", "help"], projectDir, globalConfigFile);
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Config commands:");
    expect(stdout).toContain("ixado config recovery <maxAttempts:0-10>");
  });

  test("config recovery updates and shows exception recovery max attempts", async () => {
    const projectDir = await mkdtemp(
      join(tmpdir(), "ixado-p14-config-recovery-"),
    );
    tempDirs.push(projectDir);
    const globalConfigFile = join(projectDir, ".ixado", "global-config.json");

    const updateResult = runCli(
      ["config", "recovery", "3"],
      projectDir,
      globalConfigFile,
    );
    const updateOut = new TextDecoder().decode(updateResult.stdout);
    const updateErr = new TextDecoder().decode(updateResult.stderr);
    expect(updateResult.exitCode).toBe(0);
    expect(updateErr).toBe("");
    expect(updateOut).toContain("Exception recovery max attempts set to 3.");

    const showResult = runCli(["config"], projectDir, globalConfigFile);
    const showOut = new TextDecoder().decode(showResult.stdout);
    const showErr = new TextDecoder().decode(showResult.stderr);
    expect(showResult.exitCode).toBe(0);
    expect(showErr).toBe("");
    expect(showOut).toContain("Exception recovery max attempts: 3");
  });

  test("config recovery validates value range", async () => {
    const projectDir = await mkdtemp(
      join(tmpdir(), "ixado-p14-config-recovery-invalid-"),
    );
    tempDirs.push(projectDir);
    const globalConfigFile = join(projectDir, ".ixado", "global-config.json");

    const result = runCli(
      ["config", "recovery", "11"],
      projectDir,
      globalConfigFile,
    );
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("Usage: ixado config recovery <maxAttempts:0-10>");
  });
});
