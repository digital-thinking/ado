import type { ProcessRunner } from "../process";
import { MissingCommitError } from "../errors";
import type { AuthPolicy, Role } from "../security/policy";
import type { PullRequestAutomationSettings, Task } from "../types";
import {
  OrchestrationAuthorizationDeniedError,
  authorizeOrchestratorAction,
} from "../security/orchestration-authorizer";
import { ORCHESTRATOR_ACTIONS } from "../security/workflow-profiles";
import { GitHubManager, GitManager, PrivilegedGitActions } from "../vcs";

export type RunCiIntegrationInput = {
  phaseId: string;
  phaseName: string;
  tasks: Task[];
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

/**
 * Derives PR metadata from phase/task context with deterministic formatting.
 * Includes validation safeguards to ensure metadata meets platform requirements.
 */
export function derivePullRequestMetadata(
  phaseName: string,
  tasks: Task[],
): { title: string; body: string } {
  const MAX_TITLE_LENGTH = 250;
  const MAX_BODY_LENGTH = 60000;

  const trimmedPhaseName = phaseName.trim() || "Untitled Phase";
  let title = trimmedPhaseName.replace(/\r?\n/g, " ");
  if (title.length > MAX_TITLE_LENGTH) {
    title = title.substring(0, MAX_TITLE_LENGTH - 3) + "...";
  }

  const completedTasks = tasks
    .filter((t) => t.status === "DONE")
    .sort((a, b) => a.id.localeCompare(b.id));

  const taskList = completedTasks
    .map(
      (t) =>
        `- **${(t.title || "Untitled Task").trim()}**: ${(t.description || "No description.").trim()}`,
    )
    .join("\n");

  const bodyParts = [
    `## Phase: ${trimmedPhaseName}`,
    "",
    "### Completed Tasks",
    taskList || "_No tasks recorded._",
    "",
    "---",
    "*Automated PR created by [IxADO](https://github.com/digital-thinking/ado).*",
  ];

  let body = bodyParts.join("\n").trim();
  if (body.length > MAX_BODY_LENGTH) {
    body = body.substring(0, MAX_BODY_LENGTH - 50) + "\n\n... (body truncated)";
  }

  return { title, body };
}

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

  const metadata = derivePullRequestMetadata(input.phaseName, input.tasks);

  const prUrl = await privileged.createPullRequest({
    base: baseBranch,
    head: headBranch,
    title: metadata.title,
    body: metadata.body,
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
