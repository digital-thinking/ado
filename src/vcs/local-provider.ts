import type { ProcessRunner } from "../process";
import { GitManager, type PushBranchInput } from "./git-manager";
import type {
  CiStatusSummary,
  CreatePullRequestInput,
  MarkPullRequestReadyInput,
  MergePullRequestInput,
  PollCiStatusInput,
} from "./github-manager";
import {
  UnsupportedVcsProviderOperationError,
  type VcsProvider,
} from "./vcs-provider";

export class LocalProvider implements VcsProvider {
  private readonly git: GitManager;

  constructor(runner: ProcessRunner) {
    this.git = new GitManager(runner);
  }

  async pushBranch(input: PushBranchInput): Promise<void> {
    await this.git.pushBranch(input);
  }

  async openPr(_input: CreatePullRequestInput): Promise<string> {
    throw new UnsupportedVcsProviderOperationError(
      "LocalProvider",
      "openPr",
      "Configure the github provider for pull request operations.",
    );
  }

  async pollChecks(_input: PollCiStatusInput): Promise<CiStatusSummary> {
    throw new UnsupportedVcsProviderOperationError(
      "LocalProvider",
      "pollChecks",
      "Configure the github provider for pull request operations.",
    );
  }

  async markReady(_input: MarkPullRequestReadyInput): Promise<void> {
    throw new UnsupportedVcsProviderOperationError(
      "LocalProvider",
      "markReady",
      "Configure the github provider for pull request operations.",
    );
  }

  async mergePr(_input: MergePullRequestInput): Promise<void> {
    throw new UnsupportedVcsProviderOperationError(
      "LocalProvider",
      "mergePr",
      "Configure the github provider for pull request operations.",
    );
  }
}
