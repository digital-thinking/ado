import type { ExecutionTrace, TraceNode } from "../types/execution-trace";

/**
 * Result of a critical-path analysis on an execution trace DAG.
 *
 * `nodeIds` lists the nodes on the longest (by accumulated durationMs)
 * dependency chain from a root node to a leaf node, ordered root → leaf.
 * This chain represents the bottleneck that determines the minimum possible
 * wall-clock time for the execution.
 */
export interface CriticalPathResult {
  /** Ordered node IDs on the critical path (root → leaf). */
  nodeIds: string[];
  /** Sum of durationMs along the critical path. */
  totalDurationMs: number;
}

/**
 * Compute the critical path of an execution trace DAG.
 *
 * The critical path is the longest dependency chain by accumulated
 * `durationMs`.  Nodes still running (no `durationMs`) contribute 0.
 * Parent references pointing to nodes not present in the trace are
 * silently ignored.
 *
 * Uses Kahn's algorithm for topological ordering followed by a DP
 * longest-path pass.
 */
export function computeCriticalPath(trace: ExecutionTrace): CriticalPathResult {
  const nodes = trace.nodes;
  if (nodes.length === 0) {
    return { nodeIds: [], totalDurationMs: 0 };
  }

  // Build lookup + adjacency
  const nodeMap = new Map<string, TraceNode>();
  for (const n of nodes) {
    nodeMap.set(n.id, n);
  }

  // inDegree for topological sort; children adjacency for forward traversal
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const n of nodes) {
    if (!inDegree.has(n.id)) inDegree.set(n.id, 0);
    if (!children.has(n.id)) children.set(n.id, []);
    for (const pid of n.parentIds) {
      if (!nodeMap.has(pid)) continue; // phantom ref
      inDegree.set(n.id, (inDegree.get(n.id) ?? 0) + 1);
      if (!children.has(pid)) children.set(pid, []);
      children.get(pid)!.push(n.id);
    }
  }

  // Kahn's topological sort
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    topoOrder.push(id);
    for (const child of children.get(id) ?? []) {
      const newDeg = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) queue.push(child);
    }
  }

  // DP longest path
  const dist = new Map<string, number>(); // longest distance ending at node
  const prev = new Map<string, string | null>(); // predecessor on longest path

  for (const id of topoOrder) {
    const node = nodeMap.get(id)!;
    const weight = node.durationMs ?? 0;
    dist.set(id, weight);
    prev.set(id, null);

    for (const pid of node.parentIds) {
      if (!nodeMap.has(pid)) continue;
      const candidate = (dist.get(pid) ?? 0) + weight;
      if (candidate > (dist.get(id) ?? 0)) {
        dist.set(id, candidate);
        prev.set(id, pid);
      }
    }
  }

  // Find the leaf with the maximum accumulated distance
  let bestId: string | null = null;
  let bestDist = -1;
  for (const [id, d] of dist) {
    if (d >= bestDist) {
      bestDist = d;
      bestId = id;
    }
  }

  if (bestId === null) {
    return { nodeIds: [], totalDurationMs: 0 };
  }

  // Reconstruct path (leaf → root), then reverse
  const path: string[] = [];
  let cur: string | null = bestId;
  while (cur !== null) {
    path.push(cur);
    cur = prev.get(cur) ?? null;
  }
  path.reverse();

  return { nodeIds: path, totalDurationMs: bestDist };
}
