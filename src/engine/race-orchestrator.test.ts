import { describe, expect, test } from "bun:test";

import { RaceOrchestrator, type RaceBranch } from "./race-orchestrator";

type ProvisionCall = {
  phaseId: string;
  branchName: string;
  fromRef?: string;
};

function createFakeWorktreeManager() {
  const provisionCalls: ProvisionCall[] = [];
  const teardownCalls: string[] = [];

  return {
    provisionCalls,
    teardownCalls,
    api: {
      async provision(input: ProvisionCall): Promise<string> {
        provisionCalls.push(input);
        return `/tmp/project/.ixado/worktrees/${input.phaseId}`;
      },
      async teardown(phaseId: string): Promise<void> {
        teardownCalls.push(phaseId);
      },
    },
  };
}

describe("RaceOrchestrator", () => {
  test("provisions race worktrees under the phase worktree directory", async () => {
    const fake = createFakeWorktreeManager();
    const orchestrator = new RaceOrchestrator(fake.api);

    const branches = await orchestrator.provisionBranches({
      phaseId: "phase-35",
      taskId: "task-123",
      raceCount: 3,
      baseBranchName: "phase-35-branch",
    });

    expect(fake.provisionCalls).toEqual([
      {
        phaseId: "phase-35/race-task-123-1",
        branchName: "phase-35-branch-race-task-123-1",
        fromRef: "phase-35-branch",
      },
      {
        phaseId: "phase-35/race-task-123-2",
        branchName: "phase-35-branch-race-task-123-2",
        fromRef: "phase-35-branch",
      },
      {
        phaseId: "phase-35/race-task-123-3",
        branchName: "phase-35-branch-race-task-123-3",
        fromRef: "phase-35-branch",
      },
    ]);
    expect(branches.map((branch) => branch.worktreePath)).toEqual([
      "/tmp/project/.ixado/worktrees/phase-35/race-task-123-1",
      "/tmp/project/.ixado/worktrees/phase-35/race-task-123-2",
      "/tmp/project/.ixado/worktrees/phase-35/race-task-123-3",
    ]);
  });

  test("fans out all race branches from the explicit source ref", async () => {
    const fake = createFakeWorktreeManager();
    const orchestrator = new RaceOrchestrator(fake.api);

    const branches = await orchestrator.provisionBranches({
      phaseId: "phase-35",
      taskId: "task-321",
      raceCount: 2,
      baseBranchName: "phase-35-branch",
      fromRef: "origin/main",
    });

    expect(fake.provisionCalls).toEqual([
      {
        phaseId: "phase-35/race-task-321-1",
        branchName: "phase-35-branch-race-task-321-1",
        fromRef: "origin/main",
      },
      {
        phaseId: "phase-35/race-task-321-2",
        branchName: "phase-35-branch-race-task-321-2",
        fromRef: "origin/main",
      },
    ]);
    expect(branches.map((branch) => branch.fromRef)).toEqual([
      "origin/main",
      "origin/main",
    ]);
  });

  test("dispatches every branch and collects fulfilled results", async () => {
    const fake = createFakeWorktreeManager();
    const orchestrator = new RaceOrchestrator(fake.api);
    const started: number[] = [];
    let releaseDispatch: (() => void) | undefined;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });

    const executionPromise = orchestrator.run({
      phaseId: "phase-35",
      taskId: "task-456",
      raceCount: 3,
      baseBranchName: "phase-35-branch",
      dispatch: async (branch) => {
        started.push(branch.index);
        await dispatchGate;
        return `result-${branch.index}`;
      },
    });

    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
    }
    expect(started).toEqual([1, 2, 3]);

    releaseDispatch?.();
    const result = await executionPromise;

    expect(
      result.branches.map((branch) => ({
        index: branch.index,
        status: branch.status,
        result: branch.status === "fulfilled" ? branch.result : null,
      })),
    ).toEqual([
      { index: 1, status: "fulfilled", result: "result-1" },
      { index: 2, status: "fulfilled", result: "result-2" },
      { index: 3, status: "fulfilled", result: "result-3" },
    ]);
  });

  test("collects rejected branch results without failing the whole race", async () => {
    const fake = createFakeWorktreeManager();
    const orchestrator = new RaceOrchestrator(fake.api);

    const result = await orchestrator.run({
      phaseId: "phase-35",
      taskId: "task-789",
      raceCount: 3,
      baseBranchName: "phase-35-branch",
      dispatch: async (branch: RaceBranch) => {
        if (branch.index === 2) {
          throw new Error("branch failed");
        }

        return `result-${branch.index}`;
      },
    });

    expect(result.branches[0]).toMatchObject({
      index: 1,
      status: "fulfilled",
      result: "result-1",
    });
    expect(result.branches[1]?.status).toBe("rejected");
    if (result.branches[1]?.status !== "rejected") {
      throw new Error("Expected rejected branch result.");
    }
    expect(result.branches[1].error.message).toBe("branch failed");
    expect(result.branches[2]).toMatchObject({
      index: 3,
      status: "fulfilled",
      result: "result-3",
    });
  });

  test("tears down already provisioned race worktrees when provisioning fails", async () => {
    const fake = createFakeWorktreeManager();
    let provisionCount = 0;
    const orchestrator = new RaceOrchestrator({
      async provision(input) {
        provisionCount += 1;
        if (provisionCount === 2) {
          throw new Error("provision failed");
        }

        return fake.api.provision(input);
      },
      async teardown(phaseId) {
        await fake.api.teardown(phaseId);
      },
    });

    await expect(
      orchestrator.provisionBranches({
        phaseId: "phase-35",
        taskId: "task-000",
        raceCount: 3,
        baseBranchName: "phase-35-branch",
      }),
    ).rejects.toThrow("provision failed");
    expect(fake.teardownCalls).toEqual(["phase-35/race-task-000-1"]);
  });
});
