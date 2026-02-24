import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { AgentSupervisor } from "./agent-supervisor";
import { ProcessStdinUnavailableError } from "../process/manager";

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
  let sandboxDir: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-agent-supervisor-"));
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("starts, lists, and kills an agent", () => {
    const child = createFakeChild();
    const spawnCalls: Array<{
      command: string;
      args: string[];
      options: SpawnOptions;
    }> = [];

    const supervisor = new AgentSupervisor((command, args, options) => {
      spawnCalls.push({ command, args, options });
      return child;
    });

    const started = supervisor.start({
      name: "Worker 1",
      command: "bun",
      args: ["run", "task"],
      cwd: "C:/repo",
      approvedAdapterSpawn: true,
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
      approvedAdapterSpawn: true,
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
      approvedAdapterSpawn: true,
    });

    child.stdout.write("line one\n");
    child.stderr.write("line two\n");
    child.emit("close", 2, null);

    const listed = supervisor.list().find((agent) => agent.id === started.id);
    expect(listed?.status).toBe("FAILED");
    expect(listed?.outputTail.some((line) => line.includes("line one"))).toBe(
      true,
    );
    expect(listed?.lastExitCode).toBe(2);
  });

  test("assigns and clears task ownership", () => {
    const child = createFakeChild();
    const supervisor = new AgentSupervisor(() => child);
    const started = supervisor.start({
      name: "Worker 4",
      command: "bun",
      cwd: "C:/repo",
      approvedAdapterSpawn: true,
    });

    const assigned = supervisor.assign(started.id, {
      phaseId: "phase-1",
      taskId: "task-1",
    });
    expect(assigned.phaseId).toBe("phase-1");
    expect(assigned.taskId).toBe("task-1");

    const cleared = supervisor.assign(started.id, {});
    expect(cleared.phaseId).toBeUndefined();
    expect(cleared.taskId).toBeUndefined();
  });

  test("tracks run-to-completion output and task assignment", async () => {
    const child = createFakeChild();
    const supervisor = new AgentSupervisor(() => child);

    const runPromise = supervisor.runToCompletion({
      name: "Task worker",
      command: "codex",
      args: ["run", "prompt"],
      cwd: "C:/repo",
      approvedAdapterSpawn: true,
      phaseId: "phase-1",
      taskId: "task-1",
    });

    child.stdout.write("hello\n");
    child.stderr.write("world\n");
    child.emit("close", 0, null);

    const result = await runPromise;
    const listed = supervisor.list().find((item) => item.id === result.id);
    expect(result.stdout).toContain("hello");
    expect(result.stderr).toContain("world");
    expect(listed?.status).toBe("STOPPED");
    expect(listed?.taskId).toBe("task-1");
  });

  test("rejects raw command starts that are not adapter-approved", () => {
    const child = createFakeChild();
    const supervisor = new AgentSupervisor(() => child);

    expect(() =>
      supervisor.start({
        name: "Blocked worker",
        command: "bash",
        args: ["-lc", "echo hi"],
        cwd: "C:/repo",
      }),
    ).toThrow("raw agent command execution is blocked");
  });

  test("shares tracked agents through registry file", () => {
    const registryFilePath = join(sandboxDir, ".ixado", "agents.json");
    const child = createFakeChild();
    const primary = new AgentSupervisor({
      spawnFn: () => child,
      registryFilePath,
    });
    const secondary = new AgentSupervisor({
      registryFilePath,
    });

    const started = primary.start({
      name: "Shared worker",
      command: "codex",
      args: ["run", "x"],
      cwd: "C:/repo",
      approvedAdapterSpawn: true,
      taskId: "task-shared",
    });

    const found = secondary.list().find((agent) => agent.id === started.id);
    expect(found).toBeDefined();
    expect(found?.status).toBe("RUNNING");
    expect(found?.taskId).toBe("task-shared");
  });

  test("calls onFailure hook when agent fails", (done) => {
    const child = createFakeChild();
    const supervisor = new AgentSupervisor({
      spawnFn: () => child,
      onFailure: (agent) => {
        try {
          expect(agent.status).toBe("FAILED");
          expect(agent.name).toBe("Failing worker");
          done();
        } catch (error) {
          done(error);
        }
      },
    });

    supervisor.start({
      name: "Failing worker",
      command: "bun",
      cwd: "C:/repo",
      approvedAdapterSpawn: true,
    });

    child.emit("close", 1, null);
  });

  test("throws ProcessStdinUnavailableError when stdin content is required but pipe is null", async () => {
    const emitter = new EventEmitter() as ChildProcess;
    const child = Object.assign(emitter, {
      pid: 9999,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      kill: () => true,
    }) as unknown as ChildProcess;

    const supervisor = new AgentSupervisor(() => child);

    await expect(
      supervisor.runToCompletion({
        name: "Stdin test worker",
        command: "codex",
        args: ["exec", "-"],
        cwd: "/tmp",
        approvedAdapterSpawn: true,
        stdin: "the prompt payload",
      }),
    ).rejects.toBeInstanceOf(ProcessStdinUnavailableError);
  });

  test("delivers stdin via atomic end(data) when pipe is available", async () => {
    const child = createFakeChild();
    const received: string[] = [];
    let ended = false;

    child.stdin.on("data", (chunk: Buffer | string) => {
      received.push(chunk.toString());
    });
    child.stdin.on("end", () => {
      ended = true;
    });

    const supervisor = new AgentSupervisor(() => {
      queueMicrotask(() => {
        child.emit("close", 0, null);
      });
      return child;
    });

    await supervisor.runToCompletion({
      name: "Atomic stdin worker",
      command: "codex",
      args: ["exec", "-"],
      cwd: "/tmp",
      approvedAdapterSpawn: true,
      stdin: "atomic-payload",
    });

    expect(received.join("")).toBe("atomic-payload");
    expect(ended).toBe(true);
  });

  test("appends startup-silence diagnostic to outputTail when no output arrives within startupSilenceTimeoutMs", async () => {
    const child = createFakeChild();

    const supervisor = new AgentSupervisor(() => {
      // Emit close after the silence timer fires (no output emitted)
      setTimeout(() => {
        child.emit("close", 0, null);
      }, 50);
      return child;
    });

    await supervisor.runToCompletion({
      name: "Silent worker",
      command: "claude",
      args: ["--print"],
      cwd: "/tmp",
      approvedAdapterSpawn: true,
      startupSilenceTimeoutMs: 10,
    });

    const listed = supervisor.list().find((a) => a.name === "Silent worker");
    expect(
      listed?.outputTail.some((line) =>
        line.includes("[ixado] No output from 'claude'"),
      ),
    ).toBe(true);
    expect(
      listed?.outputTail.some((line) => line.includes("verify the adapter")),
    ).toBe(true);
  });

  test("does NOT append startup-silence diagnostic when output arrives before silence window expires", async () => {
    const child = createFakeChild();

    const supervisor = new AgentSupervisor(() => {
      // Emit output immediately, before the silence timer would fire
      queueMicrotask(() => {
        child.stdout.write("some output\n");
        child.emit("close", 0, null);
      });
      return child;
    });

    await supervisor.runToCompletion({
      name: "Active worker",
      command: "gemini",
      args: ["--yolo"],
      cwd: "/tmp",
      approvedAdapterSpawn: true,
      startupSilenceTimeoutMs: 5000,
    });

    const listed = supervisor.list().find((a) => a.name === "Active worker");
    expect(listed?.outputTail.some((line) => line.includes("[ixado]"))).toBe(
      false,
    );
  });

  test("calls onFailure hook when agent is killed", (done) => {
    const child = createFakeChild();
    const supervisor = new AgentSupervisor({
      spawnFn: () => child,
      onFailure: (agent) => {
        try {
          expect(agent.status).toBe("STOPPED");
          expect(agent.name).toBe("Killed worker");
          done();
        } catch (error) {
          done(error);
        }
      },
    });

    const agent = supervisor.start({
      name: "Killed worker",
      command: "bun",
      cwd: "C:/repo",
      approvedAdapterSpawn: true,
    });

    supervisor.kill(agent.id);
  });
});
