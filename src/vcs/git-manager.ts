import type { ProcessRunner } from "../process";
import { DirtyWorktreeError } from "../errors";

export type CreateBranchInput = {
  branchName: string;
  cwd: string;
  fromRef?: string;
};

export type CreateWorktreeInput = {
  path: string;
  branchName: string;
  cwd: string;
  fromRef?: string;
};

export type RemoveWorktreeInput = {
  path: string;
  cwd: string;
  force?: boolean;
};

export type PushBranchInput = {
  branchName: string;
  cwd: string;
  remote?: string;
  setUpstream?: boolean;
};

export type RebaseInput = {
  /** Target ref to rebase the current branch onto (e.g. "main", "origin/main"). */
  onto: string;
  cwd: string;
};

export type CommitInput = {
  cwd: string;
  message: string;
};

function normalizeStatusPath(rawPath: string): string {
  let value = rawPath.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  }

  if (value.includes(" -> ")) {
    const parts = value.split(" -> ");
    value = parts[parts.length - 1] ?? value;
  }

  return value;
}

function isIgnoredRuntimeArtifact(statusLine: string): boolean {
  const payload = statusLine.length > 3 ? statusLine.slice(3) : statusLine;
  const path = normalizeStatusPath(payload);
  return path === ".ixado/cli.log";
}

export class GitManager {
  private readonly runner: ProcessRunner;

  constructor(runner: ProcessRunner) {
    this.runner = runner;
  }

  async ensureCleanWorkingTree(cwd: string): Promise<void> {
    const result = await this.runner.run({
      command: "git",
      args: ["status", "--porcelain"],
      cwd,
    });

    const dirtyEntries = result.stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .filter((line) => !isIgnoredRuntimeArtifact(line));

    if (dirtyEntries.length > 0) {
      throw new DirtyWorktreeError();
    }
  }

  async getCurrentBranch(cwd: string): Promise<string> {
    const result = await this.runner.run({
      command: "git",
      args: ["branch", "--show-current"],
      cwd,
    });

    const branchName = result.stdout.trim();
    if (!branchName) {
      throw new Error("Unable to resolve current git branch.");
    }

    return branchName;
  }

  async createBranch(input: CreateBranchInput): Promise<void> {
    if (!input.branchName.trim()) {
      throw new Error("branchName must not be empty.");
    }

    await this.runner.run({
      command: "git",
      args: ["checkout", "-b", input.branchName, input.fromRef ?? "HEAD"],
      cwd: input.cwd,
    });
  }

  async checkout(branchName: string, cwd: string): Promise<void> {
    if (!branchName.trim()) {
      throw new Error("branchName must not be empty.");
    }

    await this.runner.run({
      command: "git",
      args: ["checkout", branchName],
      cwd,
    });
  }

  async createWorktree(input: CreateWorktreeInput): Promise<void> {
    if (!input.path.trim()) {
      throw new Error("path must not be empty.");
    }
    if (!input.branchName.trim()) {
      throw new Error("branchName must not be empty.");
    }

    await this.runner.run({
      command: "git",
      args: [
        "worktree",
        "add",
        "-b",
        input.branchName,
        input.path,
        input.fromRef ?? "HEAD",
      ],
      cwd: input.cwd,
    });
  }

  async removeWorktree(input: RemoveWorktreeInput): Promise<void> {
    if (!input.path.trim()) {
      throw new Error("path must not be empty.");
    }

    const args = ["worktree", "remove"];
    if (input.force) {
      args.push("--force");
    }
    args.push(input.path);

    await this.runner.run({
      command: "git",
      args,
      cwd: input.cwd,
    });
  }

  async rebase(input: RebaseInput): Promise<void> {
    if (!input.onto.trim()) {
      throw new Error("onto must not be empty.");
    }

    await this.runner.run({
      command: "git",
      args: ["rebase", input.onto],
      cwd: input.cwd,
    });
  }

  async pushBranch(input: PushBranchInput): Promise<void> {
    if (!input.branchName.trim()) {
      throw new Error("branchName must not be empty.");
    }

    const args = ["push"];
    if (input.setUpstream ?? true) {
      args.push("-u");
    }
    args.push(input.remote ?? "origin", input.branchName);

    await this.runner.run({
      command: "git",
      args,
      cwd: input.cwd,
    });
  }

  async stageAll(cwd: string): Promise<void> {
    await this.runner.run({
      command: "git",
      args: ["add", "--all"],
      cwd,
    });
  }

  async hasStagedChanges(cwd: string): Promise<boolean> {
    const result = await this.runner.run({
      command: "git",
      args: ["diff", "--cached", "--name-only"],
      cwd,
    });

    return result.stdout.trim().length > 0;
  }

  async commit(input: CommitInput): Promise<void> {
    if (!input.message.trim()) {
      throw new Error("commit message must not be empty.");
    }

    await this.runner.run({
      command: "git",
      args: ["commit", "-m", input.message],
      cwd: input.cwd,
    });
  }
}
