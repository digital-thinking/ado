import { randomUUID } from "node:crypto";
import { z } from "zod";

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

export const CiOverallStatusSchema = z.enum([
  "PENDING",
  "SUCCESS",
  "FAILURE",
  "CANCELLED",
  "UNKNOWN",
]);
export type CiOverallStatus = z.infer<typeof CiOverallStatusSchema>;

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

export const CiActivityEventSchema = RuntimeEventBaseSchema.extend({
  family: z.literal("ci-pr-lifecycle"),
  type: z.literal("ci.activity"),
  payload: z.object({
    stage: z.enum([
      "poll-transition",
      "failed",
      "succeeded",
      "validation-max-retries",
    ]),
    summary: z.string().min(1),
    prNumber: z.number().int().positive(),
    previousOverall: CiOverallStatusSchema.optional(),
    overall: CiOverallStatusSchema.optional(),
    pollCount: z.number().int().positive().optional(),
    rerun: z.boolean().optional(),
    terminal: z.boolean().optional(),
    terminalObservationCount: z.number().int().min(0).optional(),
    requiredTerminalObservations: z.number().int().positive().optional(),
    createdFixTaskCount: z.number().int().min(0).optional(),
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
  AdapterOutputEventSchema,
  TesterActivityEventSchema,
  RecoveryActivityEventSchema,
  PrActivityEventSchema,
  CiActivityEventSchema,
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

export type LegacyAgentEvent =
  | { type: "output"; agentId: string; line: string }
  | { type: "status"; agentId: string; status: RuntimeAgentStatus };

export function toLegacyAgentEvent(
  event: RuntimeEvent,
): LegacyAgentEvent | null {
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
      return `Task update: #${event.taskNumber ?? "?"} ${event.taskTitle ?? event.taskId ?? "unknown"} -> ${event.payload.status}.`;
    case "tester.activity":
      return `Tester: ${event.payload.summary}`;
    case "recovery.activity":
      return `Recovery: ${event.payload.summary}`;
    case "pr.activity":
      return `PR: ${event.payload.summary}`;
    case "ci.activity":
      return `CI: ${event.payload.summary}`;
    case "terminal.outcome":
      return `Outcome: ${event.payload.summary}`;
    case "adapter.output":
      return event.payload.line;
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
    case "pr.activity":
    case "ci.activity":
      return event.payload.summary;
    case "tester.activity":
    case "recovery.activity":
      return event.payload.summary;
    case "terminal.outcome":
      return event.payload.summary;
    case "adapter.output":
      return event.payload.line;
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
    if (
      event.type === "ci.activity" &&
      event.payload.stage === "poll-transition"
    ) {
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
    case "task.lifecycle.phase-update":
      return (
        event.payload.status === "CREATING_PR" ||
        event.payload.status === "READY_FOR_REVIEW" ||
        event.payload.status === "CI_FAILED"
      );
    case "task.lifecycle.finish":
      return event.payload.status === "FAILED";
    case "tester.activity":
      return event.payload.stage === "failed";
    case "recovery.activity":
      return (
        event.payload.stage === "attempt-failed" ||
        event.payload.stage === "attempt-unfixable"
      );
    case "pr.activity":
      return true;
    case "ci.activity":
      return (
        event.payload.stage === "failed" ||
        event.payload.stage === "succeeded" ||
        event.payload.stage === "validation-max-retries"
      );
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
    case "ci.activity":
      return [
        event.type,
        event.phaseId ?? "",
        event.payload.stage,
        event.payload.prNumber,
        event.payload.pollCount ?? "",
        event.payload.overall ?? "",
        event.payload.summary,
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
