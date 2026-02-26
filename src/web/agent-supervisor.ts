import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { resolveCommandForSpawn } from "../process/command-resolver";
import { ProcessStdinUnavailableError } from "../process/manager";
import { AgentFailureError } from "../errors";
import { classifyAdapterFailure } from "../adapters/failure-taxonomy";
import {
  buildAdapterExecutionTimeoutDiagnostic,
  buildAdapterStartupSilenceDiagnostic,
  formatAdapterRuntimeDiagnostic,
} from "../adapters/startup";
import {
  buildAgentHeartbeatDiagnostic,
  buildAgentIdleDiagnostic,
  formatAgentRuntimeDiagnostic,
} from "../agent-runtime-diagnostics";
import { CLIAdapterIdSchema, type CLIAdapterId } from "../types";
import {
  createRuntimeEvent,
  type RuntimeAgentStatus,
  type RuntimeEvent,
} from "../types/runtime-events";

type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export type AgentStatus = RuntimeAgentStatus;

export type StartAgentInput = {
  name: string;
  command: string;
  args?: string[];
  cwd: string;
  adapterId?: CLIAdapterId;
  phaseId?: string;
  taskId?: string;
  projectName?: string;
  /** Runtime guard: only adapter-template builders may set this to true. */
  approvedAdapterSpawn?: boolean;
};

export type RunAgentInput = StartAgentInput & {
  timeoutMs?: number;
  startupSilenceTimeoutMs?: number;
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
  onFailure?: (agent: AgentView) => void | Promise<void>;
  runtimeDiagnostics?: {
    heartbeatIntervalMs?: number;
    idleThresholdMs?: number;
  };
};

export type AssignAgentInput = {
  phaseId?: string;
  taskId?: string;
};

export type AgentEvent = RuntimeEvent;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_IDLE_DIAGNOSTIC_THRESHOLD_MS = 120_000;

/**
 * How long (ms) to wait before coalescing buffered agent-registry writes into
 * a single atomic flush.  High-frequency output events (stdout/stderr lines)
 * only dirty the in-memory buffer during this window; only terminal-state
 * transitions and explicit `flushRegistry()` calls bypass the delay.
 */
const REGISTRY_FLUSH_DEBOUNCE_MS = 200;

type RuntimeDiagnosticsConfig = {
  heartbeatIntervalMs: number;
  idleThresholdMs: number;
};

type AgentRecord = {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  adapterId?: CLIAdapterId;
  phaseId?: string;
  taskId?: string;
  projectName?: string;
  status: AgentStatus;
  pid?: number;
  startedAt: string;
  stoppedAt?: string;
  lastExitCode?: number;
  outputTail: string[];
  child?: ChildProcess;
  runToken: number;
  stopRequested: boolean;
};

export type AgentView = Omit<
  AgentRecord,
  "child" | "runToken" | "stopRequested"
>;

function nowIso(): string {
  return new Date().toISOString();
}

const MAX_TAIL_LINE_LENGTH = 240;
const IXADO_DIAGNOSTIC_PREFIX = "[ixado][";

function toView(record: AgentRecord): AgentView {
  const { child: _child, runToken: _runToken, ...view } = record;
  return view;
}

function truncateTailLine(line: string): string {
  if (line.startsWith(IXADO_DIAGNOSTIC_PREFIX)) {
    return line;
  }

  if (line.length <= MAX_TAIL_LINE_LENGTH) {
    return line;
  }

  return `${line.slice(0, MAX_TAIL_LINE_LENGTH)}...`;
}

function tailPush(lines: string[], value: string): string[] {
  const chunks = value
    .split(/\r?\n/)
    .map((line) => truncateTailLine(line.trimEnd()))
    .filter((line) => line.length > 0);

  lines.push(...chunks);
  if (lines.length > 50) {
    lines.splice(0, lines.length - 50);
  }
  return chunks;
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
    candidate.status === "RUNNING" ||
    candidate.status === "STOPPED" ||
    candidate.status === "FAILED"
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
    phaseId:
      typeof candidate.phaseId === "string" ? candidate.phaseId : undefined,
    taskId: typeof candidate.taskId === "string" ? candidate.taskId : undefined,
    adapterId: (() => {
      const result = CLIAdapterIdSchema.safeParse(candidate.adapterId);
      return result.success ? result.data : undefined;
    })(),
    projectName:
      typeof candidate.projectName === "string"
        ? candidate.projectName
        : undefined,
    status,
    pid: typeof candidate.pid === "number" ? candidate.pid : undefined,
    startedAt: candidate.startedAt,
    stoppedAt:
      typeof candidate.stoppedAt === "string" ? candidate.stoppedAt : undefined,
    lastExitCode:
      typeof candidate.lastExitCode === "number"
        ? candidate.lastExitCode
        : undefined,
    outputTail: normalizeStringArray(candidate.outputTail).map((line) =>
      truncateTailLine(line),
    ),
  };
}

export class AgentSupervisor {
  private readonly spawnFn: SpawnFn;
  private readonly registryFilePath?: string;
  private readonly onFailure?: (agent: AgentView) => void | Promise<void>;
  private readonly runtimeDiagnostics: RuntimeDiagnosticsConfig;
  private readonly records = new Map<string, AgentRecord>();
  private readonly emitter = new EventEmitter();

  // --- batched-flush state ------------------------------------------------
  // Agents whose views have changed since the last registry flush.  Keyed by
  // agent id so rapid successive updates to the same agent coalesce into one
  // entry; only the latest snapshot is written on flush.
  private readonly pendingRegistryWrites = new Map<string, AgentView>();
  private registryFlushTimer: NodeJS.Timeout | undefined;
  // -------------------------------------------------------------------------

  constructor(
    spawnOrOptions: SpawnFn | AgentSupervisorOptions = spawn,
    registryFilePath?: string,
  ) {
    if (typeof spawnOrOptions === "function") {
      this.spawnFn = spawnOrOptions;
      this.registryFilePath = registryFilePath;
      this.runtimeDiagnostics = {
        heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
        idleThresholdMs: DEFAULT_IDLE_DIAGNOSTIC_THRESHOLD_MS,
      };
      return;
    }

    this.spawnFn = spawnOrOptions.spawnFn ?? spawn;
    this.registryFilePath = spawnOrOptions.registryFilePath;
    this.onFailure = spawnOrOptions.onFailure;
    this.runtimeDiagnostics = {
      heartbeatIntervalMs:
        spawnOrOptions.runtimeDiagnostics?.heartbeatIntervalMs ??
        DEFAULT_HEARTBEAT_INTERVAL_MS,
      idleThresholdMs:
        spawnOrOptions.runtimeDiagnostics?.idleThresholdMs ??
        DEFAULT_IDLE_DIAGNOSTIC_THRESHOLD_MS,
    };
    if (
      !Number.isFinite(this.runtimeDiagnostics.heartbeatIntervalMs) ||
      this.runtimeDiagnostics.heartbeatIntervalMs <= 0
    ) {
      throw new Error("runtime heartbeatIntervalMs must be > 0.");
    }
    if (
      !Number.isFinite(this.runtimeDiagnostics.idleThresholdMs) ||
      this.runtimeDiagnostics.idleThresholdMs <= 0
    ) {
      throw new Error("runtime idleThresholdMs must be > 0.");
    }
  }

  subscribe(
    agentId: string,
    listener: (event: AgentEvent) => void,
  ): () => void {
    const wrapper = (event: AgentEvent) => {
      if (event.agentId === agentId) {
        listener(event);
      }
    };
    this.emitter.on("event", wrapper);
    return () => {
      this.emitter.off("event", wrapper);
    };
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

      console.warn(
        `Unable to read agent registry: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  private writePersistedAgents(agents: AgentView[]): void {
    if (!this.registryFilePath) {
      return;
    }

    try {
      const dir = dirname(this.registryFilePath);
      mkdirSync(dir, { recursive: true });
      // Atomic write: write to a sibling temp file, then rename into place so
      // a mid-write crash never leaves a partially-written registry.
      const tmpPath = `${this.registryFilePath}.tmp`;
      writeFileSync(tmpPath, `${JSON.stringify(agents, null, 2)}\n`, "utf8");
      renameSync(tmpPath, this.registryFilePath);
    } catch (error) {
      console.warn(
        `Unable to write agent registry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Schedule a debounced registry flush.  If a flush is already pending this
   * is a no-op; the existing timer will coalesce all dirty records.
   */
  private scheduleRegistryFlush(): void {
    if (this.registryFlushTimer !== undefined) {
      return;
    }
    const timer = setTimeout(() => {
      this.doFlushRegistry();
    }, REGISTRY_FLUSH_DEBOUNCE_MS);
    // unref so a pending flush timer does not prevent the Node/Bun process
    // from exiting cleanly (terminal-transition flushes are always synchronous
    // and happen before any shutdown path).
    timer.unref();
    this.registryFlushTimer = timer;
  }

  /**
   * Synchronously merge all pending registry writes and persist them.
   * Clears the flush timer and the pending-write buffer.
   */
  private doFlushRegistry(): void {
    clearTimeout(this.registryFlushTimer);
    this.registryFlushTimer = undefined;

    if (!this.registryFilePath || this.pendingRegistryWrites.size === 0) {
      return;
    }

    // Read current on-disk state so that agents from previous sessions that
    // are no longer in the in-memory map are preserved.
    const current = this.readPersistedAgents();
    const merged = new Map<string, AgentView>(current.map((a) => [a.id, a]));
    for (const [id, view] of this.pendingRegistryWrites) {
      merged.set(id, view);
    }
    this.pendingRegistryWrites.clear();
    this.writePersistedAgents([...merged.values()]);
  }

  /**
   * Flush any pending agent-registry writes to disk immediately.
   * Useful for explicit shutdown paths or testing.
   */
  flushRegistry(): void {
    this.doFlushRegistry();
  }

  private persistRecord(record: AgentRecord): void {
    if (!this.registryFilePath) {
      return;
    }

    const view = toView(record);
    this.pendingRegistryWrites.set(record.id, view);

    // Terminal transitions (STOPPED / FAILED) must be written immediately so
    // that a crash or restart sees the final status without waiting for a
    // timer.  All other updates (output-tail growth while RUNNING) are
    // coalesced into a debounced batch flush to reduce write amplification.
    const isTerminal =
      record.status === "STOPPED" || record.status === "FAILED";
    if (isTerminal) {
      this.doFlushRegistry();
    } else {
      this.scheduleRegistryFlush();
    }
  }

  /**
   * Reconciles persisted agents that are still marked RUNNING from a prior
   * process that is no longer alive.  Should be called once at startup before
   * any new agents are spawned so that stale RUNNING entries do not pollute the
   * UI or the task-execution tracking logic.
   *
   * Returns the number of agents that were updated.
   */
  reconcileStaleRunningAgents(): number {
    if (!this.registryFilePath) {
      return 0;
    }

    const persisted = this.readPersistedAgents();
    let reconcileCount = 0;
    const updated = persisted.map((agent) => {
      if (agent.status !== "RUNNING") {
        return agent;
      }
      reconcileCount += 1;
      return {
        ...agent,
        status: "STOPPED" as AgentStatus,
        stoppedAt: nowIso(),
      };
    });

    if (reconcileCount > 0) {
      this.writePersistedAgents(updated);
    }

    return reconcileCount;
  }

  /**
   * Reconciles RUNNING agents using an external consistency predicate (for
   * example, cross-store task-state checks at startup).
   *
   * Returns the number of agents transitioned from RUNNING to STOPPED.
   */
  reconcileRunningAgentsWhere(
    predicate: (agent: AgentView) => boolean,
  ): number {
    if (!this.registryFilePath) {
      return 0;
    }

    const stoppedAt = nowIso();
    let reconcileCount = 0;
    const persisted = this.readPersistedAgents();
    const updated = persisted.map((agent) => {
      if (agent.status !== "RUNNING") {
        return agent;
      }
      if (!predicate(agent)) {
        return agent;
      }

      reconcileCount += 1;
      return {
        ...agent,
        status: "STOPPED" as AgentStatus,
        stoppedAt,
      };
    });

    if (reconcileCount > 0) {
      this.writePersistedAgents(updated);
      for (const [id, record] of this.records.entries()) {
        if (record.status !== "RUNNING") {
          continue;
        }
        const view = toView(record);
        if (!predicate(view)) {
          continue;
        }

        this.records.set(id, {
          ...record,
          status: "STOPPED",
          stoppedAt,
        });
      }
    }

    return reconcileCount;
  }

  list(): AgentView[] {
    const inMemory = [...this.records.values()].map(toView);
    if (!this.registryFilePath) {
      return inMemory;
    }

    const merged = new Map<string, AgentView>(
      this.readPersistedAgents().map((agent) => [agent.id, agent]),
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
    if (!input.approvedAdapterSpawn) {
      throw new Error(
        "raw agent command execution is blocked. Use approved adapter command builders only.",
      );
    }

    return {
      id: randomUUID(),
      name: input.name,
      command: input.command,
      args: input.args ?? [],
      cwd: input.cwd,
      adapterId: input.adapterId,
      phaseId: input.phaseId,
      taskId: input.taskId,
      projectName: input.projectName,
      status: "RUNNING",
      startedAt: nowIso(),
      outputTail: [],
      runToken: 0,
      stopRequested: false,
    };
  }

  private emit(event: AgentEvent): void {
    this.emitter.emit("event", event);
  }

  private emitAdapterOutput(
    record: AgentRecord,
    stream: "stdout" | "stderr" | "system",
    line: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.emit(
      createRuntimeEvent({
        family: "adapter-output",
        type: "adapter.output",
        payload: {
          stream,
          line,
          metadata,
          isDiagnostic: stream === "system",
        },
        context: {
          source: "AGENT_SUPERVISOR",
          agentId: record.id,
          adapterId: record.adapterId,
          phaseId: record.phaseId,
          taskId: record.taskId,
          projectName: record.projectName,
        },
      }),
    );
  }

  private emitTerminalOutcome(
    record: AgentRecord,
    input: {
      outcome: "success" | "failure" | "cancelled";
      summary: string;
      exitCode?: number;
    },
  ): void {
    this.emit(
      createRuntimeEvent({
        family: "terminal-outcome",
        type: "terminal.outcome",
        payload: {
          outcome: input.outcome,
          summary: input.summary,
          agentStatus: record.status,
          exitCode: input.exitCode,
        },
        context: {
          source: "AGENT_SUPERVISOR",
          agentId: record.id,
          adapterId: record.adapterId,
          phaseId: record.phaseId,
          taskId: record.taskId,
          projectName: record.projectName,
        },
      }),
    );
  }

  private spawnRecord(
    record: AgentRecord,
    options: {
      env?: NodeJS.ProcessEnv;
      stdin?: string;
      timeoutMs?: number;
      startupSilenceTimeoutMs?: number;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
      onClose?: (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ) => void;
      onError?: (error: Error) => void;
      onTimeout?: () => void;
    } = {},
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
    record.stopRequested = false;
    this.persistRecord(record);

    let timeoutHandle: NodeJS.Timeout | undefined;
    let silenceHandle: NodeJS.Timeout | undefined;
    let heartbeatHandle: NodeJS.Timeout | undefined;
    let hasReceivedOutput = false;
    const startedAtMs = Date.now();
    let lastOutputAtMs = startedAtMs;
    let lastIdleDiagnosticBucket = -1;

    const cancelSilenceTimer = () => {
      clearTimeout(silenceHandle);
    };
    const appendSystemOutput = (message: string) => {
      const lines = tailPush(record.outputTail, message);
      this.persistRecord(record);
      lines.forEach((line) => this.emitAdapterOutput(record, "system", line));
    };
    const markOutputReceived = () => {
      if (!hasReceivedOutput) {
        hasReceivedOutput = true;
        cancelSilenceTimer();
      }
      lastOutputAtMs = Date.now();
      lastIdleDiagnosticBucket = -1;
    };
    const clearRuntimeTimers = () => {
      clearTimeout(timeoutHandle);
      cancelSilenceTimer();
      clearInterval(heartbeatHandle);
    };

    if (options.startupSilenceTimeoutMs !== undefined) {
      const silenceMs = options.startupSilenceTimeoutMs;
      silenceHandle = setTimeout(() => {
        if (runToken !== record.runToken) {
          return;
        }
        if (!hasReceivedOutput && record.child !== undefined) {
          const message = formatAdapterRuntimeDiagnostic(
            buildAdapterStartupSilenceDiagnostic({
              adapterId: record.adapterId,
              command: record.command,
              startupSilenceTimeoutMs: silenceMs,
            }),
          );
          appendSystemOutput(message);
        }
      }, silenceMs);
    }

    heartbeatHandle = setInterval(() => {
      if (runToken !== record.runToken || record.child === undefined) {
        return;
      }
      const nowMs = Date.now();
      const elapsedMs = Math.max(0, nowMs - startedAtMs);
      const idleMs = Math.max(0, nowMs - lastOutputAtMs);
      const heartbeat = formatAgentRuntimeDiagnostic(
        buildAgentHeartbeatDiagnostic({
          agentId: record.id,
          adapterId: record.adapterId,
          command: record.command,
          elapsedMs,
          idleMs,
        }),
      );
      appendSystemOutput(heartbeat);

      if (idleMs < this.runtimeDiagnostics.idleThresholdMs) {
        return;
      }
      const idleBucket = Math.floor(
        idleMs / this.runtimeDiagnostics.idleThresholdMs,
      );
      if (idleBucket <= lastIdleDiagnosticBucket) {
        return;
      }
      lastIdleDiagnosticBucket = idleBucket;
      const diagnostic = formatAgentRuntimeDiagnostic(
        buildAgentIdleDiagnostic({
          agentId: record.id,
          adapterId: record.adapterId,
          command: record.command,
          elapsedMs,
          idleMs,
          idleThresholdMs: this.runtimeDiagnostics.idleThresholdMs,
        }),
      );
      appendSystemOutput(diagnostic);
    }, this.runtimeDiagnostics.heartbeatIntervalMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (runToken !== record.runToken) {
        return;
      }
      markOutputReceived();
      const value = chunk.toString();
      const lines = tailPush(record.outputTail, value);
      this.persistRecord(record);
      lines.forEach((line) => this.emitAdapterOutput(record, "stdout", line));
      options.onStdout?.(value);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (runToken !== record.runToken) {
        return;
      }
      markOutputReceived();
      const value = chunk.toString();
      const lines = tailPush(record.outputTail, value);
      this.persistRecord(record);
      lines.forEach((line) => this.emitAdapterOutput(record, "stderr", line));
      options.onStderr?.(value);
    });
    child.on("close", (exitCode, signal) => {
      clearRuntimeTimers();
      if (runToken !== record.runToken) {
        return;
      }
      if (record.stopRequested) {
        record.status = "STOPPED";
      } else {
        record.status = exitCode === 0 ? "STOPPED" : "FAILED";
      }
      record.lastExitCode = exitCode ?? -1;
      record.stoppedAt = nowIso();
      record.child = undefined;
      record.stopRequested = false;
      this.persistRecord(record);
      this.emitTerminalOutcome(record, {
        outcome:
          record.status === "FAILED"
            ? "failure"
            : signal
              ? "cancelled"
              : "success",
        summary:
          record.status === "FAILED"
            ? `Agent failed with exit code ${exitCode ?? -1}.`
            : signal
              ? `Agent stopped by signal ${signal}.`
              : `Agent completed with exit code ${exitCode ?? 0}.`,
        exitCode: exitCode ?? undefined,
      });
      if (record.status === "FAILED") {
        this.onFailure?.(toView(record));
      }
      options.onClose?.(exitCode, signal);
    });
    child.on("error", (error) => {
      clearRuntimeTimers();
      if (runToken !== record.runToken) {
        return;
      }
      record.status = "FAILED";
      record.stoppedAt = nowIso();
      const lines = tailPush(record.outputTail, error.message);
      record.child = undefined;
      record.stopRequested = false;
      this.persistRecord(record);
      lines.forEach((line) => this.emitAdapterOutput(record, "system", line));
      this.emitTerminalOutcome(record, {
        outcome: "failure",
        summary: `Agent execution error: ${error.message}`,
      });
      this.onFailure?.(toView(record));
      options.onError?.(error);
    });

    if (options.stdin !== undefined) {
      if (!child.stdin) {
        throw new ProcessStdinUnavailableError(record.command);
      }
      child.stdin.end(options.stdin);
    } else {
      child.stdin?.end();
    }

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
    // Flush the initial RUNNING entry immediately so that other supervisor
    // instances (e.g., web-UI processes) can observe the new agent without
    // waiting for the debounce timer.
    this.doFlushRegistry();

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
        startupSilenceTimeoutMs: input.startupSilenceTimeoutMs,
        onStdout: (chunk) => {
          stdout += chunk;
        },
        onStderr: (chunk) => {
          stderr += chunk;
        },
        onTimeout: () => {
          timedOut = true;
          const timeoutMs = input.timeoutMs ?? 0;
          const message = formatAdapterRuntimeDiagnostic(
            buildAdapterExecutionTimeoutDiagnostic({
              adapterId: record.adapterId,
              command: record.command,
              timeoutMs,
              outputReceived: stdout.length > 0 || stderr.length > 0,
            }),
          );
          const lines = tailPush(record.outputTail, message);
          this.persistRecord(record);
          lines.forEach((line) =>
            this.emitAdapterOutput(record, "system", line),
          );
        },
        onError: (error) => {
          settle(() =>
            reject(
              new AgentFailureError(
                `Agent supervisor execution error: ${error.message}`,
                classifyAdapterFailure(error),
              ),
            ),
          );
        },
        onClose: (exitCode) => {
          settle(() => {
            if (timedOut) {
              reject(
                new AgentFailureError(
                  `Command timed out after ${input.timeoutMs}ms: ${record.command}`,
                  "timeout",
                ),
              );
              return;
            }

            if ((exitCode ?? -1) !== 0) {
              reject(
                new AgentFailureError(
                  `Command failed with exit code ${exitCode ?? -1}: ${record.command} ${record.args.join(" ")}`.trim(),
                  classifyAdapterFailure(stderr || stdout),
                ),
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
      record.stopRequested = true;
      const lines = tailPush(record.outputTail, "Agent kill requested.");
      record.child.kill();
      record.status = "STOPPED";
      record.lastExitCode = -1;
      record.stoppedAt = nowIso();
      lines.forEach((line) => this.emitAdapterOutput(record, "system", line));
      this.emitTerminalOutcome(record, {
        outcome: "cancelled",
        summary: "Agent kill requested.",
        exitCode: -1,
      });
      this.onFailure?.(toView(record));
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
    this.emit(
      createRuntimeEvent({
        family: "task-lifecycle",
        type: "task.lifecycle.progress",
        payload: {
          message: "Agent restarted.",
        },
        context: {
          source: "AGENT_SUPERVISOR",
          projectName: record.projectName,
          phaseId: record.phaseId,
          taskId: record.taskId,
          agentId: record.id,
          adapterId: record.adapterId,
        },
      }),
    );

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
