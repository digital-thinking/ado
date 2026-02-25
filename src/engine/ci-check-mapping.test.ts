import { describe, expect, test } from "bun:test";

import type { Task } from "../types";
import type { CiStatusSummary } from "../vcs";
import {
  deriveTargetedCiFixTasks,
  formatCiDiagnostics,
} from "./ci-check-mapping";

describe("ci-check-mapping", () => {
  test("derives deterministic targeted CI_FIX tasks and deduplicates active CI_FIX titles", () => {
    const summary: CiStatusSummary = {
      overall: "FAILURE",
      checks: [
        { name: "unit tests", state: "FAILURE" },
        { name: "lint", state: "FAILURE", detailsUrl: "https://ci/lint" },
        { name: "build", state: "SUCCESS" },
      ],
    };
    const existingTasks: Task[] = [
      {
        id: "t1",
        title: "CI_FIX: lint",
        description: "existing",
        status: "CI_FIX",
        assignee: "UNASSIGNED",
        dependencies: [],
      },
    ];

    const mapping = deriveTargetedCiFixTasks({
      summary,
      prUrl: "https://github.com/org/repo/pull/10",
      existingTasks,
    });

    expect(mapping.skippedTaskTitles).toEqual(["CI_FIX: lint"]);
    expect(mapping.tasksToCreate).toHaveLength(1);
    expect(mapping.tasksToCreate[0]?.title).toBe("CI_FIX: unit tests");
    expect(mapping.tasksToCreate[0]?.description).toContain(
      'Resolve GitHub CI check failure for "unit tests".',
    );
  });

  test("creates fallback task when CI is terminal non-success with no blocking checks", () => {
    const summary: CiStatusSummary = {
      overall: "CANCELLED",
      checks: [{ name: "build", state: "SUCCESS" }],
    };

    const mapping = deriveTargetedCiFixTasks({
      summary,
      prUrl: "https://github.com/org/repo/pull/22",
      existingTasks: [],
    });

    expect(mapping.tasksToCreate).toHaveLength(1);
    expect(mapping.tasksToCreate[0]?.title).toBe(
      "CI_FIX: CI pipeline (CANCELLED)",
    );
  });

  test("does not create fallback CI_FIX task for non-terminal overall states like PENDING", () => {
    const summary: CiStatusSummary = {
      overall: "PENDING",
      checks: [{ name: "build", state: "SUCCESS" }],
    };

    const mapping = deriveTargetedCiFixTasks({
      summary,
      prUrl: "https://github.com/org/repo/pull/23",
      existingTasks: [],
    });

    expect(mapping.tasksToCreate).toHaveLength(0);
    expect(mapping.skippedTaskTitles).toHaveLength(0);
  });

  test("formats rich CI diagnostics with check counts and blocking entries", () => {
    const diagnostics = formatCiDiagnostics({
      prNumber: 42,
      prUrl: "https://github.com/org/repo/pull/42",
      summary: {
        overall: "FAILURE",
        checks: [
          { name: "build", state: "SUCCESS" },
          { name: "integration", state: "FAILURE", detailsUrl: "https://ci/1" },
          { name: "smoke", state: "CANCELLED" },
        ],
      },
    });

    expect(diagnostics).toContain("CI status for PR #42: FAILURE");
    expect(diagnostics).toContain("Checks summary: total=3, success=1");
    expect(diagnostics).toContain("Blocking checks: 2");
    expect(diagnostics).toContain("- integration [FAILURE] -> https://ci/1");
    expect(diagnostics).toContain("- smoke [CANCELLED]");
  });
});
