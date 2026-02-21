import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";

import { AgentSupervisor } from "./agent-supervisor";

type FakeChild = ChildProcess & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  killedByTest: boolean;
};

function createFakeChild(pid = 1001): FakeChild {
  const emitter = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let killedByTest = false;

  const child = Object.assign(emitter, {
    pid,
    stdout,
    stderr,
    stdin,
    kill: () => {
      killedByTest = true;
      return true;
    },
  }) as FakeChild;

  Object.defineProperty(child, "killedByTest", {
    get: () => killedByTest,
  });

  return child;
}

describe("AgentSupervisor", () => {
  test("starts, lists, and kills an agent", () => {
    const child = createFakeChild();
    const spawnCalls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];

    const supervisor = new AgentSupervisor((command, args, options) => {
      spawnCalls.push({ command, args, options });
      return child;
    });

    const started = supervisor.start({
      name: "Worker 1",
      command: "bun",
      args: ["run", "task"],
      cwd: "C:/repo",
      taskId: "task-123",
    });

    expect(spawnCalls).toHaveLength(1);
    expect(started.status).toBe("RUNNING");
    expect(supervisor.list()).toHaveLength(1);

    const killed = supervisor.kill(started.id);
    expect(killed.status).toBe("STOPPED");
    expect(child.killedByTest).toBe(true);
  });

  test("restarts an existing agent", () => {
    const first = createFakeChild(2001);
    const second = createFakeChild(2002);
    let spawnCount = 0;

    const supervisor = new AgentSupervisor(() => {
      spawnCount += 1;
      return spawnCount === 1 ? first : second;
    });

    const started = supervisor.start({
      name: "Worker 2",
      command: "bun",
      args: [],
      cwd: "C:/repo",
    });

    const restarted = supervisor.restart(started.id);
    expect(restarted.status).toBe("RUNNING");
    expect(restarted.pid).toBe(2002);
    expect(first.killedByTest).toBe(true);
  });

  test("captures output tail and failure state", () => {
    const child = createFakeChild();

    const supervisor = new AgentSupervisor(() => child);
    const started = supervisor.start({
      name: "Worker 3",
      command: "bun",
      cwd: "C:/repo",
    });

    child.stdout.write("line one\n");
    child.stderr.write("line two\n");
    child.emit("close", 2, null);

    const listed = supervisor.list().find((agent) => agent.id === started.id);
    expect(listed?.status).toBe("FAILED");
    expect(listed?.outputTail.some((line) => line.includes("line one"))).toBe(true);
    expect(listed?.lastExitCode).toBe(2);
  });
});
