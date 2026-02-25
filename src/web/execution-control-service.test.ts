import { describe, expect, test } from "bun:test";

import { ExecutionControlService } from "./execution-control-service";
import type { CLIAdapterId, ProjectState } from "../types";

function createState(taskStatus: "TODO" | "IN_PROGRESS" | "DONE" | "FAILED") {
  const now = new Date().toISOString();
  return {
    projectName: "alpha",
    rootDir: "/tmp/alpha",
    phases: [
      {
        id: "phase-1",
        name: "Phase 1",
        branchName: "phase-1",
        status: "CODING",
        tasks: [
          {
            id: "task-1",
            title: "Task 1",
            description: "desc",
            status: taskStatus,
            assignee: "UNASSIGNED",
            dependencies: [],
          },
        ],
      },
    ],
    activePhaseId: "phase-1",
    createdAt: now,
    updatedAt: now,
  } as unknown as ProjectState;
}

describe("ExecutionControlService", () => {
  test("runs auto mode until no actionable task remains", async () => {
    let state = createState("TODO");
    const startCalls: Array<{ assignee: CLIAdapterId }> = [];
    const service = new ExecutionControlService({
      control: {
        getState: async () => state,
        startTaskAndWait: async (input: { assignee: CLIAdapterId }) => {
          startCalls.push({ assignee: input.assignee });
          state = createState("DONE");
          return state;
        },
      } as never,
      agents: {
        list: () => [],
        kill: () => {
          throw new Error("unexpected kill");
        },
      },
      projectRootDir: "/tmp/alpha",
      projectName: "alpha",
      resolveDefaultAssignee: async () => "CODEX_CLI",
    });

    await service.startAuto({ projectName: "alpha" });
    for (let retry = 0; retry < 20; retry += 1) {
      const status = service.getStatus("alpha");
      if (!status.running) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const finalStatus = service.getStatus("alpha");
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]?.assignee).toBe("CODEX_CLI");
    expect(finalStatus.running).toBe(false);
    expect(finalStatus.message).toContain("No TODO or CI_FIX tasks remain");
  });

  test("stop kills active agent and resets failed task to TODO", async () => {
    let state = createState("TODO");
    let resetCalled = false;
    let runResolver: ((value: ProjectState) => void) | null = null;
    let runningAgent = true;

    const service = new ExecutionControlService({
      control: {
        getState: async () => state,
        startTaskAndWait: async () => {
          state = createState("IN_PROGRESS");
          return new Promise<ProjectState>((resolve) => {
            runResolver = resolve;
          });
        },
        resetTaskToTodo: async () => {
          resetCalled = true;
          state = createState("TODO");
          return state;
        },
      } as never,
      agents: {
        list: () =>
          runningAgent
            ? ([
                {
                  id: "agent-1",
                  projectName: "alpha",
                  phaseId: "phase-1",
                  taskId: "task-1",
                  status: "RUNNING",
                },
              ] as never)
            : [],
        kill: () => {
          runningAgent = false;
          state = createState("FAILED");
          if (runResolver) {
            runResolver(state);
            runResolver = null;
          }
          return {} as never;
        },
      },
      projectRootDir: "/tmp/alpha",
      projectName: "alpha",
      resolveDefaultAssignee: async () => "CODEX_CLI",
      sleep: async () => {},
    });

    await service.startAuto({ projectName: "alpha" });
    for (let retry = 0; retry < 20; retry += 1) {
      if (service.getStatus("alpha").taskId === "task-1") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const stopped = await service.stop({ projectName: "alpha" });
    expect(resetCalled).toBe(true);
    expect(stopped.message).toMatch(
      /Stop requested|Reset to the last completed task/,
    );
    expect(service.getStatus("alpha").running).toBe(false);
    expect(state.phases[0].tasks[0].status).toBe("TODO");
  });
});
