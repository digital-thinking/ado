import { describe, expect, test } from "bun:test";

import { GitManager } from "./git-manager";
import { MockProcessRunner } from "./test-utils";

describe("GitManager", () => {
  test("ensures working tree is clean", async () => {
    const runner = new MockProcessRunner([{ stdout: "" }]);
    const manager = new GitManager(runner);

    await manager.ensureCleanWorkingTree("C:/repo");

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toEqual({
      command: "git",
      args: ["status", "--porcelain"],
      cwd: "C:/repo",
    });
  });

  test("fails when working tree is dirty", async () => {
    const runner = new MockProcessRunner([{ stdout: " M src/file.ts" }]);
    const manager = new GitManager(runner);

    await expect(manager.ensureCleanWorkingTree("C:/repo")).rejects.toThrow(
      "Git working tree is not clean."
    );
  });

  test("returns current branch", async () => {
    const runner = new MockProcessRunner([{ stdout: "main\n" }]);
    const manager = new GitManager(runner);

    await expect(manager.getCurrentBranch("C:/repo")).resolves.toBe("main");
  });

  test("fails if current branch cannot be resolved", async () => {
    const runner = new MockProcessRunner([{ stdout: "\n" }]);
    const manager = new GitManager(runner);

    await expect(manager.getCurrentBranch("C:/repo")).rejects.toThrow(
      "Unable to resolve current git branch."
    );
  });

  test("creates branch from ref", async () => {
    const runner = new MockProcessRunner();
    const manager = new GitManager(runner);

    await manager.createBranch({
      branchName: "feature/test",
      cwd: "C:/repo",
      fromRef: "main",
    });

    expect(runner.calls[0]).toEqual({
      command: "git",
      args: ["checkout", "-b", "feature/test", "main"],
      cwd: "C:/repo",
    });
  });

  test("creates and removes worktrees", async () => {
    const runner = new MockProcessRunner();
    const manager = new GitManager(runner);

    await manager.createWorktree({
      path: "C:/repo/.worktrees/phase-2",
      branchName: "phase-2",
      cwd: "C:/repo",
    });
    await manager.removeWorktree({
      path: "C:/repo/.worktrees/phase-2",
      cwd: "C:/repo",
      force: true,
    });

    expect(runner.calls[0]).toEqual({
      command: "git",
      args: ["worktree", "add", "-b", "phase-2", "C:/repo/.worktrees/phase-2", "HEAD"],
      cwd: "C:/repo",
    });
    expect(runner.calls[1]).toEqual({
      command: "git",
      args: ["worktree", "remove", "--force", "C:/repo/.worktrees/phase-2"],
      cwd: "C:/repo",
    });
  });
});
