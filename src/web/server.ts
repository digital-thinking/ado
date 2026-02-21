import { resolve } from "node:path";

import { CodexUsageTracker, createAdapter } from "../adapters";
import { resolveCliLogFilePath } from "../cli/logging";
import { ProcessManager } from "../process";
import { StateEngine } from "../state";
import type { CLIAdapterId } from "../types";
import { AgentSupervisor } from "./agent-supervisor";
import { createWebApp } from "./app";
import { ControlCenterService } from "./control-center-service";
import { UsageService } from "./usage-service";

export type StartWebControlCenterInput = {
  cwd: string;
  stateFilePath: string;
  projectName: string;
  port?: number;
  defaultInternalWorkAssignee: CLIAdapterId;
  webLogFilePath: string;
};

export type WebControlCenterRuntime = {
  port: number;
  url: string;
  stop: () => void;
};

function isMissingCommandError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as NodeJS.ErrnoException;
  if (candidate.code === "ENOENT") {
    return true;
  }

  const message = candidate.message ?? "";
  return message.includes("ENOENT") || message.includes("uv_spawn");
}

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

  const processManager = new ProcessManager();
  const control = new ControlCenterService(
    new StateEngine(input.stateFilePath),
    resolve(input.cwd, "TASKS.md"),
    async (workInput) => {
      const adapter = createAdapter(workInput.assignee, processManager);
      console.info(
        `[web][internal] starting adapter=${workInput.assignee} command=${adapter.contract.command}`
      );
      const result = await (async () => {
        try {
          return await adapter.run({
            prompt: workInput.prompt,
            cwd: input.cwd,
            timeoutMs: workInput.timeoutMs,
          });
        } catch (error) {
          if (isMissingCommandError(error)) {
            throw new Error(
              `Internal work adapter '${workInput.assignee}' is configured to use '${adapter.contract.command}', but that command is not installed or not on PATH. Install it or choose another adapter in 'ixado onboard' / the web UI.`
            );
          }

          throw error;
        }
      })();
      console.info(
        `[web][internal] completed adapter=${workInput.assignee} durationMs=${result.durationMs} stdoutLen=${result.stdout.length} stderrLen=${result.stderr.length}`
      );

      return {
        command: result.command,
        args: result.args,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      };
    }
  );
  await control.ensureInitialized(input.projectName, input.cwd);

  const usage = new UsageService(new CodexUsageTracker(processManager), input.cwd);
  const agents = new AgentSupervisor();
  const cliLogFilePath = resolveCliLogFilePath(input.cwd);
  const app = createWebApp({
    control,
    agents,
    usage,
    defaultAgentCwd: input.cwd,
    defaultInternalWorkAssignee: input.defaultInternalWorkAssignee,
    webLogFilePath: input.webLogFilePath,
    cliLogFilePath,
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
