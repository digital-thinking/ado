import { describe, expect, test } from "bun:test";

import {
  buildRecoveryTraceLinks,
  formatPhaseTaskContext,
  summarizeFailure,
  toAnchorToken,
} from "./log-readability";

describe("log readability helpers", () => {
  test("summarizeFailure prefers clear failure line and truncates", () => {
    const summary = summarizeFailure(
      [
        "stdout: completed step",
        "Error: command failed with exit code 2 after long output " +
          "x".repeat(200),
      ].join("\n"),
    );

    expect(summary).toContain("Error: command failed");
    expect(summary.length).toBeLessThanOrEqual(140);
  });

  test("formatPhaseTaskContext builds compact context label", () => {
    expect(
      formatPhaseTaskContext({
        phaseName: "Phase 22",
        taskNumber: 4,
        taskTitle: "Improve logs",
      }),
    ).toBe("phase: Phase 22 | task #4 Improve logs");
  });

  test("buildRecoveryTraceLinks includes task card and recovery links", () => {
    const links = buildRecoveryTraceLinks({
      context: { taskId: "task-abc" },
      attempts: [{ attemptNumber: 2 }],
    });

    expect(links).toEqual([
      { label: "Task card", href: "#task-card-task-abc" },
      { label: "Recovery attempt 2", href: "#task-recovery-task-abc-2" },
      { label: "Recovery history", href: "#task-recovery-task-abc" },
    ]);
  });

  test("toAnchorToken normalizes unusual strings", () => {
    expect(toAnchorToken(" task id/with spaces ")).toBe("task-id-with-spaces");
  });
});
