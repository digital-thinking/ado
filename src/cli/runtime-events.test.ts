import { describe, expect, test } from "bun:test";

import {
  createRuntimeEvent,
  formatRuntimeEventForCli,
} from "../types/runtime-events";

describe("CLI runtime event consumer", () => {
  test("renders concise recovery activity", () => {
    const event = createRuntimeEvent({
      family: "tester-recovery",
      type: "recovery.activity",
      payload: {
        stage: "attempt-failed",
        summary: "Recovery attempt 1 failed: dirty worktree remains.",
        attemptNumber: 1,
        category: "DIRTY_WORKTREE",
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-1",
      },
    });

    expect(formatRuntimeEventForCli(event)).toBe(
      "Recovery attempt 1 failed: dirty worktree remains.",
    );
  });
});
