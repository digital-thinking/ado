import { z } from "zod";

// 1. Supported CLI Adapters
export const CLIAdapterIdSchema = z.enum([
  "MOCK_CLI",
  "CLAUDE_CLI",
  "GEMINI_CLI",
  "CODEX_CLI",
]);
export type CLIAdapterId = z.infer<typeof CLIAdapterIdSchema>;
export const CLI_ADAPTER_IDS: CLIAdapterId[] = [
  "CODEX_CLI",
  "CLAUDE_CLI",
  "GEMINI_CLI",
  "MOCK_CLI",
];

export const CliAgentSettingsItemSchema = z.object({
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(3_600_000),
  startupSilenceTimeoutMs: z.number().int().positive().default(60_000),
  bypassApprovalsAndSandbox: z.boolean().default(false),
});
export type CliAgentSettingsItem = z.infer<typeof CliAgentSettingsItemSchema>;

export const CliAgentSettingsSchema = z.object({
  CODEX_CLI: CliAgentSettingsItemSchema.default({
    enabled: true,
    timeoutMs: 3_600_000,
    startupSilenceTimeoutMs: 60_000,
    bypassApprovalsAndSandbox: false,
  }),
  CLAUDE_CLI: CliAgentSettingsItemSchema.default({
    enabled: true,
    timeoutMs: 3_600_000,
    startupSilenceTimeoutMs: 60_000,
    bypassApprovalsAndSandbox: false,
  }),
  GEMINI_CLI: CliAgentSettingsItemSchema.default({
    enabled: true,
    timeoutMs: 3_600_000,
    startupSilenceTimeoutMs: 60_000,
    bypassApprovalsAndSandbox: false,
  }),
  MOCK_CLI: CliAgentSettingsItemSchema.default({
    enabled: true,
    timeoutMs: 3_600_000,
    startupSilenceTimeoutMs: 60_000,
    bypassApprovalsAndSandbox: false,
  }),
});
export type CliAgentSettings = z.infer<typeof CliAgentSettingsSchema>;

const PullRequestTemplateMappingSchema = z.object({
  branchPrefix: z.string().min(1),
  templatePath: z.string().min(1),
});
export type PullRequestTemplateMapping = z.infer<
  typeof PullRequestTemplateMappingSchema
>;

export const PullRequestAutomationSettingsSchema = z
  .object({
    defaultTemplatePath: z.string().min(1).nullable().default(null),
    templateMappings: z.array(PullRequestTemplateMappingSchema).default([]),
    labels: z.array(z.string().min(1)).default([]),
    assignees: z.array(z.string().min(1)).default([]),
    createAsDraft: z.boolean().default(false),
    markReadyOnApproval: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    if (value.markReadyOnApproval && !value.createAsDraft) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "executionLoop.pullRequest.markReadyOnApproval requires createAsDraft=true.",
        path: ["markReadyOnApproval"],
      });
    }

    const seenBranchPrefixes = new Set<string>();
    value.templateMappings.forEach((mapping, index) => {
      if (seenBranchPrefixes.has(mapping.branchPrefix)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "executionLoop.pullRequest.templateMappings branchPrefix values must be unique.",
          path: ["templateMappings", index, "branchPrefix"],
        });
      }
      seenBranchPrefixes.add(mapping.branchPrefix);
    });
  });
export type PullRequestAutomationSettings = z.infer<
  typeof PullRequestAutomationSettingsSchema
>;

const PullRequestAutomationSettingsOverrideSchema = z
  .object({
    defaultTemplatePath: z.string().min(1).nullable().optional(),
    templateMappings: z.array(PullRequestTemplateMappingSchema).optional(),
    labels: z.array(z.string().min(1)).optional(),
    assignees: z.array(z.string().min(1)).optional(),
    createAsDraft: z.boolean().optional(),
    markReadyOnApproval: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    const seenBranchPrefixes = new Set<string>();
    (value.templateMappings ?? []).forEach((mapping, index) => {
      if (seenBranchPrefixes.has(mapping.branchPrefix)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "executionLoop.pullRequest.templateMappings branchPrefix values must be unique.",
          path: ["templateMappings", index, "branchPrefix"],
        });
      }
      seenBranchPrefixes.add(mapping.branchPrefix);
    });
  });

export const ExecutionLoopSettingsSchema = z.object({
  autoMode: z.boolean().default(false),
  countdownSeconds: z.number().int().min(0).max(3_600).default(10),
  testerCommand: z.string().min(1).nullable().default(null),
  testerArgs: z.array(z.string()).min(1).nullable().default(null),
  testerTimeoutMs: z.number().int().positive().default(600_000),
  ciEnabled: z.boolean().default(false),
  ciBaseBranch: z.string().min(1).default("main"),
  validationMaxRetries: z.number().int().min(0).max(20).default(3),
  ciFixMaxFanOut: z.number().int().min(1).max(50).default(10),
  ciFixMaxDepth: z.number().int().min(1).max(10).default(3),
  pullRequest: PullRequestAutomationSettingsSchema.default({
    defaultTemplatePath: null,
    templateMappings: [],
    labels: [],
    assignees: [],
    createAsDraft: false,
    markReadyOnApproval: false,
  }),
});
export type ExecutionLoopSettings = z.infer<typeof ExecutionLoopSettingsSchema>;

export const ExceptionRecoverySettingsSchema = z.object({
  maxAttempts: z.number().int().min(0).max(10).default(1),
});
export type ExceptionRecoverySettings = z.infer<
  typeof ExceptionRecoverySettingsSchema
>;

export const ProjectExecutionSettingsSchema = z.object({
  autoMode: z.boolean(),
  defaultAssignee: CLIAdapterIdSchema,
});
export type ProjectExecutionSettings = z.infer<
  typeof ProjectExecutionSettingsSchema
>;

export const TelegramNotificationLevelSchema = z.enum([
  "all",
  "important",
  "critical",
]);
export type TelegramNotificationLevel = z.infer<
  typeof TelegramNotificationLevelSchema
>;

export const TelegramNotificationSettingsSchema = z
  .object({
    level: TelegramNotificationLevelSchema.default("all"),
    suppressDuplicates: z.boolean().default(true),
  })
  .default({
    level: "all",
    suppressDuplicates: true,
  });
export type TelegramNotificationSettings = z.infer<
  typeof TelegramNotificationSettingsSchema
>;

// 2. CLI Settings
export const ProjectRecordSchema = z.object({
  name: z.string().min(1),
  rootDir: z.string().min(1),
  executionSettings: ProjectExecutionSettingsSchema.optional(),
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

export const CliSettingsSchema = z
  .object({
    projects: z.array(ProjectRecordSchema).default([]),
    activeProject: z.string().min(1).optional(),
    telegram: z.object({
      enabled: z.boolean().default(false),
      botToken: z.string().min(1).optional(),
      ownerId: z.number().int().positive().optional(),
      notifications: TelegramNotificationSettingsSchema,
    }),
    internalWork: z
      .object({
        assignee: CLIAdapterIdSchema.default("CODEX_CLI"),
      })
      .default({
        assignee: "CODEX_CLI",
      }),
    executionLoop: ExecutionLoopSettingsSchema.default({
      autoMode: false,
      countdownSeconds: 10,
      testerCommand: null,
      testerArgs: null,
      testerTimeoutMs: 600_000,
      ciEnabled: false,
      ciBaseBranch: "main",
      validationMaxRetries: 3,
      ciFixMaxFanOut: 10,
      ciFixMaxDepth: 3,
      pullRequest: {
        defaultTemplatePath: null,
        templateMappings: [],
        labels: [],
        assignees: [],
        createAsDraft: false,
        markReadyOnApproval: false,
      },
    }),
    exceptionRecovery: ExceptionRecoverySettingsSchema.default({
      maxAttempts: 1,
    }),
    usage: z
      .object({
        codexbarEnabled: z.boolean().default(true),
      })
      .default({
        codexbarEnabled: true,
      }),
    agents: CliAgentSettingsSchema.default({
      CODEX_CLI: {
        enabled: true,
        timeoutMs: 3_600_000,
        startupSilenceTimeoutMs: 60_000,
        bypassApprovalsAndSandbox: false,
      },
      CLAUDE_CLI: {
        enabled: true,
        timeoutMs: 3_600_000,
        startupSilenceTimeoutMs: 60_000,
        bypassApprovalsAndSandbox: false,
      },
      GEMINI_CLI: {
        enabled: true,
        timeoutMs: 3_600_000,
        startupSilenceTimeoutMs: 60_000,
        bypassApprovalsAndSandbox: false,
      },
      MOCK_CLI: {
        enabled: true,
        timeoutMs: 3_600_000,
        startupSilenceTimeoutMs: 60_000,
        bypassApprovalsAndSandbox: false,
      },
    }),
  })
  .superRefine((value, context) => {
    const enabledCount = CLI_ADAPTER_IDS.filter(
      (adapterId) => value.agents[adapterId].enabled,
    ).length;
    if (enabledCount === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one agent must be enabled in settings.agents.",
        path: ["agents"],
      });
    }
    if (!value.agents[value.internalWork.assignee].enabled) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `internalWork.assignee '${value.internalWork.assignee}' must be enabled in settings.agents.`,
        path: ["internalWork", "assignee"],
      });
    }
  });
export type CliSettings = z.infer<typeof CliSettingsSchema>;

const CliAgentSettingsItemOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  startupSilenceTimeoutMs: z.number().int().positive().optional(),
  bypassApprovalsAndSandbox: z.boolean().optional(),
});

const CliAgentSettingsOverrideSchema = z.object({
  CODEX_CLI: CliAgentSettingsItemOverrideSchema.optional(),
  CLAUDE_CLI: CliAgentSettingsItemOverrideSchema.optional(),
  GEMINI_CLI: CliAgentSettingsItemOverrideSchema.optional(),
  MOCK_CLI: CliAgentSettingsItemOverrideSchema.optional(),
});

const ExecutionLoopSettingsOverrideSchema = z.object({
  autoMode: z.boolean().optional(),
  countdownSeconds: z.number().int().min(0).max(3_600).optional(),
  testerCommand: z.string().min(1).nullable().optional(),
  testerArgs: z.array(z.string()).min(1).nullable().optional(),
  testerTimeoutMs: z.number().int().positive().optional(),
  ciEnabled: z.boolean().optional(),
  ciBaseBranch: z.string().min(1).optional(),
  validationMaxRetries: z.number().int().min(0).max(20).optional(),
  ciFixMaxFanOut: z.number().int().min(1).max(50).optional(),
  ciFixMaxDepth: z.number().int().min(1).max(10).optional(),
  pullRequest: PullRequestAutomationSettingsOverrideSchema.optional(),
});

const ExceptionRecoverySettingsOverrideSchema = z.object({
  maxAttempts: z.number().int().min(0).max(10).optional(),
});

export const CliSettingsOverrideSchema = z.object({
  projects: z.array(ProjectRecordSchema).optional(),
  activeProject: z.string().min(1).optional(),
  telegram: z
    .object({
      enabled: z.boolean().optional(),
      botToken: z.string().min(1).optional(),
      ownerId: z.number().int().positive().optional(),
      notifications: z
        .object({
          level: TelegramNotificationLevelSchema.optional(),
          suppressDuplicates: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  internalWork: z
    .object({
      assignee: CLIAdapterIdSchema.optional(),
    })
    .optional(),
  executionLoop: ExecutionLoopSettingsOverrideSchema.optional(),
  exceptionRecovery: ExceptionRecoverySettingsOverrideSchema.optional(),
  usage: z
    .object({
      codexbarEnabled: z.boolean().optional(),
    })
    .optional(),
  agents: CliAgentSettingsOverrideSchema.optional(),
});
export type CliSettingsOverride = z.infer<typeof CliSettingsOverrideSchema>;

// 3. Worker Assignments
export const WorkerAssigneeSchema = z.enum([
  "MOCK_CLI",
  "CLAUDE_CLI",
  "GEMINI_CLI",
  "CODEX_CLI",
  "UNASSIGNED",
]);
export type WorkerAssignee = z.infer<typeof WorkerAssigneeSchema>;

export const WorkerArchetypeSchema = z.enum([
  "CODER",
  "TESTER",
  "REVIEWER",
  "FIXER",
]);
export type WorkerArchetype = z.infer<typeof WorkerArchetypeSchema>;

// 4. CLI Adapter Contract
export const CLIAdapterSchema = z.object({
  id: CLIAdapterIdSchema,
  command: z.string().min(1),
  baseArgs: z.array(z.string()).default([]),
});
export type CLIAdapter = z.infer<typeof CLIAdapterSchema>;

// 5. Individual Task Statuses
export const TaskStatusSchema = z.enum([
  "TODO",
  "IN_PROGRESS",
  "DONE",
  "FAILED",
  "CI_FIX", // specifically for iterative fixing after a CI failure
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const ExceptionCategorySchema = z.enum([
  "DIRTY_WORKTREE",
  "MISSING_COMMIT",
  "AGENT_FAILURE",
  "UNKNOWN",
]);
export type ExceptionCategory = z.infer<typeof ExceptionCategorySchema>;

export const AdapterFailureKindSchema = z.enum([
  "auth",
  "network",
  "missing-binary",
  "timeout",
  "unknown",
]);
export type AdapterFailureKind = z.infer<typeof AdapterFailureKindSchema>;

// Typed reason a phase transitioned to CI_FAILED, enabling kind-specific operator guidance.
export const PhaseFailureKindSchema = z.enum([
  "LOCAL_TESTER", // Local test runner (tester step) failed during CODING phase
  "REMOTE_CI", // Remote CI checks (GitHub Actions) failed after PR creation
  "AGENT_FAILURE", // Task execution agent subprocess failed
]);
export type PhaseFailureKind = z.infer<typeof PhaseFailureKindSchema>;

export const ExceptionRecoveryResultSchema = z
  .object({
    status: z.enum(["fixed", "unfixable"]),
    reasoning: z.string().min(1),
    actionsTaken: z.array(z.string().min(1)).optional(),
    filesTouched: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type ExceptionRecoveryResult = z.infer<
  typeof ExceptionRecoveryResultSchema
>;

export const ExceptionMetadataSchema = z.object({
  category: ExceptionCategorySchema,
  message: z.string().min(1),
  phaseId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  adapterFailureKind: AdapterFailureKindSchema.optional(),
});
export type ExceptionMetadata = z.infer<typeof ExceptionMetadataSchema>;

export const RecoveryAttemptRecordSchema = z.object({
  id: z.string().uuid(),
  occurredAt: z.string().datetime(),
  attemptNumber: z.number().int().positive(),
  exception: ExceptionMetadataSchema,
  result: ExceptionRecoveryResultSchema,
});
export type RecoveryAttemptRecord = z.infer<typeof RecoveryAttemptRecordSchema>;

export const SideEffectContractSchema = z.enum([
  "PR_CREATION",
  "REMOTE_PUSH",
  "CI_TRIGGERED_UPDATE",
]);
export type SideEffectContract = z.infer<typeof SideEffectContractSchema>;

export const SideEffectProbeSchema = z.object({
  name: z.string().min(1),
  success: z.boolean(),
  details: z.string().min(1),
});
export type SideEffectProbe = z.infer<typeof SideEffectProbeSchema>;

export const TaskCompletionVerificationSchema = z.object({
  checkedAt: z.string().datetime(),
  contracts: z.array(SideEffectContractSchema).min(1),
  status: z.enum(["PASSED", "FAILED"]),
  probes: z.array(SideEffectProbeSchema).min(1),
  missingSideEffects: z.array(z.string().min(1)).default([]),
});
export type TaskCompletionVerification = z.infer<
  typeof TaskCompletionVerificationSchema
>;

// 6. A Single Coding Task
export const TaskSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  status: TaskStatusSchema.default("TODO"),
  assignee: WorkerAssigneeSchema.default("UNASSIGNED"),
  dependencies: z.array(z.string().uuid()).default([]),
  resultContext: z.string().optional(),
  errorLogs: z.string().optional(),
  errorCategory: ExceptionCategorySchema.optional(),
  adapterFailureKind: AdapterFailureKindSchema.optional(),
  completionVerification: TaskCompletionVerificationSchema.optional(),
  recoveryAttempts: z.array(RecoveryAttemptRecordSchema).optional(),
});
export type Task = z.infer<typeof TaskSchema>;

// 7. Phase Statuses (The GitOps Lifecycle)
export const PhaseStatusSchema = z.enum([
  "PLANNING",
  "BRANCHING", // Creating the Git feature branch
  "CODING", // Delegating Tasks to CLI Workers
  "CREATING_PR", // All tasks done, pushing to remote and opening PR
  "AWAITING_CI", // Polling GitHub Actions
  "CI_FAILED", // CI returned errors, triggering the fix loop
  "READY_FOR_REVIEW", // Green CI, awaiting human
  "DONE",
]);
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;

// 8. A Development Phase
export const PhaseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  branchName: z.string(),
  status: PhaseStatusSchema.default("PLANNING"),
  tasks: z.array(TaskSchema),
  prUrl: z.string().url().optional(),
  ciStatusContext: z.string().optional(), // Stores the GH CLI output if CI fails
  failureKind: PhaseFailureKindSchema.optional(), // Why the phase entered CI_FAILED
  recoveryAttempts: z.array(RecoveryAttemptRecordSchema).optional(),
});
export type Phase = z.infer<typeof PhaseSchema>;

// 9. Complete Project State
export const ProjectStateSchema = z.object({
  projectName: z.string(),
  rootDir: z.string(),
  phases: z.array(PhaseSchema),
  activePhaseId: z.string().uuid().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProjectState = z.infer<typeof ProjectStateSchema>;
