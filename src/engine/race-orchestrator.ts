import type { WorktreeManager } from "../vcs";

export type RaceBranch = {
  index: number;
  phaseId: string;
  taskId: string;
  worktreeId: string;
  worktreePath: string;
  branchName: string;
  fromRef: string;
};

export type RaceBranchResult<TResult> =
  | (RaceBranch & {
      status: "fulfilled";
      result: TResult;
    })
  | (RaceBranch & {
      status: "rejected";
      error: Error;
    });

export type ProvisionRaceInput = {
  phaseId: string;
  taskId: string;
  raceCount: number;
  baseBranchName: string;
  fromRef?: string;
};

export type RunRaceInput<TResult> = ProvisionRaceInput & {
  dispatch: (branch: RaceBranch) => Promise<TResult>;
};

export type RaceExecutionResult<TResult> = {
  branches: RaceBranchResult<TResult>[];
};

type WorktreeManagerApi = Pick<WorktreeManager, "provision" | "teardown">;

function normalizeRequiredValue(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} must not be empty.`);
  }

  return normalized;
}

function normalizeRaceCount(raceCount: number): number {
  if (!Number.isInteger(raceCount) || raceCount <= 0) {
    throw new Error("raceCount must be a positive integer.");
  }

  return raceCount;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function buildRaceWorktreeId(
  phaseId: string,
  taskId: string,
  index: number,
): string {
  return `${phaseId}/race-${taskId}-${index}`;
}

export function buildRaceBranchName(
  baseBranchName: string,
  taskId: string,
  index: number,
): string {
  return `${baseBranchName}-race-${taskId}-${index}`;
}

export class RaceOrchestrator {
  constructor(private readonly worktreeManager: WorktreeManagerApi) {}

  async provisionBranches(input: ProvisionRaceInput): Promise<RaceBranch[]> {
    const phaseId = normalizeRequiredValue(input.phaseId, "phaseId");
    const taskId = normalizeRequiredValue(input.taskId, "taskId");
    const baseBranchName = normalizeRequiredValue(
      input.baseBranchName,
      "baseBranchName",
    );
    const raceCount = normalizeRaceCount(input.raceCount);
    const fromRef = input.fromRef?.trim() || baseBranchName;
    const provisioned: RaceBranch[] = [];

    try {
      for (let index = 1; index <= raceCount; index += 1) {
        const worktreeId = buildRaceWorktreeId(phaseId, taskId, index);
        const branchName = buildRaceBranchName(baseBranchName, taskId, index);
        const worktreePath = await this.worktreeManager.provision({
          phaseId: worktreeId,
          branchName,
          fromRef,
        });

        provisioned.push({
          index,
          phaseId,
          taskId,
          worktreeId,
          worktreePath,
          branchName,
          fromRef,
        });
      }
    } catch (error) {
      await this.teardownBranches(provisioned);
      throw error;
    }

    return provisioned;
  }

  async run<TResult>(
    input: RunRaceInput<TResult>,
  ): Promise<RaceExecutionResult<TResult>> {
    const branches = await this.provisionBranches(input);
    const branchResults = await Promise.all(
      branches.map(async (branch): Promise<RaceBranchResult<TResult>> => {
        try {
          const result = await input.dispatch(branch);
          return {
            ...branch,
            status: "fulfilled",
            result,
          };
        } catch (error) {
          return {
            ...branch,
            status: "rejected",
            error: normalizeError(error),
          };
        }
      }),
    );

    return { branches: branchResults };
  }

  async teardownBranches(branches: readonly Pick<RaceBranch, "worktreeId">[]) {
    const failures: Error[] = [];

    await Promise.all(
      branches.map(async (branch) => {
        try {
          await this.worktreeManager.teardown(branch.worktreeId);
        } catch (error) {
          failures.push(normalizeError(error));
        }
      }),
    );

    if (failures.length > 0) {
      throw new Error(
        `Failed to teardown ${failures.length} race worktree(s): ${failures
          .map((failure) => failure.message)
          .join("; ")}`,
      );
    }
  }
}
