import type { AgentView } from "../agent-supervisor";
import type { ApiDependencies } from "./types";
import { json, readJson, asString } from "./utils";
import type { ProjectState } from "../../types";

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

export async function handleAgentsApi(
  request: Request,
  url: URL,
  deps: ApiDependencies,
): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/api/agents") {
    const agents = deps.agents.list();

    return json(
      agents.map((agent) => {
        const recovery = agent.taskId
          ? recoveryCache.get(agent.taskId)
          : undefined;

        return {
          ...agent,
          recoveryAttempted: Boolean(recovery),
          recoveryStatus: recovery?.status,
          recoveryReasoning: recovery?.reasoning,
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
    return json(deps.agents.restart(restartMatch[1]));
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

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (data: unknown) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
          );
        };

        // Send initial backlog
        agent.outputTail.forEach((line) => {
          send({ type: "output", agentId, line });
        });

        if (agent.status !== "RUNNING") {
          send({ type: "status", agentId, status: agent.status });
          controller.close();
          return;
        }

        const unsubscribe = deps.agents.subscribe(agentId, (event) => {
          send(event);
          if (event.type === "status" && event.status !== "RUNNING") {
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
