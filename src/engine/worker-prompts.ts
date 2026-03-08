import {
  WorkerArchetypeSchema,
  type Phase,
  type Task,
  type WorkerArchetype,
} from "../types";
import { resolveTaskCompletionSideEffectContracts } from "../web/control-center-service";

const WORKER_SYSTEM_PROMPTS: Record<WorkerArchetype, string> = {
  CODER:
    "Implement the task with minimal, correct changes and keep the codebase coherent.",
  TESTER:
    "Execute validations, report concrete failures, and avoid speculative conclusions.",
  REVIEWER:
    "Review the patch critically with evidence from the provided git diff.",
  FIXER:
    "Resolve reported failures quickly with targeted fixes and clear verification steps.",
};

type WorkerPromptInput = {
  archetype: WorkerArchetype;
  projectName: string;
  rootDir: string;
  phase: Phase;
  task: Task;
  gitDiff?: string;
};

export function getWorkerSystemPrompt(archetype: WorkerArchetype): string {
  const validated = WorkerArchetypeSchema.parse(archetype);
  return WORKER_SYSTEM_PROMPTS[validated];
}

export function buildWorkerPrompt(input: WorkerPromptInput): string {
  const archetype = WorkerArchetypeSchema.parse(input.archetype);
  const systemPrompt = getWorkerSystemPrompt(archetype);
  const contracts = resolveTaskCompletionSideEffectContracts(input.task);
  const isPrTask = contracts.includes("PR_CREATION");

  const requirements = isPrTask
    ? [
        `- This is a pull-request creation task. Do NOT modify any source files.`,
        `- Run exactly: gh pr create --base main --head ${input.phase.branchName} --title "${input.phase.name}" --body "Phase implementation complete."`,
        `- If a PR already exists for this branch, run: gh pr list --head ${input.phase.branchName} --json url --jq '.[0].url' to confirm it and report the URL.`,
        "- Return the PR URL in your summary.",
      ]
    : [
        "- Implement the task in this repository.",
        "- Run relevant validations/tests.",
        "- Return a concise summary of concrete changes and validation commands.",
        "- Commit all changes with a descriptive git commit message before declaring the task done.",
        "- Leave the repository in a clean state (no untracked or unstaged changes after your commit).",
      ];

  const lines = [
    `Worker archetype: ${archetype}`,
    `System prompt: ${systemPrompt}`,
    `You are implementing a coding task for the ${input.projectName} project.`,
    `Repository root: ${input.rootDir}`,
    `Phase: ${input.phase.name}`,
    `Branch: ${input.phase.branchName}`,
    `Task: ${input.task.title}`,
    "Task description:",
    input.task.description,
    "Requirements:",
    ...requirements,
  ];

  if (!isPrTask && archetype === "REVIEWER") {
    const gitDiff = input.gitDiff?.trim();
    if (!gitDiff) {
      throw new Error("Reviewer prompt requires gitDiff context.");
    }
    lines.push("Git diff to review:", gitDiff);
  }

  return lines.join("\n\n");
}
