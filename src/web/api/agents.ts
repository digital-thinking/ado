import type { AgentView } from "../agent-supervisor";
import type { ApiDependencies } from "./types";
import { json, readJson, asString } from "./utils";
import type { ProjectState } from "../../types";
import {
  parseAgentRuntimeDiagnostic,
  resolveLatestAgentRuntimeDiagnostic,
  summarizeAgentRuntimeDiagnostic,
} from "../../agent-runtime-diagnostics";
import {
  createRuntimeEvent,
  toLegacyAgentEvent,
  type RuntimeEvent,
} from "../../types/runtime-events";
import {
  buildRecoveryTraceLinks,
  formatPhaseTaskContext,
  isFileInteractionChatter,
  summarizeFailure,
} from "../../log-readability";

const recoveryCache = new Map<
  string, // taskId
  { status: string; reasoning: string }
>();

export function refreshRecoveryCache(state: ProjectState): void {
  for (const phase of state.phases) {
    for (const task of phase.tasks) {
      const attempts = Array.isArray(task.recoveryAttempts)
        ? task.recoveryAttempts
        : [];
      if (attempts.length === 0) {
        continue;
      }
      const latest = attempts[attempts.length - 1];
      recoveryCache.set(task.id, {
        status: latest.result.status,
        reasoning: latest.result.reasoning,
      });
    }
  }
}

export function buildAgentFailureReason(
  agent: AgentView,
  action: "terminated" | "killed",
): string {
  const lines = [`Agent '${agent.name}' ${action} before task completion.`];
  if (typeof agent.lastExitCode === "number") {
    lines.push(`Exit code: ${agent.lastExitCode}`);
  }
  if (agent.outputTail.length > 0) {
    lines.push("Output tail:");
    lines.push(...agent.outputTail.slice(-8));
  }

  return lines.join("\n");
}

type AgentTaskContext = {
  phaseId?: string;
  phaseName?: string;
  taskId?: string;
  taskTitle?: string;
  taskNumber?: number;
  recoveryAttempts?: Array<{
    id: string;
    attemptNumber: number;
    result: {
      status: string;
      reasoning: string;
    };
  }>;
};

function resolveAgentTaskContext(
  state: ProjectState | undefined,
  agent: AgentView,
): AgentTaskContext {
  if (!state || !agent.taskId) {
    return {
      phaseId: agent.phaseId,
      taskId: agent.taskId,
    };
  }

  for (const phase of state.phases) {
    const taskIndex = phase.tasks.findIndex((task) => task.id === agent.taskId);
    if (taskIndex < 0) {
      continue;
    }
    const task = phase.tasks[taskIndex];
    return {
      phaseId: phase.id,
      phaseName: phase.name,
      taskId: task.id,
      taskTitle: task.title,
      taskNumber: taskIndex + 1,
      recoveryAttempts: Array.isArray(task.recoveryAttempts)
        ? task.recoveryAttempts
        : [],
    };
  }

  return {
    phaseId: agent.phaseId,
    taskId: agent.taskId,
  };
}

async function resolveStateForAgent(
  deps: ApiDependencies,
  agent: AgentView,
): Promise<ProjectState | undefined> {
  try {
    return await deps.control.getState(agent.projectName ?? deps.projectName);
  } catch {
    return undefined;
  }
}

function resolveRuntimeDiagnosticSummary(outputTail: readonly string[]): {
  event: "heartbeat" | "idle-diagnostic";
  occurredAt: string;
  summary: string;
} | null {
  const latest = resolveLatestAgentRuntimeDiagnostic(outputTail);
  if (!latest) {
    return null;
  }

  return {
    event: latest.event,
    occurredAt: latest.occurredAt,
    summary: summarizeAgentRuntimeDiagnostic(latest),
  };
}

function formatOutputLineForAgentView(line: string): string {
  const diagnostic = parseAgentRuntimeDiagnostic(line);
  if (!diagnostic) {
    return line;
  }

  return `[agent-runtime] ${summarizeAgentRuntimeDiagnostic(diagnostic)}`;
}

export async function handleAgentsApi(
  request: Request,
  url: URL,
  deps: ApiDependencies,
): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/api/agents") {
    const agents = deps.agents.list();
    // Sort by startedAt descending (most recent first) for deterministic recency ordering.
    const sortedAgents = [...agents].sort((a, b) => {
      const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return bTime - aTime;
    });
    const statesByProject = new Map<string, ProjectState | undefined>();
    for (const agent of sortedAgents) {
      const projectName = agent.projectName ?? deps.projectName;
      if (statesByProject.has(projectName)) {
        continue;
      }
      try {
        statesByProject.set(
          projectName,
          await deps.control.getState(projectName),
        );
      } catch {
        statesByProject.set(projectName, undefined);
      }
    }

    return json(
      sortedAgents.map((agent) => {
        const recovery = agent.taskId
          ? recoveryCache.get(agent.taskId)
          : undefined;
        const runtimeDiagnostic = resolveRuntimeDiagnosticSummary(
          agent.outputTail,
        );
        const projectState = statesByProject.get(
          agent.projectName ?? deps.projectName,
        );
        const context = resolveAgentTaskContext(projectState, agent);

        return {
          ...agent,
          recoveryAttempted: Boolean(recovery),
          recoveryStatus: recovery?.status,
          recoveryReasoning: recovery?.reasoning,
          phaseName: context.phaseName,
          taskTitle: context.taskTitle,
          taskNumber: context.taskNumber,
          runtimeDiagnostic,
        };
      }),
    );
  }

  if (request.method === "POST" && url.pathname === "/api/agents/start") {
    const body = await readJson(request);
    const args = Array.isArray(body.args)
      ? body.args.filter((value): value is string => typeof value === "string")
      : [];

    const agent = deps.agents.start({
      name: asString(body.name) ?? "",
      command: asString(body.command) ?? "",
      args,
      cwd: asString(body.cwd) ?? deps.defaultAgentCwd,
      phaseId: asString(body.phaseId),
      taskId: asString(body.taskId),
      projectName: deps.projectName,
      approvedAdapterSpawn: true,
    });

    return json(agent, 201);
  }

  const killMatch = /^\/api\/agents\/([^/]+)\/kill$/.exec(url.pathname);
  if (request.method === "POST" && killMatch) {
    const killed = deps.agents.kill(killMatch[1]);
    return json(killed);
  }

  const assignMatch = /^\/api\/agents\/([^/]+)\/assign$/.exec(url.pathname);
  if (request.method === "POST" && assignMatch) {
    const body = await readJson(request);
    return json(
      deps.agents.assign(assignMatch[1], {
        phaseId: asString(body.phaseId),
        taskId: asString(body.taskId),
      }),
    );
  }

  const restartMatch = /^\/api\/agents\/([^/]+)\/restart$/.exec(url.pathname);
  if (request.method === "POST" && restartMatch) {
    const agentId = restartMatch[1];
    const agentToRestart = deps.agents.list().find((a) => a.id === agentId);
    if (agentToRestart?.taskId) {
      try {
        await deps.control.reconcileInProgressTaskToTodo({
          taskId: agentToRestart.taskId,
          projectName: agentToRestart.projectName,
        });
      } catch {
        // Stale task reference — proceed with the restart anyway.
      }
    }
    return json(deps.agents.restart(agentId));
  }

  const logStreamMatch = /^\/api\/agents\/([^/]+)\/logs\/stream$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && logStreamMatch) {
    const agentId = logStreamMatch[1];
    const agent = deps.agents.list().find((a) => a.id === agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const state = await resolveStateForAgent(deps, agent);
    const context = resolveAgentTaskContext(state, agent);
    const contextLabel = formatPhaseTaskContext(context);
    const recoveryLinks = buildRecoveryTraceLinks({
      context,
      attempts: context.recoveryAttempts,
    });
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (data: unknown) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
          );
        };
        const sendRuntimeEvent = (event: RuntimeEvent) => {
          const legacy = toLegacyAgentEvent(event);
          if (legacy?.type === "output") {
            // Suppress low-signal file-interaction chatter so users see only
            // reasoning / thinking progress and terminal outcome context.
            if (isFileInteractionChatter(legacy.line)) {
              return;
            }
            const displayLine = formatOutputLineForAgentView(legacy.line);
            send({
              ...legacy,
              runtimeEvent: event,
              context: contextLabel,
              formattedLine: contextLabel
                ? `[${contextLabel}] ${displayLine}`
                : displayLine,
            });
            return;
          }
          if (legacy?.type === "status") {
            const nextSummary =
              legacy.status === "FAILED"
                ? summarizeFailure(agent.outputTail.slice(-10).join("\n"))
                : undefined;
            send({
              ...legacy,
              runtimeEvent: event,
              context: contextLabel,
              failureSummary: nextSummary,
              recoveryLinks,
            });
          }
        };
        const normalizeIncomingEvent = (raw: unknown): RuntimeEvent | null => {
          if (!raw || typeof raw !== "object") {
            return null;
          }
          const candidate = raw as Record<string, unknown>;
          if (
            candidate.type === "output" &&
            typeof candidate.agentId === "string" &&
            typeof candidate.line === "string"
          ) {
            return createRuntimeEvent({
              family: "adapter-output",
              type: "adapter.output",
              payload: {
                stream: "system",
                line: candidate.line,
              },
              context: {
                source: "WEB_API",
                projectName: agent.projectName ?? deps.projectName,
                phaseId: context.phaseId,
                phaseName: context.phaseName,
                taskId: context.taskId,
                taskTitle: context.taskTitle,
                taskNumber: context.taskNumber,
                agentId: candidate.agentId,
                adapterId: agent.adapterId,
              },
            });
          }
          if (
            candidate.type === "status" &&
            typeof candidate.agentId === "string" &&
            (candidate.status === "RUNNING" ||
              candidate.status === "STOPPED" ||
              candidate.status === "FAILED")
          ) {
            return createRuntimeEvent({
              family: "terminal-outcome",
              type: "terminal.outcome",
              payload: {
                outcome:
                  candidate.status === "FAILED"
                    ? "failure"
                    : candidate.status === "RUNNING"
                      ? "cancelled"
                      : "success",
                summary: `Agent status: ${candidate.status}`,
                agentStatus: candidate.status,
              },
              context: {
                source: "WEB_API",
                projectName: agent.projectName ?? deps.projectName,
                phaseId: context.phaseId,
                phaseName: context.phaseName,
                taskId: context.taskId,
                taskTitle: context.taskTitle,
                taskNumber: context.taskNumber,
                agentId: candidate.agentId,
                adapterId: agent.adapterId,
              },
            });
          }
          return candidate as RuntimeEvent;
        };

        // Send initial backlog
        agent.outputTail.forEach((line) => {
          sendRuntimeEvent(
            createRuntimeEvent({
              family: "adapter-output",
              type: "adapter.output",
              payload: {
                stream: "system",
                line,
              },
              context: {
                source: "WEB_API",
                projectName: agent.projectName ?? deps.projectName,
                phaseId: context.phaseId,
                phaseName: context.phaseName,
                taskId: context.taskId,
                taskTitle: context.taskTitle,
                taskNumber: context.taskNumber,
                agentId,
                adapterId: agent.adapterId,
              },
            }),
          );
        });

        if (agent.status !== "RUNNING") {
          sendRuntimeEvent(
            createRuntimeEvent({
              family: "terminal-outcome",
              type: "terminal.outcome",
              payload: {
                outcome: agent.status === "FAILED" ? "failure" : "success",
                summary:
                  agent.status === "FAILED"
                    ? "Agent failed."
                    : "Agent completed.",
                agentStatus: agent.status,
                exitCode: agent.lastExitCode,
              },
              context: {
                source: "WEB_API",
                projectName: agent.projectName ?? deps.projectName,
                phaseId: context.phaseId,
                phaseName: context.phaseName,
                taskId: context.taskId,
                taskTitle: context.taskTitle,
                taskNumber: context.taskNumber,
                agentId,
                adapterId: agent.adapterId,
              },
            }),
          );
          controller.close();
          return;
        }

        const unsubscribe = deps.agents.subscribe(agentId, (event) => {
          const normalized = normalizeIncomingEvent(event);
          if (!normalized) {
            return;
          }
          sendRuntimeEvent(normalized);
          if (
            normalized.type === "terminal.outcome" &&
            normalized.payload.agentStatus !== "RUNNING"
          ) {
            unsubscribe();
            controller.close();
          }
        });

        request.signal.addEventListener("abort", () => {
          unsubscribe();
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  return null;
}
