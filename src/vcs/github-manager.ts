import { ProcessExecutionError, type ProcessRunner } from "../process";

export type CreatePullRequestInput = {
  base: string;
  head: string;
  title: string;
  body: string;
  cwd: string;
  templatePath?: string;
  labels?: string[];
  assignees?: string[];
  draft?: boolean;
};

export type ListOpenIssuesInput = {
  cwd: string;
  limit?: number;
  labels?: string[];
};

export type GitHubIssue = {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
};

export type CiCheckState =
  | "PENDING"
  | "SUCCESS"
  | "FAILURE"
  | "CANCELLED"
  | "UNKNOWN";

export type CiCheck = {
  name: string;
  state: CiCheckState;
  detailsUrl?: string;
};

export type CiStatusSummary = {
  overall: CiCheckState;
  checks: CiCheck[];
};

export type MergePullRequestInput = {
  prNumber: number;
  cwd: string;
  /** Merge strategy forwarded to `gh pr merge`. Defaults to "merge". */
  mergeMethod?: "merge" | "squash" | "rebase";
};

export type MarkPullRequestReadyInput = {
  prNumber: number;
  cwd: string;
};

export type PollCiStatusInput = {
  prNumber: number;
  cwd: string;
  intervalMs?: number;
  timeoutMs?: number;
  terminalConfirmations?: number;
  onTransition?: (transition: CiPollTransition) => void | Promise<void>;
};

export type CiPollTransition = {
  pollCount: number;
  previousOverall: CiCheckState | null;
  overall: CiCheckState;
  previousChecksFingerprint: string | null;
  checksFingerprint: string;
  isRerun: boolean;
  isTerminal: boolean;
  terminalObservationCount: number;
  requiredTerminalObservations: number;
};

export class CiPollingError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "CiPollingError";
    this.retryable = retryable;
  }
}

type StatusCheckRollupResponse = {
  statusCheckRollup?: Array<Record<string, unknown>>;
};

type IssuesListResponse = Array<Record<string, unknown>>;

function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const normalized = line.trim();
    if (normalized) {
      return normalized.replace(/^error:\s*/i, "");
    }
  }

  return null;
}

function classifyCiPollingFailure(
  prNumber: number,
  error: unknown,
): CiPollingError {
  if (error instanceof CiPollingError) {
    return error;
  }

  if (error instanceof ProcessExecutionError) {
    const detail =
      firstNonEmptyLine(error.result.stderr) ??
      firstNonEmptyLine(error.result.stdout);
    const normalizedDetail = detail ?? error.message;

    if (
      /not logged into any github hosts|authentication failed|gh auth login|token is required/i.test(
        normalizedDetail,
      )
    ) {
      return new CiPollingError(
        `GitHub CLI authentication failed while polling CI for PR #${prNumber}. Run 'gh auth status' or 'gh auth login'.`,
        false,
      );
    }

    if (
      /could not resolve to a pullrequest|no pull requests found|pull request not found|not found/i.test(
        normalizedDetail,
      )
    ) {
      return new CiPollingError(
        `GitHub CLI could not access PR #${prNumber} while polling CI. Ensure the pull request exists and the current gh account can view it.`,
        false,
      );
    }

    return new CiPollingError(
      `GitHub CLI failed while polling CI for PR #${prNumber}: ${normalizedDetail}`,
      true,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return new CiPollingError(
    `CI polling failed for PR #${prNumber}: ${message}`,
    true,
  );
}

function toUpperText(value: unknown): string {
  return typeof value === "string" ? value.toUpperCase() : "";
}

function normalizeCheckState(rawCheck: Record<string, unknown>): CiCheckState {
  const status = toUpperText(rawCheck.status ?? rawCheck.state);
  const conclusion = toUpperText(rawCheck.conclusion ?? rawCheck.result);

  if (
    ["QUEUED", "IN_PROGRESS", "PENDING", "REQUESTED", "WAITING"].includes(
      status,
    )
  ) {
    return "PENDING";
  }

  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) {
    return "SUCCESS";
  }

  if (conclusion === "CANCELLED") {
    return "CANCELLED";
  }

  if (
    ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(
      conclusion,
    )
  ) {
    return "FAILURE";
  }

  if (status === "COMPLETED" && !conclusion) {
    return "UNKNOWN";
  }

  return "UNKNOWN";
}

function computeOverallState(checks: CiCheck[]): CiCheckState {
  if (checks.some((check) => check.state === "FAILURE")) {
    return "FAILURE";
  }

  if (
    checks.some(
      (check) => check.state === "PENDING" || check.state === "UNKNOWN",
    )
  ) {
    return "PENDING";
  }

  if (checks.some((check) => check.state === "CANCELLED")) {
    return "CANCELLED";
  }

  if (checks.length > 0 && checks.every((check) => check.state === "SUCCESS")) {
    return "SUCCESS";
  }

  return "PENDING";
}

function checkFingerprint(check: CiCheck): string {
  return `${check.name.trim().toLowerCase()}::${check.state}::${check.detailsUrl ?? ""}`;
}

function summaryFingerprint(summary: CiStatusSummary): string {
  const checks = [...summary.checks].sort((a, b) =>
    checkFingerprint(a).localeCompare(checkFingerprint(b)),
  );
  return `${summary.overall}|${checks.map(checkFingerprint).join("|")}`;
}

function isTerminalState(state: CiCheckState): boolean {
  return state === "SUCCESS" || state === "FAILURE" || state === "CANCELLED";
}

function parseIssueLabels(rawLabels: unknown): string[] {
  if (!Array.isArray(rawLabels)) {
    return [];
  }

  const labels: string[] = [];
  for (const rawLabel of rawLabels) {
    if (!rawLabel || typeof rawLabel !== "object") {
      continue;
    }
    const candidate = rawLabel as Record<string, unknown>;
    if (typeof candidate.name !== "string") {
      continue;
    }
    const normalized = candidate.name.trim();
    if (normalized) {
      labels.push(normalized);
    }
  }

  return labels;
}

function parseIssueRow(row: Record<string, unknown>): GitHubIssue {
  const rawNumber = row.number;
  const title = row.title;
  const url = row.url;
  const createdAt = row.createdAt;
  const updatedAt = row.updatedAt;

  if (
    typeof rawNumber !== "number" ||
    !Number.isInteger(rawNumber) ||
    rawNumber <= 0
  ) {
    throw new Error("Issue response contains invalid number.");
  }
  if (typeof title !== "string" || !title.trim()) {
    throw new Error("Issue response contains invalid title.");
  }
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("Issue response contains invalid url.");
  }
  if (typeof createdAt !== "string" || !createdAt.trim()) {
    throw new Error("Issue response contains invalid createdAt.");
  }
  if (typeof updatedAt !== "string" || !updatedAt.trim()) {
    throw new Error("Issue response contains invalid updatedAt.");
  }

  return {
    number: rawNumber,
    title: title.trim(),
    body: typeof row.body === "string" ? row.body : "",
    url: url.trim(),
    labels: parseIssueLabels(row.labels),
    createdAt,
    updatedAt,
  };
}

export class GitHubManager {
  private readonly runner: ProcessRunner;

  constructor(runner: ProcessRunner) {
    this.runner = runner;
  }

  async listOpenIssues(input: ListOpenIssuesInput): Promise<GitHubIssue[]> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("limit must be a positive integer.");
    }

    const args = [
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      String(limit),
      "--json",
      "number,title,body,url,labels,createdAt,updatedAt",
    ];
    if (input.labels && input.labels.length > 0) {
      args.push("--label", input.labels.join(","));
    }

    const result = await this.runner.run({
      command: "gh",
      args,
      cwd: input.cwd,
    });

    let payload: IssuesListResponse;
    try {
      payload = JSON.parse(result.stdout) as IssuesListResponse;
    } catch {
      throw new Error("Unable to parse open issues response from gh.");
    }

    if (!Array.isArray(payload)) {
      throw new Error("Open issues response must be a JSON array.");
    }

    return payload.map((row) => parseIssueRow(row));
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<string> {
    // Check if a PR already exists for this branch first.
    const existing = await this.runner
      .run({
        command: "gh",
        args: [
          "pr",
          "list",
          "--head",
          input.head,
          "--json",
          "url",
          "--jq",
          ".[0].url",
        ],
        cwd: input.cwd,
      })
      .catch(() => null);
    const existingUrl = existing?.stdout?.trim();
    if (
      existingUrl &&
      /^https:\/\/github\.com\/.+\/pull\/\d+/.test(existingUrl)
    ) {
      return existingUrl;
    }

    const args = [
      "pr",
      "create",
      "--base",
      input.base,
      "--head",
      input.head,
      "--title",
      input.title,
      "--body",
      input.body,
    ];
    if (input.templatePath) {
      args.push("--template", input.templatePath);
    }
    if (input.labels && input.labels.length > 0) {
      args.push("--label", input.labels.join(","));
    }
    if (input.assignees && input.assignees.length > 0) {
      args.push("--assignee", input.assignees.join(","));
    }
    if (input.draft) {
      args.push("--draft");
    }

    const result = await this.runner.run({
      command: "gh",
      args,
      cwd: input.cwd,
    });

    const url = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^https:\/\/github\.com\/.+\/pull\/\d+/.test(line));

    if (!url) {
      throw new Error("Unable to parse pull request URL from gh output.");
    }

    return url;
  }

  async mergePullRequest(input: MergePullRequestInput): Promise<void> {
    if (input.prNumber <= 0 || !Number.isInteger(input.prNumber)) {
      throw new Error("prNumber must be a positive integer.");
    }

    const mergeFlag = `--${input.mergeMethod ?? "merge"}`;

    await this.runner.run({
      command: "gh",
      args: ["pr", "merge", String(input.prNumber), mergeFlag, "--auto"],
      cwd: input.cwd,
    });
  }

  async markPullRequestReady(input: MarkPullRequestReadyInput): Promise<void> {
    if (input.prNumber <= 0 || !Number.isInteger(input.prNumber)) {
      throw new Error("prNumber must be a positive integer.");
    }

    await this.runner.run({
      command: "gh",
      args: ["pr", "ready", String(input.prNumber)],
      cwd: input.cwd,
    });
  }

  async getCiStatus(prNumber: number, cwd: string): Promise<CiStatusSummary> {
    let result;
    try {
      result = await this.runner.run({
        command: "gh",
        args: ["pr", "view", String(prNumber), "--json", "statusCheckRollup"],
        cwd,
      });
    } catch (error) {
      throw classifyCiPollingFailure(prNumber, error);
    }

    let payload: StatusCheckRollupResponse;
    try {
      payload = JSON.parse(result.stdout) as StatusCheckRollupResponse;
    } catch {
      throw new Error("Unable to parse CI status response from gh.");
    }

    const rawChecks = payload.statusCheckRollup ?? [];
    const checks = rawChecks.map((rawCheck) => ({
      name:
        (typeof rawCheck.name === "string" && rawCheck.name) ||
        (typeof rawCheck.context === "string" && rawCheck.context) ||
        "unknown-check",
      state: normalizeCheckState(rawCheck),
      detailsUrl:
        (typeof rawCheck.detailsUrl === "string" && rawCheck.detailsUrl) ||
        (typeof rawCheck.url === "string" && rawCheck.url) ||
        (typeof rawCheck.targetUrl === "string" && rawCheck.targetUrl) ||
        undefined,
    }));

    return {
      overall: computeOverallState(checks),
      checks,
    };
  }

  async pollCiStatus(input: PollCiStatusInput): Promise<CiStatusSummary> {
    const intervalMs = input.intervalMs ?? 15_000;
    const timeoutMs = input.timeoutMs ?? 15 * 60 * 1000;
    const requiredTerminalObservations = Math.max(
      1,
      input.terminalConfirmations ?? 1,
    );
    const startedAt = Date.now();
    let pollCount = 0;
    let previousOverall: CiCheckState | null = null;
    let previousChecksFingerprint: string | null = null;
    let terminalState: CiCheckState | null = null;
    let terminalObservationCount = 0;

    while (true) {
      pollCount += 1;
      const summary = await this.getCiStatus(input.prNumber, input.cwd);
      const checksFingerprint = summaryFingerprint(summary);
      const transitioned =
        previousOverall !== summary.overall ||
        previousChecksFingerprint !== checksFingerprint;

      const isTerminal = isTerminalState(summary.overall);
      if (isTerminal) {
        if (
          terminalState === summary.overall &&
          previousChecksFingerprint === checksFingerprint
        ) {
          terminalObservationCount += 1;
        } else {
          terminalState = summary.overall;
          terminalObservationCount = 1;
        }
      } else {
        terminalState = null;
        terminalObservationCount = 0;
      }

      if (transitioned && input.onTransition) {
        const isRerun =
          previousOverall !== null &&
          isTerminalState(previousOverall) &&
          summary.overall === "PENDING";
        await input.onTransition({
          pollCount,
          previousOverall,
          overall: summary.overall,
          previousChecksFingerprint,
          checksFingerprint,
          isRerun,
          isTerminal,
          terminalObservationCount,
          requiredTerminalObservations,
        });
      }
      previousOverall = summary.overall;
      previousChecksFingerprint = checksFingerprint;

      if (
        isTerminal &&
        terminalObservationCount >= requiredTerminalObservations
      ) {
        return summary;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `CI polling timed out after ${timeoutMs}ms for PR #${input.prNumber}.`,
        );
      }

      if (
        isTerminal &&
        terminalObservationCount < requiredTerminalObservations
      ) {
        continue;
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, intervalMs);
      });
    }
  }
}

export function parsePullRequestNumberFromUrl(prUrl: string): number {
  const match = /\/pull\/(\d+)(?:\/|$|[?#])/.exec(prUrl.trim());
  if (!match) {
    throw new Error(`Invalid pull request URL: ${prUrl}`);
  }

  const prNumber = Number(match[1]);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid pull request URL: ${prUrl}`);
  }

  return prNumber;
}
