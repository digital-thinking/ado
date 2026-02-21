import { describe, expect, test } from "bun:test";

import {
  CliSettingsSchema,
  CLIAdapterSchema,
  ProjectStateSchema,
  TaskStatusSchema,
  WorkerAssigneeSchema,
} from "./index";

describe("type contracts", () => {
  test("supports expected assignees and task statuses", () => {
    expect(WorkerAssigneeSchema.parse("CODEX_CLI")).toBe("CODEX_CLI");
    expect(TaskStatusSchema.parse("CI_FIX")).toBe("CI_FIX");
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
