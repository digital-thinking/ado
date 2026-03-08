import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ExecutionRunLock } from "./execution-run-lock";

describe("ExecutionRunLock", () => {
  let sandboxDir: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-exec-lock-"));
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("acquire creates lock file and release removes it", async () => {
    const lock = new ExecutionRunLock({
      projectRootDir: sandboxDir,
      projectName: "alpha",
      phaseId: "phase-1",
      owner: "CLI_PHASE_RUN",
    });

    await lock.acquire();

    const raw = await readFile(
      join(sandboxDir, ".ixado", "execution-run-phase-1.lock.json"),
      "utf8",
    );
    const record = JSON.parse(raw) as {
      pid: number;
      owner: string;
      projectName: string;
      phaseId: string;
    };
    expect(record.pid).toBe(process.pid);
    expect(record.owner).toBe("CLI_PHASE_RUN");
    expect(record.projectName).toBe("alpha");
    expect(record.phaseId).toBe("phase-1");

    await lock.release();
    await expect(
      readFile(
        join(sandboxDir, ".ixado", "execution-run-phase-1.lock.json"),
        "utf8",
      ),
    ).rejects.toThrow();
  });

  test("rejects second concurrent lock acquisition", async () => {
    const first = new ExecutionRunLock({
      projectRootDir: sandboxDir,
      projectName: "alpha",
      phaseId: "phase-1",
      owner: "CLI_PHASE_RUN",
    });
    await first.acquire();

    const second = new ExecutionRunLock({
      projectRootDir: sandboxDir,
      projectName: "alpha",
      phaseId: "phase-1",
      owner: "WEB_AUTO_MODE",
    });
    await expect(second.acquire()).rejects.toThrow(
      "Execution is already running for project",
    );

    await first.release();
  });

  test("allows concurrent acquisition for different phases", async () => {
    const first = new ExecutionRunLock({
      projectRootDir: sandboxDir,
      projectName: "alpha",
      phaseId: "phase-1",
      owner: "CLI_PHASE_RUN",
    });
    const second = new ExecutionRunLock({
      projectRootDir: sandboxDir,
      projectName: "alpha",
      phaseId: "phase-2",
      owner: "WEB_AUTO_MODE",
    });

    await expect(first.acquire()).resolves.toBeUndefined();
    await expect(second.acquire()).resolves.toBeUndefined();

    await expect(
      readFile(
        join(sandboxDir, ".ixado", "execution-run-phase-1.lock.json"),
        "utf8",
      ),
    ).resolves.toContain('"phaseId": "phase-1"');
    await expect(
      readFile(
        join(sandboxDir, ".ixado", "execution-run-phase-2.lock.json"),
        "utf8",
      ),
    ).resolves.toContain('"phaseId": "phase-2"');

    await first.release();
    await second.release();
  });

  test("removes stale lock and acquires lock", async () => {
    const lockFilePath = join(
      sandboxDir,
      ".ixado",
      "execution-run-phase-1.lock.json",
    );
    await mkdir(join(sandboxDir, ".ixado"), { recursive: true });
    await Bun.write(
      lockFilePath,
      JSON.stringify({
        pid: 999_999_999,
        owner: "CLI_PHASE_RUN",
        projectName: "alpha",
        phaseId: "phase-1",
        acquiredAt: new Date().toISOString(),
      }),
    );

    const lock = new ExecutionRunLock({
      projectRootDir: sandboxDir,
      projectName: "alpha",
      phaseId: "phase-1",
      owner: "WEB_AUTO_MODE",
    });
    await lock.acquire();
    const raw = await readFile(lockFilePath, "utf8");
    const record = JSON.parse(raw) as { owner: string; pid: number };
    expect(record.owner).toBe("WEB_AUTO_MODE");
    expect(record.pid).toBe(process.pid);
    await lock.release();
  });
});
