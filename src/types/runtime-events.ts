import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  parseAgentRuntimeDiagnostic,
  summarizeAgentRuntimeDiagnostic,
} from "../agent-runtime-diagnostics";
import {
  CLIAdapterIdSchema,
  ExceptionCategorySchema,
  PhaseStatusSchema,
  TaskStatusSchema,
  type TelegramNotificationLevel,
} from "./index";

export const RuntimeEventSourceSchema = z.enum([
  "PHASE_RUNNER",
  "AGENT_SUPERVISOR",
  "WEB_API",
  "CLI",
  "TELEGRAM",
]);
export type RuntimeEventSource = z.infer<typeof RuntimeEventSourceSchema>;

export const RuntimeTerminalOutcomeSchema = z.enum([
  "success",
  "failure",
  "cancelled",
]);
export type RuntimeTerminalOutcome = z.infer<
  typeof RuntimeTerminalOutcomeSchema
>;

export const RuntimeAgentStatusSchema = z.enum([
  "RUNNING",
  "STOPPED",
  "FAILED",
]);
export type RuntimeAgentStatus = z.infer<typeof RuntimeAgentStatusSchema>;

const RuntimeEventBaseSchema = z.object({
  version: z.literal(1),
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  source: RuntimeEventSourceSchema,
  projectName: z.string().min(1).optional(),
  phaseId: z.string().optional(),
  phaseName: z.string().min(1).optional(),
  taskId: z.string().optional(),
  taskTitle: z.string().min(1).optional(),
  taskNumber: z.number().int().positive().optional(),
  agentId: z.string().optional(),
  adapterId: CLIAdapterIdSchema.optional(),
});

export const TaskLifecycleStartEventSchema = RuntimeEventBaseSchema.extend({
  family: z.literal("task-lifecycle"),
  type: z.literal("task.lifecycle.start"),
  payload: z.object({
    assignee: CLIAdapterIdSchema,
    resume: z.boolean(),
    message: z.string().min(1),
  }),
});

export const TaskLifecycleProgressEventSchema = RuntimeEventBaseSchema.extend({
  family: z.literal("task-lifecycle"),
  type: z.literal("task.lifecycle.progress"),
  payload: z.object({
    message: z.string().min(1),
  }),
});

export const TaskLifecyclePhaseUpdateEventSchema =
  RuntimeEventBaseSchema.extend({
    family: z.literal("task-lifecycle"),
    type: z.literal("task.lifecycle.phase-update"),
    payload: z.object({
      status: PhaseStatusSchema,
      message: z.string().min(1).optional(),
    }),
  });

export const TaskLifecycleFinishEventSchema = RuntimeEventBaseSchema.extend({
  family: z.literal("task-lifecycle"),
  type: z.literal("task.lifecycle.finish"),
  payload: z.object({
    status: TaskStatusSchema,
    message: z.string().min(1),
    deliberation: z
      .object({
        finalVerdict: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
        rounds: z.number().int().min(0),
        refinePassesUsed: z.number().int().min(0),
        pendingComments: z.number().int().min(0),
      })
      .optional(),
  }),
});

export const TaskRateLimitRetryEventSchema = RuntimeEventBaseSchema.extend({
  family: z.literal("task-resilience"),
  type: z.literal("task:rate_limit_retry"),
  payload: z.object({
    retryCount: z.number().int().positive(),
    maxRetries: z.number().int().min(0),
    retryDelayMs: z.number().int().min(0),
    retryAt: z.string().datetime(),
    summary: z.string().min(1),
  }),
});

export const PhaseTimeoutEventSchema = RuntimeEventBaseSchema.extend({
  family: z.literal("phase-resilience"),
  type: z.literal("phase:timeout"),
  payload: z.object({
    timeoutMs: z.number().int().positive(),
    elapsedMs: z.number().int().positive(),
    startedAt: z.string().datetime(),
    deadlineAt: z.string().datetime(),
    currentStep: z.string().min(1),
    summary: z.string().min(1),
  }),
});

export const AdapterOutputEventSchema = RuntimeEventBaseSchema.extend({
  family: z.literal("adapter-output"),
  type: z.literal("adapter.output"),
  payload: z.object({
    stream: z.enum(["stdout", "stderr", "system"]),
    line: z.string(),
    isDiagnostic: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const AdapterCircuitEventSchema = RuntimeEventBaseSchema.extend({
  family: z.literal("adapter-circuit"),
  type: z.literal("adapter.circuit"),
  payload: z.object({
    stage: z.enum(["opened", "closed"]),
    summary: z.string().min(1),
    consecutiveFailures: z.number().int().min(0),
    failureThreshold: z.number().int().min(1),
    cooldownMs: z.number().int().min(0),
    remainingCooldownMs: z.number().int().min(0),
    openedAt: z.string().datetime().nullable().optional(),
  }),
});

export const TesterActivityEventSchema = RuntimeEventBaseSchema.extend({
  family: z.literal("tester-recovery"),
  type: z.literal("tester.activity"),
  payload: z.object({
    stage: z.enum([
      "started",
      "passed",
      "failed",
      "skipped",
      "fix-task-created",
    ]),
    summary: z.string().min(1),
    attemptNumber: z.number().int().positive().optional(),
  }),
});

export const RecoveryActivityEventSchema = RuntimeEventBaseSchema.extend({
  family: z.literal("tester-recovery"),
  type: z.literal("recovery.activity"),
  payload: z.object({
    stage: z.enum([
      "attempt-started",
      "attempt-failed",
      "attempt-fixed",
      "attempt-unfixable",
    ]),
    summary: z.string().min(1),
    attemptNumber: z.number().int().positive().optional(),
    category: ExceptionCategorySchema.optional(),
  }),
});

export const PrActivityEventSchema = RuntimeEventBaseSchema.extend({
  family: z.literal("ci-pr-lifecycle"),
  type: z.literal("pr.activity"),
  payload: z.object({
    stage: z.enum(["created", "ready-for-review"]),
    summary: z.string().min(1),
    prUrl: z.string().url().optional(),
    prNumber: z.number().int().positive().optional(),
    baseBranch: z.string().min(1).optional(),
    headBranch: z.string().min(1).optional(),
    draft: z.boolean().optional(),
  }),
});

export const GateActivityEventSchema = RuntimeEventBaseSchema.extend({
  family: z.literal("gate-lifecycle"),
  type: z.literal("gate.activity"),
  payload: z.object({
    stage: z.enum(["start", "pass", "fail", "retry"]),
    gateName: z.string().min(1),
    gateIndex: z.number().int().min(0),
    totalGates: z.number().int().positive(),
    summary: z.string().min(1),
    diagnostics: z.string().optional(),
    retryable: z.boolean().optional(),
  }),
});

export const RaceStartEventSchema = RuntimeEventBaseSchema.extend({
  family: z.literal("race-lifecycle"),
  type: z.literal("race:start"),
  payload: z.object({
    raceCount: z.number().int().positive(),
    baseBranchName: z.string().min(1),
    summary: z.string().min(1),
  }),
});

export const RaceBranchEventSchema = RuntimeEventBaseSchema.extend({
  family: z.literal("race-lifecycle"),
  type: z.literal("race:branch"),
  payload: z.object({
    branchIndex: z.number().int().positive(),
    branchName: z.string().min(1),
    status: z.enum(["fulfilled", "rejected"]),
    summary: z.string().min(1),
    error: z.string().min(1).optional(),
  }),
});

export const RaceJudgeEventSchema = RuntimeEventBaseSchema.extend({
  family: z.literal("race-lifecycle"),
  type: z.literal("race:judge"),
  payload: z.object({
    judgeAdapter: CLIAdapterIdSchema,
    pickedBranchIndex: z.number().int().positive(),
    branchName: z.string().min(1),
    summary: z.string().min(1),
    reasoning: z.string().min(1),
  }),
});

export const RacePickEventSchema = RuntimeEventBaseSchema.extend({
  family: z.literal("race-lifecycle"),
  type: z.literal("race:pick"),
  payload: z.object({
    branchIndex: z.number().int().positive(),
    branchName: z.string().min(1),
    commitCount: z.number().int().min(0),
    summary: z.string().min(1),
  }),
});

export const TerminalOutcomeEventSchema = RuntimeEventBaseSchema.extend({
  family: z.literal("terminal-outcome"),
  type: z.literal("terminal.outcome"),
  payload: z.object({
    outcome: RuntimeTerminalOutcomeSchema,
    summary: z.string().min(1),
    agentStatus: RuntimeAgentStatusSchema.optional(),
    exitCode: z.number().int().optional(),
  }),
});

export const RuntimeEventSchema = z.discriminatedUnion("type", [
  TaskLifecycleStartEventSchema,
  TaskLifecycleProgressEventSchema,
  TaskLifecyclePhaseUpdateEventSchema,
  TaskLifecycleFinishEventSchema,
  TaskRateLimitRetryEventSchema,
  PhaseTimeoutEventSchema,
  AdapterOutputEventSchema,
  AdapterCircuitEventSchema,
  TesterActivityEventSchema,
  RecoveryActivityEventSchema,
  PrActivityEventSchema,
  GateActivityEventSchema,
  RaceStartEventSchema,
  RaceBranchEventSchema,
  RaceJudgeEventSchema,
  RacePickEventSchema,
  TerminalOutcomeEventSchema,
]);
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

export type RuntimeEventContext = {
  source: RuntimeEventSource;
  projectName?: string;
  phaseId?: string;
  phaseName?: string;
  taskId?: string;
  taskTitle?: string;
  taskNumber?: number;
  agentId?: string;
  adapterId?: z.infer<typeof CLIAdapterIdSchema>;
};

export function createRuntimeEvent<T extends RuntimeEvent["type"]>(input: {
  type: T;
  family: Extract<RuntimeEvent, { type: T }>["family"];
  payload: Extract<RuntimeEvent, { type: T }>["payload"];
  context: RuntimeEventContext;
}): Extract<RuntimeEvent, { type: T }> {
  return RuntimeEventSchema.parse({
    version: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    source: input.context.source,
    projectName: input.context.projectName,
    phaseId: input.context.phaseId,
    phaseName: input.context.phaseName,
    taskId: input.context.taskId,
    taskTitle: input.context.taskTitle,
    taskNumber: input.context.taskNumber,
    agentId: input.context.agentId,
    adapterId: input.context.adapterId,
    family: input.family,
    type: input.type,
    payload: input.payload,
  }) as Extract<RuntimeEvent, { type: T }>;
}

export type AgentStreamEvent =
  | { type: "output"; agentId: string; line: string }
  | { type: "status"; agentId: string; status: RuntimeAgentStatus };

export function toAgentStreamEvent(
  event: RuntimeEvent,
): AgentStreamEvent | null {
  if (event.type === "adapter.output" && event.agentId) {
    return {
      type: "output",
      agentId: event.agentId,
      line: event.payload.line,
    };
  }

  if (
    event.type === "terminal.outcome" &&
    event.agentId &&
    event.payload.agentStatus
  ) {
    return {
      type: "status",
      agentId: event.agentId,
      status: event.payload.agentStatus,
    };
  }

  return null;
}

export function formatRuntimeEventForTelegram(event: RuntimeEvent): string {
  switch (event.type) {
    case "task.lifecycle.start":
      return `Task started: #${event.taskNumber ?? "?"} ${event.taskTitle ?? event.taskId ?? "unknown"} (${event.payload.assignee}).`;
    case "task.lifecycle.phase-update":
      return `Phase update: ${event.phaseName ?? event.phaseId ?? "unknown"} -> ${event.payload.status}.`;
    case "task.lifecycle.finish":
      return [
        `Task update: #${event.taskNumber ?? "?"} ${event.taskTitle ?? event.taskId ?? "unknown"} -> ${event.payload.status}.`,
        event.payload.deliberation
          ? `Deliberation: ${event.payload.deliberation.finalVerdict} (rounds=${event.payload.deliberation.rounds}, refinePasses=${event.payload.deliberation.refinePassesUsed}, pendingComments=${event.payload.deliberation.pendingComments}).`
          : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    case "task:rate_limit_retry":
      return `Task retry: ${event.payload.summary}`;
    case "phase:timeout":
      return `Phase timeout: ${event.payload.summary}`;
    case "tester.activity":
      return `Tester: ${event.payload.summary}`;
    case "recovery.activity":
      return `Recovery: ${event.payload.summary}`;
    case "pr.activity":
      return `PR: ${event.payload.summary}`;
    case "gate.activity":
      return `Gate: ${event.payload.summary}`;
    case "race:start":
    case "race:branch":
    case "race:judge":
    case "race:pick":
      return `Race: ${event.payload.summary}`;
    case "terminal.outcome":
      return `Outcome: ${event.payload.summary}`;
    case "adapter.output":
      return event.payload.line;
    case "adapter.circuit":
      return `Adapter circuit: ${event.payload.summary}`;
    default:
      return event.type;
  }
}

export function formatRuntimeEventForCli(event: RuntimeEvent): string {
  switch (event.type) {
    case "task.lifecycle.start":
    case "task.lifecycle.progress":
    case "task.lifecycle.phase-update":
    case "task.lifecycle.finish":
      return event.payload.message ?? event.type;
    case "task:rate_limit_retry":
    case "phase:timeout":
    case "pr.activity":
    case "tester.activity":
    case "recovery.activity":
      return event.payload.summary;
    case "gate.activity":
      return event.payload.summary;
    case "race:start":
    case "race:branch":
    case "race:judge":
    case "race:pick":
      return event.payload.summary;
    case "terminal.outcome":
      return event.payload.summary;
    case "adapter.output": {
      const diagnostic = parseAgentRuntimeDiagnostic(event.payload.line);
      if (diagnostic) {
        return `Agent runtime: ${summarizeAgentRuntimeDiagnostic(diagnostic)}`;
      }
      return event.payload.line;
    }
    case "adapter.circuit":
      return event.payload.summary;
    default:
      return "unknown";
  }
}

export function shouldNotifyRuntimeEventForTelegram(
  event: RuntimeEvent,
  level: TelegramNotificationLevel,
): boolean {
  if (level === "all") {
    return true;
  }

  if (level === "important") {
    if (event.type === "task.lifecycle.start") {
      return false;
    }
    if (event.type === "task.lifecycle.progress") {
      return false;
    }
    if (event.type === "tester.activity" && event.payload.stage === "started") {
      return false;
    }
    if (
      event.type === "recovery.activity" &&
      event.payload.stage === "attempt-started"
    ) {
      return false;
    }
    if (event.type === "gate.activity" && event.payload.stage === "start") {
      return false;
    }
    if (event.type === "race:start") {
      return false;
    }
    if (event.type === "adapter.output") {
      return false;
    }
    return true;
  }

  switch (event.type) {
    case "terminal.outcome":
      return true;
    case "phase:timeout":
      return true;
    case "task.lifecycle.phase-update":
      return (
        event.payload.status === "CREATING_PR" ||
        event.payload.status === "READY_FOR_REVIEW" ||
        event.payload.status === "CI_FAILED"
      );
    case "task.lifecycle.finish":
      return (
        event.payload.status === "FAILED" ||
        event.payload.status === "DEAD_LETTER"
      );
    case "task:rate_limit_retry":
      return false;
    case "tester.activity":
      return event.payload.stage === "failed";
    case "recovery.activity":
      return (
        event.payload.stage === "attempt-failed" ||
        event.payload.stage === "attempt-unfixable"
      );
    case "pr.activity":
      return true;
    case "gate.activity":
      return event.payload.stage === "fail";
    case "race:start":
    case "race:branch":
    case "race:judge":
    case "race:pick":
      return false;
    case "adapter.circuit":
      return true;
    default:
      return false;
  }
}

export function createRuntimeEventNotificationKey(event: RuntimeEvent): string {
  switch (event.type) {
    case "task.lifecycle.start":
      return [
        event.type,
        event.phaseId ?? "",
        event.taskId ?? "",
        event.taskNumber ?? "",
        event.payload.assignee,
        event.payload.resume ? "resume" : "fresh",
      ].join("|");
    case "task.lifecycle.progress":
      return [
        event.type,
        event.phaseId ?? "",
        event.taskId ?? "",
        event.payload.message,
      ].join("|");
    case "task.lifecycle.phase-update":
      return [
        event.type,
        event.phaseId ?? "",
        event.payload.status,
        event.payload.message ?? "",
      ].join("|");
    case "task.lifecycle.finish":
      return [
        event.type,
        event.phaseId ?? "",
        event.taskId ?? "",
        event.taskNumber ?? "",
        event.payload.status,
      ].join("|");
    case "task:rate_limit_retry":
      return [
        event.type,
        event.phaseId ?? "",
        event.taskId ?? "",
        event.taskNumber ?? "",
        event.payload.retryCount,
        event.payload.retryAt,
      ].join("|");
    case "phase:timeout":
      return [
        event.type,
        event.phaseId ?? "",
        event.payload.timeoutMs,
        event.payload.deadlineAt,
        event.payload.currentStep,
      ].join("|");
    case "tester.activity":
      return [
        event.type,
        event.phaseId ?? "",
        event.taskId ?? "",
        event.payload.stage,
        event.payload.attemptNumber ?? "",
        event.payload.summary,
      ].join("|");
    case "recovery.activity":
      return [
        event.type,
        event.phaseId ?? "",
        event.taskId ?? "",
        event.payload.stage,
        event.payload.attemptNumber ?? "",
        event.payload.category ?? "",
        event.payload.summary,
      ].join("|");
    case "pr.activity":
      return [
        event.type,
        event.phaseId ?? "",
        event.payload.stage,
        event.payload.prNumber ?? "",
        event.payload.prUrl ?? "",
      ].join("|");
    case "terminal.outcome":
      return [
        event.type,
        event.phaseId ?? "",
        event.taskId ?? "",
        event.payload.outcome,
        event.payload.summary,
      ].join("|");
    case "adapter.output":
      return [
        event.type,
        event.agentId ?? "",
        event.payload.stream,
        event.payload.line,
      ].join("|");
    case "race:start":
      return [
        event.type,
        event.phaseId ?? "",
        event.taskId ?? "",
        event.taskNumber ?? "",
        event.payload.raceCount,
        event.payload.baseBranchName,
      ].join("|");
    case "race:branch":
      return [
        event.type,
        event.phaseId ?? "",
        event.taskId ?? "",
        event.taskNumber ?? "",
        event.payload.branchIndex,
        event.payload.branchName,
        event.payload.status,
      ].join("|");
    case "race:judge":
      return [
        event.type,
        event.phaseId ?? "",
        event.taskId ?? "",
        event.taskNumber ?? "",
        event.payload.judgeAdapter,
        event.payload.pickedBranchIndex,
        event.payload.branchName,
      ].join("|");
    case "race:pick":
      return [
        event.type,
        event.phaseId ?? "",
        event.taskId ?? "",
        event.taskNumber ?? "",
        event.payload.branchIndex,
        event.payload.branchName,
        event.payload.commitCount,
      ].join("|");
    case "gate.activity":
      return [
        event.type,
        event.phaseId ?? "",
        event.payload.stage,
        event.payload.gateName,
        event.payload.gateIndex,
      ].join("|");
    case "adapter.circuit":
      return [
        event.type,
        event.phaseId ?? "",
        event.taskId ?? "",
        event.adapterId ?? "",
        event.payload.stage,
        event.payload.consecutiveFailures,
        event.payload.summary,
      ].join("|");
    default:
      return "runtime-event";
  }
}

export function createTelegramNotificationEvaluator(input: {
  level: TelegramNotificationLevel;
  suppressDuplicates: boolean;
}): (event: RuntimeEvent) => boolean {
  const deliveredKeys = new Set<string>();

  return (event) => {
    if (!shouldNotifyRuntimeEventForTelegram(event, input.level)) {
      return false;
    }

    if (!input.suppressDuplicates) {
      return true;
    }

    const key = createRuntimeEventNotificationKey(event);
    if (deliveredKeys.has(key)) {
      return false;
    }
    deliveredKeys.add(key);
    return true;
  };
}
