import { randomUUID } from "node:crypto";

import type { StateEngine } from "../state";
import { PhaseSchema, TaskSchema, type ProjectState, type WorkerAssignee } from "../types";

export type CreatePhaseInput = {
  name: string;
  branchName: string;
};

export type CreateTaskInput = {
  phaseId: string;
  title: string;
  description: string;
  assignee?: WorkerAssignee;
  dependencies?: string[];
};

export class ControlCenterService {
  private readonly state: StateEngine;

  constructor(state: StateEngine) {
    this.state = state;
  }

  async ensureInitialized(projectName: string, rootDir: string): Promise<ProjectState> {
    try {
      return await this.state.readProjectState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("State file not found")) {
        throw error;
      }
    }

    return this.state.initialize({ projectName, rootDir });
  }

  async getState(): Promise<ProjectState> {
    return this.state.readProjectState();
  }

  async createPhase(input: CreatePhaseInput): Promise<ProjectState> {
    if (!input.name.trim()) {
      throw new Error("phase name must not be empty.");
    }
    if (!input.branchName.trim()) {
      throw new Error("branch name must not be empty.");
    }

    const state = await this.state.readProjectState();
    const phase = PhaseSchema.parse({
      id: randomUUID(),
      name: input.name.trim(),
      branchName: input.branchName.trim(),
      status: "PLANNING",
      tasks: [],
    });

    return this.state.writeProjectState({
      ...state,
      activePhaseId: phase.id,
      phases: [...state.phases, phase],
    });
  }

  async createTask(input: CreateTaskInput): Promise<ProjectState> {
    if (!input.phaseId.trim()) {
      throw new Error("phaseId must not be empty.");
    }
    if (!input.title.trim()) {
      throw new Error("task title must not be empty.");
    }
    if (!input.description.trim()) {
      throw new Error("task description must not be empty.");
    }

    const state = await this.state.readProjectState();
    const phaseIndex = state.phases.findIndex((phase) => phase.id === input.phaseId);
    if (phaseIndex < 0) {
      throw new Error(`Phase not found: ${input.phaseId}`);
    }

    const task = TaskSchema.parse({
      id: randomUUID(),
      title: input.title.trim(),
      description: input.description.trim(),
      assignee: input.assignee ?? "UNASSIGNED",
      dependencies: input.dependencies ?? [],
      status: "TODO",
    });

    const nextPhases = [...state.phases];
    nextPhases[phaseIndex] = {
      ...nextPhases[phaseIndex],
      tasks: [...nextPhases[phaseIndex].tasks, task],
    };

    return this.state.writeProjectState({
      ...state,
      phases: nextPhases,
    });
  }
}
