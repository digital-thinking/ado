import { z } from "zod";

import { buildWorkerPrompt } from "./worker-prompts";
import type { CLIAdapterId, Phase, Task } from "../types";

const REVIEWER_RESPONSE_SCHEMA = z.object({
  verdict: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
  comments: z.array(z.string()).default([]),
});

const REVIEWER_TASK_ID = "11111111-1111-4111-8111-111111111111";
const FIXER_TASK_ID = "22222222-2222-4222-8222-222222222222";

function createReviewerTask(): Task {
  return {
    id: REVIEWER_TASK_ID,
    title: "CI validation review",
    description: "Review current git diff and produce concrete blocking comments.",
    status: "TODO",
    assignee: "UNASSIGNED",
    dependencies: [],
  };
}

function createFixerTask(comments: string[]): Task {
  return {
    id: FIXER_TASK_ID,
    title: "CI validation fixes",
    description: `Address reviewer comments:\n${comments.join("\n")}`,
    status: "TODO",
    assignee: "UNASSIGNED",
    dependencies: [],
  };
}

function extractFirstJsonObject(raw: string): string | null {
  const startIndex = raw.indexOf("{");
  if (startIndex < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = startIndex; index < raw.length; index += 1) {
    const char = raw[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function parseJsonFromModelOutput(rawOutput: string): unknown {
  const direct = rawOutput.trim();
  if (!direct) {
    throw new Error("Reviewer returned empty output.");
  }

  try {
    return JSON.parse(direct);
  } catch {
    // Continue.
  }

  const fencedMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(rawOutput);
  if (fencedMatch) {
    try {
      return JSON.parse(fencedMatch[1].trim());
    } catch {
      // Continue.
    }
  }

  const objectPayload = extractFirstJsonObject(rawOutput);
  if (objectPayload) {
    try {
      return JSON.parse(objectPayload);
    } catch {
      // Continue.
    }
  }

  throw new Error("Reviewer output is not valid JSON.");
}

function normalizeComments(comments: string[]): string[] {
  return comments.map((comment) => comment.trim()).filter((comment) => comment.length > 0);
}

function buildReviewerPrompt(input: {
  projectName: string;
  rootDir: string;
  phase: Phase;
  gitDiff: string;
}): string {
  const basePrompt = buildWorkerPrompt({
    archetype: "REVIEWER",
    projectName: input.projectName,
    rootDir: input.rootDir,
    phase: input.phase,
    task: createReviewerTask(),
    gitDiff: input.gitDiff,
  });

  return [
    basePrompt,
    "Output contract:",
    '- Return valid JSON only: {"verdict":"APPROVED|CHANGES_REQUESTED","comments":["..."]}.',
    "- comments must include only concrete, actionable blocking issues.",
    "- Use verdict=APPROVED with comments=[] when there are no blocking issues.",
  ].join("\n\n");
}

function buildFixerPrompt(input: {
  projectName: string;
  rootDir: string;
  phase: Phase;
  gitDiff: string;
  comments: string[];
}): string {
  const basePrompt = buildWorkerPrompt({
    archetype: "FIXER",
    projectName: input.projectName,
    rootDir: input.rootDir,
    phase: input.phase,
    task: createFixerTask(input.comments),
  });

  return [
    basePrompt,
    "Reviewer comments to address:",
    ...input.comments.map((comment, index) => `${index + 1}. ${comment}`),
    "",
    "Current git diff:",
    input.gitDiff,
    "",
    "Apply fixes for every reviewer comment and include concise validation evidence.",
  ].join("\n");
}

type WorkResult = {
  stdout: string;
  stderr: string;
};

export type RunCiValidationLoopInput = {
  projectName: string;
  rootDir: string;
  phase: Phase;
  assignee: CLIAdapterId;
  maxRetries: number;
  readGitDiff: () => Promise<string>;
  runInternalWork: (input: {
    assignee: CLIAdapterId;
    prompt: string;
    phaseId: string;
    resume?: boolean;
  }) => Promise<WorkResult>;
};

export type CiValidationReview = {
  reviewRound: number;
  verdict: "APPROVED" | "CHANGES_REQUESTED";
  comments: string[];
};

export type RunCiValidationLoopResult =
  | {
      status: "APPROVED";
      reviews: CiValidationReview[];
      fixAttempts: number;
    }
  | {
      status: "MAX_RETRIES_EXCEEDED";
      reviews: CiValidationReview[];
      fixAttempts: number;
      maxRetries: number;
      pendingComments: string[];
    };

export async function runCiValidationLoop(
  input: RunCiValidationLoopInput
): Promise<RunCiValidationLoopResult> {
  if (!input.projectName.trim()) {
    throw new Error("projectName must not be empty.");
  }
  if (!input.rootDir.trim()) {
    throw new Error("rootDir must not be empty.");
  }
  if (!Number.isInteger(input.maxRetries) || input.maxRetries < 0) {
    throw new Error("maxRetries must be a non-negative integer.");
  }

  const reviews: CiValidationReview[] = [];
  let fixAttempts = 0;

  while (true) {
    const gitDiff = (await input.readGitDiff()).trim();
    if (!gitDiff) {
      return {
        status: "APPROVED",
        reviews,
        fixAttempts,
      };
    }

    const reviewerPrompt = buildReviewerPrompt({
      projectName: input.projectName,
      rootDir: input.rootDir,
      phase: input.phase,
      gitDiff,
    });
    const reviewerResult = await input.runInternalWork({
      assignee: input.assignee,
      prompt: reviewerPrompt,
      phaseId: input.phase.id,
      resume: false,
    });

    const reviewerPayload = REVIEWER_RESPONSE_SCHEMA.parse(
      parseJsonFromModelOutput(reviewerResult.stdout)
    );
    const comments = normalizeComments(reviewerPayload.comments);
    if (reviewerPayload.verdict === "CHANGES_REQUESTED" && comments.length === 0) {
      throw new Error("Reviewer verdict CHANGES_REQUESTED requires at least one comment.");
    }

    reviews.push({
      reviewRound: reviews.length + 1,
      verdict: reviewerPayload.verdict,
      comments,
    });

    if (reviewerPayload.verdict === "APPROVED") {
      return {
        status: "APPROVED",
        reviews,
        fixAttempts,
      };
    }

    if (fixAttempts >= input.maxRetries) {
      return {
        status: "MAX_RETRIES_EXCEEDED",
        reviews,
        fixAttempts,
        maxRetries: input.maxRetries,
        pendingComments: comments,
      };
    }

    const fixerPrompt = buildFixerPrompt({
      projectName: input.projectName,
      rootDir: input.rootDir,
      phase: input.phase,
      gitDiff,
      comments,
    });
    await input.runInternalWork({
      assignee: input.assignee,
      prompt: fixerPrompt,
      phaseId: input.phase.id,
      resume: fixAttempts > 0,
    });
    fixAttempts += 1;
  }
}
