import {
  WorkerArchetypeSchema,
  type Phase,
  type Task,
  type WorkerArchetype,
} from "../types";

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

  const lines = [
    `Worker archetype: ${archetype}`,
    `System prompt: ${systemPrompt}`,
    `You are implementing a coding task for the ${input.projectName} project.`,
    `Repository root: ${input.rootDir}`,
    `Phase: ${input.phase.name}`,
    `Task: ${input.task.title}`,
    "Task description:",
    input.task.description,
    "Requirements:",
    "- Implement the task in this repository.",
    "- Run relevant validations/tests.",
    "- Return a concise summary of concrete changes and validation commands.",
  ];

  if (archetype === "CODER") {
    lines.push(
      "- Commit all changes with a descriptive git commit message before declaring the task done.",
      "- Leave the repository in a clean state (no untracked or unstaged changes after your commit).",
    );
  }

  if (archetype === "REVIEWER") {
    const gitDiff = input.gitDiff?.trim();
    if (!gitDiff) {
      throw new Error("Reviewer prompt requires gitDiff context.");
    }
    lines.push("Git diff to review:", gitDiff);
  }

  return lines.join("\n\n");
}
