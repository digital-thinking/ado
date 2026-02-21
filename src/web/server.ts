import { CodexUsageTracker } from "../adapters";
import { ProcessManager } from "../process";
import { StateEngine } from "../state";
import { AgentSupervisor } from "./agent-supervisor";
import { createWebApp } from "./app";
import { ControlCenterService } from "./control-center-service";
import { UsageService } from "./usage-service";

export type StartWebControlCenterInput = {
  cwd: string;
  stateFilePath: string;
  projectName: string;
  port?: number;
};

export type WebControlCenterRuntime = {
  port: number;
  url: string;
  stop: () => void;
};

export async function startWebControlCenter(
  input: StartWebControlCenterInput
): Promise<WebControlCenterRuntime> {
  if (!input.cwd.trim()) {
    throw new Error("cwd must not be empty.");
  }
  if (!input.stateFilePath.trim()) {
    throw new Error("stateFilePath must not be empty.");
  }
  if (!input.projectName.trim()) {
    throw new Error("projectName must not be empty.");
  }

  const stateEngine = new StateEngine(input.stateFilePath);
  const control = new ControlCenterService(stateEngine);
  await control.ensureInitialized(input.projectName, input.cwd);

  const processManager = new ProcessManager();
  const usage = new UsageService(new CodexUsageTracker(processManager), input.cwd);
  const agents = new AgentSupervisor();
  const app = createWebApp({
    control,
    agents,
    usage,
    defaultAgentCwd: input.cwd,
  });

  const server = Bun.serve({
    port: input.port ?? 8787,
    fetch: app.fetch,
  });
  const resolvedPort = server.port ?? input.port ?? 8787;

  return {
    port: resolvedPort,
    url: `http://localhost:${resolvedPort}`,
    stop: () => {
      server.stop(true);
    },
  };
}
