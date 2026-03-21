import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { TestSandbox } from "./test-helpers";

type RunCliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function runIxadoWithPath(
  args: string[],
  sandbox: TestSandbox,
  pathPrefix: string,
): RunCliResult {
  const sandboxStateFile = join(sandbox.projectDir, ".ixado", "state.json");
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", resolve("src/cli/index.ts"), ...args],
    cwd: sandbox.projectDir,
    env: {
      ...process.env,
      PATH: `${pathPrefix}:${process.env.PATH ?? ""}`,
      IXADO_GLOBAL_CONFIG_FILE: sandbox.globalConfigFile,
      IXADO_STATE_FILE: sandboxStateFile,
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

async function installCodexPwdStub(
  sandbox: TestSandbox,
  cwdFilePath: string,
): Promise<string> {
  const binDir = join(sandbox.projectDir, ".test-bin");
  await mkdir(binDir, { recursive: true });
  const codexPath = join(binDir, "codex");
  const script = `#!/usr/bin/env bash
set -euo pipefail

pwd > "${cwdFilePath}"
cat >/dev/null
printf 'stub ok\\n'
`;
  await writeFile(codexPath, script, "utf8");
  await chmod(codexPath, 0o755);
  return binDir;
}

describe("P36 QA CLI regressions", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((sandbox) => sandbox.cleanup()));
    sandboxes.length = 0;
  });

  test("task start launches the worker from the phase worktree cwd", async () => {
    const sandbox = await TestSandbox.create("ixado-p36-cli-worktree-cwd-");
    sandboxes.push(sandbox);

    const phaseId = randomUUID();
    const taskId = randomUUID();
    const now = new Date().toISOString();
    const worktreePath = join(sandbox.projectDir, ".ixado", "worktree-phase");
    const cwdFilePath = join(sandbox.projectDir, ".ixado", "worker-cwd.txt");
    await mkdir(worktreePath, { recursive: true });

    await sandbox.writeProjectState({
      projectName: "test-project",
      rootDir: sandbox.projectDir,
      createdAt: now,
      updatedAt: now,
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 36",
          branchName: "phase-36-execution-dag",
          status: "CODING",
          worktreePath,
          tasks: [
            {
              id: taskId,
              title: "Run worker in phase worktree",
              description: "Ensure CLI task execution respects worktree cwd.",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
          ],
        },
      ],
    } as any);

    const codexBinDir = await installCodexPwdStub(sandbox, cwdFilePath);
    const result = runIxadoWithPath(
      ["task", "start", "1", "CODEX_CLI"],
      sandbox,
      codexBinDir,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Task #1 Run worker in phase worktree finished with status DONE.",
    );

    const launchedFromCwd = (await readFile(cwdFilePath, "utf8")).trim();
    expect(launchedFromCwd).toBe(worktreePath);

    const state = await sandbox.readProjectState();
    expect(state.phases[0]?.tasks[0]?.status).toBe("DONE");
  });

  test("status reports live running agents without reconciling them away", async () => {
    const sandbox = await TestSandbox.create("ixado-p36-cli-status-running-");
    sandboxes.push(sandbox);

    const phaseId = randomUUID();
    const taskId = randomUUID();
    const now = new Date().toISOString();

    await sandbox.writeProjectState({
      projectName: "test-project",
      rootDir: sandbox.projectDir,
      createdAt: now,
      updatedAt: now,
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 36",
          branchName: "phase-36-execution-dag",
          status: "CODING",
          tasks: [
            {
              id: taskId,
              title: "Observe live agent",
              description:
                "Status should show live agents without mutating them.",
              status: "IN_PROGRESS",
              assignee: "CODEX_CLI",
              dependencies: [],
            },
          ],
        },
      ],
    } as any);
    await sandbox.writeAgents([
      {
        id: randomUUID(),
        name: "CODEX_CLI task worker",
        command: "codex",
        args: ["exec", "-"],
        cwd: sandbox.projectDir,
        phaseId,
        taskId,
        adapterId: "CODEX_CLI",
        projectName: "test-project",
        status: "RUNNING",
        startedAt: now,
        outputTail: [],
      },
    ]);

    const result = runIxadoWithPath(["status"], sandbox, sandbox.projectDir);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Running Agents (1):");
    expect(result.stdout).toContain("CODEX_CLI task worker");

    const persistedAgents = JSON.parse(
      await readFile(join(sandbox.projectDir, ".ixado", "agents.json"), "utf8"),
    ) as Array<{ status: string }>;
    expect(persistedAgents[0]?.status).toBe("RUNNING");
  });
});
