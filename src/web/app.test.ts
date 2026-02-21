import { describe, expect, test } from "bun:test";

import { createWebApp } from "./app";
import type { AgentView } from "./agent-supervisor";
import type { CreatePhaseInput, CreateTaskInput } from "./control-center-service";

type TestState = {
  projectName: string;
  rootDir: string;
  phases: Array<{
    id: string;
    name: string;
    branchName: string;
    status: string;
    tasks: Array<{ id: string; title: string; description: string; status: string; assignee: string }>;
  }>;
  activePhaseId?: string;
  createdAt: string;
  updatedAt: string;
};

function createInitialState(): TestState {
  const now = new Date().toISOString();
  return {
    projectName: "IxADO",
    rootDir: "C:/repo",
    phases: [],
    activePhaseId: undefined,
    createdAt: now,
    updatedAt: now,
  };
}

describe("web app api", () => {
  test("supports phase and task creation flow", async () => {
    const state = createInitialState();
    const agents: AgentView[] = [];

    const app = createWebApp({
      defaultAgentCwd: "C:/repo",
      control: {
        getState: async () => state as never,
        ensureInitialized: async () => state as never,
        createPhase: async (input: CreatePhaseInput) => {
          const phase = {
            id: "phase-1",
            name: input.name,
            branchName: input.branchName,
            status: "PLANNING",
            tasks: [],
          };
          state.phases.push(phase);
          state.activePhaseId = phase.id;
          return state as never;
        },
        createTask: async (input: CreateTaskInput) => {
          const phase = state.phases.find((item) => item.id === input.phaseId);
          if (!phase) {
            throw new Error("Phase not found");
          }
          phase.tasks.push({
            id: "task-1",
            title: input.title,
            description: input.description,
            status: "TODO",
            assignee: input.assignee ?? "UNASSIGNED",
          });
          return state as never;
        },
      } as never,
      agents: {
        list: () => agents,
        start: (input) => {
          const agent: AgentView = {
            id: "agent-1",
            name: input.name,
            command: input.command,
            args: input.args ?? [],
            cwd: input.cwd,
            taskId: input.taskId,
            phaseId: input.phaseId,
            status: "RUNNING",
            pid: 100,
            startedAt: new Date().toISOString(),
            outputTail: [],
          };
          agents.push(agent);
          return agent;
        },
        kill: () => {
          agents[0].status = "STOPPED";
          return agents[0];
        },
        restart: () => {
          agents[0].status = "RUNNING";
          return agents[0];
        },
      },
      usage: {
        getLatest: async () => ({
          available: true,
          snapshot: {
            capturedAt: new Date().toISOString(),
            payload: { providers: { codex: { used: 1, quota: 10 } } },
            raw: "{}",
          },
        }),
      } as never,
    });

    const htmlResponse = await app.fetch(new Request("http://localhost/"));
    expect(htmlResponse.status).toBe(200);
    expect(await htmlResponse.text()).toContain("IxADO Control Center");

    const createPhaseResponse = await app.fetch(
      new Request("http://localhost/api/phases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Phase 6", branchName: "phase-6-web-interface" }),
      })
    );
    expect(createPhaseResponse.status).toBe(201);

    const createTaskResponse = await app.fetch(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phaseId: "phase-1",
          title: "Build page",
          description: "Implement dashboard",
          assignee: "CODEX_CLI",
        }),
      })
    );
    expect(createTaskResponse.status).toBe(201);

    const stateResponse = await app.fetch(new Request("http://localhost/api/state"));
    const statePayload = (await stateResponse.json()) as TestState;
    expect(statePayload.phases).toHaveLength(1);
    expect(statePayload.phases[0].tasks).toHaveLength(1);

    const startAgentResponse = await app.fetch(
      new Request("http://localhost/api/agents/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "worker",
          command: "bun",
          args: ["run", "dev"],
          cwd: "C:/repo",
          taskId: "task-1",
        }),
      })
    );
    expect(startAgentResponse.status).toBe(201);

    const killAgentResponse = await app.fetch(
      new Request("http://localhost/api/agents/agent-1/kill", { method: "POST" })
    );
    expect(killAgentResponse.status).toBe(200);

    const restartAgentResponse = await app.fetch(
      new Request("http://localhost/api/agents/agent-1/restart", { method: "POST" })
    );
    expect(restartAgentResponse.status).toBe(200);

    const usageResponse = await app.fetch(new Request("http://localhost/api/usage"));
    const usagePayload = await usageResponse.json();
    expect(usagePayload.available).toBe(true);
  });
});
