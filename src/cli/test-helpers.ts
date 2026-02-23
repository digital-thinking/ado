import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProjectState } from "../types";

export interface RunCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the IxADO CLI with given arguments in a specified directory.
 */
export function runCli(
  args: string[],
  cwd: string,
  globalConfigFile: string,
): RunCliResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", resolve("src/cli/index.ts"), ...args],
    cwd,
    env: {
      ...process.env,
      IXADO_GLOBAL_CONFIG_FILE: globalConfigFile,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

/**
 * Convenience wrapper for runCli.
 */
export function runIxado(args: string[], sandbox: TestSandbox): RunCliResult {
  return runCli(args, sandbox.projectDir, sandbox.globalConfigFile);
}

/**
 * Helper to manage a temporary project directory for testing.
 */
export class TestSandbox {
  constructor(
    public readonly projectDir: string,
    public readonly globalConfigFile: string,
  ) {}

  static async create(prefix: string): Promise<TestSandbox> {
    const projectDir = await mkdtemp(join(tmpdir(), prefix));
    // Ensure .ixado directory exists as it's used for both global config and local state
    await mkdir(join(projectDir, ".ixado"), { recursive: true });
    const globalConfigFile = join(projectDir, ".ixado", "global-config.json");
    return new TestSandbox(projectDir, globalConfigFile);
  }

  async readProjectState(): Promise<ProjectState> {
    const raw = await readFile(
      join(this.projectDir, ".ixado", "state.json"),
      "utf8",
    );
    return JSON.parse(raw) as ProjectState;
  }

  async cleanup(): Promise<void> {
    await rm(this.projectDir, { recursive: true, force: true });
  }
}
