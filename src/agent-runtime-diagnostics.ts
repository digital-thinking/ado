import type { CLIAdapterId } from "./types";

export const AGENT_RUNTIME_DIAGNOSTIC_PREFIX = "[ixado][agent-runtime] ";
const AGENT_RUNTIME_DIAGNOSTIC_MARKER = "ixado.agent.runtime";

export type AgentHeartbeatDiagnostic = {
  marker: "ixado.agent.runtime";
  event: "heartbeat";
  occurredAt: string;
  agentId?: string;
  adapterId?: CLIAdapterId;
  command: string;
  elapsedMs: number;
  idleMs: number;
  message: string;
};

export type AgentIdleDiagnostic = {
  marker: "ixado.agent.runtime";
  event: "idle-diagnostic";
  occurredAt: string;
  agentId?: string;
  adapterId?: CLIAdapterId;
  command: string;
  elapsedMs: number;
  idleMs: number;
  idleThresholdMs: number;
  message: string;
};

export type AgentRuntimeDiagnostic =
  | AgentHeartbeatDiagnostic
  | AgentIdleDiagnostic;

export function formatDurationCompact(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours}h${minutes}m${remainingSeconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m${remainingSeconds}s`;
  }

  return `${remainingSeconds}s`;
}

export function buildAgentHeartbeatDiagnostic(input: {
  occurredAt?: string;
  agentId?: string;
  adapterId?: CLIAdapterId;
  command: string;
  elapsedMs: number;
  idleMs: number;
}): AgentHeartbeatDiagnostic {
  return {
    marker: AGENT_RUNTIME_DIAGNOSTIC_MARKER,
    event: "heartbeat",
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    agentId: input.agentId,
    adapterId: input.adapterId,
    command: input.command,
    elapsedMs: input.elapsedMs,
    idleMs: input.idleMs,
    message: `Agent heartbeat: running ${formatDurationCompact(input.elapsedMs)}; last output ${formatDurationCompact(input.idleMs)} ago.`,
  };
}

export function buildAgentIdleDiagnostic(input: {
  occurredAt?: string;
  agentId?: string;
  adapterId?: CLIAdapterId;
  command: string;
  elapsedMs: number;
  idleMs: number;
  idleThresholdMs: number;
}): AgentIdleDiagnostic {
  return {
    marker: AGENT_RUNTIME_DIAGNOSTIC_MARKER,
    event: "idle-diagnostic",
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    agentId: input.agentId,
    adapterId: input.adapterId,
    command: input.command,
    elapsedMs: input.elapsedMs,
    idleMs: input.idleMs,
    idleThresholdMs: input.idleThresholdMs,
    message: `Agent idle diagnostic: no output for ${formatDurationCompact(input.idleMs)} while running ${formatDurationCompact(input.elapsedMs)}.`,
  };
}

export function formatAgentRuntimeDiagnostic(
  diagnostic: AgentRuntimeDiagnostic,
): string {
  return `${AGENT_RUNTIME_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseAgentRuntimeDiagnostic(
  line: string,
): AgentRuntimeDiagnostic | undefined {
  if (!line.startsWith(AGENT_RUNTIME_DIAGNOSTIC_PREFIX)) {
    return undefined;
  }

  const payload = line.slice(AGENT_RUNTIME_DIAGNOSTIC_PREFIX.length).trim();
  if (!payload) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }
  if (parsed.marker !== AGENT_RUNTIME_DIAGNOSTIC_MARKER) {
    return undefined;
  }
  if (
    typeof parsed.command !== "string" ||
    typeof parsed.message !== "string"
  ) {
    return undefined;
  }
  if (typeof parsed.occurredAt !== "string") {
    return undefined;
  }

  const elapsedMs = asNonNegativeNumber(parsed.elapsedMs);
  const idleMs = asNonNegativeNumber(parsed.idleMs);
  if (elapsedMs === undefined || idleMs === undefined) {
    return undefined;
  }

  if (parsed.event === "heartbeat") {
    return {
      marker: AGENT_RUNTIME_DIAGNOSTIC_MARKER,
      event: "heartbeat",
      occurredAt: parsed.occurredAt,
      agentId: asOptionalString(parsed.agentId),
      adapterId: asOptionalString(parsed.adapterId) as CLIAdapterId | undefined,
      command: parsed.command,
      elapsedMs,
      idleMs,
      message: parsed.message,
    };
  }

  if (parsed.event === "idle-diagnostic") {
    const idleThresholdMs = asNonNegativeNumber(parsed.idleThresholdMs);
    if (idleThresholdMs === undefined) {
      return undefined;
    }
    return {
      marker: AGENT_RUNTIME_DIAGNOSTIC_MARKER,
      event: "idle-diagnostic",
      occurredAt: parsed.occurredAt,
      agentId: asOptionalString(parsed.agentId),
      adapterId: asOptionalString(parsed.adapterId) as CLIAdapterId | undefined,
      command: parsed.command,
      elapsedMs,
      idleMs,
      idleThresholdMs,
      message: parsed.message,
    };
  }

  return undefined;
}

export function resolveLatestAgentRuntimeDiagnostic(
  lines: readonly string[],
): AgentRuntimeDiagnostic | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseAgentRuntimeDiagnostic(lines[index]);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

export function summarizeAgentRuntimeDiagnostic(
  diagnostic: AgentRuntimeDiagnostic,
): string {
  if (diagnostic.event === "idle-diagnostic") {
    return `Idle ${formatDurationCompact(diagnostic.idleMs)} (elapsed ${formatDurationCompact(diagnostic.elapsedMs)}).`;
  }

  return `Heartbeat: elapsed ${formatDurationCompact(diagnostic.elapsedMs)}, idle ${formatDurationCompact(diagnostic.idleMs)}.`;
}
