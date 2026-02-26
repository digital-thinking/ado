/**
 * P26-006 – Atomic persistence + batched-flush tests for AgentSupervisor.
 *
 * Covers:
 *  1. Atomic write – registry file is never left half-written (.tmp cleaned up)
 *  2. Batched flush – output-tail updates accumulate; explicit flushRegistry()
 *     commits them all at once
 *  3. Immediate flush on terminal transition – STOPPED/FAILED writes without
 *     waiting for the debounce timer
 *  4. Terminal flush includes pending output – a terminal close event flushes
 *     all buffered output that arrived before it
 *  5. Historical agents preserved across flushes
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { AgentSupervisor } from "./agent-supervisor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeChild = ChildProcess & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
};

function createFakeChild(pid = 9001): FakeChild {
  const emitter = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();

  return Object.assign(emitter, {
    pid,
    stdout,
    stderr,
    stdin,
    kill: () => true,
  }) as FakeChild;
}

function readRegistry(path: string): unknown[] {
  const raw = readFileSync(path, "utf8").trim();
  return JSON.parse(raw) as unknown[];
}

function findAgent(
  registry: unknown[],
  id: string,
): Record<string, unknown> | undefined {
  return (registry as Record<string, unknown>[]).find((a) => a["id"] === id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentSupervisor – atomic persistence (P26-006)", () => {
  let sandboxDir: string;
  let registryFilePath: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-supervisor-atomic-"));
    registryFilePath = join(sandboxDir, "agents.json");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("no .tmp file remains after terminal flush", () => {
    const child = createFakeChild();
    const supervisor = new AgentSupervisor({
      spawnFn: () => child,
      registryFilePath,
    });

    supervisor.start({
      name: "Worker",
      command: "bun",
      args: [],
      cwd: "/repo",
      approvedAdapterSpawn: true,
    });

    // Terminal close triggers immediate flush
    child.emit("close", 0, null);

    expect(existsSync(`${registryFilePath}.tmp`)).toBe(false);
    expect(existsSync(registryFilePath)).toBe(true);
  });

  test("no .tmp file remains after explicit flushRegistry", () => {
    const child = createFakeChild();
    const supervisor = new AgentSupervisor({
      spawnFn: () => child,
      registryFilePath,
    });

    const started = supervisor.start({
      name: "Worker",
      command: "bun",
      args: [],
      cwd: "/repo",
      approvedAdapterSpawn: true,
    });

    child.stdout.write("hello\n");
    supervisor.flushRegistry();

    expect(existsSync(`${registryFilePath}.tmp`)).toBe(false);

    const registry = readRegistry(registryFilePath);
    const agent = findAgent(registry, started.id);
    expect(agent).toBeDefined();
    expect(agent?.["id"]).toBe(started.id);
  });

  test("registry file contains valid JSON after each terminal write", () => {
    const child = createFakeChild();
    const supervisor = new AgentSupervisor({
      spawnFn: () => child,
      registryFilePath,
    });

    supervisor.start({
      name: "Worker",
      command: "bun",
      args: [],
      cwd: "/repo",
      approvedAdapterSpawn: true,
    });

    child.emit("close", 1, null); // FAILED → immediate flush

    const raw = readFileSync(registryFilePath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe("AgentSupervisor – batched flush (P26-006)", () => {
  let sandboxDir: string;
  let registryFilePath: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-supervisor-batch-"));
    registryFilePath = join(sandboxDir, "agents.json");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("explicit flushRegistry writes all pending output-tail updates", () => {
    const child = createFakeChild();
    const supervisor = new AgentSupervisor({
      spawnFn: () => child,
      registryFilePath,
    });

    const started = supervisor.start({
      name: "Batcher",
      command: "bun",
      args: [],
      cwd: "/repo",
      approvedAdapterSpawn: true,
    });

    child.stdout.write("line-alpha\n");
    child.stdout.write("line-beta\n");
    child.stderr.write("err-gamma\n");

    // No terminal event yet – writes may still be in the pending buffer.
    // flushRegistry() must commit everything.
    supervisor.flushRegistry();

    const registry = readRegistry(registryFilePath);
    const agent = findAgent(registry, started.id);
    expect(agent).toBeDefined();

    const tail = agent?.["outputTail"] as string[];
    expect(tail.some((l) => l.includes("line-alpha"))).toBe(true);
    expect(tail.some((l) => l.includes("line-beta"))).toBe(true);
    expect(tail.some((l) => l.includes("err-gamma"))).toBe(true);
  });

  test("terminal FAILED transition writes immediately without explicit flush", () => {
    const child = createFakeChild();
    const supervisor = new AgentSupervisor({
      spawnFn: () => child,
      registryFilePath,
    });

    const started = supervisor.start({
      name: "Failer",
      command: "bun",
      args: [],
      cwd: "/repo",
      approvedAdapterSpawn: true,
    });

    child.stdout.write("before-fail\n");
    // Non-zero exit → FAILED, which must flush immediately
    child.emit("close", 1, null);

    // No explicit flushRegistry() call – the file must already be updated
    const registry = readRegistry(registryFilePath);
    const agent = findAgent(registry, started.id);
    expect(agent?.["status"]).toBe("FAILED");
    expect(agent?.["lastExitCode"]).toBe(1);
  });

  test("terminal STOPPED (success) transition writes immediately", () => {
    const child = createFakeChild();
    const supervisor = new AgentSupervisor({
      spawnFn: () => child,
      registryFilePath,
    });

    const started = supervisor.start({
      name: "Stopper",
      command: "bun",
      args: [],
      cwd: "/repo",
      approvedAdapterSpawn: true,
    });

    child.emit("close", 0, null); // STOPPED

    const registry = readRegistry(registryFilePath);
    const agent = findAgent(registry, started.id);
    expect(agent?.["status"]).toBe("STOPPED");
    expect(agent?.["id"]).toBe(started.id);
  });

  test("terminal flush includes pending output accumulated before close", () => {
    const child = createFakeChild();
    const supervisor = new AgentSupervisor({
      spawnFn: () => child,
      registryFilePath,
    });

    const started = supervisor.start({
      name: "OutputThenClose",
      command: "bun",
      args: [],
      cwd: "/repo",
      approvedAdapterSpawn: true,
    });

    // Simulate output lines arriving before close
    child.stdout.write("important-output\n");
    child.stderr.write("important-error\n");

    // Terminal close – must flush both status AND the buffered output
    child.emit("close", 2, null);

    const registry = readRegistry(registryFilePath);
    const agent = findAgent(registry, started.id);
    expect(agent?.["status"]).toBe("FAILED");

    const tail = agent?.["outputTail"] as string[];
    expect(tail.some((l) => l.includes("important-output"))).toBe(true);
    expect(tail.some((l) => l.includes("important-error"))).toBe(true);
  });

  test("kill() writes STOPPED status immediately", () => {
    const child = createFakeChild();
    const supervisor = new AgentSupervisor({
      spawnFn: () => child,
      registryFilePath,
    });

    const started = supervisor.start({
      name: "KillTarget",
      command: "bun",
      args: [],
      cwd: "/repo",
      approvedAdapterSpawn: true,
    });

    supervisor.kill(started.id);

    const registry = readRegistry(registryFilePath);
    const agent = findAgent(registry, started.id);
    expect(agent?.["status"]).toBe("STOPPED");
  });

  test("historical agents are preserved across flushes", () => {
    const child1 = createFakeChild(1001);
    const child2 = createFakeChild(1002);
    let spawnCount = 0;
    const supervisor = new AgentSupervisor({
      spawnFn: () => {
        spawnCount += 1;
        return spawnCount === 1 ? child1 : child2;
      },
      registryFilePath,
    });

    const first = supervisor.start({
      name: "First",
      command: "bun",
      args: [],
      cwd: "/repo",
      approvedAdapterSpawn: true,
    });

    // Finish first agent → immediate flush persists it as STOPPED
    child1.emit("close", 0, null);

    const second = supervisor.start({
      name: "Second",
      command: "bun",
      args: [],
      cwd: "/repo",
      approvedAdapterSpawn: true,
    });
    child2.emit("close", 0, null);

    const registry = readRegistry(registryFilePath);
    expect(registry).toHaveLength(2);
    expect(findAgent(registry, first.id)).toBeDefined();
    expect(findAgent(registry, second.id)).toBeDefined();
  });

  test("flushRegistry is a no-op when no pending writes exist", () => {
    const supervisor = new AgentSupervisor({
      spawnFn: () => createFakeChild(),
      registryFilePath,
    });

    // No agents started – registry file does not exist; flush must not throw
    expect(() => supervisor.flushRegistry()).not.toThrow();
    expect(existsSync(registryFilePath)).toBe(false);
  });

  test("multiple output events coalesce: only one entry per agent in registry", () => {
    const child = createFakeChild();
    const supervisor = new AgentSupervisor({
      spawnFn: () => child,
      registryFilePath,
    });

    const started = supervisor.start({
      name: "MultiOut",
      command: "bun",
      args: [],
      cwd: "/repo",
      approvedAdapterSpawn: true,
    });

    for (let i = 0; i < 20; i++) {
      child.stdout.write(`line-${i}\n`);
    }

    supervisor.flushRegistry();

    const registry = readRegistry(registryFilePath);
    const agentEntries = (registry as Record<string, unknown>[]).filter(
      (a) => a["id"] === started.id,
    );
    // Should have exactly one entry in the registry, not one per output line
    expect(agentEntries).toHaveLength(1);
  });
});
