import { describe, expect, test, mock } from "bun:test";
import { handleAgentsApi, refreshRecoveryCache } from "./agents";
import type { ApiDependencies } from "./types";
import type { ProjectState } from "../../types";

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
});
