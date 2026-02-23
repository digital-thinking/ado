import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { inspect } from "node:util";
import { resolveGlobalSettingsFilePath } from "./settings";

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

function appendLogLine(logFilePath: string, level: string, args: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(formatLogArg).join(" ")}\n`;
  appendFileSync(logFilePath, line, "utf8");
}

export function resolveCliLogFilePath(_cwd: string): string {
  const configuredPath = process.env.IXADO_CLI_LOG_FILE?.trim();
  if (configuredPath) {
    return resolve(configuredPath);
  }

  const globalSettingsFilePath = resolveGlobalSettingsFilePath();
  return resolve(dirname(globalSettingsFilePath), DEFAULT_CLI_LOG_FILE);
}

export function initializeCliLogging(cwd: string): string {
  const logFilePath = resolveCliLogFilePath(cwd);
  mkdirSync(dirname(logFilePath), { recursive: true });

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
