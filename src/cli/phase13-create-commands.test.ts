import { afterEach, describe, expect, test } from "bun:test";
import { TestSandbox, runIxado } from "./test-helpers";

describe("phase13 CLI create commands", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((s) => s.cleanup()));
    sandboxes.length = 0;
  });

  test("phase create creates and activates a phase", async () => {
    const sandbox = await TestSandbox.create("ixado-p13-phase-create-");
    sandboxes.push(sandbox);

    const result = runIxado(
      ["phase", "create", "Phase 13", "phase-13-post-release-bugfixes"],
      sandbox,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Created phase Phase 13");

    const state = await sandbox.readProjectState();
    expect(state.phases).toHaveLength(1);
    expect(state.activePhaseId).toBe(state.phases[0]?.id);
    expect(state.phases[0]?.name).toBe("Phase 13");
    expect(state.phases[0]?.branchName).toBe("phase-13-post-release-bugfixes");
  });

  test("task create appends task to active phase and validates usage", async () => {
    const sandbox = await TestSandbox.create("ixado-p13-task-create-");
    sandboxes.push(sandbox);

    const phaseCreateResult = runIxado(
      ["phase", "create", "Phase 13", "phase-13-post-release-bugfixes"],
      sandbox,
    );
    expect(phaseCreateResult.exitCode).toBe(0);

    const taskCreateResult = runIxado(
      ["task", "create", "P13-002", "Implement CLI create flows", "MOCK_CLI"],
      sandbox,
    );
    expect(taskCreateResult.exitCode).toBe(0);

    const state = await sandbox.readProjectState();
    expect(state.phases[0]?.tasks).toHaveLength(1);
    expect(state.phases[0]?.tasks[0]?.title).toBe("P13-002");
    expect(state.phases[0]?.tasks[0]?.assignee).toBe("MOCK_CLI");

    const invalidUsageResult = runIxado(
      ["task", "create", "missing-description-only"],
      sandbox,
    );
    expect(invalidUsageResult.exitCode).toBe(1);
    expect(invalidUsageResult.stderr).toContain(
      "Usage: ixado task create <title> <description> [assignee]",
    );

    const invalidAssigneeResult = runIxado(
      [
        "task",
        "create",
        "P13-002",
        "Implement CLI create flows",
        "INVALID_CLI",
      ],
      sandbox,
    );
    expect(invalidAssigneeResult.exitCode).toBe(1);
    expect(invalidAssigneeResult.stderr).toContain("assignee must be one of");
  });
});
