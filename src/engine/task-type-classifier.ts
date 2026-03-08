import type { TaskType } from "../types";

export type InferTaskTypeInput = {
  title: string;
  description: string;
};

const TASK_TYPE_PRIORITY: readonly TaskType[] = [
  "security-audit",
  "code-review",
  "test-writing",
  "documentation",
  "implementation",
];

const TASK_TYPE_KEYWORDS: Readonly<Record<TaskType, readonly RegExp[]>> = {
  "security-audit": [
    /\bsecurity\b/,
    /\bvulnerab(?:ility|ilities)\b/,
    /\bvuln\b/,
    /\bcve-\d{4}-\d+\b/,
    /\bhardening\b/,
    /\bthreat\b/,
    /\bpen(?:test|etration test)\b/,
  ],
  "code-review": [
    /\breview(?:er|ing|ed)?\b/,
    /\bpr review\b/,
    /\bpeer review\b/,
    /\blgtm\b/,
  ],
  "test-writing": [
    /\btest(?:s|ing)?\b/,
    /\bunit test(?:s)?\b/,
    /\bintegration test(?:s)?\b/,
    /\be2e\b/,
    /\bregression test(?:s)?\b/,
    /\bcoverage\b/,
  ],
  documentation: [
    /\bdocs?\b/,
    /\bdocumentation\b/,
    /\breadme\b/,
    /\bchangelog\b/,
    /\bguide\b/,
  ],
  implementation: [
    /\bimplement(?:ation|ing|ed)?\b/,
    /\bbuild(?:ing)?\b/,
    /\bcreate(?:d|s|ing)?\b/,
    /\badd(?:ed|s|ing)?\b/,
    /\bfeature\b/,
    /\bfix(?:es|ed|ing)?\b/,
    /\bbug\b/,
    /\brefactor(?:ing|ed)?\b/,
  ],
};

function normalizeText(input: InferTaskTypeInput): string {
  return `${input.title} ${input.description}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function scoreTaskType(taskType: TaskType, text: string): number {
  const patterns = TASK_TYPE_KEYWORDS[taskType];
  let score = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      score += 1;
    }
  }
  return score;
}

export function inferTaskType(input: InferTaskTypeInput): TaskType | undefined {
  const text = normalizeText(input);
  if (!text) {
    return undefined;
  }

  let bestMatch: TaskType | undefined;
  let bestScore = 0;

  // Deterministic tie-break: first type in TASK_TYPE_PRIORITY wins.
  for (const taskType of TASK_TYPE_PRIORITY) {
    const score = scoreTaskType(taskType, text);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = taskType;
    }
  }

  return bestScore > 0 ? bestMatch : undefined;
}
