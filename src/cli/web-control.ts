import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { startWebControlCenter } from "../web";
import type { CLIAdapterId } from "../types";

const DEFAULT_WEB_RUNTIME_FILE = ".ixado/web-runtime.json";
const DEFAULT_WEB_LOG_FILE = ".ixado/web.log";
const WEB_READY_TIMEOUT_MS = 10_000;
const WEB_STOP_TIMEOUT_MS = 10_000;
const WEB_POLL_INTERVAL_MS = 100;

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
    };

export type StartWebDaemonInput = {
  cwd: string;
  stateFilePath: string;
  projectName: string;
  entryScriptPath: string;
  port?: number;
};

export type ServeWebControlCenterInput = {
  cwd: string;
  stateFilePath: string;
  projectName: string;
  defaultInternalWorkAssignee: CLIAdapterId;
  port?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function parseWebRuntimeRecord(raw: unknown, runtimeFilePath: string): WebRuntimeRecord {
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
  if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65535) {
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

export function resolveWebRuntimeFilePath(cwd: string): string {
  const configuredRuntimePath = process.env.IXADO_WEB_RUNTIME_FILE?.trim();
  if (configuredRuntimePath) {
    return resolve(configuredRuntimePath);
  }

  return resolve(cwd, DEFAULT_WEB_RUNTIME_FILE);
}

export function resolveWebLogFilePath(cwd: string): string {
  const configuredLogPath = process.env.IXADO_WEB_LOG_FILE?.trim();
  if (configuredLogPath) {
    return resolve(configuredLogPath);
  }

  return resolve(cwd, DEFAULT_WEB_LOG_FILE);
}

export function parseWebPort(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Invalid web port. Expected integer between 0 and 65535.");
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

export async function readWebRuntimeRecord(runtimeFilePath: string): Promise<WebRuntimeRecord | null> {
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
    throw new Error(`Web runtime file contains invalid JSON: ${runtimeFilePath}`);
  }

  return parseWebRuntimeRecord(parsed, runtimeFilePath);
}

export async function writeWebRuntimeRecord(
  runtimeFilePath: string,
  record: WebRuntimeRecord
): Promise<void> {
  await mkdir(dirname(runtimeFilePath), { recursive: true });
  await writeFile(runtimeFilePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function waitForWebRuntimeRecord(
  runtimeFilePath: string,
  expectedPid: number
): Promise<WebRuntimeRecord> {
  const deadline = Date.now() + WEB_READY_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const runtime = await readWebRuntimeRecord(runtimeFilePath);
    if (runtime && runtime.pid === expectedPid) {
      return runtime;
    }

    if (!isProcessRunning(expectedPid)) {
      break;
    }

    await sleep(WEB_POLL_INTERVAL_MS);
  }

  throw new Error("Web control center failed to start in time.");
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

export async function startWebDaemon(input: StartWebDaemonInput): Promise<WebRuntimeRecord> {
  if (!input.cwd.trim()) {
    throw new Error("cwd must not be empty.");
  }
  if (!input.stateFilePath.trim()) {
    throw new Error("stateFilePath must not be empty.");
  }
  if (!input.projectName.trim()) {
    throw new Error("projectName must not be empty.");
  }
  if (!input.entryScriptPath.trim()) {
    throw new Error("entryScriptPath must not be empty.");
  }

  const runtimeFilePath = resolveWebRuntimeFilePath(input.cwd);
  const logFilePath = resolveWebLogFilePath(input.cwd);
  const existingRuntime = await readWebRuntimeRecord(runtimeFilePath);
  if (existingRuntime && isProcessRunning(existingRuntime.pid)) {
    throw new Error(
      `Web control center is already running at ${existingRuntime.url} (pid: ${existingRuntime.pid}).`
    );
  }
  if (existingRuntime) {
    await rm(runtimeFilePath, { force: true });
  }

  await mkdir(dirname(logFilePath), { recursive: true });
  await appendFile(
    logFilePath,
    `[${new Date().toISOString()}] Starting web control center daemon.\n`,
    "utf8"
  );

  const spawnArgs = [input.entryScriptPath, "web", "serve"];
  if (input.port !== undefined) {
    spawnArgs.push(String(input.port));
  }

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
  return waitForWebRuntimeRecord(runtimeFilePath, child.pid);
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
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      await rm(runtimeFilePath, { force: true });
      return {
        status: "not_running",
        runtimeFilePath,
        reason: "stale_runtime_file",
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
  input: ServeWebControlCenterInput
): Promise<WebRuntimeRecord> {
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
    "utf8"
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
      "utf8"
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
