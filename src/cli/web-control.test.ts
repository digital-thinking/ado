import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildWebDaemonSpawnArgs,
  parseWebPort,
  resolveWebLogFilePath,
  readWebRuntimeRecord,
  resolveWebRuntimeFilePath,
  startWebDaemon,
  stopWebDaemon,
  writeWebRuntimeRecord,
  type WebRuntimeRecord,
} from "./web-control";

describe("web-control helpers", () => {
  let sandboxDir: string;
  const originalRuntimeFileEnv = process.env.IXADO_WEB_RUNTIME_FILE;
  const originalLogFileEnv = process.env.IXADO_WEB_LOG_FILE;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-web-control-"));
    process.env.HOME = sandboxDir;
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
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
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
    expect(defaultPath).toContain(sandboxDir);

    const configuredPath = join(sandboxDir, "custom", "runtime.json");
    process.env.IXADO_WEB_RUNTIME_FILE = configuredPath;

    expect(resolveWebRuntimeFilePath(sandboxDir)).toBe(configuredPath);
  });

  test("resolveWebLogFilePath prefers IXADO_WEB_LOG_FILE", () => {
    const defaultPath = resolveWebLogFilePath(sandboxDir);
    expect(defaultPath).toContain(".ixado");
    expect(defaultPath).toContain("web.log");
    expect(defaultPath).toContain(sandboxDir);

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
      logFilePath: resolveWebLogFilePath(sandboxDir),
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
      "Web runtime file contains invalid JSON",
    );
  });

  test("stopWebDaemon reports not running when runtime file is missing", async () => {
    const result = await stopWebDaemon(sandboxDir);

    expect(result.status).toBe("not_running");
    if (result.status === "not_running") {
      expect(result.reason).toBe("missing_runtime_file");
    }
  });

  test("stopWebDaemon reports permission denied when pid cannot be signaled", async () => {
    const runtimeFilePath = resolveWebRuntimeFilePath(sandboxDir);
    await writeWebRuntimeRecord(runtimeFilePath, {
      pid: 999999,
      port: 8787,
      url: "http://127.0.0.1:8787",
      logFilePath: resolveWebLogFilePath(sandboxDir),
      startedAt: new Date().toISOString(),
    });

    const originalKill = process.kill;
    (process as unknown as { kill: typeof process.kill }).kill = ((
      pid: number,
      signal?: number | NodeJS.Signals,
    ) => {
      if (pid === 999999) {
        const error = new Error(
          "operation not permitted",
        ) as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }

      return originalKill(pid, signal as never);
    }) as typeof process.kill;

    try {
      const result = await stopWebDaemon(sandboxDir);
      expect(result.status).toBe("permission_denied");
      if (result.status === "permission_denied") {
        expect(result.record.pid).toBe(999999);
      }
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    }
  });

  test("buildWebDaemonSpawnArgs includes script path when it exists", async () => {
    const entryScriptPath = join(sandboxDir, "bin", "ixado.ts");
    await mkdir(dirname(entryScriptPath), { recursive: true });
    await writeFile(entryScriptPath, "console.log('ixado');\n", "utf8");

    expect(buildWebDaemonSpawnArgs(entryScriptPath)).toEqual([entryScriptPath]);
  });

  test("buildWebDaemonSpawnArgs omits script path when it does not exist", () => {
    const missingEntryScriptPath = join(sandboxDir, "missing-entry.ts");

    expect(buildWebDaemonSpawnArgs(missingEntryScriptPath)).toEqual([]);
  });

  test("buildWebDaemonSpawnArgs omits virtual Bun entry path", () => {
    expect(buildWebDaemonSpawnArgs("/$bunfs/root/ixado")).toEqual([]);
  });

  test("startWebDaemon includes startup error details when child exits", async () => {
    const holder = createServer();
    const occupiedPort = await new Promise<number>(
      (resolvePort, rejectPort) => {
        holder.once("error", rejectPort);
        holder.listen(0, "127.0.0.1", () => {
          const address = holder.address();
          if (!address || typeof address === "string") {
            rejectPort(new Error("Failed to resolve occupied test port."));
            return;
          }
          resolvePort(address.port);
        });
      },
    );

    try {
      await expect(
        startWebDaemon({
          cwd: sandboxDir,
          stateFilePath: join(sandboxDir, "state.json"),
          settingsFilePath: join(sandboxDir, "settings.json"),
          projectName: "IxADO",
          entryScriptPath: resolve("src/cli/index.ts"),
          port: occupiedPort,
        }),
      ).rejects.toThrow("Cause: Failed to start server. Is port");
    } finally {
      await new Promise<void>((resolveClose) => {
        holder.close(() => resolveClose());
      });
    }
  });
});
