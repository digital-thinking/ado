import { describe, expect, test } from "bun:test";

import {
  RuntimeEventSchema,
  createRuntimeEventNotificationKey,
  createTelegramNotificationEvaluator,
  createRuntimeEvent,
  formatRuntimeEventForCli,
  formatRuntimeEventForTelegram,
  shouldNotifyRuntimeEventForTelegram,
  toLegacyAgentEvent,
} from "./runtime-events";

describe("runtime event contract", () => {
  test("creates and validates task lifecycle events", () => {
    const event = createRuntimeEvent({
      family: "task-lifecycle",
      type: "task.lifecycle.start",
      payload: {
        assignee: "CODEX_CLI",
        resume: false,
        message: "Starting task #1.",
      },
      context: {
        source: "PHASE_RUNNER",
        projectName: "ixado",
        phaseId: "phase-1",
        taskId: "task-1",
      },
    });

    const parsed = RuntimeEventSchema.parse(event);
    expect(parsed.type).toBe("task.lifecycle.start");
    expect(parsed.family).toBe("task-lifecycle");
  });

  test("normalizes adapter output to legacy stream shape", () => {
    const event = createRuntimeEvent({
      family: "adapter-output",
      type: "adapter.output",
      payload: {
        stream: "stdout",
        line: "hello",
      },
      context: {
        source: "AGENT_SUPERVISOR",
        agentId: "agent-1",
      },
    });

    const legacy = toLegacyAgentEvent(event);
    expect(legacy).toEqual({
      type: "output",
      agentId: "agent-1",
      line: "hello",
    });
  });

  test("formats terminal outcome for CLI and Telegram consumers", () => {
    const event = createRuntimeEvent({
      family: "terminal-outcome",
      type: "terminal.outcome",
      payload: {
        outcome: "failure",
        summary: "Task failed after retries.",
      },
      context: {
        source: "PHASE_RUNNER",
      },
    });

    expect(formatRuntimeEventForCli(event)).toBe("Task failed after retries.");
    expect(formatRuntimeEventForTelegram(event)).toBe(
      "Outcome: Task failed after retries.",
    );
  });

  test("formats CI and PR lifecycle events for Telegram consumers", () => {
    const prEvent = createRuntimeEvent({
      family: "ci-pr-lifecycle",
      type: "pr.activity",
      payload: {
        stage: "created",
        summary: "Created PR #42: https://github.com/org/repo/pull/42",
        prUrl: "https://github.com/org/repo/pull/42",
        prNumber: 42,
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-1",
      },
    });
    const ciEvent = createRuntimeEvent({
      family: "ci-pr-lifecycle",
      type: "ci.activity",
      payload: {
        stage: "failed",
        summary: "CI checks failed for PR #42; created 1 CI_FIX task(s).",
        prNumber: 42,
        overall: "FAILURE",
        createdFixTaskCount: 1,
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-1",
      },
    });

    expect(formatRuntimeEventForTelegram(prEvent)).toContain("PR:");
    expect(formatRuntimeEventForTelegram(ciEvent)).toContain("CI:");
    expect(formatRuntimeEventForCli(prEvent)).toContain("Created PR #42");
    expect(formatRuntimeEventForCli(ciEvent)).toContain("CI checks failed");
  });

  test("applies Telegram noise levels deterministically", () => {
    const transitionEvent = createRuntimeEvent({
      family: "ci-pr-lifecycle",
      type: "ci.activity",
      payload: {
        stage: "poll-transition",
        summary: "CI transition PR #42: PENDING -> SUCCESS (poll=3)",
        prNumber: 42,
        previousOverall: "PENDING",
        overall: "SUCCESS",
        pollCount: 3,
      },
      context: {
        source: "PHASE_RUNNER",
      },
    });

    expect(shouldNotifyRuntimeEventForTelegram(transitionEvent, "all")).toBe(
      true,
    );
    expect(
      shouldNotifyRuntimeEventForTelegram(transitionEvent, "important"),
    ).toBe(false);
    expect(
      shouldNotifyRuntimeEventForTelegram(transitionEvent, "critical"),
    ).toBe(false);
  });

  test("formats adapter output payload line for Telegram", () => {
    const event = createRuntimeEvent({
      family: "adapter-output",
      type: "adapter.output",
      payload: {
        stream: "stdout",
        line: "npm test failed",
      },
      context: {
        source: "AGENT_SUPERVISOR",
      },
    });

    expect(formatRuntimeEventForTelegram(event)).toBe("npm test failed");
  });

  test("suppresses adapter output events at important Telegram level", () => {
    const event = createRuntimeEvent({
      family: "adapter-output",
      type: "adapter.output",
      payload: {
        stream: "stderr",
        line: "line noise",
      },
      context: {
        source: "AGENT_SUPERVISOR",
      },
    });

    expect(shouldNotifyRuntimeEventForTelegram(event, "all")).toBe(true);
    expect(shouldNotifyRuntimeEventForTelegram(event, "important")).toBe(false);
    expect(shouldNotifyRuntimeEventForTelegram(event, "critical")).toBe(false);
  });

  test("suppresses duplicate Telegram notifications when configured", () => {
    const event = createRuntimeEvent({
      family: "tester-recovery",
      type: "recovery.activity",
      payload: {
        stage: "attempt-failed",
        summary: "Recovery attempt failed: worktree remains dirty.",
        attemptNumber: 1,
        category: "DIRTY_WORKTREE",
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-1",
        taskId: "task-1",
      },
    });
    const duplicateEvent = {
      ...event,
      eventId: event.eventId,
    };

    expect(createRuntimeEventNotificationKey(event)).toBe(
      createRuntimeEventNotificationKey(duplicateEvent),
    );

    const evaluator = createTelegramNotificationEvaluator({
      level: "all",
      suppressDuplicates: true,
    });
    expect(evaluator(event)).toBe(true);
    expect(evaluator(duplicateEvent)).toBe(false);
  });
});
