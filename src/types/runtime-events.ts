import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  CLIAdapterIdSchema,
  ExceptionCategorySchema,
  PhaseStatusSchema,
  TaskStatusSchema,
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
    case "task.lifecycle.finish":
      return `Task update: ${event.taskTitle ?? event.taskId ?? "unknown"} -> ${event.payload.status}.`;
    case "tester.activity":
      return `Tester: ${event.payload.summary}`;
    case "recovery.activity":
      return `Recovery: ${event.payload.summary}`;
    case "terminal.outcome":
      return `Outcome: ${event.payload.summary}`;
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
