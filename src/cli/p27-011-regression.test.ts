import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { TestSandbox, runIxado } from "./test-helpers";
import type { ProjectState } from "../types";

type GitRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const originalWebDaemonMode = process.env.IXADO_WEB_DAEMON_MODE;

function runGit(args: string[], cwd: string): GitRunResult {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
  };
}

async function initGitRepo(cwd: string): Promise<void> {
  const init = runGit(["init"], cwd);
  if (init.exitCode !== 0) {
    throw new Error(`git init failed: ${init.stderr || init.stdout}`);
  }

  const email = runGit(
    ["config", "user.email", "ixado-tests@example.com"],
    cwd,
  );
  if (email.exitCode !== 0) {
    throw new Error(
      `git config user.email failed: ${email.stderr || email.stdout}`,
    );
  }

  const name = runGit(["config", "user.name", "IxADO Tests"], cwd);
  if (name.exitCode !== 0) {
    throw new Error(
      `git config user.name failed: ${name.stderr || name.stdout}`,
    );
  }

  await writeFile(join(cwd, "README.md"), "ixado\n");
  const add = runGit(["add", "README.md"], cwd);
  if (add.exitCode !== 0) {
    throw new Error(`git add failed: ${add.stderr || add.stdout}`);
  }

  const commit = runGit(["commit", "-m", "chore: init"], cwd);
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  }
}

function createState(input: {
  projectName: string;
  rootDir: string;
  phases: Array<{
    id: string;
    name: string;
    branchName: string;
    status: "PLANNING" | "CODING" | "DONE";
    tasks: Array<{
      id: string;
      title: string;
      description: string;
      status: "TODO" | "DONE";
      assignee: "UNASSIGNED";
      dependencies: string[];
    }>;
  }>;
  activePhaseIds: string[];
}): ProjectState {
  const now = new Date().toISOString();
  return {
    projectName: input.projectName,
    rootDir: input.rootDir,
    phases: input.phases,
    activePhaseIds: input.activePhaseIds,
    createdAt: now,
    updatedAt: now,
  } as ProjectState;
}

beforeEach(() => {
  delete process.env.IXADO_WEB_DAEMON_MODE;
});

afterAll(() => {
  if (originalWebDaemonMode === undefined) {
    delete process.env.IXADO_WEB_DAEMON_MODE;
    return;
  }
  process.env.IXADO_WEB_DAEMON_MODE = originalWebDaemonMode;
});

describe("P27-011 active phase set operations", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((sandbox) => sandbox.cleanup()));
    sandboxes.length = 0;
  });

  test("phase active supports +<phaseId> and -<phaseId> while preserving set order", async () => {
    const sandbox = await TestSandbox.create("ixado-p27-011-active-set-");
    sandboxes.push(sandbox);

    expect(
      runIxado(["phase", "create", "Phase A", "phase-a"], sandbox).exitCode,
    ).toBe(0);
    expect(
      runIxado(["phase", "create", "Phase B", "phase-b"], sandbox).exitCode,
    ).toBe(0);

    const initial = await sandbox.readProjectState();
    const phaseAId = initial.phases[0]?.id;
    const phaseBId = initial.phases[1]?.id;
    if (!phaseAId || !phaseBId) {
      throw new Error("Expected two phases in test fixture.");
    }

    const add = runIxado(["phase", "active", `+${phaseAId}`], sandbox);
    expect(add.exitCode).toBe(0);
    expect(add.stderr).toBe("");

    const afterAdd = await sandbox.readProjectState();
    expect(afterAdd.activePhaseIds).toEqual([phaseBId, phaseAId]);

    const remove = runIxado(["phase", "active", `-${phaseBId}`], sandbox);
    expect(remove.exitCode).toBe(0);
    expect(remove.stderr).toBe("");

    const afterRemove = await sandbox.readProjectState();
    expect(afterRemove.activePhaseIds).toEqual([phaseAId]);
  });

  test("phase active rejects duplicate add and non-active remove by phase ID", async () => {
    const sandbox = await TestSandbox.create("ixado-p27-011-active-errors-");
    sandboxes.push(sandbox);

    expect(
      runIxado(["phase", "create", "Phase A", "phase-a"], sandbox).exitCode,
    ).toBe(0);
    expect(
      runIxado(["phase", "create", "Phase B", "phase-b"], sandbox).exitCode,
    ).toBe(0);

    const state = await sandbox.readProjectState();
    const phaseAId = state.phases[0]?.id;
    const phaseBId = state.phases[1]?.id;
    if (!phaseAId || !phaseBId) {
      throw new Error("Expected two phases in test fixture.");
    }

    expect(
      runIxado(["phase", "active", `+${phaseAId}`], sandbox).exitCode,
    ).toBe(0);

    const duplicate = runIxado(["phase", "active", `+${phaseAId}`], sandbox);
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stderr).toContain("already active");

    expect(
      runIxado(["phase", "active", `-${phaseBId}`], sandbox).exitCode,
    ).toBe(0);

    const missing = runIxado(["phase", "active", `-${phaseBId}`], sandbox);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("is not active");
  });
});

describe("P27-011 --phase routing", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((sandbox) => sandbox.cleanup()));
    sandboxes.length = 0;
  });

  test("phase run --phase <number> routes execution to the targeted active phase", async () => {
    const sandbox = await TestSandbox.create("ixado-p27-011-phase-num-");
    sandboxes.push(sandbox);

    const phaseOneId = "11111111-1111-4111-8111-111111111111";
    const phaseTwoId = "22222222-2222-4222-8222-222222222222";

    await sandbox.writeProjectState(
      createState({
        projectName: "ixado-p27",
        rootDir: sandbox.projectDir,
        phases: [
          {
            id: phaseOneId,
            name: "Phase One",
            branchName: "phase-one",
            status: "CODING",
            tasks: [],
          },
          {
            id: phaseTwoId,
            name: "Phase Two",
            branchName: "phase-two",
            status: "DONE",
            tasks: [],
          },
        ],
        activePhaseIds: [phaseOneId, phaseTwoId],
      }),
    );

    const result = runIxado(["phase", "run", "--phase", "2"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Phase "Phase Two" is in terminal status "DONE"',
    );
    expect(result.stderr).not.toContain("git branch --show-current");
  });

  test("phase run --phase <id> routes execution to the targeted active phase", async () => {
    const sandbox = await TestSandbox.create("ixado-p27-011-phase-id-");
    sandboxes.push(sandbox);

    const phaseOneId = "33333333-3333-4333-8333-333333333333";
    const phaseTwoId = "44444444-4444-4444-8444-444444444444";

    await sandbox.writeProjectState(
      createState({
        projectName: "ixado-p27",
        rootDir: sandbox.projectDir,
        phases: [
          {
            id: phaseOneId,
            name: "Phase Alpha",
            branchName: "phase-alpha",
            status: "DONE",
            tasks: [],
          },
          {
            id: phaseTwoId,
            name: "Phase Beta",
            branchName: "phase-beta",
            status: "CODING",
            tasks: [],
          },
        ],
        activePhaseIds: [phaseOneId, phaseTwoId],
      }),
    );

    const result = runIxado(["phase", "run", "--phase", phaseOneId], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Phase "Phase Alpha" is in terminal status "DONE"',
    );
    expect(result.stderr).not.toContain("git branch --show-current");
  });
});

describe("P27-011 worktree list/prune", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((sandbox) => sandbox.cleanup()));
    sandboxes.length = 0;
  });

  test("worktree prune removes terminal phase worktrees and list reflects remaining active worktrees", async () => {
    const sandbox = await TestSandbox.create("ixado-p27-011-worktree-");
    sandboxes.push(sandbox);

    await initGitRepo(sandbox.projectDir);

    const codingPhaseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const donePhaseId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const codingBranch = "phase-27-coding";
    const doneBranch = "phase-27-done";
    const codingWorktreePath = resolve(
      sandbox.projectDir,
      ".ixado/worktrees",
      codingPhaseId,
    );
    const doneWorktreePath = resolve(
      sandbox.projectDir,
      ".ixado/worktrees",
      donePhaseId,
    );

    expect(runGit(["branch", codingBranch], sandbox.projectDir).exitCode).toBe(
      0,
    );
    expect(
      runGit(
        ["worktree", "add", codingWorktreePath, codingBranch],
        sandbox.projectDir,
      ).exitCode,
    ).toBe(0);

    expect(runGit(["branch", doneBranch], sandbox.projectDir).exitCode).toBe(0);
    expect(
      runGit(
        ["worktree", "add", doneWorktreePath, doneBranch],
        sandbox.projectDir,
      ).exitCode,
    ).toBe(0);

    await sandbox.writeProjectState(
      createState({
        projectName: "ixado-p27",
        rootDir: sandbox.projectDir,
        phases: [
          {
            id: codingPhaseId,
            name: "Phase Coding",
            branchName: codingBranch,
            status: "CODING",
            tasks: [],
          },
          {
            id: donePhaseId,
            name: "Phase Done",
            branchName: doneBranch,
            status: "DONE",
            tasks: [],
          },
        ],
        activePhaseIds: [codingPhaseId, donePhaseId],
      }),
    );

    const listedBefore = runIxado(["worktree", "list"], sandbox);
    expect(listedBefore.exitCode).toBe(0);
    expect(listedBefore.stderr).toBe("");
    expect(listedBefore.stdout).toContain("Active managed worktrees (2):");
    expect(listedBefore.stdout).toContain(
      `${codingPhaseId} [${codingBranch}] CODING ${codingWorktreePath}`,
    );
    expect(listedBefore.stdout).toContain(
      `${donePhaseId} [${doneBranch}] DONE ${doneWorktreePath}`,
    );

    const pruned = runIxado(["worktree", "prune"], sandbox);
    expect(pruned.exitCode).toBe(0);
    expect(pruned.stderr).toBe("");
    expect(pruned.stdout).toContain("Pruned orphaned worktrees (1):");
    expect(pruned.stdout).toContain(`${donePhaseId} ${doneWorktreePath}`);

    const listedAfter = runIxado(["worktree", "list"], sandbox);
    expect(listedAfter.exitCode).toBe(0);
    expect(listedAfter.stderr).toBe("");
    expect(listedAfter.stdout).toContain("Active managed worktrees (1):");
    expect(listedAfter.stdout).toContain(
      `${codingPhaseId} [${codingBranch}] CODING ${codingWorktreePath}`,
    );
    expect(listedAfter.stdout).not.toContain(donePhaseId);
  });
});
