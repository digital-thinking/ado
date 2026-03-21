import type { GitManager } from "./git-manager";
import type { GitHubManager } from "./github-manager";

export interface VcsProvider {
  pushBranch: GitManager["pushBranch"];
  openPr: GitHubManager["createPullRequest"];
  pollChecks: GitHubManager["pollCiStatus"];
  markReady: GitHubManager["markPullRequestReady"];
  mergePr: GitHubManager["mergePullRequest"];
}
