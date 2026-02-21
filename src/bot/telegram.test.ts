import { describe, expect, test } from "bun:test";

import {
  handleSetActivePhaseCommand,
  handleStartTaskCommand,
  handleStatusCommand,
  handleTasksCommand,
} from "./telegram";
import type { ProjectState } from "../types";

type FakeCtx = {
  from?: { id?: number };
  message?: { text?: string };
  replies: string[];
  reply: (text: string) => Promise<void>;
};

function createCtx(userId?: number, text?: string): FakeCtx {
  return {
    from: userId === undefined ? undefined : { id: userId },
    message: text ? { text } : undefined,
    replies: [],
    async reply(text: string): Promise<void> {
      this.replies.push(text);
    },
  };
}

function buildState(): ProjectState {
  return {
    projectName: "IxADO",
    rootDir: "C:/repo",
    phases: [
      {
        id: "11111111-1111-1111-1111-111111111111",
        name: "Phase 3",
        branchName: "phase-3-telegram-command-center",
        status: "CODING",
        tasks: [
          {
            id: "22222222-2222-2222-2222-222222222222",
            title: "Implement Telegram adapter",
            description: "Add bot integration",
            status: "IN_PROGRESS",
            assignee: "CODEX_CLI",
            dependencies: [],
          },
        ],
      },
    ],
    activePhaseId: "11111111-1111-1111-1111-111111111111",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("telegram command handlers", () => {
  test("rejects unauthorized status call", async () => {
    const ctx = createCtx(999);
    let called = false;

    await handleStatusCommand(ctx, 123, async () => {
      called = true;
      return buildState();
    });

    expect(called).toBe(false);
    expect(ctx.replies).toEqual(["Unauthorized user."]);
  });

  test("returns status for authorized user", async () => {
    const ctx = createCtx(123);

    await handleStatusCommand(ctx, 123, async () => buildState());

    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain("Project: IxADO");
    expect(ctx.replies[0]).toContain("Active: Phase 3 (CODING)");
  });

  test("returns tasks list for authorized user", async () => {
    const ctx = createCtx(123);

    await handleTasksCommand(ctx, 123, async () => buildState());

    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain("Tasks for Phase 3:");
    expect(ctx.replies[0]).toContain("1. [IN_PROGRESS] Implement Telegram adapter (CODEX_CLI)");
  });

  test("returns no active phase when there is no active phase", async () => {
    const ctx = createCtx(123);
    const state = buildState();
    state.activePhaseId = undefined;

    await handleTasksCommand(ctx, 123, async () => state);

    expect(ctx.replies).toEqual(["No active phase selected."]);
  });

  test("returns unauthorized for tasks when owner id does not match", async () => {
    const ctx = createCtx(123);

    await handleTasksCommand(ctx, 999, async () => buildState());

    expect(ctx.replies).toEqual(["Unauthorized user."]);
  });

  test("starts task through shared task starter", async () => {
    const ctx = createCtx(123, "/starttask 1 CODEX_CLI");

    await handleStartTaskCommand(ctx, 123, "MOCK_CLI", async (input) => {
      expect(input.taskNumber).toBe(1);
      expect(input.assignee).toBe("CODEX_CLI");
      const state = buildState();
      state.phases[0].tasks[0].status = "DONE";
      return state;
    });

    expect(ctx.replies[0]).toContain("Starting task");
    expect(ctx.replies[1]).toContain("finished with status DONE");
  });

  test("returns usage for invalid starttask command", async () => {
    const ctx = createCtx(123, "/starttask");

    await handleStartTaskCommand(ctx, 123, "CODEX_CLI", async () => buildState());

    expect(ctx.replies).toEqual(["Usage: /starttask <taskNumber> [assignee]"]);
  });

  test("sets active phase through shared setter", async () => {
    const ctx = createCtx(123, "/setactivephase 11111111-1111-1111-1111-111111111111");

    await handleSetActivePhaseCommand(ctx, 123, async (input) => {
      expect(input.phaseId).toBe("11111111-1111-1111-1111-111111111111");
      const state = buildState();
      state.activePhaseId = input.phaseId;
      return state;
    });

    expect(ctx.replies).toEqual(["Active phase set to Phase 3."]);
  });

  test("returns usage for invalid setactivephase command", async () => {
    const ctx = createCtx(123, "/setactivephase");

    await handleSetActivePhaseCommand(ctx, 123, async () => buildState());

    expect(ctx.replies).toEqual(["Usage: /setactivephase <phaseId>"]);
  });
});
