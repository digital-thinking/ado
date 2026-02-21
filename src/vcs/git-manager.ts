import type { ProcessRunner } from "../process";

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

    if (result.stdout.trim()) {
      throw new Error("Git working tree is not clean.");
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
}
