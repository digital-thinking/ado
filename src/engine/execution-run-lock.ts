import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type ExecutionRunLockRecord = {
  pid: number;
  owner: "CLI_PHASE_RUN" | "WEB_AUTO_MODE";
  projectName: string;
  phaseId: string;
  acquiredAt: string;
};

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }

    throw error;
  }
}

function parseLockRecord(raw: string): ExecutionRunLockRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    !Number.isInteger(candidate.pid) ||
    (candidate.pid as number) <= 0 ||
    (candidate.owner !== "CLI_PHASE_RUN" &&
      candidate.owner !== "WEB_AUTO_MODE") ||
    typeof candidate.projectName !== "string" ||
    !candidate.projectName.trim() ||
    typeof candidate.phaseId !== "string" ||
    !candidate.phaseId.trim() ||
    typeof candidate.acquiredAt !== "string" ||
    !candidate.acquiredAt.trim()
  ) {
    return null;
  }

  return candidate as ExecutionRunLockRecord;
}

async function readLockRecord(
  lockFilePath: string,
): Promise<ExecutionRunLockRecord | null> {
  let raw: string;
  try {
    raw = await readFile(lockFilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  return parseLockRecord(raw);
}

function buildAlreadyRunningError(record: ExecutionRunLockRecord): Error {
  return new Error(
    `Execution is already running for project '${record.projectName}', phase '${record.phaseId}' (owner: ${record.owner}, pid: ${record.pid}, acquiredAt: ${record.acquiredAt}).`,
  );
}

export class ExecutionRunLock {
  private readonly lockFilePath: string;
  private readonly owner: "CLI_PHASE_RUN" | "WEB_AUTO_MODE";
  private readonly projectName: string;
  private readonly phaseId: string;
  private acquired = false;

  constructor(input: {
    projectRootDir: string;
    projectName: string;
    phaseId: string;
    owner: "CLI_PHASE_RUN" | "WEB_AUTO_MODE";
  }) {
    if (!input.projectRootDir.trim()) {
      throw new Error("projectRootDir must not be empty.");
    }
    if (!input.projectName.trim()) {
      throw new Error("projectName must not be empty.");
    }
    if (!input.phaseId.trim()) {
      throw new Error("phaseId must not be empty.");
    }

    this.lockFilePath = resolve(
      input.projectRootDir,
      ".ixado",
      `execution-run-${input.phaseId.trim()}.lock.json`,
    );
    this.projectName = input.projectName.trim();
    this.phaseId = input.phaseId.trim();
    this.owner = input.owner;
  }

  async acquire(): Promise<void> {
    if (this.acquired) {
      throw new Error("Execution lock is already acquired by this process.");
    }

    await mkdir(dirname(this.lockFilePath), { recursive: true });
    const record: ExecutionRunLockRecord = {
      pid: process.pid,
      owner: this.owner,
      projectName: this.projectName,
      phaseId: this.phaseId,
      acquiredAt: new Date().toISOString(),
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fileHandle = await open(this.lockFilePath, "wx");
        try {
          await fileHandle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
        } finally {
          await fileHandle.close();
        }
        this.acquired = true;
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw error;
        }

        const existing = await readLockRecord(this.lockFilePath);
        if (!existing) {
          await rm(this.lockFilePath, { force: true });
          continue;
        }
        if (isProcessRunning(existing.pid)) {
          throw buildAlreadyRunningError(existing);
        }

        await rm(this.lockFilePath, { force: true });
      }
    }

    throw new Error(
      "Failed to acquire execution lock after removing stale lock file.",
    );
  }

  async release(): Promise<void> {
    if (!this.acquired) {
      return;
    }

    const existing = await readLockRecord(this.lockFilePath);
    if (
      !existing ||
      (existing.pid === process.pid &&
        existing.owner === this.owner &&
        existing.projectName === this.projectName &&
        existing.phaseId === this.phaseId)
    ) {
      await rm(this.lockFilePath, { force: true });
    }

    this.acquired = false;
  }
}
