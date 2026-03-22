import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { startWebControlCenter } from "./server";

const defaultAgentSettings = {
  CODEX_CLI: {
    enabled: true,
    timeoutMs: 3_600_000,
    startupSilenceTimeoutMs: 60_000,
    bypassApprovalsAndSandbox: false,
    circuitBreaker: {
      failureThreshold: 3,
      cooldownMs: 300_000,
    },
  },
  CLAUDE_CLI: {
    enabled: true,
    timeoutMs: 3_600_000,
    startupSilenceTimeoutMs: 60_000,
    bypassApprovalsAndSandbox: false,
    circuitBreaker: {
      failureThreshold: 3,
      cooldownMs: 300_000,
    },
  },
  GEMINI_CLI: {
    enabled: true,
    timeoutMs: 3_600_000,
    startupSilenceTimeoutMs: 60_000,
    bypassApprovalsAndSandbox: false,
    circuitBreaker: {
      failureThreshold: 3,
      cooldownMs: 300_000,
    },
  },
  MOCK_CLI: {
    enabled: true,
    timeoutMs: 3_600_000,
    startupSilenceTimeoutMs: 60_000,
    bypassApprovalsAndSandbox: false,
    circuitBreaker: {
      failureThreshold: 3,
      cooldownMs: 300_000,
    },
  },
} as const;

describe("web server runtime", () => {
  let sandboxDir: string;
  let stateFilePath: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-web-server-"));
    stateFilePath = join(sandboxDir, "state.json");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("starts server and serves state api", async () => {
    const runtime = await startWebControlCenter({
      cwd: sandboxDir,
      stateFilePath,
      settingsFilePath: join(sandboxDir, "settings.json"),
      projectName: "IxADO",
      defaultInternalWorkAssignee: "MOCK_CLI",
      defaultAutoMode: false,
      agentSettings: defaultAgentSettings,
      webLogFilePath: join(sandboxDir, ".ixado", "web.log"),
      port: 0,
    });

    try {
      const response = await fetch(`${runtime.url}/api/state`);
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.projectName).toBe("IxADO");
      expect(Array.isArray(payload.phases)).toBe(true);
    } finally {
      runtime.stop();
    }
  });

  test("serves race judge settings controls and persists settings updates", async () => {
    const runtime = await startWebControlCenter({
      cwd: sandboxDir,
      stateFilePath,
      settingsFilePath: join(sandboxDir, "settings.json"),
      projectName: "IxADO",
      defaultInternalWorkAssignee: "MOCK_CLI",
      defaultAutoMode: false,
      agentSettings: defaultAgentSettings,
      webLogFilePath: join(sandboxDir, ".ixado", "web.log"),
      port: 0,
    });

    try {
      const html = await fetch(runtime.url).then((response) => response.text());
      expect(html).toContain('id="globalJudgeAdapter"');
      expect(html).toContain('id="globalRaceJudgePrompt"');

      const patchResponse = await fetch(`${runtime.url}/api/settings`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          executionLoop: {
            providerPriority: ["GEMINI_CLI", "CODEX_CLI"],
            judgeAdapter: "GEMINI_CLI",
            raceJudgePrompt: "Prefer candidates with smaller diffs.",
          },
        }),
      });
      expect(patchResponse.status).toBe(200);

      const settings = await fetch(`${runtime.url}/api/settings`).then(
        (response) => response.json(),
      );
      expect(settings.executionLoop.providerPriority).toEqual([
        "GEMINI_CLI",
        "CODEX_CLI",
      ]);
      expect(settings.executionLoop.judgeAdapter).toBe("GEMINI_CLI");
      expect(settings.executionLoop.raceJudgePrompt).toBe(
        "Prefer candidates with smaller diffs.",
      );
    } finally {
      runtime.stop();
    }
  });

  test("starts server even when Telegram is enabled in settings", async () => {
    const settingsFilePath = join(sandboxDir, "settings.json");
    await Bun.write(
      settingsFilePath,
      JSON.stringify(
        {
          telegram: {
            enabled: true,
            botToken: "test-token",
            ownerId: 123456,
          },
        },
        null,
        2,
      ),
    );

    const runtime = await startWebControlCenter({
      cwd: sandboxDir,
      stateFilePath,
      settingsFilePath,
      projectName: "IxADO",
      defaultInternalWorkAssignee: "MOCK_CLI",
      defaultAutoMode: false,
      agentSettings: defaultAgentSettings,
      webLogFilePath: join(sandboxDir, ".ixado", "web.log"),
      port: 0,
    });

    try {
      const response = await fetch(`${runtime.url}/api/state`);
      expect(response.status).toBe(200);
    } finally {
      runtime.stop();
    }
  });

  test("startup reconciles stale RUNNING agent when linked task is terminal", async () => {
    const originalGlobal = process.env.IXADO_GLOBAL_CONFIG_FILE;
    const globalConfigPath = join(sandboxDir, "global-config.json");
    process.env.IXADO_GLOBAL_CONFIG_FILE = globalConfigPath;

    const now = new Date().toISOString();
    const state = {
      projectName: "IxADO",
      rootDir: sandboxDir,
      phases: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Phase 1",
          branchName: "11111111-1111-4111-8111-111111111111",
          status: "CODING",
          tasks: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              title: "Terminal task",
              description: "desc",
              status: "DONE",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
          ],
        },
      ],
      activePhaseIds: ["11111111-1111-4111-8111-111111111111"],
      createdAt: now,
      updatedAt: now,
    };

    await Bun.write(stateFilePath, JSON.stringify(state, null, 2));
    const registryPath = join(sandboxDir, "agents.json");
    await Bun.write(
      registryPath,
      JSON.stringify(
        [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            name: "stale",
            command: "bun",
            args: [],
            cwd: sandboxDir,
            status: "RUNNING",
            taskId: "22222222-2222-4222-8222-222222222222",
            projectName: "IxADO",
            startedAt: now,
            outputTail: [],
          },
        ],
        null,
        2,
      ),
    );

    const runtime = await startWebControlCenter({
      cwd: sandboxDir,
      stateFilePath,
      settingsFilePath: join(sandboxDir, "settings.json"),
      projectName: "IxADO",
      defaultInternalWorkAssignee: "MOCK_CLI",
      defaultAutoMode: false,
      agentSettings: defaultAgentSettings,
      webLogFilePath: join(sandboxDir, ".ixado", "web.log"),
      port: 0,
    });

    try {
      const registry = JSON.parse(
        await Bun.file(registryPath).text(),
      ) as Array<{
        status: string;
        stoppedAt?: string;
      }>;
      expect(registry).toHaveLength(1);
      expect(registry[0]?.status).toBe("STOPPED");
      expect(registry[0]?.stoppedAt).toBeString();
    } finally {
      runtime.stop();
      if (originalGlobal === undefined) {
        delete process.env.IXADO_GLOBAL_CONFIG_FILE;
      } else {
        process.env.IXADO_GLOBAL_CONFIG_FILE = originalGlobal;
      }
    }
  });
});
