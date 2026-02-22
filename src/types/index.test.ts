import { describe, expect, test } from "bun:test";

import {
  CliSettingsSchema,
  CLIAdapterSchema,
  ProjectStateSchema,
  TaskStatusSchema,
  WorkerArchetypeSchema,
  WorkerAssigneeSchema,
} from "./index";

describe("type contracts", () => {
  test("supports expected assignees and task statuses", () => {
    expect(WorkerAssigneeSchema.parse("CODEX_CLI")).toBe("CODEX_CLI");
    expect(TaskStatusSchema.parse("CI_FIX")).toBe("CI_FIX");
    expect(WorkerArchetypeSchema.parse("REVIEWER")).toBe("REVIEWER");
  });

  test("validates CLI adapter shape", () => {
    const parsed = CLIAdapterSchema.parse({
      id: "MOCK_CLI",
      command: "echo",
      baseArgs: ["hello"],
    });

    expect(parsed.id).toBe("MOCK_CLI");
    expect(parsed.baseArgs).toEqual(["hello"]);
  });

  test("validates cli settings schema", () => {
    const parsed = CliSettingsSchema.parse({
      telegram: {
        enabled: true,
        botToken: "token",
        ownerId: 123,
      },
    });

    expect(parsed.telegram.enabled).toBe(true);
    expect(parsed.telegram.botToken).toBe("token");
    expect(parsed.telegram.ownerId).toBe(123);
    expect(parsed.internalWork.assignee).toBe("CODEX_CLI");
    expect(parsed.executionLoop.autoMode).toBe(false);
    expect(parsed.executionLoop.countdownSeconds).toBe(10);
    expect(parsed.executionLoop.testerCommand).toBe("npm");
    expect(parsed.executionLoop.testerArgs).toEqual(["run", "test"]);
    expect(parsed.executionLoop.testerTimeoutMs).toBe(600000);
    expect(parsed.executionLoop.ciEnabled).toBe(false);
    expect(parsed.executionLoop.ciBaseBranch).toBe("main");
    expect(parsed.executionLoop.validationMaxRetries).toBe(3);
    expect(parsed.usage.codexbarEnabled).toBe(true);
    expect(parsed.agents.CODEX_CLI.enabled).toBe(true);
    expect(parsed.agents.CODEX_CLI.timeoutMs).toBe(3_600_000);
  });

  test("rejects internal work assignee if disabled", () => {
    expect(() =>
      CliSettingsSchema.parse({
        telegram: {
          enabled: false,
        },
        internalWork: {
          assignee: "CODEX_CLI",
        },
        agents: {
          CODEX_CLI: { enabled: false, timeoutMs: 1_000 },
          CLAUDE_CLI: { enabled: true, timeoutMs: 1_000 },
          GEMINI_CLI: { enabled: true, timeoutMs: 1_000 },
          MOCK_CLI: { enabled: true, timeoutMs: 1_000 },
        },
      })
    ).toThrow("must be enabled");
  });

  test("rejects invalid project state", () => {
    expect(() =>
      ProjectStateSchema.parse({
        projectName: "IxADO",
        rootDir: "C:/repo",
        phases: [],
        createdAt: "invalid-date",
        updatedAt: "2026-02-21T00:00:00.000Z",
      })
    ).toThrow();
  });
});
