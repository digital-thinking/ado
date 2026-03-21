import { describe, expect, test } from "bun:test";
import {
  buildAgentHeartbeatDiagnostic,
  formatAgentRuntimeDiagnostic,
} from "../agent-runtime-diagnostics";

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

  test("formats rate-limit retry and phase timeout events", () => {
    const retryEvent = createRuntimeEvent({
      family: "task-resilience",
      type: "task:rate_limit_retry",
      payload: {
        retryCount: 1,
        maxRetries: 3,
        retryDelayMs: 30_000,
        retryAt: "2026-03-20T10:00:30.000Z",
        summary: "Task #7 hit a rate limit; re-queued for retry 1/3 in 30s.",
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-1",
        taskId: "task-7",
        taskNumber: 7,
        taskTitle: "Retry me",
      },
    });
    const timeoutEvent = createRuntimeEvent({
      family: "phase-resilience",
      type: "phase:timeout",
      payload: {
        timeoutMs: 5_000,
        elapsedMs: 5_200,
        startedAt: "2026-03-20T10:00:00.000Z",
        deadlineAt: "2026-03-20T10:00:05.000Z",
        currentStep: "waiting 60s for deferred task availability.",
        summary:
          'Phase "Phase 33" timed out after 5200ms (configured limit: 5000ms).',
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-33",
        phaseName: "Phase 33",
      },
    });

    expect(formatRuntimeEventForCli(retryEvent)).toBe(
      "Task #7 hit a rate limit; re-queued for retry 1/3 in 30s.",
    );
    expect(formatRuntimeEventForTelegram(retryEvent)).toBe(
      "Task retry: Task #7 hit a rate limit; re-queued for retry 1/3 in 30s.",
    );
    expect(formatRuntimeEventForCli(timeoutEvent)).toBe(
      'Phase "Phase 33" timed out after 5200ms (configured limit: 5000ms).',
    );
    expect(formatRuntimeEventForTelegram(timeoutEvent)).toBe(
      'Phase timeout: Phase "Phase 33" timed out after 5200ms (configured limit: 5000ms).',
    );
  });

  test("formats adapter circuit transition events for CLI and Telegram", () => {
    const event = createRuntimeEvent({
      family: "adapter-circuit",
      type: "adapter.circuit",
      payload: {
        stage: "opened",
        summary: "Circuit breaker opened for CODEX_CLI after 3 failures.",
        consecutiveFailures: 3,
        failureThreshold: 3,
        cooldownMs: 300_000,
        remainingCooldownMs: 300_000,
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-1",
        taskId: "task-1",
        adapterId: "CODEX_CLI",
      },
    });

    expect(formatRuntimeEventForCli(event)).toBe(
      "Circuit breaker opened for CODEX_CLI after 3 failures.",
    );
    expect(formatRuntimeEventForTelegram(event)).toBe(
      "Adapter circuit: Circuit breaker opened for CODEX_CLI after 3 failures.",
    );
    expect(shouldNotifyRuntimeEventForTelegram(event, "critical")).toBe(true);
    expect(createRuntimeEventNotificationKey(event)).toContain(
      "adapter.circuit",
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

  test("includes deliberation summary in task finish Telegram notifications", () => {
    const event = createRuntimeEvent({
      family: "task-lifecycle",
      type: "task.lifecycle.finish",
      payload: {
        status: "DONE",
        message: "task #1 finished",
        deliberation: {
          finalVerdict: "APPROVED",
          rounds: 2,
          refinePassesUsed: 1,
          pendingComments: 0,
        },
      },
      context: {
        source: "PHASE_RUNNER",
        taskNumber: 1,
        taskTitle: "Deliberate task",
      },
    });

    expect(formatRuntimeEventForTelegram(event)).toBe(
      "Task update: #1 Deliberate task -> DONE.\nDeliberation: APPROVED (rounds=2, refinePasses=1, pendingComments=0).",
    );
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

  test("delivers retry and timeout events at the intended Telegram levels", () => {
    const retryEvent = createRuntimeEvent({
      family: "task-resilience",
      type: "task:rate_limit_retry",
      payload: {
        retryCount: 1,
        maxRetries: 3,
        retryDelayMs: 30_000,
        retryAt: "2026-03-20T10:00:30.000Z",
        summary: "Task #7 hit a rate limit; re-queued for retry 1/3 in 30s.",
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-1",
        taskId: "task-7",
      },
    });
    const timeoutEvent = createRuntimeEvent({
      family: "phase-resilience",
      type: "phase:timeout",
      payload: {
        timeoutMs: 5_000,
        elapsedMs: 5_200,
        startedAt: "2026-03-20T10:00:00.000Z",
        deadlineAt: "2026-03-20T10:00:05.000Z",
        currentStep: "waiting 60s for deferred task availability.",
        summary:
          'Phase "Phase 33" timed out after 5200ms (configured limit: 5000ms).',
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-33",
      },
    });

    expect(shouldNotifyRuntimeEventForTelegram(retryEvent, "all")).toBe(true);
    expect(shouldNotifyRuntimeEventForTelegram(retryEvent, "important")).toBe(
      true,
    );
    expect(shouldNotifyRuntimeEventForTelegram(retryEvent, "critical")).toBe(
      false,
    );
    expect(shouldNotifyRuntimeEventForTelegram(timeoutEvent, "all")).toBe(true);
    expect(shouldNotifyRuntimeEventForTelegram(timeoutEvent, "important")).toBe(
      true,
    );
    expect(shouldNotifyRuntimeEventForTelegram(timeoutEvent, "critical")).toBe(
      true,
    );
  });

  test("notifies DEAD_LETTER task completion at critical Telegram level", () => {
    const event = createRuntimeEvent({
      family: "task-lifecycle",
      type: "task.lifecycle.finish",
      payload: {
        status: "DEAD_LETTER",
        message: "Task moved to DEAD_LETTER.",
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-1",
        taskId: "task-1",
      },
    });

    expect(shouldNotifyRuntimeEventForTelegram(event, "all")).toBe(true);
    expect(shouldNotifyRuntimeEventForTelegram(event, "important")).toBe(true);
    expect(shouldNotifyRuntimeEventForTelegram(event, "critical")).toBe(true);
  });

  test("formats agent runtime diagnostics for CLI adapter output", () => {
    const line = formatAgentRuntimeDiagnostic(
      buildAgentHeartbeatDiagnostic({
        agentId: "agent-1",
        adapterId: "CODEX_CLI",
        command: "codex",
        elapsedMs: 90_000,
        idleMs: 15_000,
      }),
    );
    const event = createRuntimeEvent({
      family: "adapter-output",
      type: "adapter.output",
      payload: {
        stream: "system",
        line,
      },
      context: {
        source: "AGENT_SUPERVISOR",
        agentId: "agent-1",
      },
    });

    expect(formatRuntimeEventForCli(event)).toBe(
      "Agent runtime: Heartbeat: elapsed 1m30s, idle 15s.",
    );
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

    const retryEvent = createRuntimeEvent({
      family: "task-resilience",
      type: "task:rate_limit_retry",
      payload: {
        retryCount: 2,
        maxRetries: 3,
        retryDelayMs: 60_000,
        retryAt: "2026-03-20T10:01:00.000Z",
        summary: "Task #7 hit a rate limit; re-queued for retry 2/3 in 60s.",
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-1",
        taskId: "task-7",
        taskNumber: 7,
      },
    });
    const duplicateRetryEvent = RuntimeEventSchema.parse({
      ...retryEvent,
      eventId: "11111111-1111-4111-8111-111111111111",
      occurredAt: "2026-03-20T10:00:31.000Z",
    });
    expect(createRuntimeEventNotificationKey(retryEvent)).toBe(
      createRuntimeEventNotificationKey(duplicateRetryEvent),
    );

    const timeoutEvent = createRuntimeEvent({
      family: "phase-resilience",
      type: "phase:timeout",
      payload: {
        timeoutMs: 5_000,
        elapsedMs: 5_200,
        startedAt: "2026-03-20T10:00:00.000Z",
        deadlineAt: "2026-03-20T10:00:05.000Z",
        currentStep: "waiting 60s for deferred task availability.",
        summary:
          'Phase "Phase 33" timed out after 5200ms (configured limit: 5000ms).',
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-33",
      },
    });
    const duplicateTimeoutEvent = RuntimeEventSchema.parse({
      ...timeoutEvent,
      eventId: "22222222-2222-4222-8222-222222222222",
      occurredAt: "2026-03-20T10:00:06.000Z",
    });
    expect(createRuntimeEventNotificationKey(timeoutEvent)).toBe(
      createRuntimeEventNotificationKey(duplicateTimeoutEvent),
    );

    const evaluator = createTelegramNotificationEvaluator({
      level: "all",
      suppressDuplicates: true,
    });
    expect(evaluator(event)).toBe(true);
    expect(evaluator(duplicateEvent)).toBe(false);
  });
});
