import { afterEach, describe, expect, test } from "bun:test";
import { TestSandbox, runIxado } from "./test-helpers";

describe("phase19 CLI phase run argument parsing", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((s) => s.cleanup()));
    sandboxes.length = 0;
  });

  test("phase run help includes countdownSeconds>=0 in usage", async () => {
    const sandbox = await TestSandbox.create("ixado-p19-phase-run-help-");
    sandboxes.push(sandbox);

    const result = runIxado(["phase", "help"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("countdownSeconds>=0");
  });

  test("phase run auto 0 is accepted (no usage error)", async () => {
    const sandbox = await TestSandbox.create("ixado-p19-run-auto-0-");
    sandboxes.push(sandbox);

    const result = runIxado(["phase", "run", "auto", "0"], sandbox);

    // countdownSeconds=0 must NOT produce a usage error
    expect(result.stderr).not.toContain("Usage: ixado phase run [auto|manual]");
    // It should fail with a preflight error since the sandbox has no phases,
    // not with an argument parsing error.
    expect(result.stderr).toContain("No phases found in project state");
    expect(result.exitCode).toBe(1);
  });

  test("phase run manual 0 is accepted (no usage error)", async () => {
    const sandbox = await TestSandbox.create("ixado-p19-run-manual-0-");
    sandboxes.push(sandbox);

    const result = runIxado(["phase", "run", "manual", "0"], sandbox);

    // countdownSeconds=0 must NOT produce a usage error
    expect(result.stderr).not.toContain("Usage: ixado phase run [auto|manual]");
    // It should fail with a preflight error since the sandbox has no phases,
    // not with an argument parsing error.
    expect(result.stderr).toContain("No phases found in project state");
    expect(result.exitCode).toBe(1);
  });

  test("phase run auto -1 is rejected with usage error", async () => {
    const sandbox = await TestSandbox.create("ixado-p19-run-auto-neg-");
    sandboxes.push(sandbox);

    const result = runIxado(["phase", "run", "auto", "-1"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage: ixado phase run [auto|manual]");
  });

  test("phase run with invalid mode is rejected with usage error", async () => {
    const sandbox = await TestSandbox.create("ixado-p19-run-invalid-mode-");
    sandboxes.push(sandbox);

    const result = runIxado(["phase", "run", "always"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage: ixado phase run [auto|manual]");
  });
});
