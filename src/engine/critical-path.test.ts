import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";

import type { ExecutionTrace, TraceNode } from "../types/execution-trace";
import { computeCriticalPath } from "./critical-path";

function makeNode(overrides: Partial<TraceNode> & { id: string }): TraceNode {
  return {
    type: "task_run",
    status: "passed",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    durationMs: 1000,
    phaseId: "00000000-0000-0000-0000-000000000001",
    parentIds: [],
    label: `node-${overrides.id.slice(0, 8)}`,
    ...overrides,
  };
}

function makeTrace(nodes: TraceNode[]): ExecutionTrace {
  return {
    phaseId: "00000000-0000-0000-0000-000000000001",
    nodes,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  };
}

// Stable UUIDs for readability
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const C = "00000000-0000-0000-0000-00000000000c";
const D = "00000000-0000-0000-0000-00000000000d";
const E = "00000000-0000-0000-0000-00000000000e";
const F = "00000000-0000-0000-0000-00000000000f";

describe("computeCriticalPath", () => {
  test("returns empty result for empty trace", () => {
    const result = computeCriticalPath(makeTrace([]));
    expect(result.nodeIds).toEqual([]);
    expect(result.totalDurationMs).toBe(0);
  });

  test("single node is the critical path", () => {
    const result = computeCriticalPath(
      makeTrace([makeNode({ id: A, durationMs: 500 })]),
    );
    expect(result.nodeIds).toEqual([A]);
    expect(result.totalDurationMs).toBe(500);
  });

  test("linear chain A → B → C", () => {
    const result = computeCriticalPath(
      makeTrace([
        makeNode({ id: A, durationMs: 100 }),
        makeNode({ id: B, durationMs: 200, parentIds: [A] }),
        makeNode({ id: C, durationMs: 300, parentIds: [B] }),
      ]),
    );
    expect(result.nodeIds).toEqual([A, B, C]);
    expect(result.totalDurationMs).toBe(600);
  });

  test("diamond DAG picks the heavier branch", () => {
    //   A(100)
    //  / \
    // B(50)  C(400)
    //  \ /
    //   D(100)
    const result = computeCriticalPath(
      makeTrace([
        makeNode({ id: A, durationMs: 100 }),
        makeNode({ id: B, durationMs: 50, parentIds: [A] }),
        makeNode({ id: C, durationMs: 400, parentIds: [A] }),
        makeNode({ id: D, durationMs: 100, parentIds: [B, C] }),
      ]),
    );
    expect(result.nodeIds).toEqual([A, C, D]);
    expect(result.totalDurationMs).toBe(600);
  });

  test("parallel independent chains — picks the longer one", () => {
    // Chain 1: A(100) → B(100) = 200
    // Chain 2: C(500) = 500
    const result = computeCriticalPath(
      makeTrace([
        makeNode({ id: A, durationMs: 100 }),
        makeNode({ id: B, durationMs: 100, parentIds: [A] }),
        makeNode({ id: C, durationMs: 500 }),
      ]),
    );
    expect(result.nodeIds).toEqual([C]);
    expect(result.totalDurationMs).toBe(500);
  });

  test("running nodes (no durationMs) contribute 0", () => {
    const result = computeCriticalPath(
      makeTrace([
        makeNode({ id: A, durationMs: 100 }),
        makeNode({
          id: B,
          durationMs: undefined,
          status: "running",
          endedAt: undefined,
          parentIds: [A],
        }),
      ]),
    );
    expect(result.nodeIds).toEqual([A, B]);
    expect(result.totalDurationMs).toBe(100);
  });

  test("phantom parent references are ignored", () => {
    const phantom = randomUUID();
    const result = computeCriticalPath(
      makeTrace([
        makeNode({ id: A, durationMs: 200, parentIds: [phantom] }),
        makeNode({ id: B, durationMs: 300, parentIds: [A] }),
      ]),
    );
    // phantom not in trace, so A is treated as a root
    expect(result.nodeIds).toEqual([A, B]);
    expect(result.totalDurationMs).toBe(500);
  });

  test("complex multi-merge DAG", () => {
    //   A(10)
    //  / \
    // B(5) C(20)
    // |    |
    // D(5) E(1)
    //  \ /
    //   F(10)
    //
    // Paths to F:
    // A→B→D→F = 10+5+5+10 = 30
    // A→C→E→F = 10+20+1+10 = 41  ← critical
    const result = computeCriticalPath(
      makeTrace([
        makeNode({ id: A, durationMs: 10 }),
        makeNode({ id: B, durationMs: 5, parentIds: [A] }),
        makeNode({ id: C, durationMs: 20, parentIds: [A] }),
        makeNode({ id: D, durationMs: 5, parentIds: [B] }),
        makeNode({ id: E, durationMs: 1, parentIds: [C] }),
        makeNode({ id: F, durationMs: 10, parentIds: [D, E] }),
      ]),
    );
    expect(result.nodeIds).toEqual([A, C, E, F]);
    expect(result.totalDurationMs).toBe(41);
  });
});
