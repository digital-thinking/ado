import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { PhaseStatus } from "../types";
import type {
  CreateWorktreeInput,
  GitManager,
  RemoveWorktreeInput,
} from "./git-manager";

const TERMINAL_PHASE_STATUSES: ReadonlySet<PhaseStatus> = new Set([
  "DONE",
  "READY_FOR_REVIEW",
  "CI_FAILED",
]);
const RACE_WORKTREE_ID_SEPARATOR = "--race-";

export type WorktreeManagerOptions = {
  git: Pick<GitManager, "createWorktree" | "removeWorktree">;
  projectRootDir: string;
  baseDir: string;
};

export type ProvisionWorktreeInput = {
  phaseId: string;
  branchName: string;
  fromRef?: string;
};

export type WorktreePhaseState = {
  id: string;
  status: PhaseStatus;
};

export type ActiveWorktree = {
  phaseId: string;
  path: string;
  branchName: string | null;
};

export type PruneOrphanedInput = {
  phases: WorktreePhaseState[];
};

function isPhaseTerminal(status: PhaseStatus): boolean {
  return TERMINAL_PHASE_STATUSES.has(status);
}

async function resolveGitDir(projectRootDir: string): Promise<string> {
  const dotGitPath = resolve(projectRootDir, ".git");

  try {
    const stats = await lstat(dotGitPath);
    if (stats.isDirectory()) {
      return dotGitPath;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return dotGitPath;
    }
    throw error;
  }

  const raw = (await readFile(dotGitPath, "utf8")).trim();
  const prefix = "gitdir:";
  if (!raw.startsWith(prefix)) {
    throw new Error(`Invalid .git file format at ${dotGitPath}.`);
  }

  const gitDirValue = raw.slice(prefix.length).trim();
  if (!gitDirValue) {
    throw new Error(`Invalid gitdir reference in ${dotGitPath}.`);
  }

  return isAbsolute(gitDirValue)
    ? gitDirValue
    : resolve(projectRootDir, gitDirValue);
}

async function readWorktreeBranchName(
  metadataDirPath: string,
): Promise<string | null> {
  const headPath = resolve(metadataDirPath, "HEAD");
  let raw: string;
  try {
    raw = (await readFile(headPath, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const prefix = "ref:";
  if (!raw.startsWith(prefix)) {
    return null;
  }
  const ref = raw.slice(prefix.length).trim();
  const branchPrefix = "refs/heads/";
  if (!ref.startsWith(branchPrefix)) {
    return null;
  }

  const branchName = ref.slice(branchPrefix.length).trim();
  return branchName || null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function resolvePhaseIdFromManagedWorktreePath(relPath: string): string {
  const firstSegment = relPath.split(/[\\/]/)[0]?.trim() ?? "";
  if (!firstSegment) {
    return "";
  }

  const separatorIndex = firstSegment.indexOf(RACE_WORKTREE_ID_SEPARATOR);
  if (separatorIndex < 0) {
    return firstSegment;
  }

  return firstSegment.slice(0, separatorIndex).trim();
}

export class WorktreeManager {
  private readonly git: Pick<GitManager, "createWorktree" | "removeWorktree">;
  private readonly projectRootDir: string;
  private readonly worktreesBaseDir: string;

  constructor(options: WorktreeManagerOptions) {
    if (!options.projectRootDir.trim()) {
      throw new Error("projectRootDir must not be empty.");
    }
    if (!options.baseDir.trim()) {
      throw new Error("baseDir must not be empty.");
    }

    this.git = options.git;
    this.projectRootDir = options.projectRootDir;
    this.worktreesBaseDir = resolve(options.projectRootDir, options.baseDir);
  }

  async provision(input: ProvisionWorktreeInput): Promise<string> {
    const phaseId = input.phaseId.trim();
    if (!phaseId) {
      throw new Error("phaseId must not be empty.");
    }
    if (!input.branchName.trim()) {
      throw new Error("branchName must not be empty.");
    }

    const worktreePath = resolve(this.worktreesBaseDir, phaseId);
    if (await pathExists(worktreePath)) {
      await this.git.removeWorktree({
        path: worktreePath,
        cwd: this.projectRootDir,
        force: true,
      });
    }
    const createInput: CreateWorktreeInput = {
      path: worktreePath,
      branchName: input.branchName,
      cwd: this.projectRootDir,
      ...(input.fromRef ? { fromRef: input.fromRef } : {}),
    };
    await this.git.createWorktree(createInput);
    return worktreePath;
  }

  async teardown(phaseId: string): Promise<void> {
    const normalizedPhaseId = phaseId.trim();
    if (!normalizedPhaseId) {
      throw new Error("phaseId must not be empty.");
    }

    const removeInput: RemoveWorktreeInput = {
      path: resolve(this.worktreesBaseDir, normalizedPhaseId),
      cwd: this.projectRootDir,
      force: true,
    };
    await this.git.removeWorktree(removeInput);
  }

  async listActive(): Promise<ActiveWorktree[]> {
    const gitDir = await resolveGitDir(this.projectRootDir);
    const metadataRoot = resolve(gitDir, "worktrees");

    let entries;
    try {
      entries = await readdir(metadataRoot, {
        withFileTypes: true,
        encoding: "utf8",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const active: ActiveWorktree[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const metadataDirPath = resolve(metadataRoot, entry.name);
      let rawGitdir: string;
      try {
        rawGitdir = (
          await readFile(resolve(metadataDirPath, "gitdir"), "utf8")
        ).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (!rawGitdir) {
        continue;
      }

      const resolvedGitdir = isAbsolute(rawGitdir)
        ? rawGitdir
        : resolve(metadataDirPath, rawGitdir);
      const worktreePath = dirname(resolvedGitdir);
      const rel = relative(this.worktreesBaseDir, worktreePath);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
        continue;
      }

      const phaseId = resolvePhaseIdFromManagedWorktreePath(rel);
      if (!phaseId) {
        continue;
      }

      active.push({
        phaseId,
        path: worktreePath,
        branchName: await readWorktreeBranchName(metadataDirPath),
      });
    }

    active.sort((a, b) => a.phaseId.localeCompare(b.phaseId));
    return active;
  }

  async pruneOrphaned(input: PruneOrphanedInput): Promise<ActiveWorktree[]> {
    const phasesById = new Map(input.phases.map((phase) => [phase.id, phase]));
    const active = await this.listActive();
    const pruned: ActiveWorktree[] = [];

    for (const worktree of active) {
      const phase = phasesById.get(worktree.phaseId);
      const worktreePathExists = await pathExists(worktree.path);
      if (worktreePathExists && phase && !isPhaseTerminal(phase.status)) {
        continue;
      }

      await this.git.removeWorktree({
        path: worktree.path,
        cwd: this.projectRootDir,
        force: true,
      });
      pruned.push(worktree);
    }

    return pruned;
  }
}
