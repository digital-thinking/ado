import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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

export class StateEngine {
  private readonly stateFilePath: string;

  constructor(stateFilePath: string) {
    if (!stateFilePath.trim()) {
      throw new Error("stateFilePath must not be empty.");
    }

    this.stateFilePath = stateFilePath;
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

    await this.writeRawState(state);
    return state;
  }

  async readProjectState(): Promise<ProjectState> {
    const raw = await this.readRawStateFile();
    return this.parseRawState(raw);
  }

  async writeProjectState(state: ProjectState): Promise<ProjectState> {
    const nextState = ProjectStateSchema.parse({
      ...state,
      updatedAt: new Date().toISOString(),
    });

    await this.writeRawState(nextState);
    return nextState;
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

    return this.writeProjectState({
      ...state,
      phases: nextPhases,
    });
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

  private async writeRawState(state: ProjectState): Promise<void> {
    const dir = dirname(this.stateFilePath);
    await mkdir(dir, { recursive: true });
    // Write to a sibling temp file first, then atomically rename into place so
    // a crash or power-loss mid-write never leaves a partially-written state
    // file.  rename(2) is atomic on POSIX when source and destination share the
    // same filesystem, which is guaranteed here because both paths share `dir`.
    const tmpPath = `${this.stateFilePath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.stateFilePath);
  }
}
