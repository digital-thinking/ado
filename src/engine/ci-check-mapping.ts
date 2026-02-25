import type { Task } from "../types";
import type { CiCheck, CiStatusSummary } from "../vcs";

const CI_FIX_PREFIX = "CI_FIX: ";

function normalizeCheckName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  return normalized || "unknown-check";
}

function checkSortKey(check: CiCheck): string {
  return `${normalizeCheckName(check.name).toLowerCase()}::${check.state}::${check.detailsUrl ?? ""}`;
}

function isBlockingCheck(check: CiCheck): boolean {
  return (
    check.state === "FAILURE" ||
    check.state === "CANCELLED" ||
    check.state === "UNKNOWN"
  );
}

function isTerminalOverallState(overall: CiStatusSummary["overall"]): boolean {
  return (
    overall === "SUCCESS" ||
    overall === "FAILURE" ||
    overall === "CANCELLED" ||
    overall === "UNKNOWN"
  );
}

function buildTaskTitle(checkName: string): string {
  return `${CI_FIX_PREFIX}${normalizeCheckName(checkName)}`;
}

function buildTaskDescription(input: {
  prUrl: string;
  check: CiCheck;
}): string {
  const lines = [
    `Resolve GitHub CI check failure for "${normalizeCheckName(input.check.name)}".`,
    "",
    `PR: ${input.prUrl}`,
    `Check: ${normalizeCheckName(input.check.name)}`,
    `State: ${input.check.state}`,
    input.check.detailsUrl ? `Details: ${input.check.detailsUrl}` : undefined,
    "",
    "Next action: inspect the check logs, apply the smallest fix, and rerun CI.",
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

function checkStateCount(
  summary: CiStatusSummary,
  state: CiCheck["state"],
): number {
  return summary.checks.filter((check) => check.state === state).length;
}

export function formatCiDiagnostics(input: {
  prNumber: number;
  prUrl: string;
  summary: CiStatusSummary;
}): string {
  const blockingChecks = [...input.summary.checks]
    .filter(isBlockingCheck)
    .sort((a, b) => checkSortKey(a).localeCompare(checkSortKey(b)));

  const lines = [
    `CI status for PR #${input.prNumber}: ${input.summary.overall}`,
    `PR URL: ${input.prUrl}`,
    `Checks summary: total=${input.summary.checks.length}, success=${checkStateCount(input.summary, "SUCCESS")}, pending=${checkStateCount(input.summary, "PENDING")}, failure=${checkStateCount(input.summary, "FAILURE")}, cancelled=${checkStateCount(input.summary, "CANCELLED")}, unknown=${checkStateCount(input.summary, "UNKNOWN")}`,
    `Blocking checks: ${blockingChecks.length}`,
  ];

  if (blockingChecks.length > 0) {
    lines.push(
      ...blockingChecks.map(
        (check) =>
          `- ${normalizeCheckName(check.name)} [${check.state}]${check.detailsUrl ? ` -> ${check.detailsUrl}` : ""}`,
      ),
    );
  }

  return lines.join("\n");
}

export type TargetedCiFixTask = {
  title: string;
  description: string;
  status: "CI_FIX";
  dependencies: string[];
};

export function deriveTargetedCiFixTasks(input: {
  summary: CiStatusSummary;
  prUrl: string;
  existingTasks: Task[];
}): {
  tasksToCreate: TargetedCiFixTask[];
  skippedTaskTitles: string[];
} {
  const blockingChecks = [...input.summary.checks]
    .filter(isBlockingCheck)
    .sort((a, b) => checkSortKey(a).localeCompare(checkSortKey(b)));

  if (
    blockingChecks.length === 0 &&
    isTerminalOverallState(input.summary.overall) &&
    input.summary.overall !== "SUCCESS"
  ) {
    blockingChecks.push({
      name: `CI pipeline (${input.summary.overall})`,
      state: input.summary.overall,
    });
  }

  const existingCiFixTitles = new Set(
    input.existingTasks
      .filter((task) => task.status === "CI_FIX")
      .map((task) => task.title.trim()),
  );

  const tasksToCreate: TargetedCiFixTask[] = [];
  const skippedTaskTitles: string[] = [];

  for (const check of blockingChecks) {
    const title = buildTaskTitle(check.name);
    if (existingCiFixTitles.has(title)) {
      skippedTaskTitles.push(title);
      continue;
    }

    existingCiFixTitles.add(title);
    tasksToCreate.push({
      title,
      description: buildTaskDescription({
        prUrl: input.prUrl,
        check,
      }),
      status: "CI_FIX",
      dependencies: [],
    });
  }

  return {
    tasksToCreate,
    skippedTaskTitles,
  };
}
