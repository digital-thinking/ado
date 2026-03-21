import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import {
  ExecutionTraceSchema,
  TraceNodeSchema,
  TraceNodeTypeSchema,
  TraceNodeStatusSchema,
} from "./execution-trace";

describe("ExecutionTrace schema", () => {
  test("TraceNodeTypeSchema accepts all defined types", () => {
    for (const t of [
      "task_run",
      "recovery_attempt",
      "race_branch",
      "gate_eval",
      "deliberation_pass",
    ] as const) {
      expect(TraceNodeTypeSchema.parse(t)).toBe(t);
    }
  });

  test("TraceNodeTypeSchema rejects unknown types", () => {
    expect(() => TraceNodeTypeSchema.parse("unknown")).toThrow();
  });

  test("TraceNodeStatusSchema accepts all defined statuses", () => {
    for (const s of ["running", "passed", "failed", "skipped"] as const) {
      expect(TraceNodeStatusSchema.parse(s)).toBe(s);
    }
  });

  test("TraceNodeSchema validates a complete node", () => {
    const node = {
      id: randomUUID(),
      type: "task_run",
      status: "passed",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1234,
      adapterId: "CLAUDE_CLI",
      phaseId: randomUUID(),
      taskId: randomUUID(),
      taskNumber: 1,
      parentIds: [randomUUID()],
      label: "Task #1 Build widget",
      detail: { assignee: "CLAUDE_CLI", finalStatus: "DONE" },
    };
    const parsed = TraceNodeSchema.parse(node);
    expect(parsed.id).toBe(node.id);
    expect(parsed.type).toBe("task_run");
    expect(parsed.durationMs).toBe(1234);
    expect(parsed.detail).toEqual(node.detail);
  });

  test("TraceNodeSchema allows minimal node (running, no optional fields)", () => {
    const node = {
      id: randomUUID(),
      type: "gate_eval",
      status: "running",
      startedAt: new Date().toISOString(),
      phaseId: randomUUID(),
      label: "Gate CI",
    };
    const parsed = TraceNodeSchema.parse(node);
    expect(parsed.parentIds).toEqual([]);
    expect(parsed.endedAt).toBeUndefined();
    expect(parsed.durationMs).toBeUndefined();
    expect(parsed.detail).toBeUndefined();
  });

  test("ExecutionTraceSchema validates a complete trace", () => {
    const phaseId = randomUUID();
    const now = new Date().toISOString();
    const trace = {
      phaseId,
      nodes: [
        {
          id: randomUUID(),
          type: "task_run",
          status: "passed",
          startedAt: now,
          endedAt: now,
          durationMs: 500,
          phaseId,
          label: "Task #1",
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    const parsed = ExecutionTraceSchema.parse(trace);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.phaseId).toBe(phaseId);
  });

  test("ExecutionTraceSchema defaults nodes to empty array", () => {
    const phaseId = randomUUID();
    const now = new Date().toISOString();
    const parsed = ExecutionTraceSchema.parse({
      phaseId,
      createdAt: now,
      updatedAt: now,
    });
    expect(parsed.nodes).toEqual([]);
  });
});
