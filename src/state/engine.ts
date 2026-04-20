import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  ProjectStateSchema,
  TaskSchema,
  type ProjectState,
  type Task,
} from "../types";

export type StateEngineInitInput = {
  projectName: string;
  rootDir: string;
};

const MAX_WRITE_CONFLICT_RETRIES = 3;
const RETRYABLE_WRITE_ERROR_CODES = new Set([
  "EBUSY",
  "EACCES",
  "EPERM",
  "ENOENT",
  "EEXIST",
]);

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

const STATE_FILE_MUTEXES = new Map<string, AsyncMutex>();

function getStateFileMutex(stateFilePath: string): AsyncMutex {
  const key = resolve(stateFilePath);
  const existing = STATE_FILE_MUTEXES.get(key);
  if (existing) {
    return existing;
  }

  const created = new AsyncMutex();
  STATE_FILE_MUTEXES.set(key, created);
  return created;
}

function isRetryableWriteConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && RETRYABLE_WRITE_ERROR_CODES.has(code);
}

function buildTmpStatePath(stateFilePath: string): string {
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${stateFilePath}.${process.pid}.${nonce}.tmp`;
}

export class StateEngine {
  private readonly stateFilePath: string;
  private readonly stateFileMutex: AsyncMutex;

  constructor(stateFilePath: string) {
    if (!stateFilePath.trim()) {
      throw new Error("stateFilePath must not be empty.");
    }

    this.stateFilePath = stateFilePath;
    this.stateFileMutex = getStateFileMutex(this.stateFilePath);
  }

  async initialize(input: StateEngineInitInput): Promise<ProjectState> {
    const now = new Date().toISOString();
    const state = ProjectStateSchema.parse({
      projectName: input.projectName,
      rootDir: input.rootDir,
      phases: [],
      createdAt: now,
      updatedAt: now,
    });

    await this.stateFileMutex.runExclusive(async () => {
      await this.writeRawStateWithRetry(state);
    });
    return state;
  }

  async readProjectState(): Promise<ProjectState> {
    const raw = await this.readRawStateFile();
    return this.parseRawState(raw);
  }

  async writeProjectState(state: ProjectState): Promise<ProjectState> {
    return this.stateFileMutex.runExclusive(async () =>
      this.writeProjectStateUnlocked(state),
    );
  }

  async readTasks(phaseId: string): Promise<Task[]> {
    const state = await this.readProjectState();
    const phase = state.phases.find((candidate) => candidate.id === phaseId);

    if (!phase) {
      throw new Error(`Phase not found: ${phaseId}`);
    }

    return phase.tasks;
  }

  async writeTasks(phaseId: string, tasks: Task[]): Promise<ProjectState> {
    return this.stateFileMutex.runExclusive(async () => {
      const validatedTasks = tasks.map((task) => TaskSchema.parse(task));
      const state = await this.readProjectState();
      const phaseIndex = state.phases.findIndex(
        (candidate) => candidate.id === phaseId,
      );

      if (phaseIndex < 0) {
        throw new Error(`Phase not found: ${phaseId}`);
      }

      const nextPhases = [...state.phases];
      nextPhases[phaseIndex] = {
        ...nextPhases[phaseIndex],
        tasks: validatedTasks,
      };

      return this.writeProjectStateUnlocked({
        ...state,
        phases: nextPhases,
      });
    });
  }

  private async writeProjectStateUnlocked(
    state: ProjectState,
  ): Promise<ProjectState> {
    const nextState = ProjectStateSchema.parse({
      ...state,
      updatedAt: new Date().toISOString(),
    });

    await this.writeRawStateWithRetry(nextState);
    return nextState;
  }

  private async readRawStateFile(): Promise<string> {
    try {
      return await readFile(this.stateFilePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`State file not found: ${this.stateFilePath}`);
      }

      throw error;
    }
  }

  private parseRawState(raw: string): ProjectState {
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `State file contains invalid JSON: ${this.stateFilePath}`,
      );
    }

    return ProjectStateSchema.parse(parsed);
  }

  private async writeRawStateWithRetry(state: ProjectState): Promise<void> {
    for (let attempt = 1; attempt <= MAX_WRITE_CONFLICT_RETRIES; attempt += 1) {
      try {
        await this.writeRawStateOnce(state);
        return;
      } catch (error) {
        if (
          !isRetryableWriteConflict(error) ||
          attempt === MAX_WRITE_CONFLICT_RETRIES
        ) {
          throw error;
        }
      }
    }
  }

  private async writeRawStateOnce(state: ProjectState): Promise<void> {
    const dir = dirname(this.stateFilePath);
    await mkdir(dir, { recursive: true });
    // Write to a sibling temp file first, then atomically rename into place so
    // a crash or power-loss mid-write never leaves a partially-written state
    // file.  rename(2) is atomic on POSIX when source and destination share the
    // same filesystem, which is guaranteed here because both paths share `dir`.
    const tmpPath = buildTmpStatePath(this.stateFilePath);
    try {
      await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(tmpPath, this.stateFilePath);
    } catch (error) {
      await rm(tmpPath, { force: true });
      throw error;
    }
  }
}
