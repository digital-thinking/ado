import { describe, expect, test } from "bun:test";
import {
  ExecutionTraceSchema,
  TraceEdgeSchema,
  TraceNodeKindSchema,
  TraceNodeSchema,
  TraceNodeStatusSchema,
} from "./index";

describe("ExecutionTrace schema", () => {
  const phaseId = "00000000-0000-4000-8000-000000000001";
  const nodeId1 = "00000000-0000-4000-8000-000000000010";
  const nodeId2 = "00000000-0000-4000-8000-000000000020";
  const traceId = "00000000-0000-4000-8000-000000000099";

  test("TraceNodeKind accepts all expected values", () => {
    const kinds = [
      "PHASE_START",
      "TASK_EXEC",
      "TESTER",
      "CI_CHECK",
      "CI_FIX",
      "PR_CREATE",
      "JUDGE",
      "PHASE_END",
    ] as const;
    for (const k of kinds) {
      expect(TraceNodeKindSchema.parse(k)).toBe(k);
    }
  });

  test("TraceNodeKind rejects unknown values", () => {
    expect(() => TraceNodeKindSchema.parse("BOGUS")).toThrow();
  });

  test("TraceNodeStatus accepts all expected values", () => {
    for (const s of [
      "PENDING",
      "RUNNING",
      "SUCCEEDED",
      "FAILED",
      "SKIPPED",
    ] as const) {
      expect(TraceNodeStatusSchema.parse(s)).toBe(s);
    }
  });

  test("TraceNode parses a minimal node with defaults", () => {
    const node = TraceNodeSchema.parse({
      id: nodeId1,
      kind: "TASK_EXEC",
      label: "Implement feature",
      phaseId,
    });
    expect(node.status).toBe("PENDING");
    expect(node.adapterId).toBeUndefined();
    expect(node.adapterMeta).toBeUndefined();
    expect(node.startedAt).toBeUndefined();
    expect(node.durationMs).toBeUndefined();
  });

  test("TraceNode parses a fully-populated node", () => {
    const node = TraceNodeSchema.parse({
      id: nodeId1,
      kind: "TASK_EXEC",
      label: "Implement feature",
      status: "SUCCEEDED",
      phaseId,
      taskId: nodeId2,
      adapterId: "CLAUDE_CLI",
      adapterMeta: { model: "opus", tokensUsed: 1500 },
      startedAt: "2026-03-21T10:00:00Z",
      finishedAt: "2026-03-21T10:05:00Z",
      durationMs: 300000,
    });
    expect(node.adapterId).toBe("CLAUDE_CLI");
    expect(node.adapterMeta).toEqual({ model: "opus", tokensUsed: 1500 });
    expect(node.durationMs).toBe(300000);
  });

  test("TraceNode rejects missing required fields", () => {
    expect(() => TraceNodeSchema.parse({ id: nodeId1 })).toThrow();
  });

  test("TraceEdge parses valid edge", () => {
    const edge = TraceEdgeSchema.parse({ from: nodeId1, to: nodeId2 });
    expect(edge.from).toBe(nodeId1);
    expect(edge.to).toBe(nodeId2);
  });

  test("TraceEdge rejects non-uuid", () => {
    expect(() =>
      TraceEdgeSchema.parse({ from: "not-a-uuid", to: nodeId2 }),
    ).toThrow();
  });

  test("ExecutionTrace parses a complete trace", () => {
    const trace = ExecutionTraceSchema.parse({
      id: traceId,
      phaseId,
      nodes: [
        {
          id: nodeId1,
          kind: "PHASE_START",
          label: "Start",
          status: "SUCCEEDED",
          phaseId,
          startedAt: "2026-03-21T10:00:00Z",
          finishedAt: "2026-03-21T10:00:01Z",
          durationMs: 1000,
        },
        {
          id: nodeId2,
          kind: "TASK_EXEC",
          label: "Task A",
          status: "RUNNING",
          phaseId,
          taskId: "00000000-0000-4000-8000-000000000030",
          adapterId: "CODEX_CLI",
          startedAt: "2026-03-21T10:00:01Z",
        },
      ],
      edges: [{ from: nodeId1, to: nodeId2 }],
      startedAt: "2026-03-21T10:00:00Z",
    });
    expect(trace.nodes).toHaveLength(2);
    expect(trace.edges).toHaveLength(1);
    expect(trace.finishedAt).toBeUndefined();
    expect(trace.durationMs).toBeUndefined();
  });

  test("ExecutionTrace rejects missing startedAt", () => {
    expect(() =>
      ExecutionTraceSchema.parse({
        id: traceId,
        phaseId,
        nodes: [],
        edges: [],
      }),
    ).toThrow();
  });
});
