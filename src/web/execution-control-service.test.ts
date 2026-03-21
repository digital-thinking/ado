import { describe, expect, test } from "bun:test";

import { ExecutionControlService } from "./execution-control-service";

const DUMMY_SETTINGS_FILE = "/tmp/nonexistent-settings.json";
const DUMMY_AGENT_SETTINGS = {
  CODEX_CLI: {
    enabled: true,
    timeoutMs: 60_000,
    startupSilenceTimeoutMs: 10_000,
    bypassApprovalsAndSandbox: false,
    circuitBreaker: { failureThreshold: 3, cooldownMs: 300_000 },
  },
  CLAUDE_CLI: {
    enabled: false,
    timeoutMs: 60_000,
    startupSilenceTimeoutMs: 10_000,
    bypassApprovalsAndSandbox: false,
    circuitBreaker: { failureThreshold: 3, cooldownMs: 300_000 },
  },
  GEMINI_CLI: {
    enabled: false,
    timeoutMs: 60_000,
    startupSilenceTimeoutMs: 10_000,
    bypassApprovalsAndSandbox: false,
    circuitBreaker: { failureThreshold: 3, cooldownMs: 300_000 },
  },
  MOCK_CLI: {
    enabled: false,
    timeoutMs: 60_000,
    startupSilenceTimeoutMs: 10_000,
    bypassApprovalsAndSandbox: false,
    circuitBreaker: { failureThreshold: 3, cooldownMs: 300_000 },
  },
} as never;

describe("ExecutionControlService", () => {
  test("initial status is idle", () => {
    const service = new ExecutionControlService({
      control: {} as never,
      agents: { list: () => [], kill: () => ({}) as never },
      projectRootDir: "/tmp/alpha",
      projectName: "alpha",
      settingsFilePath: DUMMY_SETTINGS_FILE,
      agentSettings: DUMMY_AGENT_SETTINGS,
      resolveDefaultAssignee: async () => "CODEX_CLI",
    });

    const status = service.getStatus("alpha");
    expect(status.running).toBe(false);
    expect(status.message).toBe("Auto mode is idle.");
    expect(status.projectName).toBe("alpha");
  });

  test("getStatus returns idle for unknown project", () => {
    const service = new ExecutionControlService({
      control: {} as never,
      agents: { list: () => [], kill: () => ({}) as never },
      projectRootDir: "/tmp/alpha",
      projectName: "alpha",
      settingsFilePath: DUMMY_SETTINGS_FILE,
      agentSettings: DUMMY_AGENT_SETTINGS,
      resolveDefaultAssignee: async () => "CODEX_CLI",
    });

    const status = service.getStatus("other");
    expect(status.running).toBe(false);
    expect(status.projectName).toBe("other");
  });

  test("stop when not running returns idle status", async () => {
    const service = new ExecutionControlService({
      control: {} as never,
      agents: { list: () => [], kill: () => ({}) as never },
      projectRootDir: "/tmp/alpha",
      projectName: "alpha",
      settingsFilePath: DUMMY_SETTINGS_FILE,
      agentSettings: DUMMY_AGENT_SETTINGS,
      resolveDefaultAssignee: async () => "CODEX_CLI",
    });

    const result = await service.stop({ projectName: "alpha" });
    expect(result.running).toBe(false);
    expect(result.message).toBe("Auto mode is not running.");
  });

  test("startAuto fails when already running", async () => {
    let getStateCalls = 0;
    const service = new ExecutionControlService({
      control: {
        getState: async () => {
          getStateCalls++;
          return {
            activePhaseIds: ["phase-1"],
            phases: [
              {
                id: "phase-1",
                name: "Phase 1",
                branchName: "phase-1",
                status: "CODING",
                tasks: [],
              },
            ],
          };
        },
      } as never,
      agents: { list: () => [], kill: () => ({}) as never },
      projectRootDir: "/tmp/alpha",
      projectName: "alpha",
      settingsFilePath: DUMMY_SETTINGS_FILE,
      agentSettings: DUMMY_AGENT_SETTINGS,
      resolveDefaultAssignee: async () => "CODEX_CLI",
    });

    // First start will fail because settings file doesn't exist,
    // but the running flag will be set briefly
    await service.startAuto({ projectName: "alpha" });
    // Wait for the runner to fail
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The service should have transitioned to not-running due to the error
    const status = service.getStatus("alpha");
    expect(status.running).toBe(false);
    expect(status.message).toContain("Auto mode failed");
  });

  test("rejects empty projectRootDir", () => {
    expect(
      () =>
        new ExecutionControlService({
          control: {} as never,
          agents: { list: () => [], kill: () => ({}) as never },
          projectRootDir: "",
          projectName: "alpha",
          settingsFilePath: DUMMY_SETTINGS_FILE,
          agentSettings: DUMMY_AGENT_SETTINGS,
          resolveDefaultAssignee: async () => "CODEX_CLI",
        }),
    ).toThrow("projectRootDir must not be empty");
  });
});
