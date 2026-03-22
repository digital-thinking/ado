import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

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

  await writeFile(join(cwd, "README.md"), "ixado\n", "utf8");
  await writeFile(join(cwd, ".gitignore"), ".ixado/\n.test-bin*/\n", "utf8");
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

async function installRaceAwareCodexStub(
  sandbox: TestSandbox,
  invocationLogPath: string,
): Promise<string> {
  const binDir = join(sandbox.projectDir, ".test-bin-race");
  await mkdir(binDir, { recursive: true });
  const codexPath = join(binDir, "codex");
  const script = `#!/usr/bin/env bash
set -euo pipefail

prompt="$(cat)"
cwd="$(pwd)"
printf '%s\\n' "$cwd" >> "${invocationLogPath}"
if [[ "$prompt" == Race\\ Judge* ]]; then
  printf 'PICK 1\\nReasoning: stub judge.\\n'
  exit 0
fi

printf 'generated from %s\\n' "$cwd" > race-output.txt
printf 'stub ok\\n'
`;
  await writeFile(codexPath, script, "utf8");
  await chmod(codexPath, 0o755);
  return binDir;
}

async function installProviderFailoverStubs(
  sandbox: TestSandbox,
  invocationLogPath: string,
): Promise<string> {
  const binDir = join(sandbox.projectDir, ".test-bin-failover");
  await mkdir(binDir, { recursive: true });

  const claudePath = join(binDir, "claude");
  const claudeScript = `#!/usr/bin/env bash
set -euo pipefail

pwd >> "${invocationLogPath}"
echo "CLAUDE" >> "${invocationLogPath}"
printf "You're out of extra usage · resets 5pm (Europe/Berlin)\\n"
exit 1
`;
  await writeFile(claudePath, claudeScript, "utf8");
  await chmod(claudePath, 0o755);

  const geminiPath = join(binDir, "gemini");
  const geminiScript = `#!/usr/bin/env bash
set -euo pipefail

pwd >> "${invocationLogPath}"
echo "GEMINI" >> "${invocationLogPath}"
cat >/dev/null
printf 'ok from gemini\\n'
`;
  await writeFile(geminiPath, geminiScript, "utf8");
  await chmod(geminiPath, 0o755);

  const codexPath = join(binDir, "codex");
  const codexScript = `#!/usr/bin/env bash
set -euo pipefail

prompt="$(cat)"
if [[ "$prompt" == Race\\ Judge* ]]; then
  printf 'PICK 1\\nReasoning: prefer the only successful candidate.\\n'
  exit 0
fi

printf 'codex helper ok\\n'
`;
  await writeFile(codexPath, codexScript, "utf8");
  await chmod(codexPath, 0o755);

  return binDir;
}

async function bindSandboxProjectInGlobalConfig(
  sandbox: TestSandbox,
  projectName: string,
): Promise<void> {
  const raw = await readFile(sandbox.globalConfigFile, "utf8");
  const config = JSON.parse(raw) as Record<string, unknown>;
  config.activeProject = projectName;
  config.projects = [
    {
      name: projectName,
      rootDir: sandbox.projectDir,
    },
  ];
  await writeFile(sandbox.globalConfigFile, JSON.stringify(config, null, 2));
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

  test("config judge updates the race judge adapter and config show reports it", async () => {
    const sandbox = await TestSandbox.create("ixado-p36-cli-judge-config-");
    sandboxes.push(sandbox);

    const updateResult = runIxadoWithPath(
      ["config", "judge", "CLAUDE_CLI"],
      sandbox,
      sandbox.projectDir,
    );

    expect(updateResult.exitCode).toBe(0);
    expect(updateResult.stdout).toContain("Race judge CLI set to CLAUDE_CLI.");

    const showResult = runIxadoWithPath(
      ["config", "show"],
      sandbox,
      sandbox.projectDir,
    );

    expect(showResult.exitCode).toBe(0);
    expect(showResult.stdout).toContain("Race judge CLI: CLAUDE_CLI");
  });

  test("task start uses the phase runner for raced tasks", async () => {
    const sandbox = await TestSandbox.create("ixado-p36-cli-race-start-");
    sandboxes.push(sandbox);

    await initGitRepo(sandbox.projectDir);
    const projectName = basename(sandbox.projectDir);

    const phaseId = randomUUID();
    const taskId = randomUUID();
    const now = new Date().toISOString();
    const invocationLogPath = join(
      sandbox.projectDir,
      ".ixado",
      "race-invocations.txt",
    );

    await sandbox.writeProjectState({
      projectName,
      rootDir: sandbox.projectDir,
      createdAt: now,
      updatedAt: now,
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 36",
          branchName: "phase-36-execution-dag",
          status: "PLANNING",
          tasks: [
            {
              id: taskId,
              title: "Run raced worker",
              description: "Ensure task start honors raced execution.",
              race: 2,
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
          ],
        },
      ],
    } as any);

    expect(
      runIxadoWithPath(["init"], sandbox, sandbox.projectDir).exitCode,
    ).toBe(0);
    expect(
      runIxadoWithPath(
        ["config", "judge", "CODEX_CLI"],
        sandbox,
        sandbox.projectDir,
      ).exitCode,
    ).toBe(0);
    expect(
      runIxadoWithPath(
        ["config", "worktrees", "on"],
        sandbox,
        sandbox.projectDir,
      ).exitCode,
    ).toBe(0);
    await bindSandboxProjectInGlobalConfig(sandbox, projectName);

    const codexBinDir = await installRaceAwareCodexStub(
      sandbox,
      invocationLogPath,
    );
    const result = runIxadoWithPath(
      ["task", "start", "1", "CODEX_CLI"],
      sandbox,
      codexBinDir,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Task #1 Run raced worker finished with status DONE.",
    );

    const invocations = (await readFile(invocationLogPath, "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(invocations.filter((line) => line.includes("--race-"))).toHaveLength(
      2,
    );

    const state = await sandbox.readProjectState();
    expect(state.phases[0]?.tasks[0]?.status).toBe("DONE");
  });

  test("task retry uses the phase runner for raced tasks", async () => {
    const sandbox = await TestSandbox.create("ixado-p36-cli-race-retry-");
    sandboxes.push(sandbox);

    await initGitRepo(sandbox.projectDir);
    const projectName = basename(sandbox.projectDir);

    const phaseId = randomUUID();
    const taskId = randomUUID();
    const now = new Date().toISOString();
    const invocationLogPath = join(
      sandbox.projectDir,
      ".ixado",
      "race-retry-invocations.txt",
    );

    await sandbox.writeProjectState({
      projectName,
      rootDir: sandbox.projectDir,
      createdAt: now,
      updatedAt: now,
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 36",
          branchName: "phase-36-execution-dag",
          status: "CI_FAILED",
          tasks: [
            {
              id: taskId,
              title: "Retry raced worker",
              description: "Ensure task retry honors raced execution.",
              race: 2,
              status: "FAILED",
              assignee: "CODEX_CLI",
              errorLogs: "previous failure",
              dependencies: [],
            },
          ],
        },
      ],
    } as any);

    expect(
      runIxadoWithPath(["init"], sandbox, sandbox.projectDir).exitCode,
    ).toBe(0);
    expect(
      runIxadoWithPath(
        ["config", "judge", "CODEX_CLI"],
        sandbox,
        sandbox.projectDir,
      ).exitCode,
    ).toBe(0);
    expect(
      runIxadoWithPath(
        ["config", "worktrees", "on"],
        sandbox,
        sandbox.projectDir,
      ).exitCode,
    ).toBe(0);
    await bindSandboxProjectInGlobalConfig(sandbox, projectName);

    const codexBinDir = await installRaceAwareCodexStub(
      sandbox,
      invocationLogPath,
    );
    const result = runIxadoWithPath(
      ["task", "retry", "1"],
      sandbox,
      codexBinDir,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Task #1 Retry raced worker finished with status DONE.",
    );

    const invocations = (await readFile(invocationLogPath, "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(invocations.filter((line) => line.includes("--race-"))).toHaveLength(
      2,
    );

    const state = await sandbox.readProjectState();
    expect(state.phases[0]?.tasks[0]?.status).toBe("DONE");
    expect(state.phases[0]?.tasks[0]?.assignee).toBe("CODEX_CLI");
  });

  test("raced task start fails over to the next provider on Claude usage exhaustion", async () => {
    const sandbox = await TestSandbox.create(
      "ixado-p36-cli-provider-failover-",
    );
    sandboxes.push(sandbox);

    await initGitRepo(sandbox.projectDir);
    const projectName = basename(sandbox.projectDir);

    const phaseId = randomUUID();
    const taskId = randomUUID();
    const now = new Date().toISOString();
    const invocationLogPath = join(
      sandbox.projectDir,
      ".ixado",
      "provider-failover-invocations.txt",
    );

    await sandbox.writeProjectState({
      projectName,
      rootDir: sandbox.projectDir,
      createdAt: now,
      updatedAt: now,
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 36",
          branchName: "phase-36-execution-dag",
          status: "PLANNING",
          tasks: [
            {
              id: taskId,
              title: "Fail over provider",
              description:
                "Switch to the next provider when Claude is exhausted.",
              race: 2,
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
          ],
        },
      ],
    } as any);

    expect(
      runIxadoWithPath(["init"], sandbox, sandbox.projectDir).exitCode,
    ).toBe(0);
    expect(
      runIxadoWithPath(
        ["config", "judge", "CODEX_CLI"],
        sandbox,
        sandbox.projectDir,
      ).exitCode,
    ).toBe(0);
    expect(
      runIxadoWithPath(
        ["config", "worktrees", "on"],
        sandbox,
        sandbox.projectDir,
      ).exitCode,
    ).toBe(0);
    expect(
      runIxadoWithPath(
        ["config", "assignee", "CLAUDE_CLI"],
        sandbox,
        sandbox.projectDir,
      ).exitCode,
    ).toBe(0);
    await bindSandboxProjectInGlobalConfig(sandbox, projectName);

    const binDir = await installProviderFailoverStubs(
      sandbox,
      invocationLogPath,
    );
    const result = runIxadoWithPath(
      ["task", "start", "1", "CLAUDE_CLI"],
      sandbox,
      binDir,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "switching immediately to GEMINI_CLI (1/3).",
    );
    expect(result.stdout).toContain(
      "Task #1 Fail over provider finished with status DONE.",
    );

    const invocations = (await readFile(invocationLogPath, "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(invocations.filter((line) => line === "CLAUDE")).toHaveLength(2);
    expect(invocations.filter((line) => line === "GEMINI")).toHaveLength(2);

    const state = await sandbox.readProjectState();
    expect(state.phases[0]?.tasks[0]?.status).toBe("DONE");
  });
});
