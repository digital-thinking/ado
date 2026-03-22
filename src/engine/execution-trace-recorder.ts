import { randomUUID } from "node:crypto";

import type {
  ExecutionTrace,
  TraceNode,
  TraceNodeStatus,
  TraceNodeType,
} from "../types/execution-trace";
import type { CLIAdapterId } from "../types";

export interface TraceNodeInit {
  type: TraceNodeType;
  phaseId: string;
  taskId?: string;
  taskNumber?: number;
  adapterId?: CLIAdapterId;
  agentId?: string;
  label: string;
  parentIds?: string[];
  detail?: Record<string, unknown>;
}

/**
 * Records execution trace nodes for a single phase run.
 *
 * Nodes are appended in order and can be started (status=running) then
 * finished (status=passed/failed/skipped) via their id.  The recorder
 * is intentionally lightweight — persistence is handled separately.
 */
export class ExecutionTraceRecorder {
  private nodes: TraceNode[] = [];
  private readonly phaseId: string;
  private readonly createdAt: string;
  private updatedAt: string;
  private readonly now: () => number;

  constructor(phaseId: string, now?: () => number) {
    this.phaseId = phaseId;
    this.now = now ?? (() => Date.now());
    const ts = new Date(this.now()).toISOString();
    this.createdAt = ts;
    this.updatedAt = ts;
  }

  /** Start a new trace node (status = "running") and return its id. */
  start(init: TraceNodeInit): string {
    const id = randomUUID();
    const startedAt = new Date(this.now()).toISOString();
    this.nodes.push({
      id,
      type: init.type,
      status: "running",
      startedAt,
      phaseId: init.phaseId,
      taskId: init.taskId,
      taskNumber: init.taskNumber,
      adapterId: init.adapterId,
      agentId: init.agentId,
      parentIds: init.parentIds ?? [],
      label: init.label,
      detail: init.detail,
    });
    this.updatedAt = startedAt;
    return id;
  }

  /** Finish a previously started node. */
  finish(
    nodeId: string,
    status: TraceNodeStatus,
    detail?: Record<string, unknown>,
    agentId?: string,
  ): void {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) {
      return;
    }
    const endedAt = new Date(this.now()).toISOString();
    node.status = status;
    node.endedAt = endedAt;
    node.durationMs =
      new Date(endedAt).getTime() - new Date(node.startedAt).getTime();
    if (detail) {
      node.detail = { ...node.detail, ...detail };
    }
    if (agentId) {
      node.agentId = agentId;
    }
    this.updatedAt = endedAt;
  }

  /** Record a complete (already-finished) node in one call. */
  record(
    init: TraceNodeInit & { status: TraceNodeStatus; durationMs?: number },
  ): string {
    const id = randomUUID();
    const now = new Date(this.now()).toISOString();
    const startMs =
      init.durationMs != null ? this.now() - init.durationMs : this.now();
    const startedAt = new Date(startMs).toISOString();
    this.nodes.push({
      id,
      type: init.type,
      status: init.status,
      startedAt,
      endedAt: now,
      durationMs: init.durationMs ?? 0,
      phaseId: init.phaseId,
      taskId: init.taskId,
      taskNumber: init.taskNumber,
      adapterId: init.adapterId,
      agentId: init.agentId,
      parentIds: init.parentIds ?? [],
      label: init.label,
      detail: init.detail,
    });
    this.updatedAt = now;
    return id;
  }

  /** Return the current snapshot of the execution trace. */
  snapshot(): ExecutionTrace {
    return {
      phaseId: this.phaseId,
      nodes: [...this.nodes],
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /** Return all recorded nodes. */
  getNodes(): readonly TraceNode[] {
    return this.nodes;
  }
}
