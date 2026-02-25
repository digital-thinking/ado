import type { ProcessRunner } from "../process";
import { MissingCommitError } from "../errors";
import type { AuthPolicy, Role } from "../security/policy";
import type { PullRequestAutomationSettings } from "../types";
import {
  OrchestrationAuthorizationDeniedError,
  authorizeOrchestratorAction,
} from "../security/orchestration-authorizer";
import { ORCHESTRATOR_ACTIONS } from "../security/workflow-profiles";
import { GitHubManager, GitManager, PrivilegedGitActions } from "../vcs";

export type RunCiIntegrationInput = {
  phaseId: string;
  phaseName: string;
  cwd: string;
  baseBranch: string;
  pullRequest: PullRequestAutomationSettings;
  runner: ProcessRunner;
  role: Role | null;
  policy: AuthPolicy;
  setPhasePrUrl: (input: { phaseId: string; prUrl: string }) => Promise<void>;
};

export type RunCiIntegrationResult = {
  phaseId: string;
  headBranch: string;
  baseBranch: string;
  prUrl: string;
};

function resolveTemplatePath(
  settings: PullRequestAutomationSettings,
  headBranch: string,
): string | undefined {
  const sortedMappings = [...settings.templateMappings].sort((a, b) => {
    const prefixLengthDelta = b.branchPrefix.length - a.branchPrefix.length;
    if (prefixLengthDelta !== 0) {
      return prefixLengthDelta;
    }
    return a.branchPrefix.localeCompare(b.branchPrefix);
  });

  const matched = sortedMappings.find((mapping) =>
    headBranch.startsWith(mapping.branchPrefix),
  );
  if (matched) {
    return matched.templatePath;
  }
  return settings.defaultTemplatePath ?? undefined;
}

export async function runCiIntegration(
  input: RunCiIntegrationInput,
): Promise<RunCiIntegrationResult> {
  const baseBranch = input.baseBranch.trim();
  if (!baseBranch) {
    throw new Error("ciBaseBranch must not be empty.");
  }

  const decision = await authorizeOrchestratorAction({
    action: ORCHESTRATOR_ACTIONS.CI_INTEGRATION_RUN,
    auditCwd: input.cwd,
    settingsFilePath: "<in-memory-policy>",
    session: { source: "cli" },
    roleConfig: {},
    loadPolicy: async () => input.policy,
    resolveSessionRole: () => input.role,
  });
  if (decision.decision === "deny") {
    throw new OrchestrationAuthorizationDeniedError(decision);
  }

  const git = new GitManager(input.runner);
  const github = new GitHubManager(input.runner);
  const privileged = new PrivilegedGitActions({
    git,
    github,
    role: input.role,
    policy: input.policy,
  });

  await git.stageAll(input.cwd);
  const hasChangesToCommit = await git.hasStagedChanges(input.cwd);
  if (!hasChangesToCommit) {
    throw new MissingCommitError();
  }

  try {
    await git.commit({
      cwd: input.cwd,
      message: `chore(ixado): finalize ${input.phaseName}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MissingCommitError(
      `CI integration could not create commit before push/PR: ${message}`,
    );
  }

  const headBranch = await git.getCurrentBranch(input.cwd);

  await privileged.pushBranch({
    branchName: headBranch,
    cwd: input.cwd,
    setUpstream: true,
  });

  const prUrl = await privileged.createPullRequest({
    base: baseBranch,
    head: headBranch,
    title: input.phaseName,
    body: `Automated PR created by IxADO for ${input.phaseName}.`,
    templatePath: resolveTemplatePath(input.pullRequest, headBranch),
    labels: input.pullRequest.labels,
    assignees: input.pullRequest.assignees,
    draft: input.pullRequest.createAsDraft,
    cwd: input.cwd,
  });

  await input.setPhasePrUrl({
    phaseId: input.phaseId,
    prUrl,
  });

  return {
    phaseId: input.phaseId,
    headBranch,
    baseBranch,
    prUrl,
  };
}
