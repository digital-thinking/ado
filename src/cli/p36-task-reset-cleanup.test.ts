import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { buildRaceWorktreeId } from "../engine/race-orchestrator";
import { TestSandbox, runIxado } from "./test-helpers";

type RunCliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function runGit(args: string[], cwd: string): RunCliResult {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

async function initGitRepo(cwd: string): Promise<void> {
  const init = runGit(["init", "-b", "main"], cwd);
  if (init.exitCode !== 0) {
    throw new Error(`git init failed: ${init.stderr || init.stdout}`);
  }

  for (const args of [
    ["config", "user.email", "ixado-tests@example.com"],
    ["config", "user.name", "IxADO Tests"],
  ]) {
    const result = runGit(args, cwd);
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
      );
    }
  }

  await Bun.write(join(cwd, "README.md"), "ixado\n");
  await Bun.write(join(cwd, ".gitignore"), ".ixado/\n");
  for (const args of [
    ["add", "README.md", ".gitignore"],
    ["commit", "-m", "chore: init"],
  ]) {
    const result = runGit(args, cwd);
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
      );
    }
  }
}

describe("P36 task reset cleanup", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((sandbox) => sandbox.cleanup()));
    sandboxes.length = 0;
  });

  test("task reset stops lingering task agents and removes race worktrees", async () => {
    const sandbox = await TestSandbox.create("ixado-p36-task-reset-cleanup-");
    sandboxes.push(sandbox);
    await initGitRepo(sandbox.projectDir);

    const phaseId = randomUUID();
    const taskId = randomUUID();
    const now = new Date().toISOString();
    const baseBranchName = "phase-36-execution-dag";
    const raceWorktreeIds = [1, 2].map((index) =>
      buildRaceWorktreeId(phaseId, taskId, index),
    );
    const raceWorktreePaths = raceWorktreeIds.map((worktreeId) =>
      resolve(sandbox.projectDir, ".ixado", "worktrees", worktreeId),
    );

    await sandbox.writeProjectState({
      projectName: "ado",
      rootDir: sandbox.projectDir,
      createdAt: now,
      updatedAt: now,
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 36",
          branchName: baseBranchName,
          status: "CODING",
          tasks: [
            {
              id: taskId,
              title: "Reset raced task",
              description: "Ensure reset cleans stale execution artifacts.",
              status: "IN_PROGRESS",
              assignee: "GEMINI_CLI",
              race: 2,
              raceState: {
                status: "running",
                raceCount: 2,
                branches: [
                  {
                    index: 1,
                    branchName: `${baseBranchName}-race-${taskId}-1`,
                    status: "pending",
                  },
                  {
                    index: 2,
                    branchName: `${baseBranchName}-race-${taskId}-2`,
                    status: "pending",
                  },
                ],
                updatedAt: now,
              },
              dependencies: [],
            },
          ],
        },
      ],
    } as any);

    for (const [index, worktreePath] of raceWorktreePaths.entries()) {
      const branchName = `${baseBranchName}-race-${taskId}-${index + 1}`;
      const add = runGit(
        ["worktree", "add", worktreePath, "-b", branchName, "HEAD"],
        sandbox.projectDir,
      );
      if (add.exitCode !== 0) {
        throw new Error(`git worktree add failed: ${add.stderr || add.stdout}`);
      }
    }

    await sandbox.writeAgents([
      {
        id: randomUUID(),
        name: "Wedged race worker",
        command: "gemini",
        args: ["--yolo"],
        cwd: raceWorktreePaths[0],
        adapterId: "GEMINI_CLI",
        phaseId,
        taskId,
        status: "RUNNING",
        pid: 999999,
        startedAt: now,
        outputTail: [],
      },
    ]);

    const result = runIxado(["task", "reset", "1"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Task #1 reset to TODO and repository hard-reset to last commit.",
    );
    expect(result.stdout).toContain(
      "Recovered: stopped 1 lingering task agent(s).",
    );
    expect(result.stdout).toContain(
      "Recovered: removed 2 lingering race worktree(s).",
    );

    const state = await sandbox.readProjectState();
    expect(state.phases[0]?.tasks[0]?.status).toBe("TODO");
    expect(state.phases[0]?.tasks[0]?.assignee).toBe("UNASSIGNED");
    expect(state.phases[0]?.tasks[0]?.raceState).toBeUndefined();

    const agents = JSON.parse(
      await readFile(join(sandbox.projectDir, ".ixado", "agents.json"), "utf8"),
    ) as Array<{ status: string }>;
    expect(agents[0]?.status).toBe("STOPPED");
    for (const worktreePath of raceWorktreePaths) {
      expect(existsSync(worktreePath)).toBe(false);
    }

    await rm(join(sandbox.projectDir, ".git", "worktrees"), {
      recursive: true,
      force: true,
    });
  });
});
