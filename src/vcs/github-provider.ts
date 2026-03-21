import type { ProcessRunner } from "../process";
import { GitManager, type PushBranchInput } from "./git-manager";
import {
  GitHubManager,
  type CreatePullRequestInput,
  type CiStatusSummary,
  type MarkPullRequestReadyInput,
  type MergePullRequestInput,
  type PollCiStatusInput,
} from "./github-manager";
import type { VcsProvider } from "./vcs-provider";

export class GitHubProvider implements VcsProvider {
  private readonly git: GitManager;
  private readonly github: GitHubManager;

  constructor(runner: ProcessRunner) {
    this.git = new GitManager(runner);
    this.github = new GitHubManager(runner);
  }

  async pushBranch(input: PushBranchInput): Promise<void> {
    await this.git.pushBranch(input);
  }

  async openPr(input: CreatePullRequestInput): Promise<string> {
    return await this.github.createPullRequest(input);
  }

  async pollChecks(input: PollCiStatusInput): Promise<CiStatusSummary> {
    return await this.github.pollCiStatus(input);
  }

  async markReady(input: MarkPullRequestReadyInput): Promise<void> {
    await this.github.markPullRequestReady(input);
  }

  async mergePr(input: MergePullRequestInput): Promise<void> {
    await this.github.mergePullRequest(input);
  }
}
