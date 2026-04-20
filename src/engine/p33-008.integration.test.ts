import { describe, expect, mock, test } from "bun:test";

import {
  PhaseRunner,
  computeRateLimitBackoffMs,
  type PhaseRunnerConfig,
} from "./phase-runner";
import { DEFAULT_AUTH_POLICY } from "../security/policy";
import type { ProcessRunner } from "../process";
import type { RuntimeEvent } from "../types/runtime-events";
import {
  createTelegramNotificationEvaluator,
  formatRuntimeEventForTelegram,
} from "../types/runtime-events";
import type { ControlCenterService } from "../web";

function createBaseConfig(): PhaseRunnerConfig {
  return {
    mode: "AUTO",
    countdownSeconds: 0,
    activeAssignee: "CODEX_CLI",
    maxRecoveryAttempts: 1,
    testerCommand: null,
    testerArgs: null,
    testerTimeoutMs: 1_000,
    maxTaskRetries: 3,
    vcsProvider: "null" as const,
    gates: [],
    ciBaseBranch: "main",
    ciPullRequest: {
      defaultTemplatePath: null,
      templateMappings: [],
      labels: [],
      assignees: [],
      createAsDraft: false,
      markReadyOnApproval: false,
    },
    ciFixMaxDepth: 3,
    projectRootDir: "/tmp/project",
    projectName: "test-project",
    policy: DEFAULT_AUTH_POLICY,
    role: "admin",
  };
}

function toTelegramMessages(
  events: RuntimeEvent[],
  level: "all" | "important" | "critical",
): string[] {
  const shouldNotify = createTelegramNotificationEvaluator({
    level,
    suppressDuplicates: true,
  });

  return events
    .filter((event) => shouldNotify(event))
    .map((event) => formatRuntimeEventForTelegram(event));
}

function createGitRunner(branchName: string): ProcessRunner {
  return {
    run: mock(async (input: any) => {
      if (input.command === "git" && input.args.includes("--porcelain")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (
        input.command === "git" &&
        input.args.includes("branch") &&
        input.args.includes("--show-current")
      ) {
        return {
          exitCode: 0,
          stdout: `${branchName}\n`,
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }),
  } as any;
}

describe("P33-008 integration coverage", () => {
  test("retries rate-limited tasks with exponential backoff and surfaces retry events", async () => {
    const phaseId = "93111111-1111-4111-8111-111111111111";
    const taskId = "93222222-2222-4222-8222-222222222222";
    const initialNowMs = Date.parse("2026-03-20T10:00:00.000Z");
    let nowMs = initialNowMs;
    const sleepCalls: number[] = [];
    const events: RuntimeEvent[] = [];
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 33",
          branchName: "phase-33-rate-limit-backoff",
          status: "PLANNING",
          tasks: [
            {
              id: taskId,
              title: "P33-008 retry flow",
              description: "Exercise retry/backoff integration",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
          ],
        },
      ],
    };

    let executionCount = 0;
    const control = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => state),
      setPhaseStatus: mock(async (input: { status: string }) => {
        state.phases[0].status = input.status as any;
        return state;
      }),
      startActiveTaskAndWait: mock(async () => {
        executionCount += 1;
        const task = state.phases[0].tasks[0] as any;
        if (executionCount < 3) {
          task.status = "FAILED";
          task.errorCategory = "AGENT_FAILURE";
          task.adapterFailureKind = "rate_limited";
          task.errorLogs =
            executionCount === 1
              ? "HTTP 429 from upstream API"
              : "too many requests, retry-after: 60";
          return state;
        }

        task.status = "DONE";
        task.resultContext = "completed after retry";
        task.rateLimitRetryCount = undefined;
        task.rateLimitRetryAt = undefined;
        task.errorLogs = undefined;
        task.errorCategory = undefined;
        task.adapterFailureKind = undefined;
        return state;
      }),
      retryFailedTaskToTodo: mock(
        async (input: {
          phaseId: string;
          taskId: string;
          rateLimitRetryCount?: number;
          rateLimitRetryAt?: string;
        }) => {
          const task = state.phases[0].tasks[0] as any;
          task.status = "TODO";
          task.rateLimitRetryCount = input.rateLimitRetryCount;
          task.rateLimitRetryAt = input.rateLimitRetryAt;
          task.errorLogs = undefined;
          task.errorCategory = undefined;
          task.adapterFailureKind = undefined;
          return state;
        },
      ),
      markTaskDeadLetter: mock(async () => state),
      createTask: mock(async () => state),
      recordRecoveryAttempt: mock(async () => state),
      runInternalWork: mock(async () => ({ stdout: "", stderr: "" })),
    } as unknown as ControlCenterService;

    const phaseRunner = new PhaseRunner(
      control,
      {
        ...createBaseConfig(),
        enabledAdapters: ["CODEX_CLI"],
        providerPriority: ["CODEX_CLI"],
        now: () => nowMs,
        sleep: async (ms) => {
          sleepCalls.push(ms);
          nowMs += ms;
        },
      },
      undefined,
      async (event) => {
        events.push(event);
      },
      createGitRunner("phase-33-rate-limit-backoff"),
    );

    await phaseRunner.run();

    const retryResetCalls = (
      control.retryFailedTaskToTodo as ReturnType<typeof mock>
    ).mock.calls.map((entry: any[]) => entry[0]);
    expect(retryResetCalls).toHaveLength(2);
    expect(retryResetCalls[0]).toEqual({
      phaseId,
      taskId,
      rateLimitRetryCount: 1,
      rateLimitRetryAt: new Date(
        initialNowMs + computeRateLimitBackoffMs(1),
      ).toISOString(),
    });
    expect(retryResetCalls[1]).toEqual({
      phaseId,
      taskId,
      rateLimitRetryCount: 2,
      rateLimitRetryAt: new Date(
        initialNowMs +
          computeRateLimitBackoffMs(1) +
          computeRateLimitBackoffMs(2),
      ).toISOString(),
    });
    expect(sleepCalls.reduce((sum, value) => sum + value, 0)).toBe(90_000);

    const retryEvents = events.filter(
      (event) => event.type === "task:rate_limit_retry",
    );
    expect(retryEvents).toHaveLength(2);
    expect(
      retryEvents.map((event) =>
        event.type === "task:rate_limit_retry"
          ? event.payload.retryDelayMs
          : null,
      ),
    ).toEqual([computeRateLimitBackoffMs(1), computeRateLimitBackoffMs(2)]);

    const importantMessages = toTelegramMessages(events, "important");
    const criticalMessages = toTelegramMessages(events, "critical");
    expect(
      importantMessages.filter((message) => message.startsWith("Task retry:")),
    ).toEqual([
      "Task retry: task #1 P33-008 retry flow hit a rate limit; re-queued for retry 1/3 in 30s.",
      "Task retry: task #1 P33-008 retry flow hit a rate limit; re-queued for retry 2/3 in 60s.",
    ]);
    expect(
      criticalMessages.some((message) => message.startsWith("Task retry:")),
    ).toBe(false);
  });

  test("moves exhausted rate-limited tasks to DEAD_LETTER and emits critical task updates", async () => {
    const phaseId = "93333333-3333-4333-8333-333333333333";
    const taskId = "93444444-4444-4444-8444-444444444444";
    const events: RuntimeEvent[] = [];
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 33 dead-letter",
          branchName: "phase-33-rate-limit-dead-letter",
          status: "PLANNING",
          tasks: [
            {
              id: taskId,
              title: "P33-008 exhausted retry budget",
              description: "Dead-letter after retries",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
              rateLimitRetryCount: 1,
            },
          ],
        },
      ],
    };

    const control = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => state),
      setPhaseStatus: mock(async (input: { status: string }) => {
        state.phases[0].status = input.status as any;
        return state;
      }),
      startActiveTaskAndWait: mock(async () => {
        const task = state.phases[0].tasks[0] as any;
        task.status = "FAILED";
        task.errorCategory = "AGENT_FAILURE";
        task.adapterFailureKind = "rate_limited";
        task.errorLogs = "HTTP 429 too many requests";
        return state;
      }),
      requeueRateLimitedTask: mock(async () => state),
      retryFailedTaskToTodo: mock(async () => state),
      markTaskDeadLetter: mock(async (input: { reason: string }) => {
        const task = state.phases[0].tasks[0] as any;
        task.status = "DEAD_LETTER";
        task.resultContext = input.reason;
        return state;
      }),
      createTask: mock(async () => state),
      recordRecoveryAttempt: mock(async () => state),
      runInternalWork: mock(async () => ({ stdout: "", stderr: "" })),
    } as unknown as ControlCenterService;

    const phaseRunner = new PhaseRunner(
      control,
      {
        ...createBaseConfig(),
        maxTaskRetries: 1,
      },
      undefined,
      async (event) => {
        events.push(event);
      },
      createGitRunner("phase-33-rate-limit-dead-letter"),
    );

    const error = await phaseRunner.run().catch((candidate) => candidate);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Rate-limit retries exhausted");
    expect(control.retryFailedTaskToTodo).not.toHaveBeenCalled();
    expect(control.markTaskDeadLetter).toHaveBeenCalledTimes(1);

    const deadLetterEvent = events.find(
      (event) =>
        event.type === "task.lifecycle.finish" &&
        event.payload.status === "DEAD_LETTER",
    );
    expect(deadLetterEvent).toBeDefined();
    expect(events.some((event) => event.type === "task:rate_limit_retry")).toBe(
      false,
    );

    const criticalMessages = toTelegramMessages(events, "critical");
    expect(criticalMessages).toContain(
      "Task update: #1 P33-008 exhausted retry budget -> DEAD_LETTER.",
    );
  });

  test("marks the phase TIMED_OUT while waiting for deferred retry availability and emits timeout diagnostics", async () => {
    const phaseId = "93555555-5555-4555-8555-555555555555";
    const taskId = "93666666-6666-4666-8666-666666666666";
    let nowMs = Date.parse("2026-03-20T12:00:00.000Z");
    const events: RuntimeEvent[] = [];
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 33 timeout",
          branchName: "phase-33-timeout",
          status: "PLANNING",
          ciStatusContext: undefined as string | undefined,
          tasks: [
            {
              id: taskId,
              title: "P33-008 deferred timeout",
              description: "Wait for retry window",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
              rateLimitRetryAt: new Date(nowMs + 60_000).toISOString(),
            },
          ],
        },
      ],
    };

    const control = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => state),
      setPhaseStatus: mock(
        async (input: { status: string; ciStatusContext?: string }) => {
          const phase = state.phases[0] as any;
          phase.status = input.status;
          phase.ciStatusContext = input.ciStatusContext;
          return state;
        },
      ),
      startActiveTaskAndWait: mock(async () => state),
      createTask: mock(async () => state),
      recordRecoveryAttempt: mock(async () => state),
      runInternalWork: mock(async () => ({ stdout: "", stderr: "" })),
    } as unknown as ControlCenterService;

    const phaseRunner = new PhaseRunner(
      control,
      {
        ...createBaseConfig(),
        phaseTimeoutMs: 5_000,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      },
      undefined,
      async (event) => {
        events.push(event);
      },
      createGitRunner("phase-33-timeout"),
    );

    const error = await phaseRunner.run().catch((candidate) => candidate);
    expect(error).toBeInstanceOf(Error);
    expect((state.phases[0] as any).status).toBe("TIMED_OUT");
    expect((state.phases[0] as any).ciStatusContext).toContain(
      "configured limit: 5000ms",
    );

    const timeoutEvent = events.find((event) => event.type === "phase:timeout");
    expect(timeoutEvent).toBeDefined();
    if (!timeoutEvent || timeoutEvent.type !== "phase:timeout") {
      throw new Error("Expected phase:timeout event.");
    }
    expect(timeoutEvent.payload.currentStep).toBe(
      "waiting 60s for deferred task availability",
    );

    const criticalMessages = toTelegramMessages(events, "critical");
    expect(
      criticalMessages.some((message) =>
        message.startsWith('Phase timeout: Phase "Phase 33 timeout" timed out'),
      ),
    ).toBe(true);
    expect(
      criticalMessages.some(
        (message) =>
          message.startsWith("Outcome:") &&
          message.includes(
            "Current step: waiting 60s for deferred task availability.",
          ),
      ),
    ).toBe(true);
  });
});
