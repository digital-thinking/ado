import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { inspect } from "node:util";

const DEFAULT_CLI_LOG_FILE = "cli.log";

let initialized = false;

function formatLogArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return inspect(value, {
    depth: 6,
    colors: false,
    breakLength: 120,
    compact: true,
  });
}

function appendLogLine(
  logFilePath: string,
  level: string,
  args: unknown[],
): void {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(formatLogArg).join(" ")}\n`;
  appendFileSync(logFilePath, line, "utf8");
}

function createLogPathError(
  logFilePath: string,
  error: unknown,
  override: boolean,
): Error {
  const cause = error instanceof Error ? error : new Error(String(error));
  const reason = cause.message || String(error);
  const hint = override
    ? "Set IXADO_CLI_LOG_FILE to a writable file path."
    : "Ensure the project directory is writable or set IXADO_CLI_LOG_FILE to a writable file path.";
  return new Error(
    `Failed to initialize CLI logging at \"${logFilePath}\": ${reason}. ${hint}`,
    { cause },
  );
}

function ensureWritableLogPath(logFilePath: string, override: boolean): void {
  try {
    mkdirSync(dirname(logFilePath), { recursive: true });
    appendFileSync(logFilePath, "", "utf8");
  } catch (error) {
    throw createLogPathError(logFilePath, error, override);
  }
}

export function resolveCliLogFilePath(cwd: string): string {
  const configuredPath = process.env.IXADO_CLI_LOG_FILE?.trim();
  if (configuredPath) {
    return resolve(configuredPath);
  }

  return resolve(cwd, ".ixado", DEFAULT_CLI_LOG_FILE);
}

export function initializeCliLogging(cwd: string): string {
  const logFilePath = resolveCliLogFilePath(cwd);
  const hasExplicitOverride = Boolean(process.env.IXADO_CLI_LOG_FILE?.trim());
  ensureWritableLogPath(logFilePath, hasExplicitOverride);

  if (!initialized) {
    const originalLog = console.log.bind(console);
    const originalInfo = console.info.bind(console);
    const originalWarn = console.warn.bind(console);
    const originalError = console.error.bind(console);

    console.log = (...args: unknown[]) => {
      originalLog(...args);
      appendLogLine(logFilePath, "LOG", args);
    };
    console.info = (...args: unknown[]) => {
      originalInfo(...args);
      appendLogLine(logFilePath, "INFO", args);
    };
    console.warn = (...args: unknown[]) => {
      originalWarn(...args);
      appendLogLine(logFilePath, "WARN", args);
    };
    console.error = (...args: unknown[]) => {
      originalError(...args);
      appendLogLine(logFilePath, "ERROR", args);
    };

    initialized = true;
  }

  appendLogLine(logFilePath, "INFO", ["IxADO CLI logging initialized."]);
  return logFilePath;
}
