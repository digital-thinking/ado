import { describe, expect, test, mock } from "bun:test";
import { handleAgentsApi, refreshRecoveryCache } from "./agents";
import type { ApiDependencies } from "./types";
import type { ProjectState } from "../../types";
import { RuntimeEventSchema } from "../../types/runtime-events";
import {
  buildAgentHeartbeatDiagnostic,
  buildAgentIdleDiagnostic,
  formatAgentRuntimeDiagnostic,
} from "../../agent-runtime-diagnostics";

function parseSsePayload(chunk: string): Record<string, unknown> {
  const normalized = chunk.trim();
  if (!normalized.startsWith("data: ")) {
    throw new Error(`Unexpected SSE payload shape: ${chunk}`);
  }

  return JSON.parse(normalized.slice("data: ".length)) as Record<
    string,
    unknown
  >;
}

describe("agents API enrichment", () => {
  const mockAgents = {
    list: mock(() => [
      {
        id: "agent-1",
        name: "Claude",
        projectName: "project-a",
        taskId: "task-1",
        status: "RUNNING",
        outputTail: [],
      },
      {
        id: "agent-2",
        name: "Gemini",
        projectName: "project-b",
        taskId: "task-2",
        status: "FAILED",
        outputTail: ["error"],
      },
    ]),
  };

  const mockDeps: ApiDependencies = {
    agents: mockAgents as any,
    projectName: "project-a",
    defaultAgentCwd: "/tmp",
  } as any;

  test("GET /api/agents returns enriched agent info from recovery cache", async () => {
    // 1. Prepare recovery cache
    const mockStateA: ProjectState = {
      projectName: "project-a",
      rootDir: "/tmp/a",
      phases: [
        {
          id: "phase-1",
          name: "P1",
          branchName: "b1",
          status: "CODING",
          tasks: [
            {
              id: "task-1",
              title: "T1",
              status: "IN_PROGRESS",
              assignee: "CLAUDE_CLI",
              dependencies: [],
              recoveryAttempts: [
                {
                  id: "rec-1",
                  occurredAt: new Date().toISOString(),
                  attemptNumber: 1,
                  exception: { category: "DIRTY_WORKTREE", message: "dirty" },
                  result: { status: "fixed", reasoning: "all good" },
                },
              ],
            },
          ],
        },
      ],
    } as any;

    refreshRecoveryCache(mockStateA);

    // 2. Call API
    const request = new Request("http://localhost/api/agents");
    const url = new URL(request.url);
    const response = await handleAgentsApi(request, url, mockDeps);

    expect(response).not.toBeNull();
    const data = await response!.json();

    expect(data).toHaveLength(2);

    const agent1 = data.find((a: any) => a.id === "agent-1");
    expect(agent1.recoveryAttempted).toBe(true);
    expect(agent1.recoveryStatus).toBe("fixed");
    expect(agent1.recoveryReasoning).toBe("all good");

    const agent2 = data.find((a: any) => a.id === "agent-2");
    expect(agent2.recoveryAttempted).toBe(false);
    expect(agent2.recoveryStatus).toBeUndefined();
  });

  test("GET /api/agents is side-effect free", async () => {
    const request = new Request("http://localhost/api/agents");
    const url = new URL(request.url);

    const initialListCount = mockAgents.list.mock.calls.length;
    await handleAgentsApi(request, url, mockDeps);

    expect(mockAgents.list.mock.calls.length).toBe(initialListCount + 1);
    // Ensure no other agent methods were called (like start, kill, assign, etc if we had mocked them)
  });

  test("GET /api/agents includes latest runtime diagnostic summary", async () => {
    const idleDiagnostic = formatAgentRuntimeDiagnostic(
      buildAgentIdleDiagnostic({
        agentId: "agent-1",
        adapterId: "CODEX_CLI",
        command: "codex",
        elapsedMs: 120_000,
        idleMs: 120_000,
        idleThresholdMs: 60_000,
        occurredAt: "2026-02-25T20:00:00.000Z",
      }),
    );
    const deps: ApiDependencies = {
      ...mockDeps,
      agents: {
        list: () => [
          {
            id: "agent-1",
            name: "Coder",
            projectName: "project-a",
            taskId: "task-1",
            status: "RUNNING",
            outputTail: [idleDiagnostic],
          },
        ],
      } as any,
    };

    const response = await handleAgentsApi(
      new Request("http://localhost/api/agents"),
      new URL("http://localhost/api/agents"),
      deps,
    );

    expect(response).not.toBeNull();
    const data = await response!.json();
    expect(data).toHaveLength(1);
    expect(data[0].runtimeDiagnostic).toEqual({
      event: "idle-diagnostic",
      occurredAt: "2026-02-25T20:00:00.000Z",
      summary: "Idle 2m0s (elapsed 2m0s).",
    });
  });

  test("GET /api/agents summarizes heartbeat diagnostics for runtime telemetry", async () => {
    const heartbeatDiagnostic = formatAgentRuntimeDiagnostic(
      buildAgentHeartbeatDiagnostic({
        agentId: "agent-1",
        adapterId: "CODEX_CLI",
        command: "codex",
        elapsedMs: 120_000,
        idleMs: 45_000,
        occurredAt: "2026-02-25T20:05:00.000Z",
      }),
    );
    const deps: ApiDependencies = {
      ...mockDeps,
      agents: {
        list: () => [
          {
            id: "agent-1",
            name: "Coder",
            projectName: "project-a",
            taskId: "task-1",
            status: "RUNNING",
            outputTail: [heartbeatDiagnostic],
          },
        ],
      } as any,
    };

    const response = await handleAgentsApi(
      new Request("http://localhost/api/agents"),
      new URL("http://localhost/api/agents"),
      deps,
    );

    expect(response).not.toBeNull();
    const data = await response!.json();
    expect(data).toHaveLength(1);
    expect(data[0].runtimeDiagnostic).toEqual({
      event: "heartbeat",
      occurredAt: "2026-02-25T20:05:00.000Z",
      summary: "Heartbeat: elapsed 2m0s, idle 45s.",
    });
  });

  test("GET /api/agents/:id/logs/stream includes formatted line, context, and recovery links", async () => {
    let capturedListener: ((event: any) => void) | undefined;
    const deps: ApiDependencies = {
      control: {
        getState: async () =>
          ({
            projectName: "project-a",
            rootDir: "/tmp/a",
            phases: [
              {
                id: "phase-1",
                name: "Phase 1",
                branchName: "phase-1",
                status: "CODING",
                tasks: [
                  {
                    id: "task-1",
                    title: "Task One",
                    status: "FAILED",
                    assignee: "CODEX_CLI",
                    dependencies: [],
                    recoveryAttempts: [
                      {
                        id: "rec-1",
                        occurredAt: new Date().toISOString(),
                        attemptNumber: 1,
                        exception: {
                          category: "AGENT_FAILURE",
                          message: "boom",
                        },
                        result: { status: "fixed", reasoning: "patched" },
                      },
                    ],
                  },
                ],
              },
            ],
          }) as any,
      } as any,
      agents: {
        list: () => [
          {
            id: "agent-1",
            name: "Coder",
            projectName: "project-a",
            phaseId: "phase-1",
            taskId: "task-1",
            status: "RUNNING",
            outputTail: ["line one"],
          },
        ],
        subscribe: (_id: string, listener: (event: any) => void) => {
          capturedListener = listener;
          return () => {};
        },
      } as any,
      usage: {} as any,
      projectName: "project-a",
      defaultAgentCwd: "/tmp",
      availableWorkerAssignees: [] as any,
      getRuntimeConfig: async () => ({}) as any,
      updateRuntimeConfig: async () => ({}) as any,
      getProjects: async () => [] as any,
      getProjectState: async () => ({}) as any,
      updateProjectSettings: async () => ({}) as any,
      getGlobalSettings: async () => ({}) as any,
      updateGlobalSettings: async () => ({}) as any,
    };

    const response = await handleAgentsApi(
      new Request("http://localhost/api/agents/agent-1/logs/stream"),
      new URL("http://localhost/api/agents/agent-1/logs/stream"),
      deps,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const reader = response!.body!.getReader();
    const decoder = new TextDecoder();

    const chunk1 = await reader.read();
    const payload1 = decoder.decode(chunk1.value);
    expect(payload1).toContain('"line":"line one"');
    expect(payload1).toContain(
      '"formattedLine":"[phase: Phase 1 | task #1 Task One] line one"',
    );
    const parsed1 = parseSsePayload(payload1);
    const runtimeEvent1 = RuntimeEventSchema.parse(parsed1.runtimeEvent);
    expect(runtimeEvent1.type).toBe("adapter.output");
    expect(runtimeEvent1.source).toBe("WEB_API");
    if (runtimeEvent1.type === "adapter.output") {
      expect(runtimeEvent1.payload.stream).toBe("system");
      expect(runtimeEvent1.payload.line).toBe("line one");
    }

    setTimeout(() => {
      capturedListener?.({
        type: "status",
        agentId: "agent-1",
        status: "FAILED",
      });
    }, 10);

    const chunk2 = await reader.read();
    const payload2 = decoder.decode(chunk2.value);
    expect(payload2).toContain('"status":"FAILED"');
    expect(payload2).toContain('"failureSummary":"line one"');
    expect(payload2).toContain('"href":"#task-card-task-1"');
    expect(payload2).toContain('"href":"#task-recovery-task-1-1"');
    const parsed2 = parseSsePayload(payload2);
    const runtimeEvent2 = RuntimeEventSchema.parse(parsed2.runtimeEvent);
    expect(runtimeEvent2.type).toBe("terminal.outcome");
    expect(runtimeEvent2.source).toBe("WEB_API");
    if (runtimeEvent2.type === "terminal.outcome") {
      expect(runtimeEvent2.payload.outcome).toBe("failure");
      expect(runtimeEvent2.payload.agentStatus).toBe("FAILED");
    }
  });

  test("POST /api/agents/:id/restart reconciles IN_PROGRESS task to TODO before restarting", async () => {
    const reconcileCalls: Array<{ taskId: string; projectName?: string }> = [];
    const restartCalls: string[] = [];

    const deps: ApiDependencies = {
      control: {
        reconcileInProgressTaskToTodo: async (input: {
          taskId: string;
          projectName?: string;
        }) => {
          reconcileCalls.push(input);
        },
      } as any,
      agents: {
        list: () => [
          {
            id: "agent-1",
            name: "Coder",
            projectName: "project-a",
            taskId: "task-1",
            status: "RUNNING",
            outputTail: [],
          },
        ],
        restart: (id: string) => {
          restartCalls.push(id);
          return { id, status: "RUNNING" };
        },
      } as any,
      usage: {} as any,
      projectName: "project-a",
      defaultAgentCwd: "/tmp",
      availableWorkerAssignees: [] as any,
      getRuntimeConfig: async () => ({}) as any,
      updateRuntimeConfig: async () => ({}) as any,
      getProjects: async () => [] as any,
      getProjectState: async () => ({}) as any,
      updateProjectSettings: async () => ({}) as any,
      getGlobalSettings: async () => ({}) as any,
      updateGlobalSettings: async () => ({}) as any,
    };

    const response = await handleAgentsApi(
      new Request("http://localhost/api/agents/agent-1/restart", {
        method: "POST",
      }),
      new URL("http://localhost/api/agents/agent-1/restart"),
      deps,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls[0]).toEqual({
      taskId: "task-1",
      projectName: "project-a",
    });
    expect(restartCalls).toEqual(["agent-1"]);
  });

  test("POST /api/agents/:id/restart proceeds even if reconcile throws", async () => {
    const restartCalls: string[] = [];

    const deps: ApiDependencies = {
      control: {
        reconcileInProgressTaskToTodo: async () => {
          throw new Error("State engine unavailable.");
        },
      } as any,
      agents: {
        list: () => [
          {
            id: "agent-2",
            name: "Worker",
            projectName: "project-b",
            taskId: "task-stale",
            status: "RUNNING",
            outputTail: [],
          },
        ],
        restart: (id: string) => {
          restartCalls.push(id);
          return { id, status: "RUNNING" };
        },
      } as any,
      usage: {} as any,
      projectName: "project-b",
      defaultAgentCwd: "/tmp",
      availableWorkerAssignees: [] as any,
      getRuntimeConfig: async () => ({}) as any,
      updateRuntimeConfig: async () => ({}) as any,
      getProjects: async () => [] as any,
      getProjectState: async () => ({}) as any,
      updateProjectSettings: async () => ({}) as any,
      getGlobalSettings: async () => ({}) as any,
      updateGlobalSettings: async () => ({}) as any,
    };

    const response = await handleAgentsApi(
      new Request("http://localhost/api/agents/agent-2/restart", {
        method: "POST",
      }),
      new URL("http://localhost/api/agents/agent-2/restart"),
      deps,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(restartCalls).toEqual(["agent-2"]);
  });

  test("POST /api/agents/:id/restart skips reconcile for agents without a taskId", async () => {
    const reconcileCalls: unknown[] = [];
    const restartCalls: string[] = [];

    const deps: ApiDependencies = {
      control: {
        reconcileInProgressTaskToTodo: async (input: unknown) => {
          reconcileCalls.push(input);
        },
      } as any,
      agents: {
        list: () => [
          {
            id: "agent-3",
            name: "Bare",
            projectName: "project-a",
            taskId: undefined,
            status: "RUNNING",
            outputTail: [],
          },
        ],
        restart: (id: string) => {
          restartCalls.push(id);
          return { id, status: "RUNNING" };
        },
      } as any,
      usage: {} as any,
      projectName: "project-a",
      defaultAgentCwd: "/tmp",
      availableWorkerAssignees: [] as any,
      getRuntimeConfig: async () => ({}) as any,
      updateRuntimeConfig: async () => ({}) as any,
      getProjects: async () => [] as any,
      getProjectState: async () => ({}) as any,
      updateProjectSettings: async () => ({}) as any,
      getGlobalSettings: async () => ({}) as any,
      updateGlobalSettings: async () => ({}) as any,
    };

    const response = await handleAgentsApi(
      new Request("http://localhost/api/agents/agent-3/restart", {
        method: "POST",
      }),
      new URL("http://localhost/api/agents/agent-3/restart"),
      deps,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(reconcileCalls).toHaveLength(0);
    expect(restartCalls).toEqual(["agent-3"]);
  });

  test("GET /api/agents/:id/logs/stream formats runtime diagnostics for readability", async () => {
    const idleDiagnostic = formatAgentRuntimeDiagnostic(
      buildAgentIdleDiagnostic({
        agentId: "agent-1",
        adapterId: "CODEX_CLI",
        command: "codex",
        elapsedMs: 120_000,
        idleMs: 120_000,
        idleThresholdMs: 60_000,
      }),
    );
    const deps: ApiDependencies = {
      control: {
        getState: async () =>
          ({
            projectName: "project-a",
            rootDir: "/tmp/a",
            phases: [
              {
                id: "phase-1",
                name: "Phase 1",
                branchName: "phase-1",
                status: "CODING",
                tasks: [
                  {
                    id: "task-1",
                    title: "Task One",
                    status: "IN_PROGRESS",
                    assignee: "CODEX_CLI",
                    dependencies: [],
                  },
                ],
              },
            ],
          }) as any,
      } as any,
      agents: {
        list: () => [
          {
            id: "agent-1",
            name: "Coder",
            projectName: "project-a",
            phaseId: "phase-1",
            taskId: "task-1",
            status: "RUNNING",
            outputTail: [idleDiagnostic],
          },
        ],
        subscribe: () => () => {},
      } as any,
      usage: {} as any,
      projectName: "project-a",
      defaultAgentCwd: "/tmp",
      availableWorkerAssignees: [] as any,
      getRuntimeConfig: async () => ({}) as any,
      updateRuntimeConfig: async () => ({}) as any,
      getProjects: async () => [] as any,
      getProjectState: async () => ({}) as any,
      updateProjectSettings: async () => ({}) as any,
      getGlobalSettings: async () => ({}) as any,
      updateGlobalSettings: async () => ({}) as any,
    };

    const response = await handleAgentsApi(
      new Request("http://localhost/api/agents/agent-1/logs/stream"),
      new URL("http://localhost/api/agents/agent-1/logs/stream"),
      deps,
    );
    expect(response).not.toBeNull();
    const reader = response!.body!.getReader();
    const decoder = new TextDecoder();
    const chunk = await reader.read();
    const payload = parseSsePayload(decoder.decode(chunk.value));

    expect(payload.formattedLine).toContain("[agent-runtime] Idle 2m0s");
  });
});

describe("P26-014: GET /api/agents recency ordering", () => {
  function makeDeps(agents: any[]): ApiDependencies {
    return {
      agents: { list: () => agents } as any,
      projectName: "project-a",
      defaultAgentCwd: "/tmp",
    } as any;
  }

  test("returns agents sorted by startedAt descending (most recent first)", async () => {
    const deps = makeDeps([
      {
        id: "agent-old",
        name: "Old",
        projectName: "project-a",
        status: "STOPPED",
        startedAt: "2026-02-20T10:00:00.000Z",
        outputTail: [],
      },
      {
        id: "agent-new",
        name: "New",
        projectName: "project-a",
        status: "RUNNING",
        startedAt: "2026-02-26T12:00:00.000Z",
        outputTail: [],
      },
      {
        id: "agent-mid",
        name: "Mid",
        projectName: "project-a",
        status: "STOPPED",
        startedAt: "2026-02-23T08:00:00.000Z",
        outputTail: [],
      },
    ]);

    const response = await handleAgentsApi(
      new Request("http://localhost/api/agents"),
      new URL("http://localhost/api/agents"),
      deps,
    );

    expect(response).not.toBeNull();
    const data = await response!.json();
    expect(data).toHaveLength(3);
    expect(data[0].id).toBe("agent-new");
    expect(data[1].id).toBe("agent-mid");
    expect(data[2].id).toBe("agent-old");
  });

  test("agents with missing startedAt sort to the end", async () => {
    const deps = makeDeps([
      {
        id: "agent-no-time",
        name: "NoTime",
        projectName: "project-a",
        status: "STOPPED",
        startedAt: undefined,
        outputTail: [],
      },
      {
        id: "agent-with-time",
        name: "WithTime",
        projectName: "project-a",
        status: "RUNNING",
        startedAt: "2026-02-26T09:00:00.000Z",
        outputTail: [],
      },
    ]);

    const response = await handleAgentsApi(
      new Request("http://localhost/api/agents"),
      new URL("http://localhost/api/agents"),
      deps,
    );

    expect(response).not.toBeNull();
    const data = await response!.json();
    expect(data).toHaveLength(2);
    expect(data[0].id).toBe("agent-with-time");
    expect(data[1].id).toBe("agent-no-time");
  });

  test("returns all agents unsorted when all have equal startedAt", async () => {
    const ts = "2026-02-26T10:00:00.000Z";
    const deps = makeDeps([
      {
        id: "a1",
        name: "A1",
        projectName: "p",
        status: "RUNNING",
        startedAt: ts,
        outputTail: [],
      },
      {
        id: "a2",
        name: "A2",
        projectName: "p",
        status: "RUNNING",
        startedAt: ts,
        outputTail: [],
      },
    ]);

    const response = await handleAgentsApi(
      new Request("http://localhost/api/agents"),
      new URL("http://localhost/api/agents"),
      deps,
    );

    expect(response).not.toBeNull();
    const data = await response!.json();
    expect(data).toHaveLength(2);
    // Both have same timestamp — order is stable, all records present.
    expect(data.map((a: any) => a.id)).toContain("a1");
    expect(data.map((a: any) => a.id)).toContain("a2");
  });
});
