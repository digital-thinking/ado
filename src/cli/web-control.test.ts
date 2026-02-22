import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildWebDaemonSpawnArgs,
  parseWebPort,
  resolveWebLogFilePath,
  readWebRuntimeRecord,
  resolveWebRuntimeFilePath,
  stopWebDaemon,
  writeWebRuntimeRecord,
  type WebRuntimeRecord,
} from "./web-control";

describe("web-control helpers", () => {
  let sandboxDir: string;
  const originalRuntimeFileEnv = process.env.IXADO_WEB_RUNTIME_FILE;
  const originalLogFileEnv = process.env.IXADO_WEB_LOG_FILE;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-web-control-"));
    delete process.env.IXADO_WEB_RUNTIME_FILE;
    delete process.env.IXADO_WEB_LOG_FILE;
  });

  afterEach(async () => {
    if (originalRuntimeFileEnv === undefined) {
      delete process.env.IXADO_WEB_RUNTIME_FILE;
    } else {
      process.env.IXADO_WEB_RUNTIME_FILE = originalRuntimeFileEnv;
    }
    if (originalLogFileEnv === undefined) {
      delete process.env.IXADO_WEB_LOG_FILE;
    } else {
      process.env.IXADO_WEB_LOG_FILE = originalLogFileEnv;
    }

    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("parseWebPort accepts valid values and rejects invalid ones", () => {
    expect(parseWebPort(undefined)).toBeUndefined();
    expect(parseWebPort("0")).toBe(0);
    expect(parseWebPort("8787")).toBe(8787);
    expect(() => parseWebPort("-1")).toThrow("Invalid web port");
    expect(() => parseWebPort("70000")).toThrow("Invalid web port");
    expect(() => parseWebPort("abc")).toThrow("Invalid web port");
  });

  test("resolveWebRuntimeFilePath prefers IXADO_WEB_RUNTIME_FILE", () => {
    const defaultPath = resolveWebRuntimeFilePath(sandboxDir);
    expect(defaultPath).toContain(".ixado");
    expect(defaultPath).toContain("web-runtime.json");

    const configuredPath = join(sandboxDir, "custom", "runtime.json");
    process.env.IXADO_WEB_RUNTIME_FILE = configuredPath;

    expect(resolveWebRuntimeFilePath(sandboxDir)).toBe(configuredPath);
  });

  test("resolveWebLogFilePath prefers IXADO_WEB_LOG_FILE", () => {
    const defaultPath = resolveWebLogFilePath(sandboxDir);
    expect(defaultPath).toContain(".ixado");
    expect(defaultPath).toContain("web.log");

    const configuredPath = join(sandboxDir, "custom", "web.log");
    process.env.IXADO_WEB_LOG_FILE = configuredPath;
    expect(resolveWebLogFilePath(sandboxDir)).toBe(configuredPath);
  });

  test("writeWebRuntimeRecord and readWebRuntimeRecord roundtrip", async () => {
    const runtimeFilePath = resolveWebRuntimeFilePath(sandboxDir);
    const record: WebRuntimeRecord = {
      pid: 12345,
      port: 8787,
      url: "http://localhost:8787",
      logFilePath: join(sandboxDir, ".ixado", "web.log"),
      startedAt: new Date().toISOString(),
    };

    await writeWebRuntimeRecord(runtimeFilePath, record);
    const loaded = await readWebRuntimeRecord(runtimeFilePath);

    expect(loaded).toEqual(record);
  });

  test("readWebRuntimeRecord fails fast on invalid JSON", async () => {
    const runtimeFilePath = resolveWebRuntimeFilePath(sandboxDir);
    await mkdir(dirname(runtimeFilePath), { recursive: true });
    await writeFile(runtimeFilePath, "{invalid", "utf8");

    await expect(readWebRuntimeRecord(runtimeFilePath)).rejects.toThrow(
      "Web runtime file contains invalid JSON"
    );
  });

  test("stopWebDaemon reports not running when runtime file is missing", async () => {
    const result = await stopWebDaemon(sandboxDir);

    expect(result.status).toBe("not_running");
    if (result.status === "not_running") {
      expect(result.reason).toBe("missing_runtime_file");
    }
  });

  test("buildWebDaemonSpawnArgs includes script path when it exists", async () => {
    const entryScriptPath = join(sandboxDir, "bin", "ixado.ts");
    await mkdir(dirname(entryScriptPath), { recursive: true });
    await writeFile(entryScriptPath, "console.log('ixado');\n", "utf8");

    expect(buildWebDaemonSpawnArgs(entryScriptPath, 8787)).toEqual([
      entryScriptPath,
      "web",
      "serve",
      "8787",
    ]);
  });

  test("buildWebDaemonSpawnArgs omits script path when it does not exist", () => {
    const missingEntryScriptPath = join(sandboxDir, "missing-entry.ts");

    expect(buildWebDaemonSpawnArgs(missingEntryScriptPath, 8787)).toEqual([
      "web",
      "serve",
      "8787",
    ]);
  });

  test("buildWebDaemonSpawnArgs omits virtual Bun entry path", () => {
    expect(buildWebDaemonSpawnArgs("/$bunfs/root/ixado", 8787)).toEqual([
      "web",
      "serve",
      "8787",
    ]);
  });
});
