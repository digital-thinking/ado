import { z } from "zod";

import { CLIAdapterIdSchema } from "./index";

// ── Trace node types ────────────────────────────────────────────────────

export const TraceNodeTypeSchema = z.enum([
  "task_run",
  "recovery_attempt",
  "race_branch",
  "gate_eval",
  "deliberation_pass",
]);
export type TraceNodeType = z.infer<typeof TraceNodeTypeSchema>;

export const TraceNodeStatusSchema = z.enum([
  "running",
  "passed",
  "failed",
  "skipped",
]);
export type TraceNodeStatus = z.infer<typeof TraceNodeStatusSchema>;

// ── Individual trace node ───────────────────────────────────────────────

export const TraceNodeSchema = z.object({
  /** Unique identifier for this node. */
  id: z.string().uuid(),
  /** What kind of execution step this node represents. */
  type: TraceNodeTypeSchema,
  /** Outcome of this node. */
  status: TraceNodeStatusSchema,
  /** ISO-8601 timestamp when the node started. */
  startedAt: z.string().datetime(),
  /** ISO-8601 timestamp when the node finished (absent while running). */
  endedAt: z.string().datetime().optional(),
  /** Wall-clock duration in milliseconds (absent while running). */
  durationMs: z.number().int().min(0).optional(),
  /** Which adapter executed this node (if applicable). */
  adapterId: CLIAdapterIdSchema.optional(),
  /** The specific agent instance ID that executed this node. */
  agentId: z.string().uuid().optional(),
  /** Phase that owns this trace. */
  phaseId: z.string().uuid(),
  /** Task associated with this node (absent for phase-level gates). */
  taskId: z.string().uuid().optional(),
  /** Human-readable task number (1-based). */
  taskNumber: z.number().int().positive().optional(),
  /** IDs of parent / predecessor nodes (forms DAG edges). */
  parentIds: z.array(z.string().uuid()).default([]),
  /** Free-form label for display. */
  label: z.string().min(1),
  /** Structured detail blob — shape varies by node type. */
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type TraceNode = z.infer<typeof TraceNodeSchema>;

// ── Full execution trace for a phase ────────────────────────────────────

export const ExecutionTraceSchema = z.object({
  /** Phase this trace belongs to. */
  phaseId: z.string().uuid(),
  /** Ordered list of trace nodes. */
  nodes: z.array(TraceNodeSchema).default([]),
  /** ISO-8601 timestamp when trace recording started. */
  createdAt: z.string().datetime(),
  /** ISO-8601 timestamp of last node update. */
  updatedAt: z.string().datetime(),
});
export type ExecutionTrace = z.infer<typeof ExecutionTraceSchema>;
