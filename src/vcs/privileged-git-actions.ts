/**
 * PrivilegedGitActions — authorization-gated wrapper around GitManager and
 * GitHubManager for all `git:privileged:*` operations.
 *
 * Every public method calls `assertAuthorized()` before delegating to the
 * underlying manager.  On a deny decision, `AuthorizationDeniedError` is
 * thrown with the full structured deny decision for upstream handling.
 *
 * This class is the single choke-point for all privileged VCS operations.
 * P11-004 will wire call sites to use this class instead of invoking
 * GitManager / GitHubManager directly for privileged operations.
 */

import { AuthorizationDeniedError, evaluate } from "../security/auth-evaluator";
import { ACTIONS, type AuthPolicy, type Role } from "../security/policy";
import {
  GitManager,
  type CreateBranchInput,
  type PushBranchInput,
  type RebaseInput,
} from "./git-manager";
import {
  GitHubManager,
  type CreatePullRequestInput,
  type MergePullRequestInput,
} from "./github-manager";

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export type PrivilegedGitActionsOptions = {
  git: GitManager;
  github: GitHubManager;
  /** The resolved role for the current session. `null` = no role → always deny. */
  role: Role | null;
  /** The loaded AuthPolicy to evaluate against. */
  policy: AuthPolicy;
};

// ---------------------------------------------------------------------------
// Wrapper class
// ---------------------------------------------------------------------------

export class PrivilegedGitActions {
  private readonly git: GitManager;
  private readonly github: GitHubManager;
  private readonly role: Role | null;
  private readonly policy: AuthPolicy;

  constructor(options: PrivilegedGitActionsOptions) {
    this.git = options.git;
    this.github = options.github;
    this.role = options.role;
    this.policy = options.policy;
  }

  // ── Private guard ─────────────────────────────────────────────────────────

  /**
   * Evaluates the action under the session's role and policy.
   * Throws `AuthorizationDeniedError` on any deny decision.
   * Synchronous — authorization completes before any I/O starts.
   */
  private assertAuthorized(action: string): void {
    const decision = evaluate(this.role, action, this.policy);
    if (decision.decision === "deny") {
      throw new AuthorizationDeniedError(decision);
    }
  }

  // ── Public gated operations ───────────────────────────────────────────────

  /** Creates a git branch. Requires `git:privileged:branch-create`. */
  async createBranch(input: CreateBranchInput): Promise<void> {
    this.assertAuthorized(ACTIONS.GIT_BRANCH_CREATE);
    return this.git.createBranch(input);
  }

  /** Rebases the current branch onto `onto`. Requires `git:privileged:rebase`. */
  async rebase(input: RebaseInput): Promise<void> {
    this.assertAuthorized(ACTIONS.GIT_REBASE);
    return this.git.rebase(input);
  }

  /** Pushes a branch to the remote. Requires `git:privileged:push`. */
  async pushBranch(input: PushBranchInput): Promise<void> {
    this.assertAuthorized(ACTIONS.GIT_PUSH);
    return this.git.pushBranch(input);
  }

  /** Creates a pull request and returns its URL. Requires `git:privileged:pr-open`. */
  async createPullRequest(input: CreatePullRequestInput): Promise<string> {
    this.assertAuthorized(ACTIONS.GIT_PR_OPEN);
    return this.github.createPullRequest(input);
  }

  /** Merges a pull request. Requires `git:privileged:pr-merge`. */
  async mergePullRequest(input: MergePullRequestInput): Promise<void> {
    this.assertAuthorized(ACTIONS.GIT_PR_MERGE);
    return this.github.mergePullRequest(input);
  }
}
