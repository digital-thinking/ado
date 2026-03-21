import type { PushBranchInput } from "./git-manager";
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

export class NullProvider implements VcsProvider {
  async pushBranch(_input: PushBranchInput): Promise<void> {}

  async openPr(_input: CreatePullRequestInput): Promise<string> {
    throw new UnsupportedVcsProviderOperationError(
      "NullProvider",
      "openPr",
      "NullProvider keeps the branch local and does not perform remote VCS operations.",
    );
  }

  async pollChecks(_input: PollCiStatusInput): Promise<CiStatusSummary> {
    throw new UnsupportedVcsProviderOperationError(
      "NullProvider",
      "pollChecks",
      "NullProvider keeps the branch local and does not perform remote VCS operations.",
    );
  }

  async markReady(_input: MarkPullRequestReadyInput): Promise<void> {
    throw new UnsupportedVcsProviderOperationError(
      "NullProvider",
      "markReady",
      "NullProvider keeps the branch local and does not perform remote VCS operations.",
    );
  }

  async mergePr(_input: MergePullRequestInput): Promise<void> {
    throw new UnsupportedVcsProviderOperationError(
      "NullProvider",
      "mergePr",
      "NullProvider keeps the branch local and does not perform remote VCS operations.",
    );
  }
}
