import { describe, expect, test } from "bun:test";

import {
  LifecycleHookRegistry,
  createLifecycleHookRegistry,
  validateLifecycleHookRegistration,
} from "./lifecycle-hooks";

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

    await registry.run("after_task_done", {
      projectName: "ixado",
      phaseId: "11111111-1111-4111-8111-111111111111",
      phaseName: "Phase 24",
      taskId: "22222222-2222-4222-8222-222222222222",
      taskTitle: "Implement hook contracts",
      taskNumber: 1,
      assignee: "CODEX_CLI",
      status: "DONE",
    });

    expect(calls).toEqual(["first", "second"]);
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
});
