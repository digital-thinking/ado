import type { PushBranchInput } from "./git-manager";
import type {
  CiStatusSummary,
  CreatePullRequestInput,
  MarkPullRequestReadyInput,
  MergePullRequestInput,
  PollCiStatusInput,
} from "./github-manager";

export interface VcsProvider {
  pushBranch(input: PushBranchInput): Promise<void>;
  openPr(input: CreatePullRequestInput): Promise<string>;
  pollChecks(input: PollCiStatusInput): Promise<CiStatusSummary>;
  markReady(input: MarkPullRequestReadyInput): Promise<void>;
  mergePr(input: MergePullRequestInput): Promise<void>;
}

export class UnsupportedVcsProviderOperationError extends Error {
  readonly providerName: string;
  readonly operation: string;

  constructor(providerName: string, operation: string, detail?: string) {
    const suffix = detail ? ` ${detail}` : "";
    super(`${providerName} does not support ${operation}.${suffix}`);
    this.name = "UnsupportedVcsProviderOperationError";
    this.providerName = providerName;
    this.operation = operation;
  }
}
