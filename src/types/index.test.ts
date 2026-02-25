import { describe, expect, test } from "bun:test";

import {
  CliSettingsSchema,
  CLIAdapterSchema,
  ExceptionRecoveryResultSchema,
  PhaseFailureKindSchema,
  PhaseSchema,
  TaskSchema,
  RecoveryAttemptRecordSchema,
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
    expect(parsed.telegram.notifications).toEqual({
      level: "all",
      suppressDuplicates: true,
    });
    expect(parsed.internalWork.assignee).toBe("CODEX_CLI");
    expect(parsed.executionLoop.autoMode).toBe(false);
    expect(parsed.executionLoop.countdownSeconds).toBe(10);
    expect(parsed.executionLoop.testerCommand).toBeNull();
    expect(parsed.executionLoop.testerArgs).toBeNull();
    expect(parsed.executionLoop.testerTimeoutMs).toBe(600000);
    expect(parsed.executionLoop.ciEnabled).toBe(false);
    expect(parsed.executionLoop.ciBaseBranch).toBe("main");
    expect(parsed.executionLoop.validationMaxRetries).toBe(3);
    expect(parsed.executionLoop.pullRequest.defaultTemplatePath).toBeNull();
    expect(parsed.executionLoop.pullRequest.templateMappings).toEqual([]);
    expect(parsed.executionLoop.pullRequest.labels).toEqual([]);
    expect(parsed.executionLoop.pullRequest.assignees).toEqual([]);
    expect(parsed.executionLoop.pullRequest.createAsDraft).toBe(false);
    expect(parsed.executionLoop.pullRequest.markReadyOnApproval).toBe(false);
    expect(parsed.exceptionRecovery.maxAttempts).toBe(1);
    expect(parsed.usage.codexbarEnabled).toBe(true);
    expect(parsed.agents.CODEX_CLI.enabled).toBe(true);
    expect(parsed.agents.CODEX_CLI.timeoutMs).toBe(3_600_000);
  });

  test("validates strict exception recovery result contract", () => {
    const parsed = ExceptionRecoveryResultSchema.parse({
      status: "fixed",
      reasoning: "Applied local cleanup commit.",
      actionsTaken: ["git add --all", 'git commit -m "fix"'],
      filesTouched: ["src/cli/index.ts"],
    });
    expect(parsed.status).toBe("fixed");
    expect(() =>
      ExceptionRecoveryResultSchema.parse({
        status: "fixed",
        reasoning: "x",
        extra: "not-allowed",
      }),
    ).toThrow();
  });

  test("validates persisted recovery-attempt record schema", () => {
    const parsed = RecoveryAttemptRecordSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      occurredAt: "2026-02-23T00:00:00.000Z",
      attemptNumber: 1,
      exception: {
        category: "MISSING_COMMIT",
        message: "Missing commit before PR.",
        phaseId: "22222222-2222-4222-8222-222222222222",
      },
      result: {
        status: "unfixable",
        reasoning: "Manual review required.",
      },
    });
    expect(parsed.result.status).toBe("unfixable");
  });

  test("supports task completion verification context for side effects", () => {
    const parsed = TaskSchema.parse({
      id: "33333333-3333-4333-8333-333333333333",
      title: "Create PR Task",
      description: "Open pull request",
      status: "FAILED",
      assignee: "CODEX_CLI",
      dependencies: [],
      errorLogs: "verification failed",
      completionVerification: {
        checkedAt: "2026-02-25T00:00:00.000Z",
        contracts: ["PR_CREATION"],
        status: "FAILED",
        probes: [
          {
            name: "phase.prUrl",
            success: false,
            details: "Missing phase PR URL.",
          },
        ],
        missingSideEffects: ["phase.prUrl is missing"],
      },
    });

    expect(parsed.completionVerification?.contracts).toEqual(["PR_CREATION"]);
    expect(parsed.completionVerification?.status).toBe("FAILED");
  });

  test("supports optional per-project execution settings", () => {
    const parsed = CliSettingsSchema.parse({
      telegram: {
        enabled: false,
      },
      projects: [
        {
          name: "alpha",
          rootDir: "/tmp/alpha",
          executionSettings: {
            autoMode: true,
            defaultAssignee: "CLAUDE_CLI",
          },
        },
      ],
    });

    expect(parsed.projects[0]?.executionSettings).toEqual({
      autoMode: true,
      defaultAssignee: "CLAUDE_CLI",
    });
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
      }),
    ).toThrow("must be enabled");
  });

  test("rejects markReadyOnApproval when draft creation is disabled", () => {
    expect(() =>
      CliSettingsSchema.parse({
        telegram: { enabled: false },
        executionLoop: {
          pullRequest: {
            createAsDraft: false,
            markReadyOnApproval: true,
          },
        },
      }),
    ).toThrow("markReadyOnApproval requires createAsDraft=true");
  });

  test("rejects duplicate PR template branch prefixes", () => {
    expect(() =>
      CliSettingsSchema.parse({
        telegram: { enabled: false },
        executionLoop: {
          pullRequest: {
            templateMappings: [
              { branchPrefix: "phase-", templatePath: ".github/PULL_A.md" },
              { branchPrefix: "phase-", templatePath: ".github/PULL_B.md" },
            ],
          },
        },
      }),
    ).toThrow("templateMappings branchPrefix values must be unique");
  });

  test("supports telegram notification noise controls", () => {
    const parsed = CliSettingsSchema.parse({
      telegram: {
        enabled: true,
        botToken: "token",
        ownerId: 1,
        notifications: {
          level: "critical",
          suppressDuplicates: false,
        },
      },
    });
    expect(parsed.telegram.notifications).toEqual({
      level: "critical",
      suppressDuplicates: false,
    });
  });

  test("rejects invalid project state", () => {
    expect(() =>
      ProjectStateSchema.parse({
        projectName: "IxADO",
        rootDir: "C:/repo",
        phases: [],
        createdAt: "invalid-date",
        updatedAt: "2026-02-21T00:00:00.000Z",
      }),
    ).toThrow();
  });

  // P26-001: PhaseFailureKind type contracts
  test("PhaseFailureKindSchema accepts all valid failure kinds", () => {
    expect(PhaseFailureKindSchema.parse("LOCAL_TESTER")).toBe("LOCAL_TESTER");
    expect(PhaseFailureKindSchema.parse("REMOTE_CI")).toBe("REMOTE_CI");
    expect(PhaseFailureKindSchema.parse("AGENT_FAILURE")).toBe("AGENT_FAILURE");
  });

  test("PhaseFailureKindSchema rejects unknown values", () => {
    expect(() => PhaseFailureKindSchema.parse("UNKNOWN_KIND")).toThrow();
    expect(() => PhaseFailureKindSchema.parse("")).toThrow();
    expect(() => PhaseFailureKindSchema.parse(null)).toThrow();
  });

  test("PhaseSchema persists failureKind for CI_FAILED phases", () => {
    const phase = PhaseSchema.parse({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Phase Alpha",
      branchName: "phase-alpha",
      status: "CI_FAILED",
      tasks: [],
      failureKind: "LOCAL_TESTER",
    });
    expect(phase.failureKind).toBe("LOCAL_TESTER");
    expect(phase.status).toBe("CI_FAILED");
  });

  test("PhaseSchema allows omitting failureKind (optional field)", () => {
    const phase = PhaseSchema.parse({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "Phase Beta",
      branchName: "phase-beta",
      status: "CODING",
      tasks: [],
    });
    expect(phase.failureKind).toBeUndefined();
  });
});
