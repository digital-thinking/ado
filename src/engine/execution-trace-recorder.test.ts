import { describe, expect, test } from "bun:test";

import { ExecutionTraceRecorder } from "./execution-trace-recorder";

const PHASE_ID = "00000000-0000-0000-0000-000000000001";
const TASK_ID = "00000000-0000-0000-0000-000000000002";

describe("ExecutionTraceRecorder", () => {
  test("start() creates a running node and snapshot() returns it", () => {
    const recorder = new ExecutionTraceRecorder(PHASE_ID);
    const id = recorder.start({
      type: "task_run",
      phaseId: PHASE_ID,
      taskId: TASK_ID,
      taskNumber: 1,
      adapterId: "CODEX_CLI",
      label: "Task #1 Build widget",
    });
    expect(id).toBeDefined();

    const trace = recorder.snapshot();
    expect(trace.phaseId).toBe(PHASE_ID);
    expect(trace.nodes).toHaveLength(1);
    expect(trace.nodes[0]?.status).toBe("running");
    expect(trace.nodes[0]?.type).toBe("task_run");
    expect(trace.nodes[0]?.label).toBe("Task #1 Build widget");
    expect(trace.nodes[0]?.taskId).toBe(TASK_ID);
    expect(trace.nodes[0]?.adapterId).toBe("CODEX_CLI");
    expect(trace.nodes[0]?.endedAt).toBeUndefined();
    expect(trace.nodes[0]?.durationMs).toBeUndefined();
  });

  test("finish() sets status, endedAt, and durationMs", () => {
    let clock = 1000;
    const recorder = new ExecutionTraceRecorder(PHASE_ID, () => clock);
    const id = recorder.start({
      type: "gate_eval",
      phaseId: PHASE_ID,
      label: "Gate CI check",
    });
    clock = 2500;
    recorder.finish(id, "passed", { diagnostics: "all green" });

    const node = recorder.getNodes()[0];
    expect(node?.status).toBe("passed");
    expect(node?.endedAt).toBeDefined();
    expect(node?.durationMs).toBe(1500);
    expect(node?.detail).toEqual({ diagnostics: "all green" });
  });

  test("finish() is a no-op for unknown nodeId", () => {
    const recorder = new ExecutionTraceRecorder(PHASE_ID);
    recorder.finish("nonexistent-id", "failed");
    expect(recorder.getNodes()).toHaveLength(0);
  });

  test("record() creates a complete node in one call", () => {
    let clock = 5000;
    const recorder = new ExecutionTraceRecorder(PHASE_ID, () => clock);
    const id = recorder.record({
      type: "recovery_attempt",
      phaseId: PHASE_ID,
      taskId: TASK_ID,
      label: "Recovery #1",
      status: "failed",
      durationMs: 800,
      detail: { attemptNumber: 1 },
    });

    const node = recorder.getNodes()[0];
    expect(node?.id).toBe(id);
    expect(node?.status).toBe("failed");
    expect(node?.durationMs).toBe(800);
    expect(node?.endedAt).toBeDefined();
    expect(node?.detail).toEqual({ attemptNumber: 1 });
  });

  test("multiple nodes are ordered and snapshot is independent", () => {
    const recorder = new ExecutionTraceRecorder(PHASE_ID);
    recorder.start({
      type: "task_run",
      phaseId: PHASE_ID,
      label: "Task #1",
    });
    recorder.start({
      type: "race_branch",
      phaseId: PHASE_ID,
      label: "Race branch #1",
    });
    recorder.start({
      type: "deliberation_pass",
      phaseId: PHASE_ID,
      label: "Deliberation",
    });

    const snap1 = recorder.snapshot();
    expect(snap1.nodes).toHaveLength(3);
    expect(snap1.nodes[0]?.type).toBe("task_run");
    expect(snap1.nodes[1]?.type).toBe("race_branch");
    expect(snap1.nodes[2]?.type).toBe("deliberation_pass");

    // Snapshot is a copy — mutating it doesn't affect recorder
    snap1.nodes.length = 0;
    expect(recorder.getNodes()).toHaveLength(3);
  });

  test("finish() merges detail with existing detail", () => {
    const recorder = new ExecutionTraceRecorder(PHASE_ID);
    const id = recorder.start({
      type: "task_run",
      phaseId: PHASE_ID,
      label: "Task #1",
      detail: { assignee: "CLAUDE_CLI" },
    });
    recorder.finish(id, "passed", { finalStatus: "DONE" });

    const node = recorder.getNodes()[0];
    expect(node?.detail).toEqual({
      assignee: "CLAUDE_CLI",
      finalStatus: "DONE",
    });
  });

  test("parentIds default to empty array", () => {
    const recorder = new ExecutionTraceRecorder(PHASE_ID);
    recorder.start({
      type: "task_run",
      phaseId: PHASE_ID,
      label: "Task #1",
    });
    expect(recorder.getNodes()[0]?.parentIds).toEqual([]);
  });

  test("parentIds are preserved when provided", () => {
    const recorder = new ExecutionTraceRecorder(PHASE_ID);
    const parentId = recorder.start({
      type: "task_run",
      phaseId: PHASE_ID,
      label: "Task #1",
    });
    recorder.start({
      type: "recovery_attempt",
      phaseId: PHASE_ID,
      label: "Recovery #1",
      parentIds: [parentId],
    });

    const child = recorder.getNodes()[1];
    expect(child?.parentIds).toEqual([parentId]);
  });

  test("updatedAt advances with each mutation", () => {
    let clock = 1000;
    const recorder = new ExecutionTraceRecorder(PHASE_ID, () => clock);
    const snap0 = recorder.snapshot();

    clock = 2000;
    recorder.start({
      type: "task_run",
      phaseId: PHASE_ID,
      label: "Task",
    });
    const snap1 = recorder.snapshot();
    expect(snap1.updatedAt).not.toBe(snap0.createdAt);
  });
});
