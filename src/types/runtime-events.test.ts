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
  toAgentStreamEvent,
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

  test("normalizes adapter output to agent stream shape", () => {
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

    const streamEvent = toAgentStreamEvent(event);
    expect(streamEvent).toEqual({
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

  test("formats PR and gate lifecycle events for Telegram consumers", () => {
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
    const gateEvent = createRuntimeEvent({
      family: "gate-lifecycle",
      type: "gate.activity",
      payload: {
        stage: "fail",
        gateName: "pr_ci",
        gateIndex: 0,
        totalGates: 1,
        summary: 'Gate "pr_ci" failed (1/1): build failed',
        diagnostics: "build failed",
        retryable: true,
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-1",
      },
    });

    expect(formatRuntimeEventForTelegram(prEvent)).toContain("PR:");
    expect(formatRuntimeEventForTelegram(gateEvent)).toContain("Gate:");
    expect(formatRuntimeEventForCli(prEvent)).toContain("Created PR #42");
    expect(formatRuntimeEventForCli(gateEvent)).toContain("build failed");
  });

  test("applies Telegram noise levels deterministically", () => {
    const gateStartEvent = createRuntimeEvent({
      family: "gate-lifecycle",
      type: "gate.activity",
      payload: {
        stage: "start",
        gateName: "pr_ci",
        gateIndex: 0,
        totalGates: 1,
        summary: 'Starting gate "pr_ci" (1/1).',
      },
      context: {
        source: "PHASE_RUNNER",
      },
    });

    expect(shouldNotifyRuntimeEventForTelegram(gateStartEvent, "all")).toBe(
      true,
    );
    expect(
      shouldNotifyRuntimeEventForTelegram(gateStartEvent, "important"),
    ).toBe(false);
    expect(
      shouldNotifyRuntimeEventForTelegram(gateStartEvent, "critical"),
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

  test("creates and formats race lifecycle events", () => {
    const startEvent = createRuntimeEvent({
      family: "race-lifecycle",
      type: "race:start",
      payload: {
        raceCount: 2,
        baseBranchName: "phase-35-race-mode",
        summary:
          "Starting race mode for task #5 Wire race events with 2 branch(es).",
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-35",
        taskId: "task-5",
        taskNumber: 5,
      },
    });
    const branchEvent = createRuntimeEvent({
      family: "race-lifecycle",
      type: "race:branch",
      payload: {
        branchIndex: 2,
        branchName: "phase-35-race-mode-race-task-5-2",
        status: "fulfilled",
        summary:
          "Race branch 2/phase-35-race-mode-race-task-5-2 finished successfully.",
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-35",
        taskId: "task-5",
        taskNumber: 5,
        adapterId: "CODEX_CLI",
      },
    });
    const judgeEvent = createRuntimeEvent({
      family: "race-lifecycle",
      type: "race:judge",
      payload: {
        judgeAdapter: "CLAUDE_CLI",
        pickedBranchIndex: 2,
        branchName: "phase-35-race-mode-race-task-5-2",
        summary:
          "Race judge CLAUDE_CLI selected candidate 2 (phase-35-race-mode-race-task-5-2).",
        reasoning: "Candidate 2 is the most coherent implementation.",
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-35",
        taskId: "task-5",
        taskNumber: 5,
        adapterId: "CLAUDE_CLI",
      },
    });
    const pickEvent = createRuntimeEvent({
      family: "race-lifecycle",
      type: "race:pick",
      payload: {
        branchIndex: 2,
        branchName: "phase-35-race-mode-race-task-5-2",
        commitCount: 2,
        summary:
          "Applied race winner candidate 2 (phase-35-race-mode-race-task-5-2) with 2 commits.",
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-35",
        taskId: "task-5",
        taskNumber: 5,
      },
    });

    expect(RuntimeEventSchema.parse(startEvent).type).toBe("race:start");
    expect(formatRuntimeEventForCli(branchEvent)).toContain(
      "finished successfully",
    );
    expect(formatRuntimeEventForTelegram(judgeEvent)).toBe(
      "Race: Race judge CLAUDE_CLI selected candidate 2 (phase-35-race-mode-race-task-5-2).",
    );
    expect(formatRuntimeEventForCli(pickEvent)).toContain(
      "Applied race winner candidate 2",
    );
    expect(shouldNotifyRuntimeEventForTelegram(startEvent, "important")).toBe(
      false,
    );
    expect(shouldNotifyRuntimeEventForTelegram(branchEvent, "important")).toBe(
      true,
    );
    expect(shouldNotifyRuntimeEventForTelegram(judgeEvent, "critical")).toBe(
      false,
    );
    expect(createRuntimeEventNotificationKey(pickEvent)).toContain("race:pick");
  });

  test("creates and formats gate activity events", () => {
    const startEvent = createRuntimeEvent({
      family: "gate-lifecycle",
      type: "gate.activity",
      payload: {
        stage: "start",
        gateName: "command",
        gateIndex: 0,
        totalGates: 3,
        summary: 'Starting gate "command" (1/3).',
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-34",
        phaseName: "Phase 34",
      },
    });

    const failEvent = createRuntimeEvent({
      family: "gate-lifecycle",
      type: "gate.activity",
      payload: {
        stage: "fail",
        gateName: "coverage",
        gateIndex: 1,
        totalGates: 3,
        summary: 'Gate "coverage" failed (2/3): Coverage 72% < 80% threshold.',
        diagnostics: "Coverage 72% < 80% threshold.",
        retryable: false,
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-34",
        phaseName: "Phase 34",
      },
    });

    const passEvent = createRuntimeEvent({
      family: "gate-lifecycle",
      type: "gate.activity",
      payload: {
        stage: "pass",
        gateName: "pr_ci",
        gateIndex: 2,
        totalGates: 3,
        summary: 'Gate "pr_ci" passed (3/3).',
      },
      context: {
        source: "PHASE_RUNNER",
        phaseId: "phase-34",
        phaseName: "Phase 34",
      },
    });

    expect(startEvent.family).toBe("gate-lifecycle");
    expect(startEvent.type).toBe("gate.activity");

    expect(formatRuntimeEventForCli(startEvent)).toBe(
      'Starting gate "command" (1/3).',
    );
    expect(formatRuntimeEventForTelegram(startEvent)).toBe(
      'Gate: Starting gate "command" (1/3).',
    );
    expect(formatRuntimeEventForCli(failEvent)).toContain("coverage");
    expect(formatRuntimeEventForTelegram(failEvent)).toContain("Gate:");
    expect(formatRuntimeEventForCli(passEvent)).toContain("pr_ci");
  });

  test("applies Telegram notification levels to gate events", () => {
    const startEvent = createRuntimeEvent({
      family: "gate-lifecycle",
      type: "gate.activity",
      payload: {
        stage: "start",
        gateName: "command",
        gateIndex: 0,
        totalGates: 2,
        summary: 'Starting gate "command" (1/2).',
      },
      context: { source: "PHASE_RUNNER" },
    });

    const failEvent = createRuntimeEvent({
      family: "gate-lifecycle",
      type: "gate.activity",
      payload: {
        stage: "fail",
        gateName: "coverage",
        gateIndex: 1,
        totalGates: 2,
        summary: 'Gate "coverage" failed (2/2).',
        diagnostics: "Coverage too low.",
        retryable: false,
      },
      context: { source: "PHASE_RUNNER" },
    });

    const passEvent = createRuntimeEvent({
      family: "gate-lifecycle",
      type: "gate.activity",
      payload: {
        stage: "pass",
        gateName: "command",
        gateIndex: 0,
        totalGates: 2,
        summary: 'Gate "command" passed (1/2).',
      },
      context: { source: "PHASE_RUNNER" },
    });

    // "all" level: everything
    expect(shouldNotifyRuntimeEventForTelegram(startEvent, "all")).toBe(true);
    expect(shouldNotifyRuntimeEventForTelegram(failEvent, "all")).toBe(true);
    expect(shouldNotifyRuntimeEventForTelegram(passEvent, "all")).toBe(true);

    // "important" level: pass and fail but not start
    expect(shouldNotifyRuntimeEventForTelegram(startEvent, "important")).toBe(
      false,
    );
    expect(shouldNotifyRuntimeEventForTelegram(failEvent, "important")).toBe(
      true,
    );
    expect(shouldNotifyRuntimeEventForTelegram(passEvent, "important")).toBe(
      true,
    );

    // "critical" level: only fail
    expect(shouldNotifyRuntimeEventForTelegram(startEvent, "critical")).toBe(
      false,
    );
    expect(shouldNotifyRuntimeEventForTelegram(failEvent, "critical")).toBe(
      true,
    );
    expect(shouldNotifyRuntimeEventForTelegram(passEvent, "critical")).toBe(
      false,
    );
  });

  test("generates unique notification keys for gate events", () => {
    const event1 = createRuntimeEvent({
      family: "gate-lifecycle",
      type: "gate.activity",
      payload: {
        stage: "start",
        gateName: "command",
        gateIndex: 0,
        totalGates: 2,
        summary: 'Starting gate "command" (1/2).',
      },
      context: { source: "PHASE_RUNNER", phaseId: "phase-34" },
    });

    const event2 = createRuntimeEvent({
      family: "gate-lifecycle",
      type: "gate.activity",
      payload: {
        stage: "pass",
        gateName: "command",
        gateIndex: 0,
        totalGates: 2,
        summary: 'Gate "command" passed (1/2).',
      },
      context: { source: "PHASE_RUNNER", phaseId: "phase-34" },
    });

    const key1 = createRuntimeEventNotificationKey(event1);
    const key2 = createRuntimeEventNotificationKey(event2);
    expect(key1).toContain("gate.activity");
    expect(key1).not.toBe(key2); // different stages
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
