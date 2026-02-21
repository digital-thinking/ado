import { describe, expect, test } from "bun:test";

import { createWebApp } from "./app";
import type { AgentView } from "./agent-supervisor";
import type {
  CreatePhaseInput,
  CreateTaskInput,
  RunInternalWorkInput,
  SetActivePhaseInput,
  StartTaskInput,
} from "./control-center-service";
import type { CLIAdapterId } from "../types";

type TestState = {
  projectName: string;
  rootDir: string;
  phases: Array<{
    id: string;
    name: string;
    branchName: string;
    status: string;
    tasks: Array<{
      id: string;
      title: string;
      description: string;
      status: string;
      assignee: string;
      dependencies?: string[];
      errorLogs?: string;
      resultContext?: string;
    }>;
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
            dependencies: input.dependencies ?? [],
          });
          return state as never;
        },
        setActivePhase: async (input: SetActivePhaseInput) => {
          const phase = state.phases.find((item) => item.id === input.phaseId);
          if (!phase) {
            throw new Error("Phase not found");
          }

          state.activePhaseId = phase.id;
          return state as never;
        },
        startTask: async (input: StartTaskInput) => {
          const phase = state.phases.find((item) => item.id === input.phaseId);
          if (!phase) {
            throw new Error("Phase not found");
          }

          const task = phase.tasks.find((item) => item.id === input.taskId);
          if (!task) {
            throw new Error("Task not found");
          }

          task.status = "IN_PROGRESS";
          task.assignee = input.assignee;
          return state as never;
        },
        resetTaskToTodo: async (input: { phaseId: string; taskId: string }) => {
          const phase = state.phases.find((item) => item.id === input.phaseId);
          if (!phase) {
            throw new Error("Phase not found");
          }
          const task = phase.tasks.find((item) => item.id === input.taskId);
          if (!task) {
            throw new Error("Task not found");
          }
          task.status = "TODO";
          task.assignee = "UNASSIGNED";
          task.errorLogs = undefined;
          task.resultContext = undefined;
          return state as never;
        },
        failTaskIfInProgress: async (input: { taskId: string; reason: string }) => {
          for (const phase of state.phases) {
            const task = phase.tasks.find((item) => item.id === input.taskId);
            if (task && task.status === "IN_PROGRESS") {
              task.status = "FAILED";
              task.errorLogs = input.reason;
            }
          }
          return state as never;
        },
        importFromTasksMarkdown: async (assignee: CLIAdapterId) => {
          expect(assignee).toBe("CODEX_CLI");
          const existingPhase = state.phases.find((phase) => phase.id === "import-phase-1");
          if (!existingPhase) {
            state.phases.push({
              id: "import-phase-1",
              name: "Phase 1: Foundation",
              branchName: "phase-1-foundation",
              status: "PLANNING",
              tasks: [
                {
                  id: "import-task-1",
                  title: "P1-001 Initialize project",
                  description: "Initialize project",
                  status: "DONE",
                  assignee: "UNASSIGNED",
                },
              ],
            });
          }

          return {
            state,
            importedPhaseCount: existingPhase ? 0 : 1,
            importedTaskCount: existingPhase ? 0 : 1,
            sourceFilePath: "C:/repo/TASKS.md",
            assignee: "CODEX_CLI",
          } as never;
        },
        runInternalWork: async (input: RunInternalWorkInput) => {
          expect(input.assignee).toBe("CODEX_CLI");
          expect(input.prompt).toBe("do internal work");
          return {
            assignee: "CODEX_CLI",
            command: "codex",
            args: ["--dangerously-bypass-approvals-and-sandbox", "do internal work"],
            stdout: "{\"ok\":true}",
            stderr: "",
            durationMs: 45,
          } as never;
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
        assign: (id, input) => {
          const found = agents.find((agent) => agent.id === id);
          if (!found) {
            throw new Error("Agent not found");
          }
          found.phaseId = input.taskId ? input.phaseId : undefined;
          found.taskId = input.taskId;
          return found;
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
      defaultInternalWorkAssignee: "CODEX_CLI",
      availableWorkerAssignees: ["CODEX_CLI", "CLAUDE_CLI", "GEMINI_CLI", "MOCK_CLI"],
      webLogFilePath: "C:/repo/.ixado/web.log",
      cliLogFilePath: "C:/repo/.ixado/cli.log",
    });

    const htmlResponse = await app.fetch(new Request("http://localhost/"));
    expect(htmlResponse.status).toBe(200);
    const htmlContent = await htmlResponse.text();
    expect(htmlContent).toContain("IxADO Control Center");
    expect(htmlContent).toContain("Phase Kanban");

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
        }),
      })
    );
    expect(createTaskResponse.status).toBe(201);

    const stateResponse = await app.fetch(new Request("http://localhost/api/state"));
    const statePayload = (await stateResponse.json()) as TestState;
    expect(statePayload.phases).toHaveLength(1);
    expect(statePayload.phases[0].tasks).toHaveLength(1);

    const setActiveResponse = await app.fetch(
      new Request("http://localhost/api/phases/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phaseId: "phase-1",
        }),
      })
    );
    expect(setActiveResponse.status).toBe(200);
    const activePayload = (await setActiveResponse.json()) as TestState;
    expect(activePayload.activePhaseId).toBe("phase-1");

    const startTaskResponse = await app.fetch(
      new Request("http://localhost/api/tasks/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phaseId: "phase-1",
          taskId: "task-1",
          assignee: "CODEX_CLI",
        }),
      })
    );
    expect(startTaskResponse.status).toBe(202);
    const startedState = (await startTaskResponse.json()) as TestState;
    expect(startedState.phases[0].tasks[0].status).toBe("IN_PROGRESS");
    expect(startedState.phases[0].tasks[0].assignee).toBe("CODEX_CLI");

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

    const assignAgentResponse = await app.fetch(
      new Request("http://localhost/api/agents/agent-1/assign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phaseId: "phase-1",
          taskId: "task-1",
        }),
      })
    );
    expect(assignAgentResponse.status).toBe(200);
    const assignPayload = await assignAgentResponse.json();
    expect(assignPayload.taskId).toBe("task-1");

    const restartAgentResponse = await app.fetch(
      new Request("http://localhost/api/agents/agent-1/restart", { method: "POST" })
    );
    expect(restartAgentResponse.status).toBe(200);

    const usageResponse = await app.fetch(new Request("http://localhost/api/usage"));
    const usagePayload = await usageResponse.json();
    expect(usagePayload.available).toBe(true);

    const importResponse = await app.fetch(
      new Request("http://localhost/api/import/tasks-md", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignee: "CODEX_CLI" }),
      })
    );
    expect(importResponse.status).toBe(200);
    const importPayload = await importResponse.json();
    expect(importPayload.importedPhaseCount).toBe(1);
    expect(importPayload.importedTaskCount).toBe(1);

    const internalRunResponse = await app.fetch(
      new Request("http://localhost/api/internal-work/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assignee: "CODEX_CLI",
          prompt: "do internal work",
        }),
      })
    );
    expect(internalRunResponse.status).toBe(200);
    const internalPayload = await internalRunResponse.json();
    expect(internalPayload.assignee).toBe("CODEX_CLI");
    expect(internalPayload.command).toBe("codex");
  });
});
