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
import { appendAuditLog, computeCommandHash } from "../security/audit-log";
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
  /** Session actor identifier used for audit logging. */
  actor?: string;
};

// ---------------------------------------------------------------------------
// Wrapper class
// ---------------------------------------------------------------------------

export class PrivilegedGitActions {
  private readonly git: GitManager;
  private readonly github: GitHubManager;
  private readonly role: Role | null;
  private readonly policy: AuthPolicy;
  private readonly actor: string;

  constructor(options: PrivilegedGitActionsOptions) {
    this.git = options.git;
    this.github = options.github;
    this.role = options.role;
    this.policy = options.policy;
    this.actor = options.actor ?? "system:unknown";
  }

  private async logAuthorizationDecision(input: {
    action: string;
    target: string;
    decision: "allow" | "deny";
    reason: string;
  }): Promise<void> {
    await appendAuditLog(process.cwd(), {
      actor: this.actor,
      role: this.role,
      action: input.action,
      target: input.target,
      decision: input.decision,
      reason: input.reason,
      commandHash: computeCommandHash(`${input.action} ${input.target}`),
    });
  }

  private async logPrivilegedCommand(input: {
    action: string;
    target: string;
    command: string;
    decision: "allow" | "deny";
    reason: string;
  }): Promise<void> {
    await appendAuditLog(process.cwd(), {
      actor: this.actor,
      role: this.role,
      action: input.action,
      target: input.target,
      decision: input.decision,
      reason: input.reason,
      commandHash: computeCommandHash(input.command),
    });
  }

  // ── Private guard ─────────────────────────────────────────────────────────

  /**
   * Evaluates the action under the session's role and policy.
   * Throws `AuthorizationDeniedError` on any deny decision.
   * Synchronous — authorization completes before any I/O starts.
   */
  private async assertAuthorized(
    action: string,
    target: string,
  ): Promise<void> {
    const decision = evaluate(this.role, action, this.policy);
    if (decision.decision === "deny") {
      await this.logAuthorizationDecision({
        action,
        target,
        decision: "deny",
        reason: decision.reason,
      });
      throw new AuthorizationDeniedError(decision);
    }

    await this.logAuthorizationDecision({
      action,
      target,
      decision: "allow",
      reason: `matched:${decision.matchedPattern}`,
    });
  }

  // ── Public gated operations ───────────────────────────────────────────────

  /** Creates a git branch. Requires `git:privileged:branch-create`. */
  async createBranch(input: CreateBranchInput): Promise<void> {
    const target = `branch:${input.branchName}`;
    const command = `git checkout -b ${input.branchName} ${input.fromRef ?? "HEAD"}`;
    await this.assertAuthorized(ACTIONS.GIT_BRANCH_CREATE, target);
    await this.git.createBranch(input);
    await this.logPrivilegedCommand({
      action: ACTIONS.GIT_BRANCH_CREATE,
      target,
      command,
      decision: "allow",
      reason: "executed",
    });
  }

  /** Rebases the current branch onto `onto`. Requires `git:privileged:rebase`. */
  async rebase(input: RebaseInput): Promise<void> {
    const target = `ref:${input.onto}`;
    const command = `git rebase ${input.onto}`;
    await this.assertAuthorized(ACTIONS.GIT_REBASE, target);
    await this.git.rebase(input);
    await this.logPrivilegedCommand({
      action: ACTIONS.GIT_REBASE,
      target,
      command,
      decision: "allow",
      reason: "executed",
    });
  }

  /** Pushes a branch to the remote. Requires `git:privileged:push`. */
  async pushBranch(input: PushBranchInput): Promise<void> {
    const remote = input.remote ?? "origin";
    const upstreamFlag = (input.setUpstream ?? true) ? "-u " : "";
    const target = `branch:${input.branchName}@${remote}`;
    const command =
      `git push ${upstreamFlag}${remote} ${input.branchName}`.trim();
    await this.assertAuthorized(ACTIONS.GIT_PUSH, target);
    await this.git.pushBranch(input);
    await this.logPrivilegedCommand({
      action: ACTIONS.GIT_PUSH,
      target,
      command,
      decision: "allow",
      reason: "executed",
    });
  }

  /** Creates a pull request and returns its URL. Requires `git:privileged:pr-open`. */
  async createPullRequest(input: CreatePullRequestInput): Promise<string> {
    const target = `pr:${input.head}->${input.base}`;
    const command = `gh pr create --base ${input.base} --head ${input.head}`;
    await this.assertAuthorized(ACTIONS.GIT_PR_OPEN, target);
    const url = await this.github.createPullRequest(input);
    await this.logPrivilegedCommand({
      action: ACTIONS.GIT_PR_OPEN,
      target,
      command,
      decision: "allow",
      reason: "executed",
    });
    return url;
  }

  /** Merges a pull request. Requires `git:privileged:pr-merge`. */
  async mergePullRequest(input: MergePullRequestInput): Promise<void> {
    const mergeMethod = input.mergeMethod ?? "merge";
    const target = `pr:${input.prNumber}`;
    const command = `gh pr merge ${input.prNumber} --${mergeMethod} --auto`;
    await this.assertAuthorized(ACTIONS.GIT_PR_MERGE, target);
    await this.github.mergePullRequest(input);
    await this.logPrivilegedCommand({
      action: ACTIONS.GIT_PR_MERGE,
      target,
      command,
      decision: "allow",
      reason: "executed",
    });
  }
}
