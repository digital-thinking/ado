import type { GitHubIssue, GitHubManager } from "../vcs";
import {
  scanTodoFixmeComments,
  type TodoFixmeFinding,
  type TodoFixmePriorityWeights,
  type TodoFixmeScannerOptions,
  type TodoFixmeTag,
  type TodoFixmeTagWeights,
} from "./todo-fixme-scanner";

export type DiscoveryCandidateSource = "TODO_COMMENT" | "GITHUB_ISSUE";

type BaseDiscoveryCandidate = {
  sourceId: string;
  source: DiscoveryCandidateSource;
  title: string;
  description: string;
  priorityScore: number;
  recencyScore: number;
  frequencyScore: number;
  tagScore: number;
};

export type TodoCommentCandidate = BaseDiscoveryCandidate & {
  source: "TODO_COMMENT";
  tag: TodoFixmeTag;
  filePath: string;
  line: number;
  lineText: string;
};

export type GitHubIssueCandidate = BaseDiscoveryCandidate & {
  source: "GITHUB_ISSUE";
  issueNumber: number;
  issueUrl: string;
};

export type DiscoveryCandidate = TodoCommentCandidate | GitHubIssueCandidate;

export type MergeDiscoveryCandidatesInput = {
  todoFindings: TodoFixmeFinding[];
  openIssues: GitHubIssue[];
  priorityWeights?: Partial<TodoFixmePriorityWeights>;
};

export type DiscoverTaskCandidatesInput = {
  rootDir: string;
  githubManager: Pick<GitHubManager, "listOpenIssues">;
  includePatterns?: TodoFixmeScannerOptions["includePatterns"];
  excludePatterns?: TodoFixmeScannerOptions["excludePatterns"];
  priorityWeights?: Partial<TodoFixmePriorityWeights>;
  tagWeights?: Partial<TodoFixmeTagWeights>;
  maxFileSizeBytes?: number;
  issueLimit?: number;
  issueLabels?: string[];
  maxCandidates?: number;
};

const DEFAULT_PRIORITY_WEIGHTS: TodoFixmePriorityWeights = {
  recency: 0.4,
  frequency: 0.3,
  tags: 0.3,
};

const ISSUE_CHECKLIST_PATTERN = /^\s*[-*]\s*\[\s\]\s+(.+)$/;
const ISSUE_TAG_LINE_PATTERN = /\b(TODO|FIXME)\b[:\-\s]*(.+)$/i;

type IssueCandidateDraft = {
  issueNumber: number;
  issueUrl: string;
  issueTitle: string;
  title: string;
  description: string;
  updatedAtMs: number;
  tagSignal: number;
  signature: string;
};

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseTimestamp(input: string): number {
  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergePriorityWeights(
  override?: Partial<TodoFixmePriorityWeights>,
): TodoFixmePriorityWeights {
  return {
    recency: override?.recency ?? DEFAULT_PRIORITY_WEIGHTS.recency,
    frequency: override?.frequency ?? DEFAULT_PRIORITY_WEIGHTS.frequency,
    tags: override?.tags ?? DEFAULT_PRIORITY_WEIGHTS.tags,
  };
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function scoreIssueTextSignals(text: string): number {
  const normalized = text.toLowerCase();
  const fixSignals = countMatches(
    normalized,
    /\b(fixme|critical|urgent|blocker|bug|regression)\b/g,
  );
  const todoSignals = countMatches(
    normalized,
    /\b(todo|follow[- ]?up|cleanup|refactor|improve)\b/g,
  );
  return fixSignals * 2 + todoSignals;
}

function summarizeIssueBody(body: string): string {
  const lines = body
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return "Open GitHub issue candidate.";
  }

  const summary = lines[0];
  return summary.length > 240 ? `${summary.slice(0, 237)}...` : summary;
}

function parseIssueBodyCandidates(
  body: string,
): Array<{ title: string; tagSignal: number }> {
  const candidates: Array<{ title: string; tagSignal: number }> = [];
  const seen = new Set<string>();

  for (const rawLine of body.split(/\r?\n/)) {
    const checklistMatch = ISSUE_CHECKLIST_PATTERN.exec(rawLine);
    if (checklistMatch?.[1]) {
      const title = normalizeText(checklistMatch[1]);
      if (title) {
        const signature = title.toLowerCase();
        if (!seen.has(signature)) {
          seen.add(signature);
          candidates.push({
            title,
            tagSignal: Math.max(1, scoreIssueTextSignals(title)),
          });
        }
      }
      continue;
    }

    const tagMatch = ISSUE_TAG_LINE_PATTERN.exec(rawLine);
    if (!tagMatch?.[2]) {
      continue;
    }

    const title = normalizeText(tagMatch[2]);
    if (!title) {
      continue;
    }
    const signature = title.toLowerCase();
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    const issueTag = tagMatch[1]?.toUpperCase();
    const tagBoost = issueTag === "FIXME" ? 2 : 1;
    candidates.push({
      title,
      tagSignal: Math.max(tagBoost, scoreIssueTextSignals(title) + tagBoost),
    });
  }

  return candidates;
}

function normalizeScore(value: number, min: number, max: number): number {
  if (max <= min) {
    return 1;
  }
  return (value - min) / (max - min);
}

function buildIssueCandidateDrafts(
  issues: GitHubIssue[],
): IssueCandidateDraft[] {
  const drafts: IssueCandidateDraft[] = [];

  for (const issue of issues) {
    const issueTitle = normalizeText(issue.title);
    const issueSummary = summarizeIssueBody(issue.body);
    const updatedAtMs = parseTimestamp(issue.updatedAt || issue.createdAt);

    drafts.push({
      issueNumber: issue.number,
      issueUrl: issue.url,
      issueTitle,
      title: issueTitle,
      description: issueSummary,
      updatedAtMs,
      tagSignal: Math.max(
        1,
        scoreIssueTextSignals(`${issueTitle}\n${issue.body}`),
      ),
      signature: issueTitle.toLowerCase(),
    });

    const bodyCandidates = parseIssueBodyCandidates(issue.body);
    for (const candidate of bodyCandidates) {
      drafts.push({
        issueNumber: issue.number,
        issueUrl: issue.url,
        issueTitle,
        title: candidate.title,
        description: `From issue #${issue.number}: ${issueTitle}`,
        updatedAtMs,
        tagSignal: candidate.tagSignal,
        signature: candidate.title.toLowerCase(),
      });
    }
  }

  return drafts;
}

function buildTodoCommentCandidates(
  findings: TodoFixmeFinding[],
  priorityWeights: TodoFixmePriorityWeights,
): TodoCommentCandidate[] {
  return findings.map((finding) => ({
    sourceId: `todo:${finding.filePath}:${finding.line}:${finding.tag}`,
    source: "TODO_COMMENT",
    tag: finding.tag,
    title:
      finding.text || `${finding.tag} in ${finding.filePath}:${finding.line}`,
    description:
      `${finding.filePath}:${finding.line} ${finding.lineText}`.trim(),
    priorityScore:
      finding.recencyScore * priorityWeights.recency +
      finding.frequencyScore * priorityWeights.frequency +
      finding.tagScore * priorityWeights.tags,
    recencyScore: finding.recencyScore,
    frequencyScore: finding.frequencyScore,
    tagScore: finding.tagScore,
    filePath: finding.filePath,
    line: finding.line,
    lineText: finding.lineText,
  }));
}

function buildGitHubIssueCandidates(
  issues: GitHubIssue[],
  priorityWeights: TodoFixmePriorityWeights,
): GitHubIssueCandidate[] {
  const drafts = buildIssueCandidateDrafts(issues);
  if (drafts.length === 0) {
    return [];
  }

  const minUpdatedAtMs = Math.min(...drafts.map((draft) => draft.updatedAtMs));
  const maxUpdatedAtMs = Math.max(...drafts.map((draft) => draft.updatedAtMs));

  const frequencyBySignature = new Map<string, number>();
  for (const draft of drafts) {
    frequencyBySignature.set(
      draft.signature,
      (frequencyBySignature.get(draft.signature) ?? 0) + 1,
    );
  }
  const maxFrequency = Math.max(...frequencyBySignature.values());
  const maxTagSignal = Math.max(...drafts.map((draft) => draft.tagSignal));

  return drafts.map((draft) => {
    const frequency = frequencyBySignature.get(draft.signature) ?? 1;
    const recencyScore = normalizeScore(
      draft.updatedAtMs,
      minUpdatedAtMs,
      maxUpdatedAtMs,
    );
    const frequencyScore = maxFrequency <= 0 ? 0 : frequency / maxFrequency;
    const tagScore = maxTagSignal <= 0 ? 0 : draft.tagSignal / maxTagSignal;
    const priorityScore =
      recencyScore * priorityWeights.recency +
      frequencyScore * priorityWeights.frequency +
      tagScore * priorityWeights.tags;

    return {
      sourceId: `issue:${draft.issueNumber}:${draft.signature}`,
      source: "GITHUB_ISSUE" as const,
      title: draft.title,
      description: draft.description,
      issueNumber: draft.issueNumber,
      issueUrl: draft.issueUrl,
      recencyScore,
      frequencyScore,
      tagScore,
      priorityScore,
    };
  });
}

function compareCandidates(
  left: DiscoveryCandidate,
  right: DiscoveryCandidate,
): number {
  if (right.priorityScore !== left.priorityScore) {
    return right.priorityScore - left.priorityScore;
  }
  if (right.tagScore !== left.tagScore) {
    return right.tagScore - left.tagScore;
  }
  if (left.source !== right.source) {
    return left.source.localeCompare(right.source);
  }
  return left.sourceId.localeCompare(right.sourceId);
}

export function mergeDiscoveryCandidates(
  input: MergeDiscoveryCandidatesInput,
): DiscoveryCandidate[] {
  const priorityWeights = mergePriorityWeights(input.priorityWeights);
  const todoCandidates = buildTodoCommentCandidates(
    input.todoFindings,
    priorityWeights,
  );
  const issueCandidates = buildGitHubIssueCandidates(
    input.openIssues,
    priorityWeights,
  );
  const merged = [...todoCandidates, ...issueCandidates];
  merged.sort(compareCandidates);
  return merged;
}

export async function discoverTaskCandidates(
  input: DiscoverTaskCandidatesInput,
): Promise<DiscoveryCandidate[]> {
  if (
    input.maxCandidates !== undefined &&
    (!Number.isInteger(input.maxCandidates) || input.maxCandidates <= 0)
  ) {
    throw new Error("maxCandidates must be a positive integer.");
  }

  const [todoFindings, openIssues] = await Promise.all([
    scanTodoFixmeComments({
      rootDir: input.rootDir,
      includePatterns: input.includePatterns,
      excludePatterns: input.excludePatterns,
      priorityWeights: input.priorityWeights,
      tagWeights: input.tagWeights,
      maxFileSizeBytes: input.maxFileSizeBytes,
    }),
    input.githubManager.listOpenIssues({
      cwd: input.rootDir,
      limit: input.issueLimit,
      labels: input.issueLabels,
    }),
  ]);

  const merged = mergeDiscoveryCandidates({
    todoFindings,
    openIssues,
    priorityWeights: input.priorityWeights,
  });

  if (input.maxCandidates === undefined) {
    return merged;
  }

  return merged.slice(0, input.maxCandidates);
}
