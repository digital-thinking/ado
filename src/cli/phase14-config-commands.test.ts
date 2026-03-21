import { afterEach, describe, expect, test } from "bun:test";
import { TestSandbox, runIxado } from "./test-helpers";

describe("phase14 CLI config commands", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((s) => s.cleanup()));
    sandboxes.length = 0;
  });

  test("config help includes recovery and task-retries commands", async () => {
    const sandbox = await TestSandbox.create("ixado-p14-config-help-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "help"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Config commands:");
    expect(result.stdout).toContain("ixado config recovery <maxAttempts:0-10>");
    expect(result.stdout).toContain(
      "ixado config task-retries <maxRetries:0-20>",
    );
  });

  test("config recovery updates and shows exception recovery max attempts", async () => {
    const sandbox = await TestSandbox.create("ixado-p14-config-recovery-");
    sandboxes.push(sandbox);

    const updateResult = runIxado(["config", "recovery", "3"], sandbox);
    expect(updateResult.exitCode).toBe(0);
    expect(updateResult.stderr).toBe("");
    expect(updateResult.stdout).toContain(
      "Exception recovery max attempts set to 3.",
    );

    const showResult = runIxado(["config"], sandbox);
    expect(showResult.exitCode).toBe(0);
    expect(showResult.stderr).toBe("");
    expect(showResult.stdout).toContain("Exception recovery max attempts: 3");
  });

  test("config recovery validates value range", async () => {
    const sandbox = await TestSandbox.create(
      "ixado-p14-config-recovery-invalid-",
    );
    sandboxes.push(sandbox);

    const result = runIxado(["config", "recovery", "11"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Usage: ixado config recovery <maxAttempts:0-10>",
    );
  });

  test("config task-retries updates and shows execution loop max task retries", async () => {
    const sandbox = await TestSandbox.create("ixado-p14-config-task-retries-");
    sandboxes.push(sandbox);

    const updateResult = runIxado(["config", "task-retries", "5"], sandbox);
    expect(updateResult.exitCode).toBe(0);
    expect(updateResult.stderr).toBe("");
    expect(updateResult.stdout).toContain(
      "Execution loop max task retries set to 5.",
    );

    const showResult = runIxado(["config"], sandbox);
    expect(showResult.exitCode).toBe(0);
    expect(showResult.stderr).toBe("");
    expect(showResult.stdout).toContain("Execution loop max task retries: 5");
  });

  test("config task-retries validates value range", async () => {
    const sandbox = await TestSandbox.create(
      "ixado-p14-config-task-retries-invalid-",
    );
    sandboxes.push(sandbox);

    const result = runIxado(["config", "task-retries", "21"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Usage: ixado config task-retries <maxRetries:0-20>",
    );
  });
});
