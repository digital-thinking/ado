import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type AgentStatus = "RUNNING" | "STOPPED" | "FAILED";

export type StartAgentInput = {
  name: string;
  command: string;
  args?: string[];
  cwd: string;
  phaseId?: string;
  taskId?: string;
};

type AgentRecord = {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  phaseId?: string;
  taskId?: string;
  status: AgentStatus;
  pid?: number;
  startedAt: string;
  stoppedAt?: string;
  lastExitCode?: number;
  outputTail: string[];
  child?: ChildProcess;
};

export type AgentView = Omit<AgentRecord, "child">;

function nowIso(): string {
  return new Date().toISOString();
}

function toView(record: AgentRecord): AgentView {
  const { child: _child, ...view } = record;
  return view;
}

function tailPush(lines: string[], value: string): void {
  const chunks = value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  lines.push(...chunks);
  if (lines.length > 50) {
    lines.splice(0, lines.length - 50);
  }
}

export class AgentSupervisor {
  private readonly spawnFn: SpawnFn;
  private readonly records = new Map<string, AgentRecord>();

  constructor(spawnFn: SpawnFn = spawn) {
    this.spawnFn = spawnFn;
  }

  list(): AgentView[] {
    return [...this.records.values()].map(toView);
  }

  start(input: StartAgentInput): AgentView {
    if (!input.name.trim()) {
      throw new Error("agent name must not be empty.");
    }
    if (!input.command.trim()) {
      throw new Error("agent command must not be empty.");
    }
    if (!input.cwd.trim()) {
      throw new Error("agent cwd must not be empty.");
    }

    const id = randomUUID();
    const args = input.args ?? [];
    const child = this.spawnFn(input.command, args, {
      cwd: input.cwd,
      shell: false,
      stdio: "pipe",
      windowsHide: true,
    });

    const record: AgentRecord = {
      id,
      name: input.name,
      command: input.command,
      args,
      cwd: input.cwd,
      phaseId: input.phaseId,
      taskId: input.taskId,
      status: "RUNNING",
      pid: child.pid,
      startedAt: nowIso(),
      outputTail: [],
      child,
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      tailPush(record.outputTail, chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      tailPush(record.outputTail, chunk.toString());
    });
    child.on("close", (exitCode) => {
      record.status = exitCode === 0 ? "STOPPED" : "FAILED";
      record.lastExitCode = exitCode ?? -1;
      record.stoppedAt = nowIso();
      record.child = undefined;
    });
    child.on("error", (error) => {
      record.status = "FAILED";
      record.stoppedAt = nowIso();
      tailPush(record.outputTail, error.message);
      record.child = undefined;
    });

    this.records.set(id, record);
    return toView(record);
  }

  kill(agentId: string): AgentView {
    const record = this.records.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    if (record.status === "RUNNING" && record.child) {
      record.child.kill();
      record.status = "STOPPED";
      record.stoppedAt = nowIso();
    }

    return toView(record);
  }

  restart(agentId: string): AgentView {
    const record = this.records.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    if (record.status === "RUNNING" && record.child) {
      record.child.kill();
    }

    const child = this.spawnFn(record.command, record.args, {
      cwd: record.cwd,
      shell: false,
      stdio: "pipe",
      windowsHide: true,
    });

    record.status = "RUNNING";
    record.startedAt = nowIso();
    record.stoppedAt = undefined;
    record.lastExitCode = undefined;
    record.pid = child.pid;
    record.child = child;

    child.stdout?.on("data", (chunk: Buffer | string) => {
      tailPush(record.outputTail, chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      tailPush(record.outputTail, chunk.toString());
    });
    child.on("close", (exitCode) => {
      record.status = exitCode === 0 ? "STOPPED" : "FAILED";
      record.lastExitCode = exitCode ?? -1;
      record.stoppedAt = nowIso();
      record.child = undefined;
    });
    child.on("error", (error) => {
      record.status = "FAILED";
      record.stoppedAt = nowIso();
      tailPush(record.outputTail, error.message);
      record.child = undefined;
    });

    return toView(record);
  }
}
