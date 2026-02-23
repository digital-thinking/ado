import { describe, expect, test } from "bun:test";
import { createWebApp } from "./app";
import type { CLIAdapterId, ProjectRecord } from "../types";

describe("P12-011: API-level tests", () => {
  const now = new Date().toISOString();

  const projectAlpha = {
    name: "alpha",
    rootDir: "/tmp/alpha",
    executionSettings: {
      autoMode: false,
      defaultAssignee: "CODEX_CLI" as const,
    },
  };

  const alphaState = {
    projectName: "alpha",
    rootDir: "/tmp/alpha",
    phases: [],
    createdAt: now,
    updatedAt: now,
  };

  const globalSettings = {
    projects: [projectAlpha],
    telegram: { enabled: false },
    internalWork: { assignee: "MOCK_CLI" as const },
    executionLoop: { autoMode: false },
    usage: { codexbarEnabled: true },
    agents: {
      MOCK_CLI: { enabled: true, timeoutMs: 1000 },
      CODEX_CLI: { enabled: true, timeoutMs: 1000 },
      CLAUDE_CLI: { enabled: true, timeoutMs: 1000 },
      GEMINI_CLI: { enabled: true, timeoutMs: 1000 },
    },
  };

  function makeApp(overrides: any = {}) {
    return createWebApp({
      defaultAgentCwd: "/tmp/alpha",
      control: {
        getState: async (name?: string) => {
          if (name === "alpha" || !name) return alphaState as any;
          throw new Error("Project not found");
        },
      } as any,
      agents: {
        list: () => overrides.agentsList || [],
        subscribe: (id: string, listener: any) => {
          if (overrides.onSubscribe) overrides.onSubscribe(id, listener);
          return () => {};
        },
      } as any,
      usage: { getLatest: async () => ({}) } as any,
      defaultInternalWorkAssignee: "MOCK_CLI",
      defaultAutoMode: false,
      availableWorkerAssignees: [
        "MOCK_CLI",
        "CODEX_CLI",
        "CLAUDE_CLI",
        "GEMINI_CLI",
      ],
      projectName: "alpha",
      getRuntimeConfig: async () => ({
        autoMode: false,
        defaultInternalWorkAssignee: "MOCK_CLI",
      }),
      updateRuntimeConfig: async (input: any) => input,
      getProjects: async () => [projectAlpha],
      getProjectState: async (name: string) => {
        if (name === "alpha") return alphaState as any;
        throw new Error("Project not found");
      },
      updateProjectSettings: async (name: string, patch: any) => {
        if (name !== "alpha") throw new Error("Project not found");
        return {
          ...projectAlpha,
          executionSettings: { ...projectAlpha.executionSettings, ...patch },
        };
      },
      getGlobalSettings: async () => globalSettings as any,
      updateGlobalSettings: async (patch: any) =>
        ({ ...globalSettings, ...patch }) as any,
      webLogFilePath: "/tmp/web.log",
      cliLogFilePath: "/tmp/cli.log",
    });
  }

  test("GET /api/projects", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/projects"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeArray();
    expect(body[0].name).toBe("alpha");
  });

  test("GET /api/projects/:name/state", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/api/projects/alpha/state"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectName).toBe("alpha");
  });

  test("PATCH /api/projects/:name/settings", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/api/projects/alpha/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoMode: true, defaultAssignee: "CLAUDE_CLI" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectRecord;
    expect(body.executionSettings?.autoMode).toBe(true);
    expect(body.executionSettings?.defaultAssignee).toBe("CLAUDE_CLI");
  });

  test("GET /api/settings", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/settings"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.internalWork.assignee).toBe("MOCK_CLI");
  });

  test("PATCH /api/settings", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internalWork: { assignee: "GEMINI_CLI" } }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.internalWork.assignee).toBe("GEMINI_CLI");
  });

  test("SSE endpoint /api/agents/:id/logs/stream format", async () => {
    let capturedListener: any;
    const app = makeApp({
      agentsList: [{ id: "agent-1", status: "RUNNING", outputTail: [] }],
      onSubscribe: (id: string, listener: any) => {
        capturedListener = listener;
      },
    });

    const res = await app.fetch(
      new Request("http://localhost/api/agents/agent-1/logs/stream"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextEncoder();

    // Trigger an event
    setTimeout(() => {
      capturedListener({
        type: "output",
        agentId: "agent-1",
        line: "hello sse",
      });
    }, 10);

    const { value } = await reader.read();
    const decoded = new TextDecoder().decode(value);

    // Verify SSE format: data: JSON\n\n
    expect(decoded).toMatch(/^data: \{.*\}\n\n$/);
    const data = JSON.parse(decoded.replace(/^data: /, "").trim());
    expect(data.type).toBe("output");
    expect(data.line).toBe("hello sse");
  });
});
