import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ProjectState } from "../types";

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

async function readStateFile(projectDir: string): Promise<ProjectState> {
  const raw = await readFile(join(projectDir, ".ixado", "state.json"), "utf8");
  return JSON.parse(raw) as ProjectState;
}

describe("phase13 CLI create commands", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  test("phase create creates and activates a phase", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "ixado-p13-phase-create-"));
    tempDirs.push(projectDir);
    const globalConfigFile = join(projectDir, ".ixado", "global-config.json");

    const result = runCli(
      ["phase", "create", "Phase 13", "phase-13-post-release-bugfixes"],
      projectDir,
      globalConfigFile,
    );
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Created phase Phase 13");

    const state = await readStateFile(projectDir);
    expect(state.phases).toHaveLength(1);
    expect(state.activePhaseId).toBe(state.phases[0]?.id);
    expect(state.phases[0]?.name).toBe("Phase 13");
    expect(state.phases[0]?.branchName).toBe("phase-13-post-release-bugfixes");
  });

  test("task create appends task to active phase and validates usage", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "ixado-p13-task-create-"));
    tempDirs.push(projectDir);
    const globalConfigFile = join(projectDir, ".ixado", "global-config.json");

    const phaseCreateResult = runCli(
      ["phase", "create", "Phase 13", "phase-13-post-release-bugfixes"],
      projectDir,
      globalConfigFile,
    );
    expect(phaseCreateResult.exitCode).toBe(0);

    const taskCreateResult = runCli(
      ["task", "create", "P13-002", "Implement CLI create flows", "MOCK_CLI"],
      projectDir,
      globalConfigFile,
    );
    expect(taskCreateResult.exitCode).toBe(0);

    const state = await readStateFile(projectDir);
    expect(state.phases[0]?.tasks).toHaveLength(1);
    expect(state.phases[0]?.tasks[0]?.title).toBe("P13-002");
    expect(state.phases[0]?.tasks[0]?.assignee).toBe("MOCK_CLI");

    const invalidUsageResult = runCli(
      ["task", "create", "missing-description-only"],
      projectDir,
      globalConfigFile,
    );
    const usageStderr = new TextDecoder().decode(invalidUsageResult.stderr);
    expect(invalidUsageResult.exitCode).toBe(1);
    expect(usageStderr).toContain(
      "Usage: ixado task create <title> <description> [assignee]",
    );

    const invalidAssigneeResult = runCli(
      [
        "task",
        "create",
        "P13-002",
        "Implement CLI create flows",
        "BAD_ASSIGNEE",
      ],
      projectDir,
      globalConfigFile,
    );
    const invalidAssigneeStderr = new TextDecoder().decode(
      invalidAssigneeResult.stderr,
    );
    expect(invalidAssigneeResult.exitCode).toBe(1);
    expect(invalidAssigneeStderr).toContain(
      "assignee must be one of: MOCK_CLI, CLAUDE_CLI, GEMINI_CLI, CODEX_CLI, UNASSIGNED",
    );
  });

  test("phase/task subcommand help is explicit and succeeds", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "ixado-p13-sub-help-"));
    tempDirs.push(projectDir);
    const globalConfigFile = join(projectDir, ".ixado", "global-config.json");

    const phaseHelp = runCli(["phase", "--help"], projectDir, globalConfigFile);
    const phaseHelpOut = new TextDecoder().decode(phaseHelp.stdout);
    expect(phaseHelp.exitCode).toBe(0);
    expect(phaseHelpOut).toContain("Phase commands:");
    expect(phaseHelpOut).toContain("ixado phase create <name> <branchName>");

    const taskHelp = runCli(["task", "--help"], projectDir, globalConfigFile);
    const taskHelpOut = new TextDecoder().decode(taskHelp.stdout);
    expect(taskHelp.exitCode).toBe(0);
    expect(taskHelpOut).toContain("Task commands:");
    expect(taskHelpOut).toContain(
      "ixado task create <title> <description> [assignee]",
    );
  });
});
