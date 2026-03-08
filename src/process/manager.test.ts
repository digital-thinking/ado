import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";

import { resolveCommandForSpawn } from "./command-resolver";
import {
  ProcessExecutionError,
  ProcessManager,
  ProcessStdinUnavailableError,
} from "./manager";
import type { SpawnFn } from "./types";

type FakeChildProcess = ChildProcess & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  killedByTest: boolean;
};

function createFakeChild(): FakeChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let killedByTest = false;

  const child = Object.assign(emitter, {
    stdout,
    stderr,
    stdin,
    kill: () => {
      killedByTest = true;
      return true;
    },
  }) as FakeChildProcess;

  Object.defineProperty(child, "killedByTest", {
    get: () => killedByTest,
  });

  return child;
}

describe("ProcessManager", () => {
  test("runs a command and collects stdout/stderr", async () => {
    const child = createFakeChild();
    const spawnCalls: Array<{
      command: string;
      args: string[];
      options: SpawnOptions;
    }> = [];

    const spawnFn: SpawnFn = (command, args, options) => {
      spawnCalls.push({ command, args, options });
      queueMicrotask(() => {
        child.stdout.write("ok");
        child.stderr.write("warn");
        child.emit("close", 0, null);
      });
      return child;
    };

    const manager = new ProcessManager(spawnFn);
    const result = await manager.run({ command: "git", args: ["status"] });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.command).toBe(
      resolveCommandForSpawn("git", process.env),
    );
    expect(spawnCalls[0]?.args).toEqual(["status"]);
    expect(result.stdout).toBe("ok");
    expect(result.stderr).toBe("warn");
    expect(result.exitCode).toBe(0);
  });

  test("throws ProcessExecutionError for non-zero exit code", async () => {
    const child = createFakeChild();
    const spawnFn: SpawnFn = () => {
      queueMicrotask(() => {
        child.stderr.write("fatal");
        child.emit("close", 3, null);
      });
      return child;
    };

    const manager = new ProcessManager(spawnFn);
    let capturedError: unknown;

    try {
      await manager.run({ command: "git", args: ["fetch"] });
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toBeInstanceOf(ProcessExecutionError);
    const executionError = capturedError as ProcessExecutionError;
    expect(executionError.result.exitCode).toBe(3);
    expect(executionError.result.stderr).toBe("fatal");
  });

  test("writes stdin when provided", async () => {
    const child = createFakeChild();
    let stdinPayload = "";
    child.stdin.on("data", (chunk) => {
      stdinPayload += chunk.toString();
    });

    const spawnFn: SpawnFn = () => {
      queueMicrotask(() => {
        child.emit("close", 0, null);
      });
      return child;
    };

    const manager = new ProcessManager(spawnFn);
    await manager.run({ command: "cat", stdin: "hello" });

    expect(stdinPayload).toBe("hello");
  });

  test("throws ProcessStdinUnavailableError when stdin content is required but stdin pipe is null", async () => {
    const emitter = new EventEmitter() as ChildProcess;
    const child = Object.assign(emitter, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      kill: () => true,
    }) as unknown as ChildProcess;

    const spawnFn: SpawnFn = () => child;
    const manager = new ProcessManager(spawnFn);

    await expect(
      manager.run({ command: "codex", stdin: "prompt" }),
    ).rejects.toBeInstanceOf(ProcessStdinUnavailableError);
  });

  test("delivers stdin via atomic end(data) when pipe is available", async () => {
    const child = createFakeChild();
    const received: string[] = [];
    let ended = false;

    child.stdin.on("data", (chunk) => {
      received.push(chunk.toString());
    });
    child.stdin.on("end", () => {
      ended = true;
    });

    const spawnFn: SpawnFn = () => {
      queueMicrotask(() => {
        child.emit("close", 0, null);
      });
      return child;
    };

    const manager = new ProcessManager(spawnFn);
    await manager.run({ command: "cat", stdin: "atomic-payload" });

    expect(received.join("")).toBe("atomic-payload");
    expect(ended).toBe(true);
  });

  test("fails when process emits an error", async () => {
    const child = createFakeChild();
    const spawnFn: SpawnFn = () => {
      queueMicrotask(() => {
        child.emit("error", new Error("spawn failed"));
      });
      return child;
    };

    const manager = new ProcessManager(spawnFn);
    await expect(manager.run({ command: "bad" })).rejects.toThrow(
      "spawn failed",
    );
  });

  test("times out and kills the process", async () => {
    const child = createFakeChild();
    const spawnFn: SpawnFn = () => child;
    const manager = new ProcessManager(spawnFn);

    await expect(
      manager.run({ command: "sleep", timeoutMs: 10 }),
    ).rejects.toThrow("Command timed out");
    expect(child.killedByTest).toBe(true);
  });
});
