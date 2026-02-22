import type { ProcessRunner } from "../process";
import { GitHubManager, GitManager } from "../vcs";

export type RunCiIntegrationInput = {
  phaseId: string;
  phaseName: string;
  cwd: string;
  baseBranch: string;
  runner: ProcessRunner;
  setPhasePrUrl: (input: { phaseId: string; prUrl: string }) => Promise<void>;
};

export type RunCiIntegrationResult = {
  phaseId: string;
  headBranch: string;
  baseBranch: string;
  prUrl: string;
};

export async function runCiIntegration(input: RunCiIntegrationInput): Promise<RunCiIntegrationResult> {
  const baseBranch = input.baseBranch.trim();
  if (!baseBranch) {
    throw new Error("ciBaseBranch must not be empty.");
  }

  const git = new GitManager(input.runner);
  const github = new GitHubManager(input.runner);
  const headBranch = await git.getCurrentBranch(input.cwd);

  await git.pushBranch({
    branchName: headBranch,
    cwd: input.cwd,
    setUpstream: true,
  });

  const prUrl = await github.createPullRequest({
    base: baseBranch,
    head: headBranch,
    title: input.phaseName,
    body: `Automated PR created by IxADO for ${input.phaseName}.`,
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
