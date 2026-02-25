import type { ProcessRunner } from "../process";

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

type StatusCheckRollupResponse = {
  statusCheckRollup?: Array<Record<string, unknown>>;
};

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

export class GitHubManager {
  private readonly runner: ProcessRunner;

  constructor(runner: ProcessRunner) {
    this.runner = runner;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<string> {
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
    const result = await this.runner.run({
      command: "gh",
      args: ["pr", "view", String(prNumber), "--json", "statusCheckRollup"],
      cwd,
    });

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
