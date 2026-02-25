import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { startWebControlCenter } from "../web";
import type { CLIAdapterId, CliAgentSettings } from "../types";
import { ValidationError } from "./validation";

const WEB_READY_TIMEOUT_MS = 10_000;
const WEB_STOP_TIMEOUT_MS = 10_000;
const WEB_POLL_INTERVAL_MS = 100;
const WEB_START_ERROR_LOG_LINE_COUNT = 12;
const WEB_START_MARKER = "Starting web control center daemon.";

export type WebRuntimeRecord = {
  pid: number;
  port: number;
  url: string;
  logFilePath: string;
  startedAt: string;
};

type StopWebDaemonResult =
  | {
      status: "stopped";
      runtimeFilePath: string;
      record: WebRuntimeRecord;
    }
  | {
      status: "not_running";
      runtimeFilePath: string;
      reason: "missing_runtime_file" | "stale_runtime_file";
    }
  | {
      status: "permission_denied";
      runtimeFilePath: string;
      record: WebRuntimeRecord;
    };

export type StartWebDaemonInput = {
  cwd: string;
  stateFilePath: string;
  settingsFilePath: string;
  projectName: string;
  entryScriptPath: string;
  port?: number;
};

export type ServeWebControlCenterInput = {
  cwd: string;
  stateFilePath: string;
  settingsFilePath: string;
  projectName: string;
  defaultInternalWorkAssignee: CLIAdapterId;
  defaultAutoMode: boolean;
  agentSettings: CliAgentSettings;
  port?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function parseWebRuntimeRecord(
  raw: unknown,
  runtimeFilePath: string,
): WebRuntimeRecord {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid web runtime file format: ${runtimeFilePath}`);
  }

  const record = raw as Record<string, unknown>;
  const pid = record.pid;
  const port = record.port;
  const url = record.url;
  const rawLogFilePath = record.logFilePath;
  const startedAt = record.startedAt;

  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    throw new Error(`Invalid web runtime PID in ${runtimeFilePath}`);
  }
  if (
    !Number.isInteger(port) ||
    (port as number) < 0 ||
    (port as number) > 65535
  ) {
    throw new Error(`Invalid web runtime port in ${runtimeFilePath}`);
  }
  if (typeof url !== "string" || !url.trim()) {
    throw new Error(`Invalid web runtime URL in ${runtimeFilePath}`);
  }
  const logFilePath =
    typeof rawLogFilePath === "string" && rawLogFilePath.trim()
      ? rawLogFilePath
      : resolve(dirname(runtimeFilePath), "web.log");
  if (typeof startedAt !== "string" || !startedAt.trim()) {
    throw new Error(`Invalid web runtime timestamp in ${runtimeFilePath}`);
  }

  return {
    pid: pid as number,
    port: port as number,
    url,
    logFilePath,
    startedAt,
  };
}

export function resolveWebRuntimeFilePath(_cwd: string): string {
  const configuredRuntimePath = process.env.IXADO_WEB_RUNTIME_FILE?.trim();
  if (configuredRuntimePath) {
    return resolve(configuredRuntimePath);
  }

  return resolve(resolveGlobalIxadoDir(), "web-runtime.json");
}

export function resolveWebLogFilePath(_cwd: string): string {
  const configuredLogPath = process.env.IXADO_WEB_LOG_FILE?.trim();
  if (configuredLogPath) {
    return resolve(configuredLogPath);
  }

  return resolve(resolveGlobalIxadoDir(), "web.log");
}

function resolveGlobalIxadoDir(): string {
  const configuredHome = process.env.HOME?.trim();
  const homeDirectory = configuredHome || homedir().trim();
  if (!homeDirectory) {
    throw new Error(
      "Could not resolve home directory for global web runtime path.",
    );
  }

  return resolve(homeDirectory, ".ixado");
}

export function parseWebPort(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ValidationError(
      `Invalid web port: '${raw}'. Expected an integer from 0 to 65535.`,
      {
        hint: "Provide a valid port number, e.g., 3000.",
      },
    );
  }

  return port;
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }

    throw error;
  }
}

export async function readWebRuntimeRecord(
  runtimeFilePath: string,
): Promise<WebRuntimeRecord | null> {
  let raw: string;
  try {
    raw = await readFile(runtimeFilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Web runtime file contains invalid JSON: ${runtimeFilePath}`,
    );
  }

  return parseWebRuntimeRecord(parsed, runtimeFilePath);
}

export async function writeWebRuntimeRecord(
  runtimeFilePath: string,
  record: WebRuntimeRecord,
): Promise<void> {
  await mkdir(dirname(runtimeFilePath), { recursive: true });
  await writeFile(
    runtimeFilePath,
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

async function waitForWebRuntimeRecord(
  runtimeFilePath: string,
  expectedPid: number,
  logFilePath: string,
  startupMarkerLine: string,
): Promise<WebRuntimeRecord> {
  const deadline = Date.now() + WEB_READY_TIMEOUT_MS;
  let exitedBeforeStartup = false;

  while (Date.now() <= deadline) {
    const runtime = await readWebRuntimeRecord(runtimeFilePath);
    if (runtime && runtime.pid === expectedPid) {
      return runtime;
    }

    if (!isProcessRunning(expectedPid)) {
      exitedBeforeStartup = true;
      break;
    }

    await sleep(WEB_POLL_INTERVAL_MS);
  }

  const baseMessage = exitedBeforeStartup
    ? "Web control center process exited before startup completed."
    : "Web control center failed to start in time.";
  const logTail = await readWebLogTail(
    logFilePath,
    WEB_START_ERROR_LOG_LINE_COUNT,
    startupMarkerLine,
  );
  if (!logTail) {
    throw new Error(`${baseMessage}\nLogs: ${logFilePath}`);
  }

  const childStartupFailure = extractChildStartupFailureMessage(logTail);
  if (childStartupFailure) {
    throw new Error(
      `${baseMessage}\nCause: ${childStartupFailure}\nLogs: ${logFilePath}`,
    );
  }

  throw new Error(
    `${baseMessage}\nRecent web log output:\n${logTail}\nLogs: ${logFilePath}`,
  );
}

async function readWebLogTail(
  logFilePath: string,
  maxLines: number,
  startupMarkerLine: string,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(logFilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  const startupIndex = lines.lastIndexOf(startupMarkerLine);
  const scopedLines = startupIndex >= 0 ? lines.slice(startupIndex + 1) : lines;
  if (scopedLines.length === 0) {
    return null;
  }

  return scopedLines.slice(-Math.max(maxLines, 1)).join("\n");
}

function extractChildStartupFailureMessage(logTail: string): string | null {
  const lines = logTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    const startupFailedIndex = line.indexOf("Startup failed:");
    if (startupFailedIndex >= 0) {
      const message = line
        .slice(startupFailedIndex + "Startup failed:".length)
        .trim();
      return message || null;
    }

    const errorPrefixIndex = line.indexOf("Error:");
    if (errorPrefixIndex >= 0) {
      const message = line.slice(errorPrefixIndex + "Error:".length).trim();
      return message || null;
    }
  }

  return null;
}

async function waitForProcessStop(pid: number): Promise<void> {
  const deadline = Date.now() + WEB_STOP_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    if (!isProcessRunning(pid)) {
      return;
    }

    await sleep(WEB_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out while waiting for process ${pid} to stop.`);
}

export async function startWebDaemon(
  input: StartWebDaemonInput,
): Promise<WebRuntimeRecord> {
  if (!input.cwd.trim()) {
    throw new Error("cwd must not be empty.");
  }
  if (!input.stateFilePath.trim()) {
    throw new Error("stateFilePath must not be empty.");
  }
  if (!input.settingsFilePath.trim()) {
    throw new Error("settingsFilePath must not be empty.");
  }
  if (!input.projectName.trim()) {
    throw new Error("projectName must not be empty.");
  }

  const runtimeFilePath = resolveWebRuntimeFilePath(input.cwd);
  const logFilePath = resolveWebLogFilePath(input.cwd);
  const existingRuntime = await readWebRuntimeRecord(runtimeFilePath);
  if (existingRuntime && isProcessRunning(existingRuntime.pid)) {
    throw new Error(
      `Web control center is already running at ${existingRuntime.url} (pid: ${existingRuntime.pid}).`,
    );
  }
  if (existingRuntime) {
    await rm(runtimeFilePath, { force: true });
  }

  await mkdir(dirname(logFilePath), { recursive: true });
  const startupMarkerLine = `[${new Date().toISOString()}] ${WEB_START_MARKER}`;
  await appendFile(logFilePath, `${startupMarkerLine}\n`, "utf8");

  const spawnArgs = buildWebDaemonSpawnArgs(input.entryScriptPath, input.port);

  const stdoutFd = openSync(logFilePath, "a");
  const stderrFd = openSync(logFilePath, "a");
  const child = (() => {
    try {
      return spawn(process.execPath, spawnArgs, {
        cwd: input.cwd,
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
        windowsHide: true,
        env: {
          ...process.env,
          IXADO_STATE_FILE: input.stateFilePath,
          IXADO_SETTINGS_FILE: input.settingsFilePath,
          IXADO_WEB_RUNTIME_FILE: runtimeFilePath,
          IXADO_WEB_LOG_FILE: logFilePath,
        },
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
  })();

  if (!child.pid) {
    throw new Error("Failed to start web control center process.");
  }

  child.unref();
  return waitForWebRuntimeRecord(
    runtimeFilePath,
    child.pid,
    logFilePath,
    startupMarkerLine,
  );
}

export function buildWebDaemonSpawnArgs(
  entryScriptPath: string,
  port?: number,
): string[] {
  const spawnArgs: string[] = [];
  const trimmedEntryScriptPath = entryScriptPath.trim();
  if (trimmedEntryScriptPath) {
    const isVirtualBunFsPath = trimmedEntryScriptPath.startsWith("/$bunfs/");
    const resolvedEntryScriptPath = resolve(trimmedEntryScriptPath);
    if (!isVirtualBunFsPath && existsSync(resolvedEntryScriptPath)) {
      spawnArgs.push(resolvedEntryScriptPath);
    }
  }

  spawnArgs.push("web", "serve");
  if (port !== undefined) {
    spawnArgs.push(String(port));
  }

  return spawnArgs;
}

export async function stopWebDaemon(cwd: string): Promise<StopWebDaemonResult> {
  const runtimeFilePath = resolveWebRuntimeFilePath(cwd);
  const runtime = await readWebRuntimeRecord(runtimeFilePath);

  if (!runtime) {
    return {
      status: "not_running",
      runtimeFilePath,
      reason: "missing_runtime_file",
    };
  }

  if (!isProcessRunning(runtime.pid)) {
    await rm(runtimeFilePath, { force: true });
    return {
      status: "not_running",
      runtimeFilePath,
      reason: "stale_runtime_file",
    };
  }

  try {
    process.kill(runtime.pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      await rm(runtimeFilePath, { force: true });
      return {
        status: "not_running",
        runtimeFilePath,
        reason: "stale_runtime_file",
      };
    }
    if (code === "EPERM") {
      return {
        status: "permission_denied",
        runtimeFilePath,
        record: runtime,
      };
    }

    throw error;
  }

  await waitForProcessStop(runtime.pid);
  await rm(runtimeFilePath, { force: true });

  return {
    status: "stopped",
    runtimeFilePath,
    record: runtime,
  };
}

export async function serveWebControlCenter(
  input: ServeWebControlCenterInput,
): Promise<WebRuntimeRecord> {
  if (!input.settingsFilePath.trim()) {
    throw new Error("settingsFilePath must not be empty.");
  }
  const logFilePath = resolveWebLogFilePath(input.cwd);
  const runtime = await startWebControlCenter({
    ...input,
    webLogFilePath: logFilePath,
  });
  const runtimeFilePath = resolveWebRuntimeFilePath(input.cwd);
  await mkdir(dirname(logFilePath), { recursive: true });
  await appendFile(
    logFilePath,
    `[${new Date().toISOString()}] Web control center started at ${runtime.url} (pid: ${process.pid}).\n`,
    "utf8",
  );
  const record: WebRuntimeRecord = {
    pid: process.pid,
    port: runtime.port,
    url: runtime.url,
    logFilePath,
    startedAt: new Date().toISOString(),
  };

  await writeWebRuntimeRecord(runtimeFilePath, record);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    runtime.stop();
    await appendFile(
      logFilePath,
      `[${new Date().toISOString()}] Web control center stopped (pid: ${process.pid}).\n`,
      "utf8",
    );
    await rm(runtimeFilePath, { force: true });
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => {
      process.exit(0);
    });
  });

  process.once("SIGTERM", () => {
    void shutdown().finally(() => {
      process.exit(0);
    });
  });

  return record;
}
