import type { ProcessRunner } from "../process";

export type CreatePullRequestInput = {
  base: string;
  head: string;
  title: string;
  body: string;
  cwd: string;
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

export type PollCiStatusInput = {
  prNumber: number;
  cwd: string;
  intervalMs?: number;
  timeoutMs?: number;
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

export class GitHubManager {
  private readonly runner: ProcessRunner;

  constructor(runner: ProcessRunner) {
    this.runner = runner;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<string> {
    const result = await this.runner.run({
      command: "gh",
      args: [
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
      ],
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
    }));

    return {
      overall: computeOverallState(checks),
      checks,
    };
  }

  async pollCiStatus(input: PollCiStatusInput): Promise<CiStatusSummary> {
    const intervalMs = input.intervalMs ?? 15_000;
    const timeoutMs = input.timeoutMs ?? 15 * 60 * 1000;
    const startedAt = Date.now();

    while (true) {
      const summary = await this.getCiStatus(input.prNumber, input.cwd);

      if (
        summary.overall === "SUCCESS" ||
        summary.overall === "FAILURE" ||
        summary.overall === "CANCELLED"
      ) {
        return summary;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `CI polling timed out after ${timeoutMs}ms for PR #${input.prNumber}.`,
        );
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, intervalMs);
      });
    }
  }
}
