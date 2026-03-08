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
  TaskTypeSchema,
  TaskRoutingReasonSchema,
  TaskStatusSchema,
  WorkerArchetypeSchema,
  WorkerAssigneeSchema,
} from "./index";

describe("type contracts", () => {
  test("supports expected assignees and task statuses", () => {
    expect(WorkerAssigneeSchema.parse("CODEX_CLI")).toBe("CODEX_CLI");
    expect(TaskStatusSchema.parse("CI_FIX")).toBe("CI_FIX");
    expect(TaskStatusSchema.parse("DEAD_LETTER")).toBe("DEAD_LETTER");
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
    expect(parsed.executionLoop.deliberation.reviewerAdapter).toBe("CODEX_CLI");
    expect(parsed.executionLoop.deliberation.maxRefinePasses).toBe(1);
    expect(parsed.executionLoop.pullRequest.defaultTemplatePath).toBeNull();
    expect(parsed.executionLoop.pullRequest.templateMappings).toEqual([]);
    expect(parsed.executionLoop.pullRequest.labels).toEqual([]);
    expect(parsed.executionLoop.pullRequest.assignees).toEqual([]);
    expect(parsed.executionLoop.pullRequest.createAsDraft).toBe(false);
    expect(parsed.executionLoop.pullRequest.markReadyOnApproval).toBe(false);
    expect(parsed.discovery.includePatterns).toEqual(["**/*"]);
    expect(parsed.discovery.excludePatterns).toEqual([
      ".git/**",
      ".ixado/**",
      "node_modules/**",
      "dist/**",
      "coverage/**",
    ]);
    expect(parsed.discovery.priorityWeights).toEqual({
      recency: 0.4,
      frequency: 0.3,
      tags: 0.3,
    });
    expect(parsed.discovery.maxCandidates).toBe(25);
    expect(parsed.exceptionRecovery.maxAttempts).toBe(1);
    expect(parsed.usage.codexbarEnabled).toBe(true);
    expect(parsed.agents.CODEX_CLI.enabled).toBe(true);
    expect(parsed.agents.CODEX_CLI.timeoutMs).toBe(3_600_000);
    expect(parsed.agents.CODEX_CLI.circuitBreaker.failureThreshold).toBe(3);
    expect(parsed.agents.CODEX_CLI.circuitBreaker.cooldownMs).toBe(300_000);
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
    expect(parsed.taskType).toBeUndefined();
  });

  test("supports optional task type classification", () => {
    expect(TaskTypeSchema.parse("implementation")).toBe("implementation");
    expect(TaskTypeSchema.parse("code-review")).toBe("code-review");
    expect(TaskTypeSchema.parse("test-writing")).toBe("test-writing");
    expect(TaskTypeSchema.parse("security-audit")).toBe("security-audit");
    expect(TaskTypeSchema.parse("documentation")).toBe("documentation");

    const parsedTask = TaskSchema.parse({
      id: "44444444-4444-4444-8444-444444444444",
      title: "Write docs",
      description: "Document new CLI command",
      taskType: "documentation",
    });

    expect(parsedTask.taskType).toBe("documentation");
  });

  test("supports optional deliberate flag on tasks", () => {
    const parsedTask = TaskSchema.parse({
      id: "66666666-6666-4666-8666-666666666666",
      title: "Deliberate decision",
      description: "Require council review before implementation",
      deliberate: true,
    });

    expect(parsedTask.deliberate).toBe(true);
  });

  test("rejects invalid task type classification", () => {
    expect(() => TaskTypeSchema.parse("refactor")).toThrow();
    expect(() =>
      TaskSchema.parse({
        id: "55555555-5555-4555-8555-555555555555",
        title: "Invalid type task",
        description: "Should fail",
        taskType: "refactor",
      }),
    ).toThrow();
  });

  test("supports routing metadata for resolved assignee", () => {
    expect(TaskRoutingReasonSchema.parse("affinity")).toBe("affinity");
    expect(TaskRoutingReasonSchema.parse("fallback")).toBe("fallback");

    const parsedTask = TaskSchema.parse({
      id: "77777777-7777-4777-8777-777777777777",
      title: "Route this task",
      description: "Ensure metadata is persisted",
      resolvedAssignee: "CLAUDE_CLI",
      routingReason: "affinity",
    });

    expect(parsedTask.resolvedAssignee).toBe("CLAUDE_CLI");
    expect(parsedTask.routingReason).toBe("affinity");
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

  test("rejects deliberation reviewer adapter if disabled", () => {
    expect(() =>
      CliSettingsSchema.parse({
        telegram: {
          enabled: false,
        },
        executionLoop: {
          deliberation: {
            reviewerAdapter: "CLAUDE_CLI",
          },
        },
        agents: {
          CODEX_CLI: { enabled: true, timeoutMs: 1_000 },
          CLAUDE_CLI: { enabled: false, timeoutMs: 1_000 },
          GEMINI_CLI: { enabled: true, timeoutMs: 1_000 },
          MOCK_CLI: { enabled: true, timeoutMs: 1_000 },
        },
      }),
    ).toThrow("executionLoop.deliberation.reviewerAdapter");
  });

  test("accepts adapter affinities that target enabled adapters", () => {
    const parsed = CliSettingsSchema.parse({
      telegram: { enabled: false },
      agents: {
        CODEX_CLI: { enabled: true, timeoutMs: 1_000 },
        CLAUDE_CLI: { enabled: true, timeoutMs: 1_000 },
        GEMINI_CLI: { enabled: true, timeoutMs: 1_000 },
        MOCK_CLI: { enabled: true, timeoutMs: 1_000 },
        adapterAffinities: {
          documentation: "CLAUDE_CLI",
          "code-review": "GEMINI_CLI",
        },
      },
    });

    expect(parsed.agents.adapterAffinities).toEqual({
      documentation: "CLAUDE_CLI",
      "code-review": "GEMINI_CLI",
    });
  });

  test("rejects adapter affinities with unknown task type keys", () => {
    expect(() =>
      CliSettingsSchema.parse({
        telegram: { enabled: false },
        agents: {
          CODEX_CLI: { enabled: true, timeoutMs: 1_000 },
          CLAUDE_CLI: { enabled: true, timeoutMs: 1_000 },
          GEMINI_CLI: { enabled: true, timeoutMs: 1_000 },
          MOCK_CLI: { enabled: true, timeoutMs: 1_000 },
          adapterAffinities: {
            refactor: "CODEX_CLI",
          },
        },
      }),
    ).toThrow("Invalid key in record");
  });

  test("rejects adapter affinities that target disabled adapters", () => {
    expect(() =>
      CliSettingsSchema.parse({
        telegram: { enabled: false },
        agents: {
          CODEX_CLI: { enabled: true, timeoutMs: 1_000 },
          CLAUDE_CLI: { enabled: false, timeoutMs: 1_000 },
          GEMINI_CLI: { enabled: true, timeoutMs: 1_000 },
          MOCK_CLI: { enabled: true, timeoutMs: 1_000 },
          adapterAffinities: {
            documentation: "CLAUDE_CLI",
          },
        },
      }),
    ).toThrow("adapter is disabled");
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

  test("rejects discovery priorityWeights with non-positive total", () => {
    expect(() =>
      CliSettingsSchema.parse({
        telegram: {
          enabled: false,
        },
        discovery: {
          priorityWeights: {
            recency: 0,
            frequency: 0,
            tags: 0,
          },
        },
      }),
    ).toThrow("discovery.priorityWeights");
  });
});
