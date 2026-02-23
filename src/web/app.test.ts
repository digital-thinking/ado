import { describe, expect, test } from "bun:test";

import { createWebApp } from "./app";
import type { AgentView } from "./agent-supervisor";
import type {
  CreatePhaseInput,
  CreateTaskInput,
  RunInternalWorkInput,
  SetActivePhaseInput,
  StartTaskInput,
  UpdateTaskInput,
} from "./control-center-service";
import type { CLIAdapterId, ProjectRecord } from "../types";

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
    const runtimeConfig = {
      defaultInternalWorkAssignee: "CODEX_CLI" as CLIAdapterId,
      autoMode: false,
    };

    const app = createWebApp({
      defaultAgentCwd: "C:/repo",
      control: {
        getState: async (_name?: string) => state as never,
        createPhase: async (
          input: CreatePhaseInput & { projectName?: string },
        ) => {
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
        createTask: async (
          input: CreateTaskInput & { projectName?: string },
        ) => {
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
        updateTask: async (
          input: UpdateTaskInput & { projectName?: string },
        ) => {
          const phase = state.phases.find((item) => item.id === input.phaseId);
          if (!phase) {
            throw new Error("Phase not found");
          }
          const task = phase.tasks.find((item) => item.id === input.taskId);
          if (!task) {
            throw new Error("Task not found");
          }
          task.title = input.title;
          task.description = input.description;
          task.dependencies = input.dependencies;
          return state as never;
        },
        setActivePhase: async (
          input: SetActivePhaseInput & { projectName?: string },
        ) => {
          const phase = state.phases.find((item) => item.id === input.phaseId);
          if (!phase) {
            throw new Error("Phase not found");
          }

          state.activePhaseId = phase.id;
          return state as never;
        },
        startTask: async (input: StartTaskInput & { projectName?: string }) => {
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
        resetTaskToTodo: async (input: {
          phaseId: string;
          taskId: string;
          projectName?: string;
        }) => {
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
        failTaskIfInProgress: async (input: {
          taskId: string;
          reason: string;
          projectName?: string;
        }) => {
          for (const phase of state.phases) {
            const task = phase.tasks.find((item) => item.id === input.taskId);
            if (task && task.status === "IN_PROGRESS") {
              task.status = "FAILED";
              task.errorLogs = input.reason;
            }
          }
          return state as never;
        },
        recordRecoveryAttempt: async () => state as never,
        importFromTasksMarkdown: async (
          assignee: CLIAdapterId,
          _name?: string,
        ) => {
          expect(assignee).toBe("CODEX_CLI");
          const existingPhase = state.phases.find(
            (phase) => phase.id === "import-phase-1",
          );
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
            args: [
              "--dangerously-bypass-approvals-and-sandbox",
              "do internal work",
            ],
            stdout: '{"ok":true}',
            stderr: "",
            durationMs: 45,
          } as never;
        },
      } as never,
      agents: {
        list: () => agents,
        start: (input) => {
          expect(input.projectName).toBe("IxADO");
          expect(input.approvedAdapterSpawn).toBe(true);
          const agent: AgentView = {
            id: "agent-1",
            name: input.name,
            command: input.command,
            args: input.args ?? [],
            cwd: input.cwd,
            taskId: input.taskId,
            phaseId: input.phaseId,
            projectName: input.projectName,
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
        subscribe: () => () => {},
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
      defaultAutoMode: false,
      availableWorkerAssignees: [
        "CODEX_CLI",
        "CLAUDE_CLI",
        "GEMINI_CLI",
        "MOCK_CLI",
      ],
      projectName: "IxADO",
      getRuntimeConfig: async () => runtimeConfig,
      updateRuntimeConfig: async (input) => {
        if (input.defaultInternalWorkAssignee) {
          runtimeConfig.defaultInternalWorkAssignee =
            input.defaultInternalWorkAssignee;
        }
        if (typeof input.autoMode === "boolean") {
          runtimeConfig.autoMode = input.autoMode;
        }
        return runtimeConfig;
      },
      getProjects: async () => [],
      getProjectState: async (_name) => {
        throw new Error("not configured");
      },
      updateProjectSettings: async (_name, _patch) => {
        throw new Error("not configured");
      },
      getGlobalSettings: async () => ({}) as never,
      updateGlobalSettings: async (_patch) => ({}) as never,
      webLogFilePath: "C:/repo/.ixado/web.log",
      cliLogFilePath: "C:/repo/.ixado/cli.log",
    });

    const htmlResponse = await app.fetch(new Request("http://localhost/"));
    expect(htmlResponse.status).toBe(200);
    const htmlContent = await htmlResponse.text();
    expect(htmlContent).toContain("IxADO Control Center");
    expect(htmlContent).toContain("Phase Kanban");
    expect(htmlContent).toContain("task-edit-toggle-button");

    const createPhaseResponse = await app.fetch(
      new Request("http://localhost/api/phases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Phase 6",
          branchName: "phase-6-web-interface",
        }),
      }),
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
      }),
    );
    expect(createTaskResponse.status).toBe(201);

    const stateResponse = await app.fetch(
      new Request("http://localhost/api/state"),
    );
    const statePayload = (await stateResponse.json()) as TestState;
    expect(statePayload.phases).toHaveLength(1);
    expect(statePayload.phases[0].tasks).toHaveLength(1);

    const updateTaskResponse = await app.fetch(
      new Request("http://localhost/api/tasks/task-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phaseId: "phase-1",
          title: "Build page v2",
          description: "Implement dashboard and editing",
          dependencies: [],
        }),
      }),
    );
    expect(updateTaskResponse.status).toBe(200);
    const updatedState = (await updateTaskResponse.json()) as TestState;
    expect(updatedState.phases[0].tasks[0].title).toBe("Build page v2");
    expect(updatedState.phases[0].tasks[0].description).toBe(
      "Implement dashboard and editing",
    );

    const runtimeConfigResponse = await app.fetch(
      new Request("http://localhost/api/runtime-config"),
    );
    expect(runtimeConfigResponse.status).toBe(200);
    const runtimeConfigPayload = await runtimeConfigResponse.json();
    expect(runtimeConfigPayload.defaultInternalWorkAssignee).toBe("CODEX_CLI");
    expect(runtimeConfigPayload.autoMode).toBe(false);

    const runtimeConfigUpdateResponse = await app.fetch(
      new Request("http://localhost/api/runtime-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          defaultInternalWorkAssignee: "GEMINI_CLI",
          autoMode: true,
        }),
      }),
    );
    expect(runtimeConfigUpdateResponse.status).toBe(200);
    const runtimeConfigUpdatePayload = await runtimeConfigUpdateResponse.json();
    expect(runtimeConfigUpdatePayload.defaultInternalWorkAssignee).toBe(
      "GEMINI_CLI",
    );
    expect(runtimeConfigUpdatePayload.autoMode).toBe(true);

    const setActiveResponse = await app.fetch(
      new Request("http://localhost/api/phases/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phaseId: "phase-1",
        }),
      }),
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
      }),
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
      }),
    );
    expect(startAgentResponse.status).toBe(201);

    const killAgentResponse = await app.fetch(
      new Request("http://localhost/api/agents/agent-1/kill", {
        method: "POST",
      }),
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
      }),
    );
    expect(assignAgentResponse.status).toBe(200);
    const assignPayload = await assignAgentResponse.json();
    expect(assignPayload.taskId).toBe("task-1");

    const restartAgentResponse = await app.fetch(
      new Request("http://localhost/api/agents/agent-1/restart", {
        method: "POST",
      }),
    );
    expect(restartAgentResponse.status).toBe(200);

    const usageResponse = await app.fetch(
      new Request("http://localhost/api/usage"),
    );
    const usagePayload = await usageResponse.json();
    expect(usagePayload.available).toBe(true);

    const importResponse = await app.fetch(
      new Request("http://localhost/api/import/tasks-md", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignee: "CODEX_CLI" }),
      }),
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
      }),
    );
    expect(internalRunResponse.status).toBe(200);
    const internalPayload = await internalRunResponse.json();
    expect(internalPayload.assignee).toBe("CODEX_CLI");
    expect(internalPayload.command).toBe("codex");
  });
});

describe("multi-project api", () => {
  const now = new Date().toISOString();

  const projectAlpha = {
    name: "alpha",
    rootDir: "/tmp/alpha",
    executionSettings: {
      autoMode: false,
      defaultAssignee: "CODEX_CLI" as const,
    },
  };
  const projectBeta = {
    name: "beta",
    rootDir: "/tmp/beta",
  };

  const alphaState = {
    projectName: "alpha",
    rootDir: "/tmp/alpha",
    phases: [],
    createdAt: now,
    updatedAt: now,
  };

  function makeApp(
    overrides: {
      getProjects?: () => Promise<(typeof projectAlpha)[]>;
      getProjectState?: (name: string) => Promise<typeof alphaState>;
      updateProjectSettings?: (
        name: string,
        patch: { autoMode?: boolean; defaultAssignee?: CLIAdapterId },
      ) => Promise<typeof projectAlpha>;
      getGlobalSettings?: () => Promise<any>;
      updateGlobalSettings?: (patch: any) => Promise<any>;
    } = {},
  ) {
    const runtimeConfig = {
      defaultInternalWorkAssignee: "CODEX_CLI" as CLIAdapterId,
      autoMode: false,
    };
    const globalSettings = {
      projects: [projectAlpha, projectBeta],
      internalWork: { assignee: "MOCK_CLI" },
      agents: {
        MOCK_CLI: { enabled: true, timeoutMs: 1000 },
      },
    };

    return createWebApp({
      defaultAgentCwd: "/tmp/alpha",
      control: {
        getState: async (_name?: string) =>
          ({
            projectName: "alpha",
            rootDir: "/tmp/alpha",
            phases: [],
            createdAt: now,
            updatedAt: now,
          }) as never,
        ensureInitialized: async (_name: string, _rootDir: string) =>
          ({}) as never,
        createPhase: async (_input: unknown) => ({}) as never,
        createTask: async (_input: unknown) => ({}) as never,
        updateTask: async (_input: unknown) => ({}) as never,
        setActivePhase: async (_input: unknown) => ({}) as never,
        startTask: async (_input: unknown) => ({}) as never,
        resetTaskToTodo: async (_input: unknown) => ({}) as never,
        failTaskIfInProgress: async (_input: unknown) => ({}) as never,
        recordRecoveryAttempt: async () => ({}) as never,
        importFromTasksMarkdown: async (_assignee: unknown, _name?: string) =>
          ({}) as never,
        runInternalWork: async (_input: unknown) => ({}) as never,
      } as never,
      agents: {
        list: () => [],
        start: () => ({}) as never,
        assign: () => ({}) as never,
        kill: () => ({}) as never,
        restart: () => ({}) as never,
        subscribe: () => () => {},
      },
      usage: { getLatest: async () => ({}) } as never,
      defaultInternalWorkAssignee: "CODEX_CLI",
      defaultAutoMode: false,
      availableWorkerAssignees: [
        "CODEX_CLI",
        "CLAUDE_CLI",
        "GEMINI_CLI",
        "MOCK_CLI",
      ],
      projectName: "IxADO",
      getRuntimeConfig: async () => runtimeConfig,
      updateRuntimeConfig: async () => runtimeConfig,
      getProjects:
        overrides.getProjects ??
        (async () => [projectAlpha, projectBeta] as never),
      getProjectState:
        overrides.getProjectState ??
        (async (name) => {
          if (name === "alpha") return alphaState as never;
          throw new Error(`Project not found: ${name}`);
        }),
      updateProjectSettings:
        overrides.updateProjectSettings ??
        (async (name, patch) => {
          if (name !== "alpha") throw new Error(`Project not found: ${name}`);
          return {
            ...projectAlpha,
            executionSettings: { ...projectAlpha.executionSettings, ...patch },
          } as never;
        }),
      getGlobalSettings:
        overrides.getGlobalSettings ?? (async () => globalSettings as any),
      updateGlobalSettings:
        overrides.updateGlobalSettings ??
        (async (patch) => ({ ...globalSettings, ...patch }) as any),
      webLogFilePath: "/tmp/alpha/.ixado/web.log",
      cliLogFilePath: "/tmp/alpha/.ixado/cli.log",
    });
  }

  test("GET /api/settings returns global settings", async () => {
    const app = makeApp();
    const response = await app.fetch(
      new Request("http://localhost/api/settings"),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.internalWork.assignee).toBe("MOCK_CLI");
  });

  test("PATCH /api/settings updates global settings", async () => {
    let capturedPatch: any = null;
    const app = makeApp({
      updateGlobalSettings: async (patch) => {
        capturedPatch = patch;
        return {
          internalWork: { assignee: "CLAUDE_CLI" },
        };
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          internalWork: { assignee: "CLAUDE_CLI" },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.internalWork.assignee).toBe("CLAUDE_CLI");
    expect(capturedPatch.internalWork.assignee).toBe("CLAUDE_CLI");
  });

  test("GET /api/projects returns all registered projects", async () => {
    const app = makeApp();
    const response = await app.fetch(
      new Request("http://localhost/api/projects"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as (typeof projectAlpha)[];
    expect(payload).toHaveLength(2);
    expect(payload[0].name).toBe("alpha");
    expect(payload[0].rootDir).toBe("/tmp/alpha");
    expect(payload[0].executionSettings?.autoMode).toBe(false);
    expect(payload[1].name).toBe("beta");
  });

  test("GET /api/projects/:name/state returns ProjectState for known project", async () => {
    const app = makeApp();
    const response = await app.fetch(
      new Request("http://localhost/api/projects/alpha/state"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as typeof alphaState;
    expect(payload.projectName).toBe("alpha");
    expect(payload.rootDir).toBe("/tmp/alpha");
    expect(Array.isArray(payload.phases)).toBe(true);
  });

  test("GET /api/projects/:name/state returns 400 for unknown project", async () => {
    const app = makeApp();
    const response = await app.fetch(
      new Request("http://localhost/api/projects/unknown/state"),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("Project not found");
  });

  test("PATCH /api/projects/:name/settings updates executionSettings", async () => {
    const capturedPatches: Array<{
      autoMode?: boolean;
      defaultAssignee?: CLIAdapterId;
    }> = [];
    const app = makeApp({
      updateProjectSettings: async (name, patch) => {
        expect(name).toBe("alpha");
        capturedPatches.push(patch);
        return {
          ...projectAlpha,
          executionSettings: { autoMode: true, defaultAssignee: "CLAUDE_CLI" },
        } as never;
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/projects/alpha/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoMode: true, defaultAssignee: "CLAUDE_CLI" }),
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as ProjectRecord;
    expect(payload.name).toBe("alpha");
    expect(payload.executionSettings?.autoMode).toBe(true);
    expect(payload.executionSettings?.defaultAssignee).toBe("CLAUDE_CLI");
    expect(capturedPatches).toHaveLength(1);
    expect(capturedPatches[0]?.autoMode).toBe(true);
    expect(capturedPatches[0]?.defaultAssignee).toBe("CLAUDE_CLI");
  });

  test("PATCH /api/projects/:name/settings returns 400 for unknown project", async () => {
    const app = makeApp();
    const response = await app.fetch(
      new Request("http://localhost/api/projects/unknown/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoMode: true }),
      }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("Project not found");
  });

  test("GET /api/agents/:id/logs/stream returns SSE stream", async () => {
    let capturedListener: any = null;
    const app = createWebApp({
      defaultAgentCwd: "/tmp",
      control: {} as any,
      usage: {} as any,
      defaultInternalWorkAssignee: "MOCK_CLI",
      defaultAutoMode: false,
      availableWorkerAssignees: ["MOCK_CLI"],
      projectName: "test",
      getRuntimeConfig: async () => ({}) as any,
      updateRuntimeConfig: async () => ({}) as any,
      getProjects: async () => [],
      getProjectState: async () => ({}) as any,
      updateProjectSettings: async () => ({}) as any,
      getGlobalSettings: async () => ({}) as any,
      updateGlobalSettings: async () => ({}) as any,
      webLogFilePath: "/tmp/web.log",
      cliLogFilePath: "/tmp/cli.log",
      agents: {
        list: () => [
          {
            id: "agent-1",
            status: "RUNNING",
            outputTail: ["line 1"],
          } as any,
        ],
        start: () => ({}) as any,
        assign: () => ({}) as any,
        kill: () => ({}) as any,
        restart: () => ({}) as any,
        subscribe: (id, listener) => {
          expect(id).toBe("agent-1");
          capturedListener = listener;
          return () => {};
        },
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/agents/agent-1/logs/stream"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();

    // Initial backlog
    const chunk1 = await reader?.read();
    expect(decoder.decode(chunk1?.value)).toContain(
      'data: {"type":"output","agentId":"agent-1","line":"line 1"}',
    );

    // New output
    setTimeout(() => {
      capturedListener({
        type: "output",
        agentId: "agent-1",
        line: "line 2",
      });
    }, 10);

    const chunk2 = await reader?.read();
    expect(decoder.decode(chunk2?.value)).toContain(
      'data: {"type":"output","agentId":"agent-1","line":"line 2"}',
    );

    // Terminal status
    setTimeout(() => {
      capturedListener({
        type: "status",
        agentId: "agent-1",
        status: "STOPPED",
      });
    }, 10);

    const chunk3 = await reader?.read();
    expect(decoder.decode(chunk3?.value)).toContain(
      'data: {"type":"status","agentId":"agent-1","status":"STOPPED"}',
    );

    const chunk4 = await reader?.read();
    expect(chunk4?.done).toBe(true);
  });
});

describe("project tabs frontend (P12-006)", () => {
  async function getHtml(): Promise<string> {
    const app = createWebApp({
      defaultAgentCwd: "/tmp",
      control: {
        getState: async () => ({}) as never,
        createPhase: async () => ({}) as never,
        createTask: async () => ({}) as never,
        updateTask: async () => ({}) as never,
        setActivePhase: async () => ({}) as never,
        startTask: async () => ({}) as never,
        resetTaskToTodo: async () => ({}) as never,
        failTaskIfInProgress: async () => ({}) as never,
        recordRecoveryAttempt: async () => ({}) as never,
        importFromTasksMarkdown: async () => ({}) as never,
        runInternalWork: async () => ({}) as never,
      } as never,
      agents: {
        list: () => [],
        start: () => ({}) as never,
        assign: () => ({}) as never,
        kill: () => ({}) as never,
        restart: () => ({}) as never,
        subscribe: () => () => {},
      },
      usage: { getLatest: async () => ({ available: false }) } as never,
      defaultInternalWorkAssignee: "MOCK_CLI",
      defaultAutoMode: false,
      availableWorkerAssignees: ["MOCK_CLI"],
      projectName: "TestProject",
      getRuntimeConfig: async () => ({
        defaultInternalWorkAssignee: "MOCK_CLI" as CLIAdapterId,
        autoMode: false,
      }),
      updateRuntimeConfig: async () => ({
        defaultInternalWorkAssignee: "MOCK_CLI" as CLIAdapterId,
        autoMode: false,
      }),
      getProjects: async () => [],
      getProjectState: async () => ({}) as never,
      updateProjectSettings: async () => ({}) as never,
      getGlobalSettings: async () => ({}) as never,
      updateGlobalSettings: async () => ({}) as never,
      webLogFilePath: "/tmp/web.log",
      cliLogFilePath: "/tmp/cli.log",
    });
    const response = await app.fetch(new Request("http://localhost/"));
    return response.text();
  }

  test("HTML contains tab strip container element", async () => {
    const html = await getHtml();
    expect(html).toContain('id="tabStrip"');
  });

  test("HTML includes renderTabs and switchProject functions for lazy-loading", async () => {
    const html = await getHtml();
    expect(html).toContain("renderTabs");
    expect(html).toContain("switchProject");
  });

  test("HTML includes + affordance with ixado init guidance", async () => {
    const html = await getHtml();
    expect(html).toContain("ixado init");
  });

  test("HTML polls active tab state every 5 seconds", async () => {
    const html = await getHtml();
    expect(html).toContain("5000");
    expect(html).toContain("refreshActiveProject");
  });

  test("HTML includes per-tab lazy-load state cache", async () => {
    const html = await getHtml();
    expect(html).toContain("projectStateCache");
  });

  test("HTML shows kanban board as project tab body", async () => {
    const html = await getHtml();
    expect(html).toContain('id="kanbanBoard"');
    expect(html).toContain('id="projectContent"');
  });

  test("HTML contains settings tab alongside project tabs", async () => {
    const html = await getHtml();
    expect(html).toContain("tab-settings");
    expect(html).toContain('id="settingsContent"');
  });
});

describe("agent top bar frontend (P12-007)", () => {
  async function getHtml(): Promise<string> {
    const app = createWebApp({
      defaultAgentCwd: "/tmp",
      control: {
        getState: async () => ({}) as never,
        createPhase: async () => ({}) as never,
        createTask: async () => ({}) as never,
        updateTask: async () => ({}) as never,
        setActivePhase: async () => ({}) as never,
        startTask: async () => ({}) as never,
        resetTaskToTodo: async () => ({}) as never,
        failTaskIfInProgress: async () => ({}) as never,
        recordRecoveryAttempt: async () => ({}) as never,
        importFromTasksMarkdown: async () => ({}) as never,
        runInternalWork: async () => ({}) as never,
      } as never,
      agents: {
        list: () => [],
        start: () => ({}) as never,
        assign: () => ({}) as never,
        kill: () => ({}) as never,
        restart: () => ({}) as never,
        subscribe: () => () => {},
      },
      usage: { getLatest: async () => ({ available: false }) } as never,
      defaultInternalWorkAssignee: "MOCK_CLI",
      defaultAutoMode: false,
      availableWorkerAssignees: ["MOCK_CLI"],
      projectName: "TestProject",
      getRuntimeConfig: async () => ({
        defaultInternalWorkAssignee: "MOCK_CLI" as CLIAdapterId,
        autoMode: false,
      }),
      updateRuntimeConfig: async () => ({
        defaultInternalWorkAssignee: "MOCK_CLI" as CLIAdapterId,
        autoMode: false,
      }),
      getProjects: async () => [],
      getProjectState: async () => ({}) as never,
      updateProjectSettings: async () => ({}) as never,
      getGlobalSettings: async () => ({}) as never,
      updateGlobalSettings: async () => ({}) as never,
      webLogFilePath: "/tmp/web.log",
      cliLogFilePath: "/tmp/cli.log",
    });
    const response = await app.fetch(new Request("http://localhost/"));
    return response.text();
  }

  test("HTML contains sticky agent top bar container", async () => {
    const html = await getHtml();
    expect(html).toContain('id="agentTopBar"');
    expect(html).toContain("sticky-top-bar");
  });

  test("HTML contains agent top bar table with required columns", async () => {
    const html = await getHtml();
    expect(html).toContain('id="agentTopTable"');
    expect(html).toContain("<th>Project</th>");
    expect(html).toContain("<th>Agent</th>");
    expect(html).toContain("<th>Task</th>");
    expect(html).toContain("<th>Status</th>");
    expect(html).toContain("<th>PID</th>");
    expect(html).toContain("<th>Actions</th>");
  });

  test("HTML includes logic to populate top bar table", async () => {
    const html = await getHtml();
    expect(html).toContain("agentTopTableBody");
    expect(html).toContain("agentTopTableBody.innerHTML");
  });

  test("HTML includes event delegation for top bar table actions", async () => {
    const html = await getHtml();
    expect(html).toContain(
      'agentTopTableBody.addEventListener("click", handleAgentAction)',
    );
  });

  test("HTML includes recovery indicators for tasks and agent status", async () => {
    const html = await getHtml();
    expect(html).toContain("! recovery");
    expect(html).toContain("agent.recoveryAttempted");
    expect(html).toContain("agent.recoveryReasoning");
  });
});

describe("SSE log viewer frontend (P12-010)", () => {
  async function getHtml(): Promise<string> {
    const app = createWebApp({
      defaultAgentCwd: "/tmp",
      control: {} as any,
      agents: {
        list: () => [],
        subscribe: () => () => {},
      } as any,
      usage: { getLatest: async () => ({ available: false }) } as any,
      defaultInternalWorkAssignee: "MOCK_CLI",
      defaultAutoMode: false,
      availableWorkerAssignees: ["MOCK_CLI"],
      projectName: "TestProject",
      getRuntimeConfig: async () => ({}) as any,
      updateRuntimeConfig: async () => ({}) as any,
      getProjects: async () => [],
      getProjectState: async () => ({}) as any,
      updateProjectSettings: async () => ({}) as any,
      getGlobalSettings: async () => ({}) as any,
      updateGlobalSettings: async () => ({}) as any,
      webLogFilePath: "/tmp/web.log",
      cliLogFilePath: "/tmp/cli.log",
    });
    const response = await app.fetch(new Request("http://localhost/"));
    return response.text();
  }

  test("HTML contains log overlay and modal elements", async () => {
    const html = await getHtml();
    expect(html).toContain('id="logOverlay"');
    expect(html).toContain('id="logModalTitle"');
    expect(html).toContain('id="logModalBody"');
    expect(html).toContain('id="logModalStatus"');
    expect(html).toContain('id="closeLogModal"');
  });

  test("HTML includes CSS for overlay and modal", async () => {
    const html = await getHtml();
    expect(html).toContain(".overlay");
    expect(html).toContain(".modal");
    expect(html).toContain(".modal-header");
    expect(html).toContain(".modal-body");
  });

  test("HTML includes logic to open SSE stream and handle messages", async () => {
    const html = await getHtml();
    expect(html).toContain("new EventSource");
    expect(html).toContain("source.onmessage");
    expect(html).toContain('data.type === "output"');
    expect(html).toContain('data.type === "status"');
    expect(html).toContain(
      "logModalBody.scrollTop = logModalBody.scrollHeight",
    );
  });

  test("HTML includes logic to close stream and overlay", async () => {
    const html = await getHtml();
    expect(html).toContain("function closeLogs");
    expect(html).toContain("currentEventSource.close()");
    expect(html).toContain('logOverlay.classList.add("hidden")');
  });
});

describe("phase14 recovery surfacing", () => {
  test("GET /api/agents includes recovery enrichment", async () => {
    const app = createWebApp({
      defaultAgentCwd: "/tmp",
      control: {
        failTaskIfInProgress: async () => ({}) as never,
        recordRecoveryAttempt: async () => ({}) as never,
      } as never,
      agents: {
        list: () =>
          [
            {
              id: "agent-1",
              name: "worker",
              command: "mock",
              args: [],
              cwd: "/tmp/alpha",
              phaseId: "11111111-1111-4111-8111-111111111111",
              taskId: "22222222-2222-4222-8222-222222222222",
              projectName: "alpha",
              status: "RUNNING",
              outputTail: [],
              startedAt: "2026-02-23T00:00:00.000Z",
            },
          ] as any,
        start: () => ({}) as any,
        assign: () => ({}) as any,
        kill: () => ({}) as any,
        restart: () => ({}) as any,
        subscribe: () => () => {},
      },
      usage: { getLatest: async () => ({ available: false }) } as never,
      defaultInternalWorkAssignee: "MOCK_CLI",
      defaultAutoMode: false,
      availableWorkerAssignees: ["MOCK_CLI"],
      projectName: "alpha",
      getRuntimeConfig: async () => ({}) as never,
      updateRuntimeConfig: async () => ({}) as never,
      getProjects: async () => [{ name: "alpha", rootDir: "/tmp/alpha" }],
      getProjectState: async () =>
        ({
          projectName: "alpha",
          rootDir: "/tmp/alpha",
          phases: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Phase",
              branchName: "phase",
              status: "CODING",
              recoveryAttempts: [],
              tasks: [
                {
                  id: "22222222-2222-4222-8222-222222222222",
                  title: "Task",
                  description: "desc",
                  status: "FAILED",
                  assignee: "MOCK_CLI",
                  dependencies: [],
                  recoveryAttempts: [
                    {
                      id: "33333333-3333-4333-8333-333333333333",
                      occurredAt: "2026-02-23T00:00:00.000Z",
                      attemptNumber: 1,
                      exception: {
                        category: "AGENT_FAILURE",
                        message: "worker failed",
                      },
                      result: {
                        status: "fixed",
                        reasoning: "retried successfully",
                      },
                    },
                  ],
                },
              ],
            },
          ],
          activePhaseId: "11111111-1111-4111-8111-111111111111",
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        }) as any,
      updateProjectSettings: async () => ({}) as never,
      getGlobalSettings: async () => ({}) as never,
      updateGlobalSettings: async () => ({}) as never,
      webLogFilePath: "/tmp/web.log",
      cliLogFilePath: "/tmp/cli.log",
    });

    const response = await app.fetch(
      new Request("http://localhost/api/agents"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Array<{
      recoveryAttempted?: boolean;
      recoveryStatus?: string;
      recoveryReasoning?: string;
    }>;
    expect(payload[0]?.recoveryAttempted).toBe(true);
    expect(payload[0]?.recoveryStatus).toBe("fixed");
    expect(payload[0]?.recoveryReasoning).toBe("retried successfully");
  });
});
