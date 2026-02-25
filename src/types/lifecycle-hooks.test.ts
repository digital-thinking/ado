import { describe, expect, test } from "bun:test";

import {
  AfterTaskDoneHookPayloadSchema,
  BeforeTaskStartHookPayloadSchema,
  OnCiFailedHookPayloadSchema,
  OnRecoveryHookPayloadSchema,
  parseLifecycleHookPayload,
} from "./lifecycle-hooks";

describe("lifecycle hook contracts", () => {
  test("validates before_task_start payload strictly", () => {
    const parsed = BeforeTaskStartHookPayloadSchema.parse({
      projectName: "ixado",
      phaseId: "11111111-1111-4111-8111-111111111111",
      phaseName: "Phase 24",
      taskId: "22222222-2222-4222-8222-222222222222",
      taskTitle: "Implement hook contracts",
      taskNumber: 1,
      assignee: "CODEX_CLI",
      resume: false,
    });
    expect(parsed.assignee).toBe("CODEX_CLI");

    expect(() =>
      BeforeTaskStartHookPayloadSchema.parse({
        ...parsed,
        extra: true,
      }),
    ).toThrow();
  });

  test("validates after_task_done payload strictly", () => {
    const parsed = AfterTaskDoneHookPayloadSchema.parse({
      projectName: "ixado",
      phaseId: "11111111-1111-4111-8111-111111111111",
      phaseName: "Phase 24",
      taskId: "22222222-2222-4222-8222-222222222222",
      taskTitle: "Implement hook contracts",
      taskNumber: 1,
      assignee: "CODEX_CLI",
      status: "DONE",
    });
    expect(parsed.status).toBe("DONE");
  });

  test("validates on_recovery payload strictly", () => {
    const parsed = OnRecoveryHookPayloadSchema.parse({
      projectName: "ixado",
      phaseId: "11111111-1111-4111-8111-111111111111",
      phaseName: "Phase 24",
      taskId: "22222222-2222-4222-8222-222222222222",
      taskTitle: "Implement hook contracts",
      attemptNumber: 1,
      exception: {
        category: "DIRTY_WORKTREE",
        message: "Repository is dirty.",
      },
      result: {
        status: "fixed",
        reasoning: "Committed staged files.",
      },
    });
    expect(parsed.result.status).toBe("fixed");
  });

  test("validates on_ci_failed payload strictly", () => {
    const parsed = OnCiFailedHookPayloadSchema.parse({
      projectName: "ixado",
      phaseId: "11111111-1111-4111-8111-111111111111",
      phaseName: "Phase 24",
      prNumber: 24,
      prUrl: "https://github.com/example/ixado/pull/24",
      ciStatusContext: "CI status for PR #24: FAILURE",
      createdFixTaskCount: 2,
    });
    expect(parsed.createdFixTaskCount).toBe(2);
  });

  test("parses payload by hook name", () => {
    const parsed = parseLifecycleHookPayload("after_task_done", {
      projectName: "ixado",
      phaseId: "11111111-1111-4111-8111-111111111111",
      phaseName: "Phase 24",
      taskId: "22222222-2222-4222-8222-222222222222",
      taskTitle: "Implement hook contracts",
      taskNumber: 1,
      assignee: "CODEX_CLI",
      status: "FAILED",
    });
    expect(parsed.status).toBe("FAILED");
  });
});
