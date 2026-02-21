import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { resolveCommandForSpawn } from "../process/command-resolver";

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

export type RunAgentInput = StartAgentInput & {
  timeoutMs?: number;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
};

export type RunAgentResult = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type AgentSupervisorOptions = {
  spawnFn?: SpawnFn;
  registryFilePath?: string;
};

export type AssignAgentInput = {
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
  runToken: number;
};

export type AgentView = Omit<AgentRecord, "child" | "runToken">;

function nowIso(): string {
  return new Date().toISOString();
}

const MAX_TAIL_LINE_LENGTH = 240;

function toView(record: AgentRecord): AgentView {
  const { child: _child, runToken: _runToken, ...view } = record;
  return view;
}

function truncateTailLine(line: string): string {
  if (line.length <= MAX_TAIL_LINE_LENGTH) {
    return line;
  }

  return `${line.slice(0, MAX_TAIL_LINE_LENGTH)}...`;
}

function tailPush(lines: string[], value: string): void {
  const chunks = value
    .split(/\r?\n/)
    .map((line) => truncateTailLine(line.trimEnd()))
    .filter((line) => line.length > 0);

  lines.push(...chunks);
  if (lines.length > 50) {
    lines.splice(0, lines.length - 50);
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function parsePersistedAgent(value: unknown): AgentView | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.command !== "string" ||
    typeof candidate.cwd !== "string" ||
    typeof candidate.startedAt !== "string"
  ) {
    return null;
  }

  const status =
    candidate.status === "RUNNING" || candidate.status === "STOPPED" || candidate.status === "FAILED"
      ? candidate.status
      : null;
  if (!status) {
    return null;
  }

  return {
    id: candidate.id,
    name: candidate.name,
    command: candidate.command,
    args: normalizeStringArray(candidate.args),
    cwd: candidate.cwd,
    phaseId: typeof candidate.phaseId === "string" ? candidate.phaseId : undefined,
    taskId: typeof candidate.taskId === "string" ? candidate.taskId : undefined,
    status,
    pid: typeof candidate.pid === "number" ? candidate.pid : undefined,
    startedAt: candidate.startedAt,
    stoppedAt: typeof candidate.stoppedAt === "string" ? candidate.stoppedAt : undefined,
    lastExitCode: typeof candidate.lastExitCode === "number" ? candidate.lastExitCode : undefined,
    outputTail: normalizeStringArray(candidate.outputTail).map((line) => truncateTailLine(line)),
  };
}

export class AgentSupervisor {
  private readonly spawnFn: SpawnFn;
  private readonly registryFilePath?: string;
  private readonly records = new Map<string, AgentRecord>();

  constructor(spawnOrOptions: SpawnFn | AgentSupervisorOptions = spawn, registryFilePath?: string) {
    if (typeof spawnOrOptions === "function") {
      this.spawnFn = spawnOrOptions;
      this.registryFilePath = registryFilePath;
      return;
    }

    this.spawnFn = spawnOrOptions.spawnFn ?? spawn;
    this.registryFilePath = spawnOrOptions.registryFilePath;
  }

  private readPersistedAgents(): AgentView[] {
    if (!this.registryFilePath) {
      return [];
    }

    try {
      const raw = readFileSync(this.registryFilePath, "utf8").trim();
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .map((item) => parsePersistedAgent(item))
        .filter((item): item is AgentView => item !== null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      console.warn(`Unable to read agent registry: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private writePersistedAgents(agents: AgentView[]): void {
    if (!this.registryFilePath) {
      return;
    }

    try {
      mkdirSync(dirname(this.registryFilePath), { recursive: true });
      writeFileSync(this.registryFilePath, `${JSON.stringify(agents, null, 2)}\n`, "utf8");
    } catch (error) {
      console.warn(`Unable to write agent registry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persistRecord(record: AgentRecord): void {
    if (!this.registryFilePath) {
      return;
    }

    const view = toView(record);
    const current = this.readPersistedAgents();
    const existingIndex = current.findIndex((agent) => agent.id === view.id);
    if (existingIndex >= 0) {
      current[existingIndex] = view;
    } else {
      current.push(view);
    }

    this.writePersistedAgents(current);
  }

  list(): AgentView[] {
    const inMemory = [...this.records.values()].map(toView);
    if (!this.registryFilePath) {
      return inMemory;
    }

    const merged = new Map<string, AgentView>(
      this.readPersistedAgents().map((agent) => [agent.id, agent])
    );
    for (const local of inMemory) {
      merged.set(local.id, local);
    }
    return [...merged.values()];
  }

  private createRecord(input: StartAgentInput): AgentRecord {
    if (!input.name.trim()) {
      throw new Error("agent name must not be empty.");
    }
    if (!input.command.trim()) {
      throw new Error("agent command must not be empty.");
    }
    if (!input.cwd.trim()) {
      throw new Error("agent cwd must not be empty.");
    }

    return {
      id: randomUUID(),
      name: input.name,
      command: input.command,
      args: input.args ?? [],
      cwd: input.cwd,
      phaseId: input.phaseId,
      taskId: input.taskId,
      status: "RUNNING",
      startedAt: nowIso(),
      outputTail: [],
      runToken: 0,
    };
  }

  private spawnRecord(
    record: AgentRecord,
    options: {
      env?: NodeJS.ProcessEnv;
      stdin?: string;
      timeoutMs?: number;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
      onClose?: (exitCode: number | null, signal: NodeJS.Signals | null) => void;
      onError?: (error: Error) => void;
      onTimeout?: () => void;
    } = {}
  ): ChildProcess {
    record.runToken += 1;
    const runToken = record.runToken;
    const env = options.env ?? process.env;
    const resolvedCommand = resolveCommandForSpawn(record.command, env);

    const child = this.spawnFn(resolvedCommand, record.args, {
      cwd: record.cwd,
      env,
      shell: false,
      stdio: "pipe",
      windowsHide: true,
    });

    record.pid = child.pid;
    record.child = child;
    this.persistRecord(record);

    let timeoutHandle: NodeJS.Timeout | undefined;
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (runToken !== record.runToken) {
        return;
      }
      const value = chunk.toString();
      tailPush(record.outputTail, value);
      this.persistRecord(record);
      options.onStdout?.(value);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (runToken !== record.runToken) {
        return;
      }
      const value = chunk.toString();
      tailPush(record.outputTail, value);
      this.persistRecord(record);
      options.onStderr?.(value);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeoutHandle);
      if (runToken !== record.runToken) {
        return;
      }
      record.status = exitCode === 0 ? "STOPPED" : "FAILED";
      record.lastExitCode = exitCode ?? -1;
      record.stoppedAt = nowIso();
      record.child = undefined;
      this.persistRecord(record);
      options.onClose?.(exitCode, signal);
    });
    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      if (runToken !== record.runToken) {
        return;
      }
      record.status = "FAILED";
      record.stoppedAt = nowIso();
      tailPush(record.outputTail, error.message);
      record.child = undefined;
      this.persistRecord(record);
      options.onError?.(error);
    });

    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();

    if (options.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        options.onTimeout?.();
        child.kill();
      }, options.timeoutMs);
    }

    return child;
  }

  start(input: StartAgentInput): AgentView {
    const record = this.createRecord(input);
    this.records.set(record.id, record);
    this.persistRecord(record);
    this.spawnRecord(record);

    return toView(record);
  }

  async runToCompletion(input: RunAgentInput): Promise<RunAgentResult> {
    const record = this.createRecord(input);
    this.records.set(record.id, record);

    return new Promise<RunAgentResult>((resolve, reject) => {
      const startedAtMs = Date.now();
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;

      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        callback();
      };

      this.spawnRecord(record, {
        env: input.env,
        stdin: input.stdin,
        timeoutMs: input.timeoutMs,
        onStdout: (chunk) => {
          stdout += chunk;
        },
        onStderr: (chunk) => {
          stderr += chunk;
        },
        onTimeout: () => {
          timedOut = true;
          tailPush(record.outputTail, `Command timed out after ${input.timeoutMs}ms.`);
        },
        onError: (error) => {
          settle(() => reject(error));
        },
        onClose: (exitCode) => {
          settle(() => {
            if (timedOut) {
              reject(new Error(`Command timed out after ${input.timeoutMs}ms: ${record.command}`));
              return;
            }

            if ((exitCode ?? -1) !== 0) {
              reject(
                new Error(
                  `Command failed with exit code ${exitCode ?? -1}: ${record.command} ${record.args.join(" ")}`.trim()
                )
              );
              return;
            }

            resolve({
              id: record.id,
              command: record.command,
              args: [...record.args],
              cwd: record.cwd,
              stdout,
              stderr,
              durationMs: Date.now() - startedAtMs,
            });
          });
        },
      });
    });
  }

  kill(agentId: string): AgentView {
    const record = this.records.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    if (record.status === "RUNNING" && record.child) {
      record.runToken += 1;
      const child = record.child;
      record.child = undefined;
      child.kill();
      record.status = "STOPPED";
      record.stoppedAt = nowIso();
    }
    this.persistRecord(record);

    return toView(record);
  }

  restart(agentId: string): AgentView {
    const record = this.records.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    if (record.status === "RUNNING" && record.child) {
      record.runToken += 1;
      record.child.kill();
    }

    record.status = "RUNNING";
    record.startedAt = nowIso();
    record.stoppedAt = undefined;
    record.lastExitCode = undefined;
    this.persistRecord(record);
    this.spawnRecord(record);

    return toView(record);
  }

  assign(agentId: string, input: AssignAgentInput): AgentView {
    const record = this.records.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const rawPhaseId = input.phaseId?.trim();
    const rawTaskId = input.taskId?.trim();
    record.phaseId = rawPhaseId && rawTaskId ? rawPhaseId : undefined;
    record.taskId = rawTaskId || undefined;
    if (!record.taskId) {
      record.phaseId = undefined;
    }
    this.persistRecord(record);

    return toView(record);
  }
}
