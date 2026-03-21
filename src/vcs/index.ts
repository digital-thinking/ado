export { GitManager } from "./git-manager";
export type {
  CommitInput,
  CommitTrailers,
  CreateBranchInput,
  CreateWorktreeInput,
  PushBranchInput,
  RebaseInput,
  RemoveWorktreeInput,
} from "./git-manager";

export { GitHubManager } from "./github-manager";
export type {
  CiCheck,
  CiCheckState,
  CiPollTransition,
  CiStatusSummary,
  CreatePullRequestInput,
  GitHubIssue,
  ListOpenIssuesInput,
  MarkPullRequestReadyInput,
  MergePullRequestInput,
  PollCiStatusInput,
} from "./github-manager";
export { parsePullRequestNumberFromUrl } from "./github-manager";
export { createVcsProvider } from "./create-vcs-provider";
export { GitHubProvider } from "./github-provider";
export { LocalProvider } from "./local-provider";
export { NullProvider } from "./null-provider";
export {
  UnsupportedVcsProviderOperationError,
  type VcsProvider,
} from "./vcs-provider";

export { WorktreeManager } from "./worktree-manager";
export type {
  ActiveWorktree,
  PruneOrphanedInput,
  ProvisionWorktreeInput,
  WorktreeManagerOptions,
  WorktreePhaseState,
} from "./worktree-manager";

export { PrivilegedGitActions } from "./privileged-git-actions";
export type { PrivilegedGitActionsOptions } from "./privileged-git-actions";
