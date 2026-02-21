import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StateEngine } from "../state";
import { ControlCenterService } from "./control-center-service";

describe("ControlCenterService", () => {
  let sandboxDir: string;
  let stateFilePath: string;
  let service: ControlCenterService;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-web-control-"));
    stateFilePath = join(sandboxDir, "state.json");
    service = new ControlCenterService(new StateEngine(stateFilePath));
    await service.ensureInitialized("IxADO", "C:/repo");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("creates phases and tasks", async () => {
    const afterPhase = await service.createPhase({
      name: "Phase 6",
      branchName: "phase-6-web-interface",
    });
    expect(afterPhase.phases).toHaveLength(1);

    const phaseId = afterPhase.phases[0].id;
    const afterTask = await service.createTask({
      phaseId,
      title: "Build dashboard",
      description: "Create control center page",
      assignee: "CODEX_CLI",
    });

    expect(afterTask.phases[0].tasks).toHaveLength(1);
    expect(afterTask.phases[0].tasks[0].title).toBe("Build dashboard");
    expect(afterTask.phases[0].tasks[0].assignee).toBe("CODEX_CLI");
  });

  test("fails fast on invalid task target phase", async () => {
    await expect(
      service.createTask({
        phaseId: "missing",
        title: "x",
        description: "y",
      })
    ).rejects.toThrow("Phase not found");
  });
});
