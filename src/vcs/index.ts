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
  CiStatusSummary,
  CreatePullRequestInput,
  CiPollTransition,
  GitHubIssue,
  ListOpenIssuesInput,
  MarkPullRequestReadyInput,
  MergePullRequestInput,
  PollCiStatusInput,
} from "./github-manager";
export { parsePullRequestNumberFromUrl } from "./github-manager";
export { GitHubProvider } from "./github-provider";
export type { VcsProvider } from "./vcs-provider";

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
