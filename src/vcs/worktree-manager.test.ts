import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { WorktreeManager } from "./worktree-manager";

type FakeGitCall = {
  path: string;
  branchName?: string;
  cwd: string;
  fromRef?: string;
  force?: boolean;
};

function createFakeGit() {
  const createCalls: FakeGitCall[] = [];
  const removeCalls: FakeGitCall[] = [];

  return {
    createCalls,
    removeCalls,
    api: {
      async createWorktree(input: {
        path: string;
        branchName: string;
        cwd: string;
        fromRef?: string;
      }) {
        createCalls.push(input);
      },
      async removeWorktree(input: {
        path: string;
        cwd: string;
        force?: boolean;
      }) {
        removeCalls.push(input);
      },
    },
  };
}

async function createRepoRoot(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "ixado-worktree-manager-"));
  await mkdir(resolve(repoRoot, ".git"), { recursive: true });
  return repoRoot;
}

async function createLinkedRepoRoot(): Promise<{
  repoRoot: string;
  gitDirPath: string;
}> {
  const repoRoot = await mkdtemp(join(tmpdir(), "ixado-worktree-manager-"));
  const gitDirPath = resolve(repoRoot, ".git-data");
  await mkdir(gitDirPath, { recursive: true });
  await writeFile(resolve(repoRoot, ".git"), `gitdir: ${gitDirPath}\n`);
  return { repoRoot, gitDirPath };
}

async function writeWorktreeMetadata(input: {
  repoRoot: string;
  gitDirPath?: string;
  metadataName: string;
  worktreePath: string;
  branchName?: string;
}): Promise<void> {
  const gitDirPath = input.gitDirPath ?? resolve(input.repoRoot, ".git");
  const metadataDir = resolve(gitDirPath, "worktrees", input.metadataName);
  await mkdir(metadataDir, { recursive: true });
  await writeFile(
    resolve(metadataDir, "gitdir"),
    `${resolve(input.worktreePath, ".git")}\n`,
  );
  if (input.branchName) {
    await writeFile(
      resolve(metadataDir, "HEAD"),
      `ref: refs/heads/${input.branchName}\n`,
    );
  }
}

describe("WorktreeManager", () => {
  test("provisions a phase worktree and returns the resolved path", async () => {
    const repoRoot = await createRepoRoot();
    const fakeGit = createFakeGit();
    try {
      const manager = new WorktreeManager({
        git: fakeGit.api,
        projectRootDir: repoRoot,
        baseDir: ".ixado/worktrees",
      });

      const path = await manager.provision({
        phaseId: "phase-27-a",
        branchName: "phase-27-a",
        fromRef: "main",
      });

      expect(path).toBe(resolve(repoRoot, ".ixado/worktrees", "phase-27-a"));
      expect(fakeGit.createCalls).toEqual([
        {
          path: resolve(repoRoot, ".ixado/worktrees", "phase-27-a"),
          branchName: "phase-27-a",
          cwd: repoRoot,
          fromRef: "main",
        },
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("tears down a phase worktree using force removal", async () => {
    const repoRoot = await createRepoRoot();
    const fakeGit = createFakeGit();
    try {
      const manager = new WorktreeManager({
        git: fakeGit.api,
        projectRootDir: repoRoot,
        baseDir: ".ixado/worktrees",
      });

      await manager.teardown("phase-27-b");

      expect(fakeGit.removeCalls).toEqual([
        {
          path: resolve(repoRoot, ".ixado/worktrees", "phase-27-b"),
          cwd: repoRoot,
          force: true,
        },
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("lists active managed worktrees from git metadata", async () => {
    const repoRoot = await createRepoRoot();
    const fakeGit = createFakeGit();
    try {
      const managedPath = resolve(repoRoot, ".ixado/worktrees", "phase-27-c");
      const unmanagedPath = resolve(repoRoot, "tmp", "scratch");
      await writeWorktreeMetadata({
        repoRoot,
        metadataName: "managed",
        worktreePath: managedPath,
        branchName: "phase-27-c",
      });
      await writeWorktreeMetadata({
        repoRoot,
        metadataName: "unmanaged",
        worktreePath: unmanagedPath,
        branchName: "tmp-branch",
      });

      const manager = new WorktreeManager({
        git: fakeGit.api,
        projectRootDir: repoRoot,
        baseDir: ".ixado/worktrees",
      });
      const active = await manager.listActive();

      expect(active).toEqual([
        {
          phaseId: "phase-27-c",
          path: managedPath,
          branchName: "phase-27-c",
        },
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("returns empty active list when no git worktree metadata exists", async () => {
    const repoRoot = await createRepoRoot();
    const fakeGit = createFakeGit();
    try {
      const manager = new WorktreeManager({
        git: fakeGit.api,
        projectRootDir: repoRoot,
        baseDir: ".ixado/worktrees",
      });

      await expect(manager.listActive()).resolves.toEqual([]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("lists active managed worktrees when .git is a gitdir pointer file", async () => {
    const { repoRoot, gitDirPath } = await createLinkedRepoRoot();
    const fakeGit = createFakeGit();
    try {
      const managedPath = resolve(repoRoot, ".ixado/worktrees", "phase-27-d");
      await writeWorktreeMetadata({
        repoRoot,
        gitDirPath,
        metadataName: "managed",
        worktreePath: managedPath,
        branchName: "phase-27-d",
      });

      const manager = new WorktreeManager({
        git: fakeGit.api,
        projectRootDir: repoRoot,
        baseDir: ".ixado/worktrees",
      });
      const active = await manager.listActive();

      expect(active).toEqual([
        {
          phaseId: "phase-27-d",
          path: managedPath,
          branchName: "phase-27-d",
        },
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("prunes worktrees whose phases are missing or terminal", async () => {
    const repoRoot = await createRepoRoot();
    const fakeGit = createFakeGit();
    try {
      const missingPath = resolve(
        repoRoot,
        ".ixado/worktrees",
        "phase-missing",
      );
      const donePath = resolve(repoRoot, ".ixado/worktrees", "phase-done");
      const codingPath = resolve(repoRoot, ".ixado/worktrees", "phase-coding");
      await writeWorktreeMetadata({
        repoRoot,
        metadataName: "missing",
        worktreePath: missingPath,
        branchName: "phase-missing",
      });
      await writeWorktreeMetadata({
        repoRoot,
        metadataName: "done",
        worktreePath: donePath,
        branchName: "phase-done",
      });
      await writeWorktreeMetadata({
        repoRoot,
        metadataName: "coding",
        worktreePath: codingPath,
        branchName: "phase-coding",
      });

      const manager = new WorktreeManager({
        git: fakeGit.api,
        projectRootDir: repoRoot,
        baseDir: ".ixado/worktrees",
      });
      const pruned = await manager.pruneOrphaned({
        phases: [
          { id: "phase-done", status: "DONE" },
          { id: "phase-coding", status: "CODING" },
        ],
      });

      expect(pruned.map((entry) => entry.phaseId)).toEqual([
        "phase-done",
        "phase-missing",
      ]);
      expect(fakeGit.removeCalls).toEqual([
        {
          path: donePath,
          cwd: repoRoot,
          force: true,
        },
        {
          path: missingPath,
          cwd: repoRoot,
          force: true,
        },
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
