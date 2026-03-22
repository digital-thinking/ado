import { z } from "zod";

import { parseJsonFromModelOutput } from "./json-parser";
import type { CLIAdapterId, Phase, Task } from "../types";

const PROPOSAL_RESPONSE_SCHEMA = z.object({
  proposal: z.string().min(1),
});

const CRITIQUE_RESPONSE_SCHEMA = z.object({
  verdict: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
  comments: z.array(z.string()).default([]),
});

type WorkResult = {
  agentId?: string;
  stdout: string;
  stderr: string;
};

export type DeliberationRound = {
  round: number;
  proposal: string;
  verdict: "APPROVED" | "CHANGES_REQUESTED";
  comments: string[];
};

export type DeliberationSummary = {
  taskId: string;
  taskTitle: string;
  implementerAssignee: CLIAdapterId;
  reviewerAssignee: CLIAdapterId;
  maxRefinePasses: number;
  refinePassesUsed: number;
  finalVerdict: "APPROVED" | "CHANGES_REQUESTED";
  rounds: DeliberationRound[];
  pendingComments: string[];
};

export type RunDeliberationPassInput = {
  projectName: string;
  rootDir: string;
  phase: Phase;
  task: Task;
  implementerAssignee: CLIAdapterId;
  reviewerAssignee: CLIAdapterId;
  maxRefinePasses: number;
  runInternalWork: (input: {
    assignee: CLIAdapterId;
    prompt: string;
    phaseId: string;
    taskId: string;
    resume?: boolean;
  }) => Promise<WorkResult>;
};

export type RunDeliberationPassResult =
  | {
      status: "APPROVED";
      refinedPrompt: string;
      summary: DeliberationSummary;
    }
  | {
      status: "MAX_REFINE_PASSES_EXCEEDED";
      refinedPrompt: string;
      summary: DeliberationSummary;
    };

function normalizeComments(comments: string[]): string[] {
  return comments
    .map((comment) => comment.trim())
    .filter((comment) => comment.length > 0);
}

function buildProposalPrompt(input: {
  projectName: string;
  rootDir: string;
  phase: Phase;
  task: Task;
}): string {
  return [
    "Deliberation Stage: PROPOSE",
    `Project: ${input.projectName}`,
    `Repository root: ${input.rootDir}`,
    `Phase: ${input.phase.name}`,
    `Task: ${input.task.title}`,
    "",
    "Task description:",
    input.task.description,
    "",
    "Produce an implementation prompt that is specific, minimal, and executable.",
    "Output contract:",
    '- Return valid JSON only: {"proposal":"..."}',
  ].join("\n");
}

function buildCritiquePrompt(input: {
  projectName: string;
  rootDir: string;
  phase: Phase;
  task: Task;
  proposal: string;
}): string {
  return [
    "Deliberation Stage: CRITIQUE",
    `Project: ${input.projectName}`,
    `Repository root: ${input.rootDir}`,
    `Phase: ${input.phase.name}`,
    `Task: ${input.task.title}`,
    "",
    "Task description:",
    input.task.description,
    "",
    "Proposed implementation prompt:",
    input.proposal,
    "",
    "Critique for blocking issues only.",
    "Output contract:",
    '- Return valid JSON only: {"verdict":"APPROVED|CHANGES_REQUESTED","comments":["..."]}.',
    "- Use APPROVED with comments=[] when no blocking issues remain.",
  ].join("\n");
}

function buildRefinePrompt(input: {
  projectName: string;
  rootDir: string;
  phase: Phase;
  task: Task;
  proposal: string;
  comments: string[];
}): string {
  return [
    "Deliberation Stage: REFINE",
    `Project: ${input.projectName}`,
    `Repository root: ${input.rootDir}`,
    `Phase: ${input.phase.name}`,
    `Task: ${input.task.title}`,
    "",
    "Task description:",
    input.task.description,
    "",
    "Current proposal:",
    input.proposal,
    "",
    "Reviewer blocking comments:",
    ...input.comments.map((comment, index) => `${index + 1}. ${comment}`),
    "",
    "Return a refined implementation prompt that resolves every blocking comment.",
    "Output contract:",
    '- Return valid JSON only: {"proposal":"..."}',
  ].join("\n");
}

export async function runDeliberationPass(
  input: RunDeliberationPassInput,
): Promise<RunDeliberationPassResult> {
  if (!input.projectName.trim()) {
    throw new Error("projectName must not be empty.");
  }
  if (!input.rootDir.trim()) {
    throw new Error("rootDir must not be empty.");
  }
  if (!input.task.title.trim()) {
    throw new Error("task.title must not be empty.");
  }
  if (!input.task.description.trim()) {
    throw new Error("task.description must not be empty.");
  }
  if (!Number.isInteger(input.maxRefinePasses) || input.maxRefinePasses < 1) {
    throw new Error("maxRefinePasses must be a positive integer.");
  }

  const rounds: DeliberationRound[] = [];
  let refinePassesUsed = 0;

  const proposeResult = await input.runInternalWork({
    assignee: input.implementerAssignee,
    phaseId: input.phase.id,
    taskId: input.task.id,
    resume: false,
    prompt: buildProposalPrompt({
      projectName: input.projectName,
      rootDir: input.rootDir,
      phase: input.phase,
      task: input.task,
    }),
  });
  let currentProposal = PROPOSAL_RESPONSE_SCHEMA.parse(
    parseJsonFromModelOutput(
      proposeResult.stdout,
      "Deliberation proposer output is not valid JSON.",
    ),
  ).proposal;

  while (true) {
    const critiqueResult = await input.runInternalWork({
      assignee: input.reviewerAssignee,
      phaseId: input.phase.id,
      taskId: input.task.id,
      resume: rounds.length > 0,
      prompt: buildCritiquePrompt({
        projectName: input.projectName,
        rootDir: input.rootDir,
        phase: input.phase,
        task: input.task,
        proposal: currentProposal,
      }),
    });
    const critiquePayload = CRITIQUE_RESPONSE_SCHEMA.parse(
      parseJsonFromModelOutput(
        critiqueResult.stdout,
        "Deliberation critique output is not valid JSON.",
      ),
    );
    const comments = normalizeComments(critiquePayload.comments);
    if (
      critiquePayload.verdict === "CHANGES_REQUESTED" &&
      comments.length === 0
    ) {
      throw new Error(
        "Critique verdict CHANGES_REQUESTED requires at least one comment.",
      );
    }

    rounds.push({
      round: rounds.length + 1,
      proposal: currentProposal,
      verdict: critiquePayload.verdict,
      comments,
    });

    if (critiquePayload.verdict === "APPROVED") {
      return {
        status: "APPROVED",
        refinedPrompt: currentProposal,
        summary: {
          taskId: input.task.id,
          taskTitle: input.task.title,
          implementerAssignee: input.implementerAssignee,
          reviewerAssignee: input.reviewerAssignee,
          maxRefinePasses: input.maxRefinePasses,
          refinePassesUsed,
          finalVerdict: "APPROVED",
          rounds,
          pendingComments: [],
        },
      };
    }

    if (refinePassesUsed >= input.maxRefinePasses) {
      return {
        status: "MAX_REFINE_PASSES_EXCEEDED",
        refinedPrompt: currentProposal,
        summary: {
          taskId: input.task.id,
          taskTitle: input.task.title,
          implementerAssignee: input.implementerAssignee,
          reviewerAssignee: input.reviewerAssignee,
          maxRefinePasses: input.maxRefinePasses,
          refinePassesUsed,
          finalVerdict: "CHANGES_REQUESTED",
          rounds,
          pendingComments: comments,
        },
      };
    }

    const refineResult = await input.runInternalWork({
      assignee: input.implementerAssignee,
      phaseId: input.phase.id,
      taskId: input.task.id,
      resume: true,
      prompt: buildRefinePrompt({
        projectName: input.projectName,
        rootDir: input.rootDir,
        phase: input.phase,
        task: input.task,
        proposal: currentProposal,
        comments,
      }),
    });
    currentProposal = PROPOSAL_RESPONSE_SCHEMA.parse(
      parseJsonFromModelOutput(
        refineResult.stdout,
        "Deliberation refine output is not valid JSON.",
      ),
    ).proposal;
    refinePassesUsed += 1;
  }
}
