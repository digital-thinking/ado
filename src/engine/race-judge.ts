type RaceJudgeBranchStatus = "fulfilled" | "rejected";
const RACE_JUDGE_DIFF_MAX_CHARS = 12_000;
const RACE_JUDGE_STDOUT_MAX_CHARS = 3_000;
const RACE_JUDGE_STDERR_MAX_CHARS = 3_000;

export type RaceJudgeBranchInput = {
  index: number;
  branchName: string;
  status: RaceJudgeBranchStatus;
  diff: string;
  stdout: string;
  stderr: string;
  error?: string;
};

export type BuildRaceJudgePromptInput = {
  projectName: string;
  rootDir: string;
  phaseName: string;
  taskTitle: string;
  taskDescription: string;
  branches: readonly RaceJudgeBranchInput[];
};

export type RaceJudgeVerdict = {
  pickedBranchIndex: number;
  reasoning: string;
};

function normalizeRequiredText(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} must not be empty.`);
  }

  return normalized;
}

function normalizeBranchIndex(index: number): number {
  if (!Number.isInteger(index) || index <= 0) {
    throw new Error("branch.index must be a positive integer.");
  }

  return index;
}

function normalizeBranchStatus(status: string): RaceJudgeBranchStatus {
  if (status !== "fulfilled" && status !== "rejected") {
    throw new Error("branch.status must be either 'fulfilled' or 'rejected'.");
  }

  return status;
}

function normalizeBlock(value: string): string {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : "(empty)";
}

function truncateBlock(value: string, maxChars: number): string {
  const normalized = normalizeBlock(value);
  if (normalized === "(empty)" || normalized.length <= maxChars) {
    return normalized;
  }

  const visibleChars = Math.max(0, maxChars);
  const omittedChars = normalized.length - visibleChars;
  return `${normalized.slice(0, visibleChars)}\n[truncated ${omittedChars} chars]`;
}

function formatBranchSection(branch: RaceJudgeBranchInput): string {
  const index = normalizeBranchIndex(branch.index);
  const status = normalizeBranchStatus(branch.status);
  const branchName = normalizeRequiredText(
    branch.branchName,
    "branch.branchName",
  );
  const error = branch.error?.trim();

  const lines = [
    `## Candidate ${index}`,
    `Branch: ${branchName}`,
    `Status: ${status}`,
  ];

  if (error) {
    lines.push(`Error: ${error}`);
  }

  lines.push(
    "",
    "Git diff:",
    "```diff",
    truncateBlock(branch.diff, RACE_JUDGE_DIFF_MAX_CHARS),
    "```",
    "",
    "Captured stdout:",
    "```text",
    truncateBlock(branch.stdout, RACE_JUDGE_STDOUT_MAX_CHARS),
    "```",
    "",
    "Captured stderr:",
    "```text",
    truncateBlock(branch.stderr, RACE_JUDGE_STDERR_MAX_CHARS),
    "```",
  );

  return lines.join("\n");
}

export function buildRaceJudgePrompt(input: BuildRaceJudgePromptInput): string {
  const projectName = normalizeRequiredText(input.projectName, "projectName");
  const rootDir = normalizeRequiredText(input.rootDir, "rootDir");
  const phaseName = normalizeRequiredText(input.phaseName, "phaseName");
  const taskTitle = normalizeRequiredText(input.taskTitle, "taskTitle");
  const taskDescription = normalizeRequiredText(
    input.taskDescription,
    "taskDescription",
  );
  if (input.branches.length === 0) {
    throw new Error("branches must not be empty.");
  }

  const seenIndexes = new Set<number>();
  for (const branch of input.branches) {
    const index = normalizeBranchIndex(branch.index);
    if (seenIndexes.has(index)) {
      throw new Error(`branches contains duplicate index ${index}.`);
    }
    seenIndexes.add(index);
  }

  return [
    "Race Judge",
    `Project: ${projectName}`,
    `Repository root: ${rootDir}`,
    `Phase: ${phaseName}`,
    `Task: ${taskTitle}`,
    "",
    "Task description:",
    taskDescription,
    "",
    "Choose exactly one candidate implementation.",
    "Prefer the branch that is most correct, minimal, coherent, and best supported by its diff and execution output.",
    "Do not merge ideas across branches. Pick a single winner.",
    "",
    "Output contract:",
    "- First verdict line: PICK <N>",
    "- After the verdict, provide plain-text reasoning that references concrete evidence from the candidate data.",
    "",
    "Candidates:",
    ...input.branches.map((branch) => formatBranchSection(branch)),
  ].join("\n");
}

export function parseRaceJudgeVerdict(
  rawOutput: string,
  branchCount: number,
): RaceJudgeVerdict {
  const trimmedOutput = rawOutput.trim();
  if (!trimmedOutput) {
    throw new Error("Judge output must not be empty.");
  }
  if (!Number.isInteger(branchCount) || branchCount <= 0) {
    throw new Error("branchCount must be a positive integer.");
  }

  const verdictMatch = /(^|\n)\s*PICK\s+(\d+)\b([^\n]*)/i.exec(trimmedOutput);
  if (!verdictMatch) {
    throw new Error("Judge output must include a 'PICK <N>' verdict.");
  }

  const pickedBranchIndex = Number(verdictMatch[2]);
  if (
    !Number.isInteger(pickedBranchIndex) ||
    pickedBranchIndex < 1 ||
    pickedBranchIndex > branchCount
  ) {
    throw new Error(
      `Judge verdict PICK ${verdictMatch[2]} is out of range for ${branchCount} branch(es).`,
    );
  }

  const inlineReasoning =
    verdictMatch[3]?.trim().replace(/^[:.-]\s*/, "") ?? "";
  const trailingReasoning = trimmedOutput
    .slice(verdictMatch.index + verdictMatch[0].length)
    .trim();
  const reasoning = [inlineReasoning, trailingReasoning]
    .map((value) => value.replace(/^Reasoning:\s*/i, "").trim())
    .filter((value) => value.length > 0)
    .join("\n")
    .trim();

  if (!reasoning) {
    throw new Error("Judge output must include reasoning after the verdict.");
  }

  return {
    pickedBranchIndex,
    reasoning,
  };
}
