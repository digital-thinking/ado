import { resolve } from "node:path";

import { createPromptLogArtifacts, writeOutputLog } from "../agent-logs";
import { resolveAgentRegistryFilePath } from "../agent-registry";
import { CodexUsageTracker, createAdapter } from "../adapters";
import { resolveCliLogFilePath } from "../cli/logging";
import { ProcessManager } from "../process";
import { StateEngine } from "../state";
import { CLI_ADAPTER_IDS, type CLIAdapterId, type CliAgentSettings } from "../types";
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
  agentSettings: CliAgentSettings;
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
  if (!input.agentSettings[input.defaultInternalWorkAssignee].enabled) {
    throw new Error(
      `defaultInternalWorkAssignee '${input.defaultInternalWorkAssignee}' must be enabled in agent settings.`
    );
  }

  const processManager = new ProcessManager();
  const agents = new AgentSupervisor({
    registryFilePath: resolveAgentRegistryFilePath(input.cwd),
  });
  const control = new ControlCenterService(
    new StateEngine(input.stateFilePath),
    resolve(input.cwd, "TASKS.md"),
    async (workInput) => {
      const assigneeSettings = input.agentSettings[workInput.assignee];
      if (!assigneeSettings.enabled) {
        const available = CLI_ADAPTER_IDS.filter((adapterId) => input.agentSettings[adapterId].enabled);
        throw new Error(
          `Agent '${workInput.assignee}' is disabled. Available agents: ${available.join(", ")}.`
        );
      }

      const adapter = createAdapter(workInput.assignee, processManager);
      const artifacts = await createPromptLogArtifacts({
        cwd: input.cwd,
        assignee: workInput.assignee,
        prompt: workInput.prompt,
      });
      const useStdinPrompt =
        workInput.assignee === "CODEX_CLI" ||
        workInput.assignee === "CLAUDE_CLI" ||
        workInput.assignee === "GEMINI_CLI";
      const args = workInput.assignee === "CODEX_CLI"
        ? [...adapter.contract.baseArgs, "-"]
        : workInput.assignee === "GEMINI_CLI"
          ? [...adapter.contract.baseArgs, "--prompt", ""]
          : useStdinPrompt
            ? [...adapter.contract.baseArgs]
            : [...adapter.contract.baseArgs, artifacts.inputFilePath];
      const stdin = useStdinPrompt ? workInput.prompt : undefined;
      const agentName = workInput.taskId
        ? `${workInput.assignee} task worker`
        : `${workInput.assignee} internal worker`;
      console.info(
        `[web][internal] starting adapter=${workInput.assignee} command=${adapter.contract.command}`
      );
      const result = await (async () => {
        try {
          const runResult = await agents.runToCompletion({
            name: agentName,
            command: adapter.contract.command,
            args,
            cwd: input.cwd,
            timeoutMs: assigneeSettings.timeoutMs,
            stdin,
            phaseId: workInput.phaseId,
            taskId: workInput.taskId,
          });
          await writeOutputLog({
            outputFilePath: artifacts.outputFilePath,
            command: runResult.command,
            args: runResult.args,
            durationMs: runResult.durationMs,
            stdout: runResult.stdout,
            stderr: runResult.stderr,
          });
          return runResult;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await writeOutputLog({
            outputFilePath: artifacts.outputFilePath,
            command: adapter.contract.command,
            args,
            errorMessage: message,
          });
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
  const cliLogFilePath = resolveCliLogFilePath(input.cwd);
  const app = createWebApp({
    control,
    agents,
    usage,
    defaultAgentCwd: input.cwd,
    defaultInternalWorkAssignee: input.defaultInternalWorkAssignee,
    availableWorkerAssignees: CLI_ADAPTER_IDS.filter(
      (adapterId) => input.agentSettings[adapterId].enabled
    ),
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
