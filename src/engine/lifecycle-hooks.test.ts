import { describe, expect, test } from "bun:test";

import {
  LifecycleHookExecutionError,
  LifecycleHookRegistry,
  createLifecycleHookRegistry,
  validateLifecycleHookRegistration,
} from "./lifecycle-hooks";

const AFTER_TASK_DONE_PAYLOAD = {
  projectName: "ixado",
  phaseId: "11111111-1111-4111-8111-111111111111",
  phaseName: "Phase 24",
  taskId: "22222222-2222-4222-8222-222222222222",
  taskTitle: "Implement hook contracts",
  taskNumber: 1,
  assignee: "CODEX_CLI" as const,
  status: "DONE" as const,
};

const ON_CI_FAILED_PAYLOAD = {
  projectName: "ixado",
  phaseId: "11111111-1111-4111-8111-111111111111",
  phaseName: "Phase 24",
  prNumber: 24,
  prUrl: "https://github.com/example/ixado/pull/24",
  ciStatusContext: "CI status for PR #24: FAILURE",
  createdFixTaskCount: 1,
};

describe("lifecycle hook registry", () => {
  test("validates registration shape and requires at least one handler", () => {
    expect(() =>
      validateLifecycleHookRegistration({
        id: "empty",
        handlers: {},
      }),
    ).toThrow("must register at least one handler");

    expect(() =>
      validateLifecycleHookRegistration({
        id: "invalid-handler",
        handlers: {
          before_task_start: "not-a-function" as any,
        },
      }),
    ).toThrow("must be a function");
  });

  test("fails fast on duplicate registration id", () => {
    const registry = new LifecycleHookRegistry();
    registry.register({
      id: "telegram-hooks",
      handlers: {
        before_task_start: () => undefined,
      },
    });

    expect(() =>
      registry.register({
        id: "telegram-hooks",
        handlers: {
          on_ci_failed: () => undefined,
        },
      }),
    ).toThrow('registration "telegram-hooks" already exists');
  });

  test("keeps deterministic registration order per hook", async () => {
    const calls: string[] = [];
    const registry = createLifecycleHookRegistry([
      {
        id: "first",
        handlers: {
          after_task_done: () => {
            calls.push("first");
          },
        },
      },
      {
        id: "second",
        handlers: {
          after_task_done: () => {
            calls.push("second");
          },
        },
      },
    ]);

    await registry.run("after_task_done", AFTER_TASK_DONE_PAYLOAD);

    expect(calls).toEqual(["first", "second"]);
  });

  test("keeps deterministic sequential ordering even with async handler durations", async () => {
    const calls: string[] = [];
    const registry = createLifecycleHookRegistry([
      {
        id: "slow-first",
        handlers: {
          after_task_done: async () => {
            calls.push("slow-first:start");
            await new Promise((resolve) => setTimeout(resolve, 15));
            calls.push("slow-first:end");
          },
        },
      },
      {
        id: "fast-second",
        handlers: {
          after_task_done: () => {
            calls.push("fast-second:start");
            calls.push("fast-second:end");
          },
        },
      },
    ]);

    await registry.run("after_task_done", AFTER_TASK_DONE_PAYLOAD);

    expect(calls).toEqual([
      "slow-first:start",
      "slow-first:end",
      "fast-second:start",
      "fast-second:end",
    ]);
  });

  test("validates payload before running a hook", async () => {
    const registry = createLifecycleHookRegistry([
      {
        id: "ci-notifier",
        handlers: {
          on_ci_failed: () => undefined,
        },
      },
    ]);

    await expect(
      registry.run("on_ci_failed", {
        projectName: "ixado",
      }),
    ).rejects.toThrow();
  });

  test("validates run options contract before executing handlers", async () => {
    let calls = 0;
    const registry = createLifecycleHookRegistry([
      {
        id: "ci-notifier",
        handlers: {
          on_ci_failed: () => {
            calls += 1;
          },
        },
      },
    ]);

    await expect(
      registry.run("on_ci_failed", ON_CI_FAILED_PAYLOAD, {
        timeoutMs: 0,
      }),
    ).rejects.toThrow();
    await expect(
      registry.run("on_ci_failed", ON_CI_FAILED_PAYLOAD, {
        timeoutMs: 10.5,
      }),
    ).rejects.toThrow();
    await expect(
      registry.run("on_ci_failed", ON_CI_FAILED_PAYLOAD, {
        timeoutMs: 25,
        extra: true,
      } as any),
    ).rejects.toThrow();

    expect(calls).toBe(0);
  });

  test("fails fast and isolates hook execution error with structured metadata", async () => {
    const calls: string[] = [];
    const registry = createLifecycleHookRegistry([
      {
        id: "first-fails",
        handlers: {
          after_task_done: () => {
            calls.push("first");
            throw new Error("boom");
          },
        },
      },
      {
        id: "second-never-runs",
        handlers: {
          after_task_done: () => {
            calls.push("second");
          },
        },
      },
    ]);

    const error = await registry
      .run("after_task_done", AFTER_TASK_DONE_PAYLOAD)
      .catch((e) => e);

    expect(error).toBeInstanceOf(LifecycleHookExecutionError);
    const hookError = error as LifecycleHookExecutionError;
    expect(hookError.hookName).toBe("after_task_done");
    expect(hookError.registrationId).toBe("first-fails");
    expect(hookError.causeError.message).toContain("boom");
    expect(calls).toEqual(["first"]);

    const logObject = hookError.toLogObject();
    expect(logObject.name).toBe("LifecycleHookExecutionError");
    expect(logObject.hookName).toBe("after_task_done");
    expect(logObject.registrationId).toBe("first-fails");
    expect(logObject.cause.message).toContain("boom");
  });

  test("propagates async handler failures and stops downstream handlers", async () => {
    const calls: string[] = [];
    const registry = createLifecycleHookRegistry([
      {
        id: "async-fails",
        handlers: {
          after_task_done: async () => {
            calls.push("async-fails");
            throw new Error("async-boom");
          },
        },
      },
      {
        id: "never-runs",
        handlers: {
          after_task_done: () => {
            calls.push("never-runs");
          },
        },
      },
    ]);

    const error = await registry
      .run("after_task_done", AFTER_TASK_DONE_PAYLOAD)
      .catch((e) => e);

    expect(error).toBeInstanceOf(LifecycleHookExecutionError);
    const hookError = error as LifecycleHookExecutionError;
    expect(hookError.registrationId).toBe("async-fails");
    expect(hookError.causeError.message).toContain("async-boom");
    expect(calls).toEqual(["async-fails"]);
  });

  test("normalizes non-error throw values in failure surfaces", async () => {
    const registry = createLifecycleHookRegistry([
      {
        id: "throws-string",
        handlers: {
          after_task_done: () => {
            throw "boom-string";
          },
        },
      },
    ]);

    const error = await registry
      .run("after_task_done", AFTER_TASK_DONE_PAYLOAD)
      .catch((e) => e);

    expect(error).toBeInstanceOf(LifecycleHookExecutionError);
    const hookError = error as LifecycleHookExecutionError;
    expect(hookError.causeError).toBeInstanceOf(Error);
    expect(hookError.causeError.message).toBe("boom-string");
    expect(hookError.message).toContain("boom-string");
  });

  test("enforces timeout guardrails for hook execution", async () => {
    const registry = createLifecycleHookRegistry([
      {
        id: "slow-hook",
        handlers: {
          after_task_done: async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
          },
        },
      },
    ]);

    const error = await registry
      .run("after_task_done", AFTER_TASK_DONE_PAYLOAD, {
        timeoutMs: 10,
      })
      .catch((e) => e);

    expect(error).toBeInstanceOf(LifecycleHookExecutionError);
    const hookError = error as LifecycleHookExecutionError;
    expect(hookError.registrationId).toBe("slow-hook");
    expect(hookError.timeoutMs).toBe(10);
    expect(hookError.causeError.name).toBe("LifecycleHookTimeoutError");
    expect(hookError.causeError.message).toContain(
      'timed out for registration "slow-hook"',
    );
    expect(hookError.message).toContain(
      'Lifecycle hook "after_task_done" failed',
    );
  });
});
